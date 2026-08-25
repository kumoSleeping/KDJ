//! YouTube Music provider。
//!
//! 匿名可用：搜索 / 歌单 / 链接解析全都不需要账号。播放流受 YouTube 的
//! botguard / PO token 质询影响；登录后复用浏览器 Cookie，并按 ytmusicapi 的
//! 方式动态生成 SAPISIDHASH。它拥有独立于普通 YouTube 视频来源的本机会话。
//!
//! 音质档映射：免费流最高约 128k opus、会员约 256k AAC，没有无损，
//! 所以 Flac 请求按"能拿到的最高码率"处理。HLS 回退交给 FFmpeg 提取音轨。

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, Platform, QrSession, QrStateValue, Quality, ResolveKind,
    ResolveResponse, SongSource, StreamPlaylist, StreamPlaylistResponse,
};
use kdj_core::paths::render_filename;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;

use super::auth::YoutubeAuth;
use super::client::YtmClient;
use crate::net::{create_download_writer, host_is, AtomicDownload};
use crate::provider::{
    effective_limit, full_listing, no_login, str_field, unique_download_path, Capabilities,
    DownloadJob, MusicProvider, ProtectedPreviewCipher, ProtectedPreviewIdentity, ProviderContext,
};
use crate::tags;

const LABEL: &str = "YouTube Music";
const DISABLED_MESSAGE: &str = "未启用，在「下载」里打开开关";
/// 契约音质 → YouTube Music 现实里最接近的码率目标。
/// 平台没有无损档：flac 和 320 都对准会员上限（约 256k AAC）。
fn target_bitrate(quality: Quality) -> i64 {
    match quality {
        Quality::Flac | Quality::Q320 => 256_000,
        Quality::Q128 => 128_000,
    }
}

/// 解析出来的音频流形态：直链（可试听/下载）或 HLS（只能下载，交给 FFmpeg）。
enum StreamSource {
    Direct { url: String, ext: String },
    Hls { url: String },
}

pub struct YoutubeMusicProvider {
    ctx: ProviderContext,
    client: YtmClient,
    auth: Arc<YoutubeAuth>,
}

impl YoutubeMusicProvider {
    pub fn new(ctx: ProviderContext, auth: Arc<YoutubeAuth>) -> Result<Self> {
        let client = YtmClient::new(auth.clone())?;
        Ok(YoutubeMusicProvider { ctx, client, auth })
    }

    fn ensure_enabled(&self) -> Result<()> {
        anyhow::ensure!(self.ctx.ytm_enabled(), "{DISABLED_MESSAGE}");
        Ok(())
    }

    fn video_id(source: &SongSource) -> Result<String> {
        let key = source.payload_str("video_id");
        anyhow::ensure!(!key.is_empty(), "YouTube Music 歌曲缺少 video_id");
        Ok(key)
    }

    // 登录由 `/api/accounts/ytm/login/*` 导入 YouTube Music 自己的浏览器会话；
    // 不读取、覆盖或清理普通 YouTube 视频来源的登录态。

    // ------------------------------------------------------------ 流解析

    /// 解析音频流。返回直链（可试听/下载）或 HLS（下载用）。
    async fn stream_source(
        &self,
        video_id: &str,
        quality: Quality,
        lowest: bool,
    ) -> Result<StreamSource> {
        let player = self.client.player(video_id, None).await?;
        ensure_playable(&player)?;
        let formats = audio_formats(&player);
        if !formats.is_empty() {
            let format = if lowest {
                formats
                    .iter()
                    .filter(|format| format.bitrate > 0)
                    .min_by_key(|format| format.bitrate)
                    .or_else(|| formats.first())
                    .expect("上面已确认非空")
            } else {
                pick_format(&formats, quality)
            };
            let url = self.format_url(format).await?;
            return Ok(StreamSource::Direct {
                url,
                ext: ext_of(format),
            });
        }
        // 自适应流没有（匿名被剥 URL / 免费账号只给 HLS）时退回 HLS。
        if let Some(hls) = hls_manifest_url(&player) {
            return Ok(StreamSource::Hls {
                url: hls.to_string(),
            });
        }
        bail!("YouTube Music 没有返回可供原生播放器读取的音频流；该内容可能受地区、年龄或版权限制")
    }

    /// 直链直接用；签名串走播放器脚本解密。
    async fn format_url(&self, format: &AudioFormat) -> Result<String> {
        if let Some(url) = &format.url {
            return Ok(url.clone());
        }
        anyhow::ensure!(!format.cipher.is_empty(), "音频流既没有直链也没有签名参数");
        let params: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(format.cipher.as_bytes())
                .into_owned()
                .collect();
        let url = params
            .get("url")
            .filter(|value| !value.is_empty())
            .context("音频流签名参数缺少 url")?;
        let scrambled = params
            .get("s")
            .filter(|value| !value.is_empty())
            .context("音频流签名参数缺少 s")?;
        let key_name = params
            .get("sp")
            .filter(|value| !value.is_empty())
            .map(String::as_str)
            .unwrap_or("signature");
        let script = self.client.player_script().await?;
        let signature = script
            .decipher(scrambled)
            .context("还原 YouTube Music 音频签名失败")?;
        Ok(format!("{url}&{key_name}={signature}"))
    }

    async fn fetch_cover(&self, url: &str) -> Option<Vec<u8>> {
        if url.is_empty() {
            return None;
        }
        let response = self.client.http().get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.bytes().await.ok().map(|bytes| bytes.to_vec())
    }

    async fn resolve_song(&self, video_id: &str) -> Result<SongSource> {
        // 解析元数据与播放共用 iOS 响应：匿名也返回完整的 videoDetails。
        let player = self.client.player(video_id, None).await?;
        ensure_playable(&player)?;
        let details = player
            .get("videoDetails")
            .context("YouTube Music 播放信息缺少 videoDetails")?;
        Ok(source_from_video_details(details, video_id))
    }

    async fn resolve_playlist(
        &self,
        playlist_id: &str,
        limit: usize,
    ) -> Result<(String, Vec<SongSource>)> {
        let body = self
            .client
            .browse(&format!("VL{playlist_id}"))
            .await
            .context("读取 YouTube Music 歌单失败")?;
        let (title, sources) =
            playlist_from_browse(&body).context("YouTube Music 歌单里没有可用歌曲")?;
        Ok((title, sources.into_iter().take(limit).collect()))
    }

    /// HLS 音频轨提取：`-vn -c:a copy` 把 TS 里的 AAC 原样装进 m4a。
    /// HLS 是按分片拉取的，没有逐字节进度；跑完一次性报总量。
    async fn download_hls(
        &self,
        url: &str,
        output: &std::path::Path,
        job: &DownloadJob<'_>,
    ) -> Result<()> {
        anyhow::ensure!(
            crate::ffmpeg::available(),
            "需要 FFmpeg 才能下载 HLS 音频流"
        );
        let log_path = self.ctx.data_dir.join("ytm-hls-ffmpeg.log");
        let args = vec![
            "-y".to_string(),
            "-i".to_string(),
            url.to_string(),
            "-vn".to_string(),
            "-c:a".to_string(),
            "copy".to_string(),
            "-f".to_string(),
            "ipod".to_string(),
            output.to_string_lossy().into_owned(),
        ];
        job.report(0, 0);
        crate::ffmpeg::run(&args, &log_path, &job.cancel)
            .await
            .context("FFmpeg 提取 HLS 音轨失败")?;
        job.check_canceled()?;
        let size = std::fs::metadata(output)
            .map(|meta| meta.len())
            .unwrap_or(0);
        job.report(size, size);
        Ok(())
    }
}

#[async_trait]
impl MusicProvider for YoutubeMusicProvider {
    fn platform(&self) -> Platform {
        Platform::Ytm
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::MUSIC
    }

    async fn account(&self) -> Account {
        let mut account = Account::new(Platform::Ytm, LABEL, AccountState::Missing, "未登录");
        account.login_method = "browser".into();
        account.credential_kind = "anonymous".into();
        let Some(session) = self.auth.snapshot() else {
            account.detail = if self.ctx.ytm_enabled() {
                "可匿名搜索；导入浏览器会话后解锁账号内容".into()
            } else {
                DISABLED_MESSAGE.into()
            };
            return account;
        };
        account.account_key = session.x_goog_authuser.clone();
        account.state = AccountState::Valid;
        account.credential_kind = "browser_session".into();
        account.detail = session.imported_from;
        if let Ok(body) = self.client.account_menu().await {
            if let Some(name) = first_text(&body, &["accountName", "name"]) {
                account.nickname = name;
            }
        }
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        no_login::create_qr(LABEL)
    }

    async fn poll_qr(&self, _session_id: &str) -> Result<(QrStateValue, String)> {
        Ok(no_login::poll_qr(LABEL))
    }

    async fn logout(&self) -> Result<()> {
        self.auth.clear();
        Ok(())
    }

    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if keyword.is_empty() || !self.ctx.ytm_enabled() {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let body = self.client.search_songs(keyword).await?;
        Ok(search_sources(&body).into_iter().take(limit).collect())
    }

    async fn stream_playlists(&self) -> Result<Vec<StreamPlaylist>> {
        // 侧栏账号浏览与「下载源」开关正交；开关只门禁搜索、解析和下载。
        if !self.auth.is_logged_in() {
            return Ok(Vec::new());
        }
        let body = self
            .client
            .library_playlists()
            .await
            .context("读取 YouTube Music 播放列表失败")?;
        let mut playlists = ytm_library_playlists(&body);
        // 目录把「赞过的音乐」标成自动列表，不提供曲目数；单独读一次头部，
        // 避免侧栏把已有内容误写成 0。失败时仍保留可点击入口。
        if let Some(liked) = playlists.iter_mut().find(|playlist| playlist.key == "LM") {
            if let Ok(body) = self.client.browse("VLLM").await {
                liked.count = playlist_count_from_browse(&body).unwrap_or(liked.count);
            }
        }
        Ok(playlists)
    }

    async fn stream_playlist_tracks(
        &self,
        key: &str,
        limit: usize,
    ) -> Result<Option<StreamPlaylistResponse>> {
        let key = key.trim().trim_start_matches("VL");
        if key.is_empty() {
            return Ok(None);
        }
        let body = self
            .client
            .browse(&format!("VL{key}"))
            .await
            .context("读取 YouTube Music 歌单失败")?;
        let (title, sources) = playlist_contents_from_browse(&body);
        Ok(Some(StreamPlaylistResponse {
            platform: Platform::Ytm,
            key: key.to_string(),
            title,
            sources: sources.into_iter().take(full_listing(limit)).collect(),
        }))
    }

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let text = url.trim();
        // 普通 youtube.com / youtu.be / Shorts 归独立的 YouTube 视频来源。
        if !host_is(text, "music.youtube.com") {
            return Ok(None);
        }
        self.ensure_enabled()?;
        let Some((kind, key)) = parse_ytm_url(text) else {
            bail!("没有识别出这段 YouTube 链接里的内容。");
        };
        match kind {
            ResolveKind::Song => {
                let source = self.resolve_song(&key).await?;
                Ok(Some(ResolveResponse {
                    kind: ResolveKind::Song,
                    platform: Platform::Ytm,
                    title: source.title.clone(),
                    sources: vec![source],
                }))
            }
            ResolveKind::Playlist => {
                let limit = full_listing(limit);
                let (title, sources) = self.resolve_playlist(&key, limit).await?;
                Ok(Some(ResolveResponse {
                    kind: ResolveKind::Playlist,
                    platform: Platform::Ytm,
                    title,
                    sources,
                }))
            }
            ResolveKind::Album | ResolveKind::Unknown => {
                bail!("YouTube Music 不支持这种链接")
            }
        }
    }

    /// 试听 = 最低码率那一档。HLS 不能直接交给原生 Range 解码器。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        self.ensure_enabled()?;
        let key = Self::video_id(source)?;
        match self.stream_source(&key, Quality::Q128, true).await? {
            StreamSource::Direct { url, .. } => Ok(Some(url)),
            StreamSource::Hls { .. } => bail!("YouTube Music 当前只返回 HLS，无法直接试听"),
        }
    }

    async fn preview_url_at_quality(
        &self,
        source: &SongSource,
        quality: Quality,
    ) -> Result<Option<String>> {
        self.ensure_enabled()?;
        let key = Self::video_id(source)?;
        match self.stream_source(&key, quality, false).await? {
            StreamSource::Direct { url, .. } => Ok(Some(url)),
            StreamSource::Hls { .. } => bail!("YouTube Music 当前只返回 HLS，无法直接试听"),
        }
    }

    async fn protected_preview_cipher(
        &self,
        source: &SongSource,
        quality: Quality,
        po_token: &str,
        identity: &ProtectedPreviewIdentity,
    ) -> Result<Option<ProtectedPreviewCipher>> {
        self.ensure_enabled()?;
        let key = Self::video_id(source)?;
        let player = self
            .client
            .protected_web_player(
                &key,
                po_token,
                &identity.visitor_data,
                &identity.data_sync_id,
            )
            .await?;
        ensure_playable(&player)?;
        let formats = audio_formats(&player);
        let format = (!formats.is_empty()).then(|| pick_format(&formats, quality));
        let Some(format) = format else {
            bail!("YouTube Music 没有返回可签名的音频流");
        };
        anyhow::ensure!(
            !format.cipher.is_empty(),
            "YouTube Music Web player 没有返回 signatureCipher"
        );
        let player_url = self
            .client
            .protected_player_url(player.pointer("/assets/js").and_then(Value::as_str))
            .await?;
        Ok(Some(ProtectedPreviewCipher {
            signature_cipher: format.cipher.clone(),
            player_url,
        }))
    }

    async fn protected_preview_player_script(&self, player_url: &str) -> Result<Option<String>> {
        Ok(Some(self.client.protected_player_script(player_url).await?))
    }

    async fn protected_preview_identity(&self) -> Result<Option<ProtectedPreviewIdentity>> {
        let (visitor_data, data_sync_id) = self.client.protected_web_identity().await?;
        Ok(Some(ProtectedPreviewIdentity {
            visitor_data,
            data_sync_id,
        }))
    }

    async fn protected_preview_botguard(
        &self,
        operation: &str,
        payload: &Value,
    ) -> Result<Option<Value>> {
        Ok(Some(
            self.client.protected_botguard(operation, payload).await?,
        ))
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        self.ensure_enabled()?;
        job.check_canceled()?;
        let source = job.source;
        let key = Self::video_id(source)?;
        let stream = self.stream_source(&key, job.quality, false).await?;
        job.check_canceled()?;

        let ext = match &stream {
            StreamSource::Direct { ext, .. } => ext.clone(),
            // HLS 交给 FFmpeg 提取音轨，产物统一 m4a（TS 里的 AAC 原样封装）
            StreamSource::Hls { .. } => "m4a".to_string(),
        };
        let output_dir = self.ctx.platform_dir(Platform::Ytm)?;
        let filename = render_filename(
            &self.ctx.filename_template(),
            &source.title,
            &source.artist_text(),
            &source.album,
            &source.key,
            &ext,
        );
        let final_path = unique_download_path(&output_dir, &filename);

        let guard = AtomicDownload::new(&final_path);
        match stream {
            StreamSource::Direct { url, .. } => {
                let response = self
                    .client
                    .http()
                    .get(&url)
                    .send()
                    .await
                    .context("YouTube Music 音频下载失败")?;
                if response.status() == reqwest::StatusCode::FORBIDDEN {
                    bail!("YouTube Music 拒绝了音频请求（签名可能已失效，稍后重试）");
                }
                let response = response
                    .error_for_status()
                    .context("YouTube Music 音频下载失败")?;
                let total = response.content_length().unwrap_or(0);
                job.report(0, total);

                let mut file = create_download_writer(guard.partial())
                    .await
                    .context("创建下载临时文件失败")?;
                let mut downloaded = 0u64;
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    job.check_canceled()?;
                    let chunk = chunk.context("YouTube Music 音频流中断")?;
                    file.write_all(&chunk).await.context("写入下载文件失败")?;
                    downloaded += chunk.len() as u64;
                    job.report(downloaded, total.max(downloaded));
                }
                file.flush().await.context("提交下载缓冲失败")?;
                drop(file);
            }
            StreamSource::Hls { url } => {
                self.download_hls(&url, guard.partial(), &job).await?;
            }
        }
        let path = guard.commit()?;

        let cover = self.fetch_cover(&source.cover).await;
        let artists = if source.artists.is_empty() {
            vec!["Unknown".to_string()]
        } else {
            source.artists.clone()
        };
        if let Err(err) = tags::embed_metadata(
            &path,
            &source.title,
            &artists,
            &source.album,
            cover.as_deref(),
        ) {
            tracing::warn!("YouTube Music 写标签失败 song={}: {err}", source.key);
        }
        Ok(path)
    }
}

// ---------------------------------------------------------------- 流与音质

#[derive(Debug, Clone)]
struct AudioFormat {
    bitrate: i64,
    mime: String,
    url: Option<String>,
    cipher: String,
}

fn audio_formats(player: &Value) -> Vec<AudioFormat> {
    player
        .pointer("/streamingData/adaptiveFormats")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|format| {
                    str_field(format, "mimeType").is_some_and(|mime| mime.starts_with("audio/"))
                })
                .map(|format| AudioFormat {
                    bitrate: format.get("bitrate").and_then(Value::as_i64).unwrap_or(0),
                    mime: str_field(format, "mimeType")
                        .unwrap_or_default()
                        .to_string(),
                    url: str_field(format, "url").map(str::to_string),
                    cipher: str_field(format, "signatureCipher")
                        .or_else(|| str_field(format, "cipher"))
                        .unwrap_or_default()
                        .to_string(),
                })
                // 既没有直链也没有签名参数的条目拿不到音频，别留在候选里
                .filter(|format| format.url.is_some() || !format.cipher.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 选离目标码率最近的格式；等距时取码率更高那个。
/// 没有无损档可降级，所以不需要 netease 那种梯度回退——目标本身就是就近匹配。
fn pick_format(formats: &[AudioFormat], quality: Quality) -> &AudioFormat {
    let target = target_bitrate(quality);
    formats
        .iter()
        .min_by_key(|format| ((format.bitrate - target).abs(), -format.bitrate))
        .expect("调用方已确认非空")
}

fn ext_of(format: &AudioFormat) -> String {
    if format.mime.contains("webm") {
        "webm".to_string()
    } else if format.mime.contains("mp4") {
        "m4a".to_string()
    } else {
        "m4a".to_string()
    }
}

fn hls_manifest_url(player: &Value) -> Option<&str> {
    player
        .pointer("/streamingData/hlsManifestUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
}

fn ensure_playable(player: &Value) -> Result<()> {
    let status = player
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status == "OK" {
        return Ok(());
    }
    let reason = player
        .pointer("/playabilityStatus/reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status.is_empty() {
        bail!("YouTube Music 没有返回播放状态");
    }
    if reason.is_empty() {
        bail!("这首在 YouTube Music 不可播放（{status}）");
    }
    bail!("这首在 YouTube Music 不可播放：{reason}");
}

// ---------------------------------------------------------------- 链接解析

const VIDEO_ID_CHARS: usize = 11;

fn looks_like_video_id(text: &str) -> bool {
    text.len() == VIDEO_ID_CHARS
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn parse_ytm_url(text: &str) -> Option<(ResolveKind, String)> {
    let parsed = url::Url::parse(text).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    // YTM 只认音乐站；普通 youtube.com / youtu.be 交给 YouTube 视频 provider。
    if host != "music.youtube.com" {
        return None;
    }
    let path = parsed.path();
    let query: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();

    if path.ends_with("/watch") {
        if let Some(list) = query.get("list").filter(|id| !id.is_empty()) {
            return Some((ResolveKind::Playlist, list.clone()));
        }
        if let Some(video) = query.get("v").filter(|id| looks_like_video_id(id)) {
            return Some((ResolveKind::Song, video.clone()));
        }
        return None;
    }
    if path.starts_with("/playlist") {
        if let Some(list) = query.get("list").filter(|id| !id.is_empty()) {
            return Some((ResolveKind::Playlist, list.clone()));
        }
    }
    None
}

// ---------------------------------------------------------------- JSON 解析

/// `musicResponsiveListItemFlexColumnRenderer.text` 对象的第一段文本。
fn first_run_text(text: Option<&Value>) -> String {
    text.and_then(|text| text.pointer("/runs/0/text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn column_text(item: &Value, index: usize) -> String {
    let pointer = format!("/flexColumns/{index}/musicResponsiveListItemFlexColumnRenderer/text");
    first_run_text(item.pointer(&pointer))
}

/// 艺人列：优先取带艺人跳转端点的 run；兜底按分隔符拆整列文本。
fn column_artists(item: &Value, index: usize) -> Vec<String> {
    let pointer = format!("/flexColumns/{index}/musicResponsiveListItemFlexColumnRenderer/text");
    let Some(text) = item.pointer(&pointer) else {
        return Vec::new();
    };
    let runs = text.get("runs").and_then(Value::as_array);
    if let Some(runs) = runs {
        let explicit: Vec<String> = runs
            .iter()
            .filter(|run| {
                run.pointer(
                    "/navigationEndpoint/browseEndpoint/\
                     browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType",
                )
                .and_then(Value::as_str)
                    == Some("MUSIC_PAGE_TYPE_ARTIST")
            })
            .filter_map(|run| str_field(run, "text").map(str::to_string))
            .collect();
        if !explicit.is_empty() {
            return explicit;
        }
        let joined: String = runs
            .iter()
            .filter_map(|run| str_field(run, "text"))
            .collect::<Vec<_>>()
            .join("");
        return joined
            .split(['•', '、', '，', ',', '/', '&'])
            .map(str::trim)
            .filter(|piece| !piece.is_empty())
            .map(str::to_string)
            .collect();
    }
    Vec::new()
}

/// "3:45" / "1:02:33" → 秒。
fn parse_duration_text(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut total = 0f64;
    for part in parts {
        let number: f64 = part.trim().parse().ok()?;
        total = total * 60.0 + number;
    }
    (total > 0.0).then_some(total)
}

fn item_video_id(item: &Value) -> Option<String> {
    item.get("playlistItemData")
        .and_then(|data| str_field(data, "videoId"))
        .map(str::to_string)
        .or_else(|| {
            item.pointer("/navigationEndpoint/watchEndpoint/videoId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            item.pointer("/navigationEndpoint/watchPlaylistEndpoint/videoId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty())
}

fn song_source(item: &Value) -> Option<SongSource> {
    let item = item.get("musicResponsiveListItemRenderer")?;
    let video_id = item_video_id(item)?;
    let title = column_text(item, 0);
    if title.is_empty() {
        return None;
    }
    let artists = column_artists(item, 1);
    let album = column_text(item, 2);
    let duration = item
        .pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text")
        .and_then(|text| parse_duration_text(&first_run_text(Some(text))))
        .filter(|value| *value > 0.0);
    let cover = item
        .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
        .and_then(Value::as_array)
        .and_then(|list| list.last())
        .and_then(|thumb| str_field(thumb, "url"))
        .unwrap_or_default()
        .to_string();
    let mut payload = serde_json::Map::new();
    payload.insert("video_id".into(), json!(video_id));
    Some(SongSource {
        platform: Platform::Ytm,
        key: video_id,
        title,
        artists: if artists.is_empty() {
            vec!["Unknown".to_string()]
        } else {
            artists
        },
        album,
        duration,
        cover,
        // YouTube Music 免费流最高约 128k opus；会员才给更高码率
        max_quality: Some(Quality::Q128),
        vip: false,
        payload,
    })
}

/// 搜索结果里的歌曲：遍历所有 shelf 收集条目（song filter 下基本都是歌曲）。
fn search_sources(body: &Value) -> Vec<SongSource> {
    let mut out = Vec::new();
    let Some(sections) = body
        .pointer(
            "/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/\
             sectionListRenderer/contents",
        )
        .and_then(Value::as_array)
    else {
        return out;
    };
    for section in sections {
        let Some(shelf) = section.get("musicShelfRenderer") else {
            continue;
        };
        let Some(items) = shelf.get("contents").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(source) = song_source(item) {
                out.push(source);
            }
        }
    }
    out
}

fn source_from_video_details(details: &Value, video_id: &str) -> SongSource {
    let title = str_field(details, "title").unwrap_or("Unknown").to_string();
    let artist = str_field(details, "author").unwrap_or_default();
    let duration = details
        .get("lengthSeconds")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|value| *value > 0.0);
    let cover = details
        .pointer("/thumbnail/thumbnails")
        .and_then(Value::as_array)
        .and_then(|list| list.last())
        .and_then(|thumb| str_field(thumb, "url"))
        .unwrap_or_default()
        .to_string();
    let mut payload = serde_json::Map::new();
    payload.insert("video_id".into(), json!(video_id));
    SongSource {
        platform: Platform::Ytm,
        key: video_id.to_string(),
        title,
        artists: if artist.is_empty() {
            vec!["Unknown".to_string()]
        } else {
            vec![artist.to_string()]
        },
        album: String::new(),
        duration,
        cover,
        max_quality: Some(Quality::Q128),
        vip: false,
        payload,
    }
}

fn text_runs(value: &Value) -> String {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }
    if let Some(text) = value
        .get("simpleText")
        .or_else(|| value.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }
    value
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|run| run.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

fn visible_count(text: &str) -> usize {
    let mut digits = String::new();
    let mut started = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            started = true;
        } else if started && ch != ',' {
            break;
        }
    }
    digits.parse().unwrap_or(0)
}

fn last_thumbnail_url(value: &Value) -> String {
    fn visit(value: &Value, best: &mut (u64, String)) {
        match value {
            Value::Object(map) => {
                if let Some(url) = map.get("url").and_then(Value::as_str) {
                    let area = map.get("width").and_then(Value::as_u64).unwrap_or(0)
                        * map.get("height").and_then(Value::as_u64).unwrap_or(0);
                    if !url.is_empty() && (best.1.is_empty() || area >= best.0) {
                        *best = (area, url.to_string());
                    }
                }
                for child in map.values() {
                    visit(child, best);
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(child, best);
                }
            }
            _ => {}
        }
    }
    let mut best = (0, String::new());
    visit(value, &mut best);
    best.1
}

fn contains_key(value: &Value, expected: &str) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key(expected) || map.values().any(|child| contains_key(child, expected))
        }
        Value::Array(items) => items.iter().any(|child| contains_key(child, expected)),
        _ => false,
    }
}

fn ytm_playlist_tile(renderer: &Value) -> Option<StreamPlaylist> {
    let raw_key = [
        "/navigationEndpoint/watchEndpoint/playlistId",
        "/navigationEndpoint/browseEndpoint/browseId",
        "/title/runs/0/navigationEndpoint/watchEndpoint/playlistId",
        "/title/runs/0/navigationEndpoint/browseEndpoint/browseId",
    ]
    .iter()
    .find_map(|pointer| renderer.pointer(pointer).and_then(Value::as_str))?;
    let key = raw_key.trim().trim_start_matches("VL");
    // SE 是 YouTube Music 的「稍后再听」播客分集队列，不是歌曲歌单；当前
    // SongSource/下载管线无法正确展开它，侧栏不要放一个必然打不开的入口。
    if key.is_empty() || key.starts_with("FE") || key == "SE" {
        return None;
    }
    let title = text_runs(renderer.get("title")?);
    if title.is_empty() {
        return None;
    }
    let favorite = key == "LM";
    let owned = contains_key(renderer, "deletePlaylistEndpoint")
        || contains_key(renderer, "playlistEditorEndpoint")
        // 兼容旧版 InnerTube 菜单命名。
        || contains_key(renderer, "playlistDeleteEndpoint")
        || contains_key(renderer, "playlistEditEndpoint");
    Some(StreamPlaylist {
        platform: Platform::Ytm,
        key: key.to_string(),
        title,
        cover: last_thumbnail_url(renderer),
        count: visible_count(&text_runs(renderer.get("subtitle").unwrap_or(&Value::Null))),
        is_favorite: favorite,
        origin: if favorite {
            "favorite"
        } else if owned {
            "created"
        } else {
            "collected"
        }
        .into(),
    })
}

fn playlist_count_from_browse(body: &Value) -> Option<usize> {
    [
        "/header/musicResponsiveHeaderRenderer/secondSubtitle",
        "/header/musicDetailHeaderRenderer/subtitle",
        "/header/musicEditablePlaylistDetailHeaderRenderer/header/\
         musicDetailHeaderRenderer/subtitle",
        "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
         sectionListRenderer/contents/0/musicResponsiveHeaderRenderer/secondSubtitle",
    ]
    .iter()
    .filter_map(|pointer| body.pointer(pointer))
    .map(text_runs)
    .map(|text| visible_count(&text))
    .find(|count| *count > 0)
}

fn ytm_library_playlists(body: &Value) -> Vec<StreamPlaylist> {
    fn visit(value: &Value, playlists: &mut Vec<StreamPlaylist>) {
        match value {
            Value::Object(map) => {
                if let Some(renderer) = map.get("musicTwoRowItemRenderer") {
                    if let Some(playlist) = ytm_playlist_tile(renderer) {
                        if !playlists.iter().any(|item| item.key == playlist.key) {
                            playlists.push(playlist);
                        }
                    }
                    return;
                }
                for child in map.values() {
                    visit(child, playlists);
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(child, playlists);
                }
            }
            _ => {}
        }
    }
    let mut playlists = Vec::new();
    visit(body, &mut playlists);
    playlists
}

/// 歌单浏览页：标题 + 全部可见歌曲。
///
/// 布局随客户端形态在变：老版是 `singleColumnBrowseResultsRenderer`，
/// 现在网页端是 `twoColumnBrowseResultsRenderer`（主栏放标题头、
/// 次栏放曲目 shelf）。三处 shelf 都扫一遍，标题带 microformat 兜底。
fn playlist_contents_from_browse(body: &Value) -> (String, Vec<SongSource>) {
    let title = [
        "/header/musicDetailHeaderRenderer/title/runs/0/text",
        "/header/musicEditablePlaylistDetailHeaderRenderer/header/musicDetailHeaderRenderer/title/runs/0/text",
        "/header/musicResponsiveHeaderRenderer/title/runs/0/text",
        "/microformat/microformatDataRenderer/title",
        "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
         sectionListRenderer/contents/0/musicResponsiveHeaderRenderer/title/runs/0/text",
    ]
    .iter()
    .find_map(|pointer| body.pointer(pointer).and_then(Value::as_str))
    .unwrap_or("YouTube Music 歌单")
    .to_string();

    const SHELF_LISTS: [&str; 3] = [
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
         sectionListRenderer/contents",
        "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
         sectionListRenderer/contents",
        "/contents/twoColumnBrowseResultsRenderer/secondaryContents/\
         sectionListRenderer/contents",
    ];
    let mut sources = Vec::new();
    for pointer in SHELF_LISTS {
        let Some(sections) = body.pointer(pointer).and_then(Value::as_array) else {
            continue;
        };
        for section in sections {
            // 歌单页里可能混着别的 section（作者卡片、继续项等），跳过而不是整体放弃
            let Some(shelf) = section
                .get("musicPlaylistShelfRenderer")
                .or_else(|| section.get("musicShelfRenderer"))
            else {
                continue;
            };
            let Some(items) = shelf.get("contents").and_then(Value::as_array) else {
                continue;
            };
            sources.extend(items.iter().filter_map(song_source));
        }
    }
    (title, sources)
}

fn playlist_from_browse(body: &Value) -> Option<(String, Vec<SongSource>)> {
    let contents = playlist_contents_from_browse(body);
    (!contents.1.is_empty()).then_some(contents)
}

fn first_text(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(text) = map
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    return Some(text.to_string());
                }
            }
            map.values().find_map(|child| first_text(child, keys))
        }
        Value::Array(items) => items.iter().find_map(|child| first_text(child, keys)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song_item(video_id: &str, title: &str) -> Value {
        json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": title}]}}},
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
                        {"text": "Artist A", "navigationEndpoint": {"browseEndpoint": {"browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}}}},
                        {"text": " • "},
                        {"text": "Artist B", "navigationEndpoint": {"browseEndpoint": {"browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}}}}
                    ]}}},
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Album X"}]}}}
                ],
                "fixedColumns": [
                    {"musicResponsiveListItemFixedColumnRenderer": {"text": {"runs": [{"text": "3:45"}]}}}
                ],
                "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
                    {"url": "https://i.ytimg.com/vi/ID/small.jpg"},
                    {"url": "https://i.ytimg.com/vi/ID/hqdefault.jpg"}
                ]}}},
                "playlistItemData": {"videoId": video_id}
            }
        })
    }

    #[test]
    fn search_sources_parse_titles_artists_album_and_duration() {
        let body = json!({
            "contents": {"tabbedSearchResultsRenderer": {"tabs": [
                {"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
                    {"musicShelfRenderer": {"contents": [song_item("abcDEF12345", "Song One"), song_item("ZYXwvu98765", "Song Two")]}}
                ]}}}}
            ]}}
        });
        let sources = search_sources(&body);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "Song One");
        assert_eq!(sources[0].artists, vec!["Artist A", "Artist B"]);
        assert_eq!(sources[0].album, "Album X");
        assert_eq!(sources[0].duration, Some(225.0));
        assert_eq!(sources[0].key, "abcDEF12345");
        assert_eq!(sources[0].cover, "https://i.ytimg.com/vi/ID/hqdefault.jpg");
        assert_eq!(sources[0].payload_str("video_id"), "abcDEF12345");
        assert_eq!(sources[0].platform, Platform::Ytm);
    }

    #[test]
    fn watch_endpoint_is_a_video_id_fallback() {
        let item = json!({
            "musicResponsiveListItemRenderer": {
                "flexColumns": [
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "T"}]}}}
                ],
                "navigationEndpoint": {"watchEndpoint": {"videoId": "watchID12345"}}
            }
        });
        let source = song_source(&item).unwrap();
        assert_eq!(source.key, "watchID12345");
    }

    #[test]
    fn explicit_badge_does_not_mark_a_song_as_vip() {
        // VIP 是"会员/版权"语义；YouTube Music 的 E 标是脏标，不能混用
        let mut item = song_item("abcDEF12345", "T");
        item["musicResponsiveListItemRenderer"]["badges"] = json!([
            {"musicInlineBadgeRenderer": {"icon": {"iconType": "MUSIC_EXPLICIT_BADGE"}}}
        ]);
        assert!(!song_source(&item).unwrap().vip);
    }

    #[test]
    fn duration_text_parses_minutes_and_hours() {
        assert_eq!(parse_duration_text("3:45"), Some(225.0));
        assert_eq!(parse_duration_text("1:02:33"), Some(3753.0));
        assert_eq!(parse_duration_text("0:00"), None);
        assert_eq!(parse_duration_text("nope"), None);
    }

    #[test]
    fn audio_formats_only_keep_audio_mimes() {
        let player = json!({
            "streamingData": {"adaptiveFormats": [
                {"mimeType": "audio/mp4; codecs=\"opus\"", "bitrate": 131072, "url": "https://goo/a"},
                {"mimeType": "video/mp4; codecs=\"avc1\"", "bitrate": 999999, "url": "https://goo/v"},
                {"mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 70000, "signatureCipher": "s=SG&sp=sig&url=https%3A%2F%2Fgoo%2Fb"}
            ]}
        });
        let formats = audio_formats(&player);
        assert_eq!(formats.len(), 2);
        assert_eq!(formats[0].bitrate, 131_072);
        assert_eq!(formats[0].url.as_deref(), Some("https://goo/a"));
        assert_eq!(formats[1].mime, "audio/webm; codecs=\"opus\"");
    }

    #[test]
    fn quality_gradient_picks_the_best_meeting_the_floor() {
        let formats = vec![
            AudioFormat {
                bitrate: 70_000,
                mime: "audio/webm".into(),
                url: Some("lo".into()),
                cipher: String::new(),
            },
            AudioFormat {
                bitrate: 140_000,
                mime: "audio/mp4".into(),
                url: Some("mid".into()),
                cipher: String::new(),
            },
            AudioFormat {
                bitrate: 260_000,
                mime: "audio/mp4".into(),
                url: Some("hi".into()),
                cipher: String::new(),
            },
        ];
        assert_eq!(
            pick_format(&formats, Quality::Q128).url.as_deref(),
            Some("mid"),
            "128 档选离 128k 最近的"
        );
        assert_eq!(
            pick_format(&formats, Quality::Q320).url.as_deref(),
            Some("hi")
        );
        assert_eq!(
            pick_format(&formats, Quality::Flac).url.as_deref(),
            Some("hi"),
            "无无损档，对准会员上限"
        );
        let low_only = &formats[..1];
        assert_eq!(
            pick_format(low_only, Quality::Flac).url.as_deref(),
            Some("lo"),
            "只有低码率时就它"
        );
    }

    #[test]
    fn ext_follows_the_container() {
        let mp4 = AudioFormat {
            bitrate: 1,
            mime: "audio/mp4".into(),
            url: None,
            cipher: String::new(),
        };
        let webm = AudioFormat {
            bitrate: 1,
            mime: "audio/webm".into(),
            url: None,
            cipher: String::new(),
        };
        assert_eq!(ext_of(&mp4), "m4a");
        assert_eq!(ext_of(&webm), "webm");
    }

    #[test]
    fn unplayable_status_is_reported_with_reason() {
        let player = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "请登录"}});
        let error = ensure_playable(&player).unwrap_err().to_string();
        assert!(error.contains("请登录"), "{error}");
        assert!(ensure_playable(&json!({"playabilityStatus": {"status": "OK"}})).is_ok());
    }

    #[test]
    fn ytm_links_are_parsed_for_watch_and_playlist() {
        assert_eq!(
            parse_ytm_url("https://music.youtube.com/watch?v=abcDEF12345"),
            Some((ResolveKind::Song, "abcDEF12345".into()))
        );
        assert_eq!(
            parse_ytm_url("https://www.youtube.com/watch?v=abcDEF12345&list=PLxyz"),
            None
        );
        assert_eq!(parse_ytm_url("https://youtu.be/abcDEF12345?t=30"), None);
        assert_eq!(
            parse_ytm_url("https://youtube.com/shorts/abcDEF12345"),
            None
        );
        assert_eq!(
            parse_ytm_url("https://music.youtube.com/playlist?list=PLabc"),
            Some((ResolveKind::Playlist, "PLabc".into()))
        );
        assert_eq!(
            parse_ytm_url("https://example.com/watch?v=abcDEF12345"),
            None
        );
        assert_eq!(
            parse_ytm_url("https://music.youtube.com/watch?feature=share"),
            None
        );
    }

    #[test]
    fn browse_playlist_title_and_songs_are_extracted() {
        let body = json!({
            "header": {"musicDetailHeaderRenderer": {"title": {"runs": [{"text": "我的歌单"}]}}},
            "contents": {"singleColumnBrowseResultsRenderer": {"tabs": [
                {"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
                    {"musicPlaylistShelfRenderer": {"contents": [song_item("abcDEF12345", "Song One")]}}
                ]}}}}
            ]}}
        });
        let (title, sources) = playlist_from_browse(&body).unwrap();
        assert_eq!(title, "我的歌单");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].title, "Song One");
    }

    #[test]
    fn two_column_browse_layout_with_microformat_title_is_parsed() {
        // 2026 年网页端的真实布局：次栏放曲目 shelf，标题在 microformat
        let body = json!({
            "microformat": {"microformatDataRenderer": {"title": "Samurai Lofi"}},
            "contents": {"twoColumnBrowseResultsRenderer": {
                "tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
                    {"musicResponsiveHeaderRenderer": {"title": {"runs": [{"text": "Samurai Lofi"}]}}}
                ]}}}}],
                "secondaryContents": {"sectionListRenderer": {"contents": [
                    {"musicPlaylistShelfRenderer": {"contents": [
                        song_item("yY7iGa4t9-I", "SAMURAI"),
                        song_item("Zo3Ltf7rFkA", "Best of Asian")
                    ]}}
                ]}}
            }}
        });
        let (title, sources) = playlist_from_browse(&body).unwrap();
        assert_eq!(title, "Samurai Lofi");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "SAMURAI");
    }

    #[test]
    fn library_playlists_keep_likes_and_split_owned_from_collected() {
        let tile = |title: &str, key: &str, owned: bool| {
            let mut value = json!({
                "musicTwoRowItemRenderer": {
                    "title": {"runs": [{"text": title}]},
                    "subtitle": {"runs": [{"text": "1,234 首歌曲"}]},
                    "navigationEndpoint": {"watchEndpoint": {"playlistId": key}},
                    "thumbnailRenderer": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
                        {"url": "https://i.ytimg.com/small.jpg", "width": 120, "height": 120},
                        {"url": "https://i.ytimg.com/large.jpg", "width": 480, "height": 480}
                    ]}}}
                }
            });
            if owned {
                value["musicTwoRowItemRenderer"]["menu"] =
                    json!({"deletePlaylistEndpoint": {"playlistId": key}});
            }
            value
        };
        let body = json!({"items": [
            tile("喜欢的音乐", "LM", false),
            tile("我的列表", "PLMINE", true),
            tile("收藏列表", "PLTHEIRS", false),
            tile("重复项", "VLPLTHEIRS", false),
            tile("稍后再听", "VLSE", false)
        ]});
        let playlists = ytm_library_playlists(&body);
        assert_eq!(playlists.len(), 3);
        assert!(playlists[0].is_favorite);
        assert_eq!(playlists[0].origin, "favorite");
        assert_eq!(playlists[0].count, 1_234);
        assert_eq!(playlists[0].cover, "https://i.ytimg.com/large.jpg");
        assert_eq!(playlists[1].origin, "created");
        assert_eq!(playlists[2].origin, "collected");
    }

    #[test]
    fn playlist_header_count_does_not_merge_duration_digits() {
        let body = json!({
            "header": {"musicResponsiveHeaderRenderer": {
                "secondSubtitle": {"runs": [
                    {"text": "3 首歌曲"}, {"text": " • "}, {"text": "11 分钟"}
                ]}
            }}
        });
        assert_eq!(playlist_count_from_browse(&body), Some(3));
    }

    #[test]
    fn empty_browse_is_rejected() {
        assert!(playlist_from_browse(&json!({})).is_none());
    }
}
