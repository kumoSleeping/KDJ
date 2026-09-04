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
use kdj_core::models::{
    Account, AccountState, LyricText, Platform, QrSession, QrStateValue, Quality, ResolveKind,
    ResolveResponse, SongSource, StreamPlaylist, StreamPlaylistResponse,
};
use kdj_core::paths::render_filename;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;

use super::auth::{BrowserSession, YoutubeAuth};
use super::client::{is_auth_rejection, YtmClient, PLAYBACK_WEB_USER_AGENT};
use crate::net::{create_download_writer, host_is, AtomicDownload};
use crate::provider::{
    effective_limit, full_listing, no_login, str_field, unique_download_path, Capabilities,
    DownloadJob, MusicProvider, ProtectedPreviewCipher, ProtectedPreviewIdentity, ProviderContext,
};
use crate::tags;

const LABEL: &str = "YouTube Music";
const DISABLED_MESSAGE: &str = "未启用，在「下载」里打开开关";
const MAX_PLAYLIST_CONTINUATION_PAGES: usize = 512;
const PLAYLIST_SECTION_LISTS: [&str; 3] = [
    "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
     sectionListRenderer",
    "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/\
     sectionListRenderer",
    "/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer",
];
/// WEB_REMIX player 发下来的 GVS URL 不是普通公开文件地址。媒体 GET 必须保持
/// 同一 Music origin / referer / client UA；遗漏这些头时 player 请求本身成功，
/// 随后的试听和下载却都会在 googlevideo 上变成 403。
pub fn gvs_playback_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN-US,zh-CN;q=0.9")
        .header(reqwest::header::ORIGIN, "https://music.youtube.com")
        .header(reqwest::header::REFERER, "https://music.youtube.com/")
        .header(reqwest::header::USER_AGENT, PLAYBACK_WEB_USER_AGENT)
}
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

fn stream_source_from_prepared_url(url: &str) -> Result<StreamSource> {
    let parsed = url::Url::parse(url).context("YouTube Music 播放流 URL 无效")?;
    let mime = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "mime").then(|| value.into_owned()))
        .unwrap_or_default();
    anyhow::ensure!(mime.starts_with("audio/"), "YouTube Music 播放流不是音频");
    let ext = if mime.contains("webm") { "webm" } else { "m4a" };
    Ok(StreamSource::Direct {
        url: url.to_string(),
        ext: ext.to_string(),
    })
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

    pub async fn validate_browser_session(&self, session: &BrowserSession) -> Result<()> {
        self.client.validate_browser_session(session).await
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
                pick_lowest_format(&formats)
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
        let (title, sources) = self
            .playlist_sources(playlist_id, limit)
            .await
            .context("读取 YouTube Music 歌单失败")?;
        anyhow::ensure!(!sources.is_empty(), "YouTube Music 歌单里没有可用歌曲");
        Ok((title, sources))
    }

    /// 拉完整歌单：首屏 browse + 2025 续页 token，直到达到 limit 或没有下一页。
    /// 与普通 YouTube `playlist_sources` / ytmusicapi `get_continuations_2025` 对齐。
    async fn playlist_sources(
        &self,
        playlist_id: &str,
        limit: usize,
    ) -> Result<(String, Vec<SongSource>)> {
        let body = self
            .client
            .browse(&format!("VL{playlist_id}"))
            .await
            .context("读取 YouTube Music 歌单失败")?;
        let (title, mut sources) = playlist_contents_from_browse(&body);
        if sources.len() > limit {
            sources.truncate(limit);
        }
        let mut continuation = playlist_continuation_token(&body);
        let mut seen_tokens = std::collections::HashSet::new();
        let mut page_count = 0usize;
        while sources.len() < limit {
            let Some(token) = continuation.take() else {
                break;
            };
            if !seen_tokens.insert(token.clone()) {
                break;
            }
            anyhow::ensure!(
                page_count < MAX_PLAYLIST_CONTINUATION_PAGES,
                "YouTube Music 歌单续页数量异常"
            );
            page_count += 1;
            let page = self
                .client
                .browse_continuation(&token)
                .await
                .context("继续读取 YouTube Music 歌单失败")?;
            let before = sources.len();
            sources.extend(songs_from_continuation_page(&page));
            if sources.len() > limit {
                sources.truncate(limit);
            }
            continuation = playlist_continuation_token(&page);
            if sources.len() == before && continuation.is_none() {
                break;
            }
        }
        Ok((title, sources))
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

    /// 播放 API 的 Opus 装在 WebM 容器里。WebM 在曲库中会被当成视频，而且
    /// 常见 DJ 软件无法写封面；无损重封装成 Ogg Opus 后再走统一标签链路。
    async fn remux_webm_opus(&self, input: &std::path::Path, job: &DownloadJob<'_>) -> Result<()> {
        anyhow::ensure!(
            crate::ffmpeg::available(),
            "需要 FFmpeg 才能整理 WebM 音频格式"
        );
        let converted =
            input.with_extension(format!("ytm-opus-{:016x}.partial", rand::random::<u64>()));
        let log_path = self.ctx.data_dir.join("ytm-audio-ffmpeg.log");
        let args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input.to_string_lossy().into_owned(),
            "-vn".to_string(),
            "-map".to_string(),
            "0:a:0".to_string(),
            "-c:a".to_string(),
            "copy".to_string(),
            "-f".to_string(),
            "opus".to_string(),
            converted.to_string_lossy().into_owned(),
        ];
        if let Err(error) = crate::ffmpeg::run(&args, &log_path, &job.cancel).await {
            let _ = tokio::fs::remove_file(&converted).await;
            return Err(error).context("整理 YouTube Music Opus 音频失败");
        }
        job.check_canceled()?;
        tokio::fs::remove_file(input)
            .await
            .context("移除 YouTube Music WebM 临时文件失败")?;
        if let Err(error) = tokio::fs::rename(&converted, input).await {
            let _ = tokio::fs::remove_file(&converted).await;
            return Err(error).context("提交 YouTube Music Opus 音频失败");
        }
        Ok(())
    }

    async fn consume_prepared_spool(
        &self,
        source: &std::path::Path,
        destination: &std::path::Path,
        job: &DownloadJob<'_>,
    ) -> Result<()> {
        let source = tokio::fs::canonicalize(source)
            .await
            .context("受保护媒体会话文件不存在")?;
        let allowed = tokio::fs::canonicalize(self.ctx.data_dir.join("media-spool"))
            .await
            .context("受保护媒体会话目录不存在")?;
        anyhow::ensure!(
            source.starts_with(&allowed)
                && source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("ytm-")),
            "拒绝读取媒体会话目录之外的文件"
        );
        let total = tokio::fs::metadata(&source)
            .await
            .context("读取媒体会话文件信息失败")?
            .len();
        job.check_canceled()?;
        if tokio::fs::rename(&source, destination).await.is_ok() {
            return Ok(());
        }
        let result: Result<()> = async {
            let mut input = tokio::fs::File::open(&source)
                .await
                .context("打开媒体会话文件失败")?;
            let mut output = create_download_writer(destination)
                .await
                .context("创建下载临时文件失败")?;
            let mut copied = 0_u64;
            let mut buffer = vec![0_u8; 256 * 1024];
            // 网络落盘阶段已经通过统一队列上报到 100%；这里是跨文件系统时的本地
            // 搬运，不能再把进度倒回 0 并伪装成第二次下载。
            loop {
                job.check_canceled()?;
                let read = tokio::io::AsyncReadExt::read(&mut input, &mut buffer)
                    .await
                    .context("读取媒体会话文件失败")?;
                if read == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..read])
                    .await
                    .context("写入下载临时文件失败")?;
                copied += read as u64;
            }
            anyhow::ensure!(copied == total, "媒体会话文件复制不完整");
            output.flush().await.context("提交下载缓冲失败")?;
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(&source).await;
        result
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
        Capabilities {
            external_download_preparation: true,
            ..Capabilities::MUSIC
        }
    }

    async fn account(&self) -> Account {
        let mut account = self.cached_account().await;
        if account.state != AccountState::Valid {
            return account;
        }
        match self.client.library_playlists().await {
            Ok(_) => {
                if let Ok(body) = self.client.account_menu().await {
                    if let Some(name) = first_text(&body, &["accountName", "name"]) {
                        account.nickname = name;
                    }
                }
                account
            }
            Err(error) if is_auth_rejection(&error) => {
                account.state = AccountState::Expired;
                account.detail = "登录已失效，请重新连接".into();
                account
            }
            Err(error) => {
                account.state = AccountState::Unknown;
                account.detail = format!("登录态检查失败：{error:#}")
                    .chars()
                    .take(160)
                    .collect();
                account
            }
        }
    }

    async fn cached_account(&self) -> Account {
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
        account.account_key = session.x_goog_authuser;
        account.state = AccountState::Valid;
        account.credential_kind = "browser_session".into();
        account.detail = session.imported_from;
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        no_login::create_qr(LABEL)
    }

    async fn poll_qr(&self, _session_id: &str) -> Result<(QrStateValue, String)> {
        Ok(no_login::poll_qr(LABEL))
    }

    async fn logout(&self) -> Result<()> {
        self.auth.clear()?;
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
        // 目录响应没有「赞过的音乐」数量时保持未知/0；不能为了侧栏数字再打一条
        // browse。用户真正打开该列表时才读取内容。
        Ok(ytm_library_playlists(&body))
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
        let limit = full_listing(limit);
        let (title, sources) = self.playlist_sources(key, limit).await?;
        Ok(Some(StreamPlaylistResponse {
            platform: Platform::Ytm,
            key: key.to_string(),
            title,
            sources,
        }))
    }

    async fn remove_stream_playlist_track(&self, key: &str, source: &SongSource) -> Result<()> {
        anyhow::ensure!(self.auth.is_logged_in(), "请先连接 YouTube Music 登录态");
        anyhow::ensure!(
            source.platform == Platform::Ytm,
            "歌曲来源不是 YouTube Music"
        );
        let playlist_id = key.trim().trim_start_matches("VL");
        let video_id = source.key.trim();
        anyhow::ensure!(!playlist_id.is_empty(), "YouTube Music 歌单 ID 为空");
        anyhow::ensure!(!video_id.is_empty(), "YouTube Music 歌曲 ID 为空");

        // 目录回包里的编辑/删除 endpoint 是当前账号是否拥有歌单的权威信号。
        let playlists = self.stream_playlists().await?;
        let target = playlists
            .iter()
            .find(|playlist| playlist.key == playlist_id)
            .context("当前账号的目录里没有这个 YouTube Music 歌单")?;
        let response = if playlist_id == "LM" && target.origin == "favorite" {
            self.client.remove_song_like(video_id).await?
        } else {
            anyhow::ensure!(
                target.origin == "created",
                "收藏的他人歌单不能移除其中的歌曲"
            );
            let set_video_id = source
                .payload
                .get("set_video_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .context("YouTube Music 歌单项缺少 setVideoId，请刷新歌单后重试")?;
            self.client
                .remove_playlist_item(playlist_id, video_id, set_video_id)
                .await?
        };
        if let Some(status) = response.get("status").and_then(Value::as_str) {
            anyhow::ensure!(
                status.contains("SUCCEEDED"),
                "YouTube Music 移除歌曲失败：{status}"
            );
        }
        Ok(())
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
        po_token: Option<&str>,
        identity: &ProtectedPreviewIdentity,
        player_url: &str,
        signature_timestamp: u64,
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
                signature_timestamp,
            )
            .await?;
        ensure_playable(&player)?;
        let formats = audio_formats(&player);
        anyhow::ensure!(
            formats.iter().any(native_playback_format),
            "YouTube Music 播放 API 没有返回 KDJ 可解码的 AAC 音频流"
        );
        let format = (!formats.is_empty()).then(|| pick_format(&formats, quality));
        let Some(format) = format else {
            bail!("YouTube Music 没有返回可签名的音频流");
        };
        anyhow::ensure!(
            !format.cipher.is_empty(),
            "YouTube Music Web player 没有返回 signatureCipher"
        );
        // The response's assets.js is the authoritative decipher program for this exact Player
        // response. It normally matches the requested script; if YouTube rolls the player between
        // the homepage and this request, return the new trusted URL as part of the same path.
        let response_player_url = player.pointer("/assets/js").and_then(Value::as_str);
        let player_url = self
            .client
            .protected_player_url(response_player_url.or(Some(player_url)))
            .await?;
        let sabr_url = player
            .pointer("/streamingData/serverAbrStreamingUrl")
            .and_then(Value::as_str)
            .map(str::to_string);
        let video_playback_ustreamer_config = player
            .pointer(
                "/playerConfig/mediaCommonConfig/mediaUstreamerRequestConfig/videoPlaybackUstreamerConfig",
            )
            .and_then(Value::as_str)
            .map(str::to_string);
        let sabr_formats = player
            .pointer("/streamingData/adaptiveFormats")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let duration_ms = player
            .pointer("/videoDetails/lengthSeconds")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|seconds| seconds.checked_mul(1000))
            .or_else(|| {
                sabr_formats.iter().find_map(|format| {
                    format
                        .get("approxDurationMs")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<u64>().ok())
                })
            })
            .unwrap_or_default();
        Ok(Some(ProtectedPreviewCipher {
            signature_cipher: format.cipher.clone(),
            player_url,
            sabr_url,
            video_playback_ustreamer_config,
            sabr_formats,
            sabr_audio_itag: format.itag,
            duration_ms,
        }))
    }

    async fn protected_preview_player_url(&self) -> Result<Option<String>> {
        Ok(Some(self.client.protected_player_url(None).await?))
    }

    async fn protected_preview_player_script(&self, player_url: &str) -> Result<Option<String>> {
        Ok(Some(self.client.protected_player_script(player_url).await?))
    }

    async fn protected_preview_identity(&self) -> Result<Option<ProtectedPreviewIdentity>> {
        Ok(Some(self.client.protected_web_identity().await?))
    }

    async fn lyric(&self, key: &str) -> Result<Option<LyricText>> {
        let video_id = key.trim();
        if video_id.is_empty() || !looks_like_video_id(video_id) {
            return Ok(None);
        }
        let next = self
            .client
            .next_watch(video_id)
            .await
            .context("请求 YouTube Music 歌词入口失败")?;
        let Some(browse_id) = lyrics_browse_id(&next) else {
            return Ok(None);
        };
        // 先走 Android Music：只有移动端会给逐行时间戳。
        if let Ok(body) = self.client.browse_android_music(browse_id).await {
            if let Some(text) = lyric_text_from_browse(&body) {
                return Ok(Some(text));
            }
        }
        // 回退网页端：通常只有纯文本（LyricFind / Musixmatch 说明页）。
        let body = self
            .client
            .browse(browse_id)
            .await
            .context("读取 YouTube Music 歌词失败")?;
        Ok(lyric_text_from_browse(&body))
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        self.ensure_enabled()?;
        job.check_canceled()?;
        let source = job.source;
        Self::video_id(source)?;
        // iOS 裸直链现在普遍要求 GVS PO Token。桌面队列优先使用 WebView 在点击
        // “开始”时通过同一播放 API 生成的新鲜 URL；没有 WebView 的调用方仍保留
        // 旧解析路径作为兼容回退。
        let stream = match job.prepared_source_url {
            Some(url) => stream_source_from_prepared_url(url)?,
            None => bail!("YouTube Music 下载流尚未就绪，请重试"),
        };
        job.check_canceled()?;

        let remux_webm = matches!(&stream, StreamSource::Direct { ext, .. } if ext == "webm");
        let ext = match &stream {
            StreamSource::Direct { .. } if remux_webm => "opus".to_string(),
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
                let parsed = url::Url::parse(&url).context("YouTube Music 播放流 URL 无效")?;
                if parsed.scheme() == "file" {
                    let source = parsed
                        .to_file_path()
                        .map_err(|_| anyhow::anyhow!("媒体会话文件路径无效"))?;
                    self.consume_prepared_spool(&source, guard.partial(), &job)
                        .await?;
                } else {
                    // 与试听代理使用同样的裸 reqwest client。不要复用 InnerTube client
                    // 上伪装的 Chrome UA：GVS URL/PO Token 来自当前 WebView 播放会话，
                    // 下载请求必须保持播放链路的请求身份与重定向策略。
                    kdj_core::ensure_rustls_ring();
                    let playback_http = reqwest::Client::builder()
                        .redirect(reqwest::redirect::Policy::limited(5))
                        .build()
                        .context("创建 YouTube Music 播放流客户端失败")?;
                    let mut file = create_download_writer(guard.partial())
                        .await
                        .context("创建下载临时文件失败")?;
                    let mut downloaded = 0u64;
                    let mut expected_total = 0u64;
                    // GVS 会主动把大文件切成多个 206；像播放缓存一样按 Content-Range
                    // 续拉，不能把第一段 EOF 当成整首完成。
                    for _ in 0..2048 {
                        let mut response = gvs_playback_request(&playback_http, &url)
                            .header(reqwest::header::RANGE, gvs_download_range(downloaded))
                            .send()
                            .await
                            .context("YouTube Music 音频下载失败")?;
                        if response.status() == reqwest::StatusCode::FORBIDDEN {
                            bail!("YouTube Music GVS 拒绝下载请求（403），播放授权可能已失效");
                        }
                        let status = response.status();
                        let segment =
                            direct_response_segment(status, response.headers(), downloaded)?;
                        if expected_total > 0
                            && segment.total > 0
                            && expected_total != segment.total
                        {
                            bail!("YouTube Music 音频总长度在续传时发生变化");
                        }
                        expected_total = expected_total.max(segment.total);
                        job.report(downloaded, expected_total);
                        let segment_start = downloaded;
                        while let Some(chunk) =
                            response.chunk().await.context("YouTube Music 音频流中断")?
                        {
                            job.check_canceled()?;
                            file.write_all(&chunk).await.context("写入下载文件失败")?;
                            downloaded += chunk.len() as u64;
                            job.report(downloaded, expected_total.max(downloaded));
                        }
                        if segment.total == 0 || downloaded >= segment.total {
                            break;
                        }
                        anyhow::ensure!(
                            downloaded > segment_start
                                && downloaded == segment.end.saturating_add(1),
                            "YouTube Music 音频分段不连续"
                        );
                    }
                    anyhow::ensure!(
                        expected_total == 0 || downloaded == expected_total,
                        "YouTube Music 音频没有完整下载"
                    );
                    file.flush().await.context("提交下载缓冲失败")?;
                    drop(file);
                }
            }
            StreamSource::Hls { url } => {
                self.download_hls(&url, guard.partial(), &job).await?;
            }
        }
        if remux_webm {
            self.remux_webm_opus(guard.partial(), &job).await?;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectResponseSegment {
    end: u64,
    total: u64,
}

fn direct_response_segment(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    requested_start: u64,
) -> Result<DirectResponseSegment> {
    if status == reqwest::StatusCode::OK {
        anyhow::ensure!(
            requested_start == 0,
            "YouTube Music 续传请求被错误地从头返回"
        );
        let total = headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        return Ok(DirectResponseSegment {
            end: total.saturating_sub(1),
            total,
        });
    }
    anyhow::ensure!(
        status == reqwest::StatusCode::PARTIAL_CONTENT,
        "YouTube Music 音频请求返回 {status}"
    );
    let raw = headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .context("YouTube Music 音频分段缺少 Content-Range")?;
    let value = raw
        .trim()
        .strip_prefix("bytes ")
        .context("YouTube Music Content-Range 无效")?;
    let (span, total) = value
        .split_once('/')
        .context("YouTube Music Content-Range 无效")?;
    let (start, end) = span
        .split_once('-')
        .context("YouTube Music Content-Range 无效")?;
    let start = start.parse::<u64>().context("YouTube Music 分段起点无效")?;
    let end = end.parse::<u64>().context("YouTube Music 分段终点无效")?;
    let total = total
        .parse::<u64>()
        .context("YouTube Music 音频总长度无效")?;
    anyhow::ensure!(
        start == requested_start && start <= end && end < total,
        "YouTube Music 音频分段范围不连续"
    );
    Ok(DirectResponseSegment { end, total })
}

fn gvs_download_range(start: u64) -> String {
    format!("bytes={start}-")
}

// ---------------------------------------------------------------- 流与音质

#[derive(Debug, Clone)]
struct AudioFormat {
    itag: u32,
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
                    itag: format
                        .get("itag")
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or_default(),
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
    // 当前原生解码器支持 MP4/AAC，但 Symphonia 0.5 没有 Opus decoder。WebM/Opus
    // 即使网络响应完全正常也会报 unsupported audio format；播放 API 同时提供 AAC
    // 时必须优先 AAC。下载复用同一选择，最终文件也才能直接进入 KDJ/DJ 软件。
    let has_native_format = formats.iter().any(native_playback_format);
    formats
        .iter()
        .filter(|format| !has_native_format || native_playback_format(format))
        .min_by_key(|format| ((format.bitrate - target).abs(), -format.bitrate))
        .expect("调用方已确认非空")
}

fn pick_lowest_format(formats: &[AudioFormat]) -> &AudioFormat {
    let has_native_format = formats.iter().any(native_playback_format);
    formats
        .iter()
        .filter(|format| !has_native_format || native_playback_format(format))
        .filter(|format| format.bitrate > 0)
        .min_by_key(|format| format.bitrate)
        .or_else(|| {
            formats
                .iter()
                .find(|format| !has_native_format || native_playback_format(format))
        })
        .expect("调用方已确认非空")
}

fn native_playback_format(format: &AudioFormat) -> bool {
    let mime = format.mime.to_ascii_lowercase();
    (mime.starts_with("audio/mp4") && !mime.contains("opus")) || mime.starts_with("audio/mpeg")
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

fn item_set_video_id(item: &Value) -> Option<String> {
    fn find(value: &Value) -> Option<&str> {
        match value {
            Value::Object(map) => {
                for key in ["playlistSetVideoId", "setVideoId"] {
                    if let Some(text) = map
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        return Some(text);
                    }
                }
                map.values().find_map(find)
            }
            Value::Array(items) => items.iter().find_map(find),
            _ => None,
        }
    }
    find(item).map(str::to_string)
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
    if let Some(set_video_id) = item_set_video_id(item) {
        payload.insert("set_video_id".into(), json!(set_video_id));
    }
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

#[cfg(test)]
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
/// 从 browse / 续页 JSON 里取出下一页 token。
///
/// 同一份 browse 里经常**同时**存在两种 token：
/// 1. 曲目列表末尾的 `continuationItemRenderer`（2025 / ytmusicapi
///    `get_continuations_2025`）→ 响应走 `onResponseReceivedActions`
/// 2. `sectionListRenderer.continuations` 老字段 → 响应走 `continuationContents`
///
/// 深度优先时会先撞上 (2)，续页却解析不出新曲目，歌单就卡在首屏 ~100 首。
/// 因此**必须优先**用 shelf 尾的 2025 token；找不到再退回老 `continuations`。
fn playlist_continuation_token(value: &Value) -> Option<String> {
    playlist_tail_continuation_token(value).or_else(|| playlist_legacy_continuation_token(value))
}

fn continuation_from_items(items: Option<&Vec<Value>>) -> Option<String> {
    items?.last().and_then(continuation_token_from_item)
}

struct TrackShelves<'a> {
    shelves: Vec<&'a Value>,
    /// `musicPlaylistShelfRenderer` 是歌单曲目的权威容器。只要响应里出现它，
    /// 同级的通用 `musicShelfRenderer` 就是推荐等附属内容，不能混进歌单。
    explicit: bool,
}

fn preferred_track_shelves<'a>(sections: impl IntoIterator<Item = &'a Value>) -> TrackShelves<'a> {
    let mut playlist = Vec::new();
    let mut fallback = Vec::new();
    for section in sections {
        if let Some(shelf) = section.get("musicPlaylistShelfRenderer") {
            playlist.push(shelf);
        } else if let Some(shelf) = section
            .get("musicShelfRenderer")
            .or_else(|| section.get("itemSectionRenderer"))
        {
            fallback.push(shelf);
        }
    }
    if playlist.is_empty() {
        TrackShelves {
            shelves: fallback,
            explicit: false,
        }
    } else {
        TrackShelves {
            shelves: playlist,
            explicit: true,
        }
    }
}

fn browse_track_shelves(value: &Value) -> TrackShelves<'_> {
    let mut sections = Vec::new();
    for pointer in PLAYLIST_SECTION_LISTS {
        let Some(items) = value
            .pointer(pointer)
            .and_then(|section_list| section_list.get("contents"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        sections.extend(items);
    }
    preferred_track_shelves(sections)
}

/// 只从真正交给歌曲解析器的列表尾部读取 2025 continuation。
/// 响应里可能还有推荐、搜索建议等其它货架，它们的 token 不能用于歌单翻页。
fn playlist_tail_continuation_token(value: &Value) -> Option<String> {
    let browse_shelves = browse_track_shelves(value);
    for shelf in &browse_shelves.shelves {
        if let Some(token) =
            continuation_from_items(shelf.get("contents").and_then(Value::as_array))
        {
            return Some(token);
        }
    }
    // 显式歌单 shelf 已经给出了曲目范围；它没有尾 token 就代表曲目到此结束。
    // 外层 sectionList 的 token 可能打开「推荐歌曲」，不能继续向下泛搜。
    if browse_shelves.explicit {
        return None;
    }

    if let Some(actions) = value
        .get("onResponseReceivedActions")
        .and_then(Value::as_array)
    {
        for action in actions {
            if let Some(token) = continuation_from_items(
                action
                    .pointer("/appendContinuationItemsAction/continuationItems")
                    .and_then(Value::as_array),
            ) {
                return Some(token);
            }
        }
    }

    let contents = value.get("continuationContents")?.as_object()?;
    for (kind, node) in contents {
        if kind == "sectionListContinuation" {
            let Some(sections) = node.get("contents").and_then(Value::as_array) else {
                continue;
            };
            let continuation_shelves = preferred_track_shelves(sections);
            for shelf in &continuation_shelves.shelves {
                if let Some(token) =
                    continuation_from_items(shelf.get("contents").and_then(Value::as_array))
                {
                    return Some(token);
                }
            }
            if continuation_shelves.explicit {
                return None;
            }
        } else if matches!(
            kind.as_str(),
            "musicPlaylistShelfContinuation" | "musicShelfContinuation"
        ) {
            if let Some(token) =
                continuation_from_items(node.get("contents").and_then(Value::as_array))
            {
                return Some(token);
            }
        }
    }
    None
}

fn legacy_continuation_from_node(node: &Value) -> Option<String> {
    node.get("continuations")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|item| {
            item.pointer("/nextContinuationData/continuation")
                .or_else(|| item.pointer("/nextRadioContinuationData/continuation"))
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
        })
        .map(str::to_string)
}

/// 老布局同样只看歌单 section/shelf 自己的 `continuations`，不扫描整份响应。
fn playlist_legacy_continuation_token(value: &Value) -> Option<String> {
    let browse_shelves = browse_track_shelves(value);
    for shelf in &browse_shelves.shelves {
        if let Some(token) = legacy_continuation_from_node(shelf) {
            return Some(token);
        }
    }
    // 当前网页会把「推荐歌曲」放在 sectionList 的续页里。显式歌单 shelf
    // 没有自己的 continuation 时，外层 continuation 不是歌单分页。
    if browse_shelves.explicit {
        return None;
    }

    for pointer in PLAYLIST_SECTION_LISTS {
        let Some(section_list) = value.pointer(pointer) else {
            continue;
        };
        if let Some(token) = legacy_continuation_from_node(section_list) {
            return Some(token);
        }
    }

    let contents = value.get("continuationContents")?.as_object()?;
    for (kind, node) in contents {
        if kind == "sectionListContinuation" {
            let Some(sections) = node.get("contents").and_then(Value::as_array) else {
                continue;
            };
            let continuation_shelves = preferred_track_shelves(sections);
            for shelf in &continuation_shelves.shelves {
                if let Some(token) = legacy_continuation_from_node(shelf) {
                    return Some(token);
                }
            }
            if continuation_shelves.explicit {
                return None;
            }
            if let Some(token) = legacy_continuation_from_node(node) {
                return Some(token);
            }
        } else if matches!(
            kind.as_str(),
            "musicPlaylistShelfContinuation" | "musicShelfContinuation"
        ) {
            if let Some(token) = legacy_continuation_from_node(node) {
                return Some(token);
            }
        }
    }
    None
}

fn continuation_token_from_item(item: &Value) -> Option<String> {
    const PATHS: [&str; 3] = [
        "/continuationItemRenderer/continuationEndpoint/continuationCommand/token",
        "/continuationItemRenderer/continuationEndpoint/commandExecutorCommand/commands",
        "/continuationItemViewModel/continuationCommand/innertubeCommand/continuationCommand/token",
    ];
    if let Some(token) = item
        .pointer(PATHS[0])
        .or_else(|| item.pointer(PATHS[2]))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
    {
        return Some(token.to_string());
    }
    let commands = item.pointer(PATHS[1]).and_then(Value::as_array)?;
    for command in commands {
        let request = command
            .pointer("/continuationCommand/request")
            .and_then(Value::as_str);
        if request == Some("CONTINUATION_REQUEST_TYPE_BROWSE")
            || command.pointer("/continuationCommand/token").is_some()
        {
            if let Some(token) = command
                .pointer("/continuationCommand/token")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
            {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// 续页响应：
/// - 2025：`onResponseReceivedActions[].appendContinuationItemsAction.continuationItems`
/// - 老 token：`continuationContents.*(musicPlaylistShelfContinuation|…)`
fn songs_from_continuation_page(page: &Value) -> Vec<SongSource> {
    let mut sources = Vec::new();
    if let Some(actions) = page
        .get("onResponseReceivedActions")
        .and_then(Value::as_array)
    {
        for action in actions {
            if let Some(items) = action
                .pointer("/appendContinuationItemsAction/continuationItems")
                .and_then(Value::as_array)
            {
                sources.extend(items.iter().filter_map(song_source));
            }
        }
    }
    if sources.is_empty() {
        sources.extend(songs_from_continuation_contents(page));
    }
    if sources.is_empty() {
        // 少数响应仍包一层 shelf / sectionListContinuation，退回通用解析。
        let (_, fallback) = playlist_contents_from_browse(page);
        sources = fallback;
    }
    sources
}

/// 老续页：`continuationContents` 下的 shelf / sectionList continuation。
fn songs_from_continuation_contents(page: &Value) -> Vec<SongSource> {
    let Some(contents) = page.get("continuationContents").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    for (key, node) in contents {
        if key == "sectionListContinuation" {
            let Some(sections) = node.get("contents").and_then(Value::as_array) else {
                continue;
            };
            let continuation_shelves = preferred_track_shelves(sections);
            for shelf in continuation_shelves.shelves {
                let Some(shelf_items) =
                    shelf.get("contents").and_then(Value::as_array).or_else(|| {
                        shelf
                            .pointer("/contents/0/musicPlaylistShelfRenderer/contents")
                            .and_then(Value::as_array)
                    })
                else {
                    continue;
                };
                sources.extend(shelf_items.iter().filter_map(song_source));
            }
            continue;
        }
        // musicPlaylistShelfContinuation / musicShelfContinuation 等：contents 直接是曲目
        if matches!(
            key.as_str(),
            "musicPlaylistShelfContinuation" | "musicShelfContinuation"
        ) {
            if let Some(items) = node.get("contents").and_then(Value::as_array) {
                sources.extend(items.iter().filter_map(song_source));
            }
        }
    }
    sources
}

/// 布局随客户端形态在变：老版是 `singleColumnBrowseResultsRenderer`，
/// 现在网页端是 `twoColumnBrowseResultsRenderer`（主栏放标题头、
/// 次栏放曲目 shelf）。三处位置都检查，但显式 playlist shelf 一旦存在就排除
/// 通用 music shelf（后者通常是推荐歌曲）；标题带 microformat 兜底。
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

    let mut sources = Vec::new();
    for shelf in browse_track_shelves(body).shelves {
        let Some(items) = shelf.get("contents").and_then(Value::as_array) else {
            continue;
        };
        sources.extend(items.iter().filter_map(song_source));
    }
    (title, sources)
}

// ---------------------------------------------------------------- 歌词

/// `next` 响应里的歌词页 browseId（`MPLYt…`）。
/// 不跳过 `unselectable`：部分曲目 UI 先灰掉歌词 tab，但 browseId 仍可用。
fn lyrics_browse_id(next: &Value) -> Option<&str> {
    let tabs = next
        .pointer(
            "/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/\
             watchNextTabbedResultsRenderer/tabs",
        )
        .and_then(Value::as_array)?;
    for tab in tabs {
        let page = tab
            .pointer(
                "/tabRenderer/endpoint/browseEndpoint/\
                 browseEndpointContextSupportedConfigs/\
                 browseEndpointContextMusicConfig/pageType",
            )
            .and_then(Value::as_str);
        if page != Some("MUSIC_PAGE_TYPE_TRACK_LYRICS") {
            continue;
        }
        if let Some(browse_id) = tab
            .pointer("/tabRenderer/endpoint/browseEndpoint/browseId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return Some(browse_id);
        }
    }
    None
}

fn lyric_text_from_browse(body: &Value) -> Option<LyricText> {
    if let Some(lrc) = timed_lrc_from_browse(body) {
        return Some(LyricText {
            lrc,
            word_lrc: String::new(),
            translated_lrc: String::new(),
            romaji_lrc: String::new(),
        });
    }
    let plain = plain_lyrics_from_browse(body)?;
    // 无时间轴时按行落成 00:00.00，至少能进面板；真正卡拉 OK 仍依赖 timed 路径。
    let lrc = plain
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| format!("[00:00.00]{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    if lrc.is_empty() {
        return None;
    }
    Some(LyricText {
        lrc,
        word_lrc: String::new(),
        translated_lrc: String::new(),
        romaji_lrc: String::new(),
    })
}

fn timed_lrc_from_browse(body: &Value) -> Option<String> {
    let lines = body
        .pointer(
            "/contents/elementRenderer/newElement/type/componentType/model/\
             timedLyricsModel/lyricsData/timedLyricsData",
        )
        .and_then(Value::as_array)?;
    let mut out = Vec::new();
    for line in lines {
        let text = line
            .get("lyricLine")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        // ♪ 是器乐间奏占位，LRC 解析会丢掉空正文，这里直接跳过。
        if text.is_empty() || text == "♪" {
            continue;
        }
        let start_ms = line
            .pointer("/cueRange/startTimeMilliseconds")
            .and_then(parse_millis)?;
        out.push(format!("{}{text}", format_lrc_stamp(start_ms)));
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("\n"))
    }
}

fn plain_lyrics_from_browse(body: &Value) -> Option<String> {
    // messageRenderer 常见于「Lyrics not available」，不当正文。
    if let Some(runs) = body
        .pointer("/contents/messageRenderer/text/runs")
        .and_then(Value::as_array)
    {
        let text = join_runs(runs);
        if text.is_empty() || text.eq_ignore_ascii_case("Lyrics not available") {
            return None;
        }
    }
    let sections = body
        .pointer("/contents/sectionListRenderer/contents")
        .and_then(Value::as_array)?;
    for section in sections {
        let runs = section
            .pointer("/musicDescriptionShelfRenderer/description/runs")
            .and_then(Value::as_array);
        if let Some(runs) = runs {
            let text = join_runs(runs);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn join_runs(runs: &[Value]) -> String {
    runs.iter()
        .filter_map(|run| run.get("text").and_then(Value::as_str))
        .collect::<String>()
}

fn parse_millis(value: &Value) -> Option<u64> {
    match value {
        Value::String(text) => text.parse().ok(),
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u64)
        }),
        _ => None,
    }
}

fn format_lrc_stamp(ms: u64) -> String {
    let total_cs = ms / 10;
    let minutes = total_cs / 6_000;
    let seconds = (total_cs % 6_000) / 100;
    let cs = total_cs % 100;
    format!("[{minutes:02}:{seconds:02}.{cs:02}]")
}

#[cfg(test)]
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

    #[test]
    fn completed_protected_spool_is_a_valid_prepared_audio_source() {
        let stream = stream_source_from_prepared_url(
            "file:///tmp/media-spool/ytm-test.m4a?mime=audio%2Fmp4",
        )
        .unwrap();
        assert!(matches!(
            stream,
            StreamSource::Direct { url, ext }
                if url.starts_with("file://") && ext == "m4a"
        ));
    }

    #[tokio::test]
    async fn completed_protected_spool_is_consumed_without_another_network_request() {
        let root = std::env::temp_dir().join(format!(
            "kdj-ytm-provider-spool-test-{:016x}",
            rand::random::<u64>()
        ));
        let data = root.join("data");
        let spool_dir = data.join("media-spool");
        let output_dir = root.join("output");
        tokio::fs::create_dir_all(&spool_dir).await.unwrap();
        tokio::fs::create_dir_all(&output_dir).await.unwrap();
        let spool = spool_dir.join("ytm-test.m4a");
        let destination = output_dir.join("song.partial");
        let expected = vec![7_u8; 512 * 1024];
        tokio::fs::write(&spool, &expected).await.unwrap();
        let ctx = ProviderContext::new(
            data,
            crate::provider::ProviderLiveSettings {
                download_dir: output_dir,
                filename_template: "{title}.{ext}".into(),
                default_quality: Quality::Q128,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: true,
                youtube_enabled: false,
                video_dir: None,
                video_format: "mp4".into(),
            },
        );
        let auth = Arc::new(YoutubeAuth::new(&ctx, Platform::Ytm).unwrap());
        let provider = YoutubeMusicProvider::new(ctx, auth).unwrap();
        let source = SongSource {
            platform: Platform::Ytm,
            key: "video".into(),
            title: "title".into(),
            artists: vec![],
            album: String::new(),
            duration: None,
            cover: String::new(),
            max_quality: None,
            vip: false,
            payload: Default::default(),
        };
        let job = DownloadJob::new(&source, Quality::Q128);

        provider
            .consume_prepared_spool(&spool, &destination, &job)
            .await
            .unwrap();

        assert_eq!(tokio::fs::read(&destination).await.unwrap(), expected);
        assert!(tokio::fs::metadata(&spool).await.is_err());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

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
    fn playlist_item_identity_is_kept_for_exact_remote_removal() {
        let mut item = song_item("abcDEF12345", "T");
        item["musicResponsiveListItemRenderer"]["playlistItemData"]["playlistSetVideoId"] =
            json!("SET-ITEM-42");
        let source = song_source(&item).unwrap();
        assert_eq!(source.payload_str("set_video_id"), "SET-ITEM-42");
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
                {"itag": 140, "mimeType": "audio/mp4; codecs=\"opus\"", "bitrate": 131072, "url": "https://goo/a"},
                {"mimeType": "video/mp4; codecs=\"avc1\"", "bitrate": 999999, "url": "https://goo/v"},
                {"itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 70000, "signatureCipher": "s=SG&sp=sig&url=https%3A%2F%2Fgoo%2Fb"}
            ]}
        });
        let formats = audio_formats(&player);
        assert_eq!(formats.len(), 2);
        assert_eq!(formats[0].itag, 140);
        assert_eq!(formats[0].bitrate, 131_072);
        assert_eq!(formats[0].url.as_deref(), Some("https://goo/a"));
        assert_eq!(formats[1].mime, "audio/webm; codecs=\"opus\"");
        assert_eq!(formats[1].itag, 251);
    }

    #[test]
    fn quality_gradient_picks_the_best_meeting_the_floor() {
        let formats = vec![
            AudioFormat {
                itag: 251,
                bitrate: 70_000,
                mime: "audio/webm".into(),
                url: Some("lo".into()),
                cipher: String::new(),
            },
            AudioFormat {
                itag: 140,
                bitrate: 140_000,
                mime: "audio/mp4".into(),
                url: Some("mid".into()),
                cipher: String::new(),
            },
            AudioFormat {
                itag: 141,
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
        let webm_closer = vec![
            AudioFormat {
                itag: 251,
                bitrate: 128_000,
                mime: "audio/webm; codecs=opus".into(),
                url: Some("opus".into()),
                cipher: String::new(),
            },
            AudioFormat {
                itag: 140,
                bitrate: 140_000,
                mime: "audio/mp4; codecs=mp4a.40.2".into(),
                url: Some("aac".into()),
                cipher: String::new(),
            },
        ];
        assert_eq!(
            pick_format(&webm_closer, Quality::Q128).url.as_deref(),
            Some("aac"),
            "原生播放/下载必须优先可解码的 AAC，不能因 Opus 更接近目标码率而选 WebM"
        );
        assert_eq!(
            pick_lowest_format(&webm_closer).url.as_deref(),
            Some("aac"),
            "最低码率试听同样不能选原生解码器不支持的 Opus"
        );
    }

    #[test]
    fn ext_follows_the_container() {
        let mp4 = AudioFormat {
            itag: 140,
            bitrate: 1,
            mime: "audio/mp4".into(),
            url: None,
            cipher: String::new(),
        };
        let webm = AudioFormat {
            itag: 251,
            bitrate: 1,
            mime: "audio/webm".into(),
            url: None,
            cipher: String::new(),
        };
        assert_eq!(ext_of(&mp4), "m4a");
        assert_eq!(ext_of(&webm), "webm");
    }

    #[test]
    fn prepared_playback_urls_keep_their_real_audio_container() {
        let webm = stream_source_from_prepared_url(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fwebm%3Bcodecs%3Dopus",
        )
        .unwrap();
        assert!(matches!(webm, StreamSource::Direct { ext, .. } if ext == "webm"));

        let m4a = stream_source_from_prepared_url(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=audio%2Fmp4%3Bcodecs%3Dmp4a.40.2",
        )
        .unwrap();
        assert!(matches!(m4a, StreamSource::Direct { ext, .. } if ext == "m4a"));
        assert!(stream_source_from_prepared_url(
            "https://rr1---sn.example.googlevideo.com/videoplayback?mime=video%2Fmp4"
        )
        .is_err());
    }

    #[test]
    fn direct_download_ranges_must_be_contiguous() {
        assert_eq!(gvs_download_range(0), "bytes=0-");
        assert_eq!(gvs_download_range(524288), "bytes=524288-");
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            "bytes 524288-1048575/2000000".parse().unwrap(),
        );
        assert_eq!(
            direct_response_segment(reqwest::StatusCode::PARTIAL_CONTENT, &headers, 524288)
                .unwrap(),
            DirectResponseSegment {
                end: 1048575,
                total: 2000000,
            }
        );
        assert!(
            direct_response_segment(reqwest::StatusCode::PARTIAL_CONTENT, &headers, 0).is_err()
        );

        let mut complete = reqwest::header::HeaderMap::new();
        complete.insert(reqwest::header::CONTENT_LENGTH, "1234".parse().unwrap());
        assert_eq!(
            direct_response_segment(reqwest::StatusCode::OK, &complete, 0).unwrap(),
            DirectResponseSegment {
                end: 1233,
                total: 1234,
            }
        );
        assert!(direct_response_segment(reqwest::StatusCode::OK, &complete, 10).is_err());
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
    fn playlist_continuation_token_is_read_from_shelf_tail() {
        let body = json!({
            "contents": {"twoColumnBrowseResultsRenderer": {"secondaryContents": {
                "sectionListRenderer": {"contents": [
                    {"musicPlaylistShelfRenderer": {"contents": [
                        song_item("aaaaaaaaaaa", "One"),
                        {"continuationItemRenderer": {"continuationEndpoint": {
                            "continuationCommand": {"token": "page-2"}
                        }}}
                    ]}}
                ]}
            }}}
        });
        assert_eq!(
            playlist_continuation_token(&body).as_deref(),
            Some("page-2")
        );
        let (_, sources) = playlist_contents_from_browse(&body);
        assert_eq!(sources.len(), 1, "续页项不能被当成歌曲");
    }

    #[test]
    fn nested_command_executor_continuation_token_is_parsed() {
        let item = json!({
            "continuationItemRenderer": {"continuationEndpoint": {
                "commandExecutorCommand": {"commands": [
                    {"playlistVotingRefreshPopupCommand": {}},
                    {"continuationCommand": {
                        "request": "CONTINUATION_REQUEST_TYPE_BROWSE",
                        "token": "nested-token"
                    }}
                ]}
            }}
        });
        assert_eq!(
            continuation_token_from_item(&item).as_deref(),
            Some("nested-token")
        );
    }

    #[test]
    fn continuation_page_songs_and_next_token_are_extracted() {
        let page = json!({
            "onResponseReceivedActions": [{
                "appendContinuationItemsAction": {"continuationItems": [
                    song_item("bbbbbbbbbbb", "Two"),
                    song_item("ccccccccccc", "Three"),
                    {"continuationItemRenderer": {"continuationEndpoint": {
                        "continuationCommand": {"token": "page-3"}
                    }}}
                ]}
            }]
        });
        let sources = songs_from_continuation_page(&page);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "Two");
        assert_eq!(sources[1].title, "Three");
        assert_eq!(
            playlist_continuation_token(&page).as_deref(),
            Some("page-3")
        );
    }

    #[test]
    fn shelf_tail_token_wins_over_section_list_continuations() {
        // 实况 browse：sectionListRenderer.continuations 与 shelf 尾
        // continuationItemRenderer 同时存在；必须取后者，否则续页卡在 100 首。
        let body = json!({
            "contents": {"twoColumnBrowseResultsRenderer": {"secondaryContents": {
                "sectionListRenderer": {
                    "contents": [
                        {"musicPlaylistShelfRenderer": {"contents": [
                            song_item("aaaaaaaaaaa", "One"),
                            {"continuationItemRenderer": {"continuationEndpoint": {
                                "continuationCommand": {"token": "tail-2025"}
                            }}}
                        ]}}
                    ],
                    "continuations": [{
                        "nextContinuationData": {"continuation": "legacy-section-token"}
                    }]
                }
            }}}
        });
        assert_eq!(
            playlist_continuation_token(&body).as_deref(),
            Some("tail-2025")
        );
    }

    #[test]
    fn section_list_recommendation_continuation_is_not_used_after_playlist_shelf() {
        // 当前网页的真实短歌单：曲目在显式 playlist shelf；外层 sectionList
        // continuation 打开的却是「推荐歌曲」。跟它会把推荐误追加到歌单。
        let body = json!({
            "header": {"continuationItemRenderer": {"continuationEndpoint": {
                "continuationCommand": {"token": "unrelated-header-token"}
            }}},
            "contents": {"twoColumnBrowseResultsRenderer": {"secondaryContents": {
                "sectionListRenderer": {
                    "contents": [
                        {"musicPlaylistShelfRenderer": {"contents": [
                            song_item("aaaaaaaaaaa", "One")
                        ]}}
                    ],
                    "continuations": [{
                        "nextContinuationData": {"continuation": "recommendations-token"}
                    }]
                }
            }}}
        });
        assert_eq!(playlist_continuation_token(&body), None);
    }

    #[test]
    fn legacy_section_continuations_used_when_no_item_renderer() {
        let body = json!({
            "contents": {"singleColumnBrowseResultsRenderer": {
                "tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {
                    "contents": [
                        {"musicShelfRenderer": {"contents": [song_item("aaaaaaaaaaa", "One")]}}
                    ],
                    "continuations": [{
                        "nextContinuationData": {"continuation": "legacy-only"}
                    }]
                }}}}]
            }}
        });
        assert_eq!(
            playlist_continuation_token(&body).as_deref(),
            Some("legacy-only")
        );
    }

    #[test]
    fn explicit_playlist_shelf_excludes_generic_recommendations() {
        let body = json!({
            "contents": {"twoColumnBrowseResultsRenderer": {
                "tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
                    {"musicShelfRenderer": {"contents": [
                        song_item("rrrrrrrrrrr", "Recommended")
                    ]}}
                ]}}}}],
                "secondaryContents": {"sectionListRenderer": {"contents": [
                    {"musicPlaylistShelfRenderer": {"contents": [
                        song_item("aaaaaaaaaaa", "One"),
                        song_item("bbbbbbbbbbb", "Two")
                    ]}}
                ]}}
            }}
        });
        let (_, sources) = playlist_contents_from_browse(&body);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "One");
        assert_eq!(sources[1].title, "Two");
    }

    #[test]
    fn continuation_contents_shelf_songs_are_extracted() {
        let page = json!({
            "continuationContents": {
                "musicPlaylistShelfContinuation": {
                    "contents": [
                        song_item("ddddddddddd", "Four"),
                        song_item("eeeeeeeeeee", "Five"),
                        {"continuationItemRenderer": {"continuationEndpoint": {
                            "continuationCommand": {"token": "legacy-next"}
                        }}}
                    ],
                    "continuations": [{
                        "nextContinuationData": {"continuation": "legacy-next-2"}
                    }]
                }
            }
        });
        let sources = songs_from_continuation_page(&page);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "Four");
        assert_eq!(
            playlist_continuation_token(&page).as_deref(),
            Some("legacy-next"),
            "有 item renderer 时仍优先 2025 token"
        );
    }

    #[test]
    fn empty_browse_is_rejected() {
        assert!(playlist_from_browse(&json!({})).is_none());
    }

    #[test]
    fn lyrics_browse_id_reads_unselectable_tab() {
        let next = json!({
            "contents": {"singleColumnMusicWatchNextResultsRenderer": {
                "tabbedRenderer": {"watchNextTabbedResultsRenderer": {"tabs": [
                    {"tabRenderer": {"title": "Up next"}},
                    {"tabRenderer": {
                        "unselectable": true,
                        "endpoint": {"browseEndpoint": {
                            "browseId": "MPLYt_abc",
                            "browseEndpointContextSupportedConfigs": {
                                "browseEndpointContextMusicConfig": {
                                    "pageType": "MUSIC_PAGE_TYPE_TRACK_LYRICS"
                                }
                            }
                        }}
                    }}
                ]}}
            }}
        });
        assert_eq!(lyrics_browse_id(&next), Some("MPLYt_abc"));
    }

    #[test]
    fn timed_lyrics_convert_to_lrc() {
        let body = json!({
            "contents": {
                "elementRenderer": {
                    "newElement": {
                        "type": {
                            "componentType": {
                                "model": {
                                    "timedLyricsModel": {
                                        "lyricsData": {
                                            "timedLyricsData": [
                                                {
                                                    "lyricLine": "♪",
                                                    "cueRange": {
                                                        "startTimeMilliseconds": "0",
                                                        "endTimeMilliseconds": "1000"
                                                    }
                                                },
                                                {
                                                    "lyricLine": "We're no strangers to love",
                                                    "cueRange": {
                                                        "startTimeMilliseconds": "19620",
                                                        "endTimeMilliseconds": "23000"
                                                    }
                                                },
                                                {
                                                    "lyricLine": "You know the rules",
                                                    "cueRange": {
                                                        "startTimeMilliseconds": "23100",
                                                        "endTimeMilliseconds": "25000"
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        let text = lyric_text_from_browse(&body).unwrap();
        assert!(text.lrc.contains("[00:19.62]We're no strangers to love"));
        assert!(text.lrc.contains("[00:23.10]You know the rules"));
        assert!(!text.lrc.contains('♪'));
    }

    #[test]
    fn plain_lyrics_fall_back_to_zero_stamps() {
        let body = json!({
            "contents": {
                "sectionListRenderer": {
                    "contents": [
                        {
                            "musicDescriptionShelfRenderer": {
                                "description": {
                                    "runs": [{ "text": "Line one\nLine two" }]
                                }
                            }
                        }
                    ]
                }
            }
        });
        let text = lyric_text_from_browse(&body).unwrap();
        assert_eq!(text.lrc, "[00:00.00]Line one\n[00:00.00]Line two");
    }

    #[test]
    fn unavailable_message_is_not_lyrics() {
        let body = json!({
            "contents": {
                "messageRenderer": {
                    "text": {
                        "runs": [{ "text": "Lyrics not available" }]
                    }
                }
            }
        });
        assert!(lyric_text_from_browse(&body).is_none());
    }
}
