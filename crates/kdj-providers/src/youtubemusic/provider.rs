//! YouTube Music provider。
//!
//! 匿名可用：搜索 / 歌单 / 链接解析全都不需要账号。**播放流**则是另一回事——
//! YouTube 从 2024 年起对匿名播放强制 botguard / PO token 质询，匿名拿到的
//! 自适应流全被剥掉 URL；而**带 Google 登录态**的请求（`Authorization: Bearer`）
//! 被视作可信客户端：会员直接放行自适应流，普通账号至少放行 HLS。
//! 所以登录（设备码 OAuth，见 [`super::auth`]）是拿到播放流的关键路径。
//!
//! 音质档映射：免费流最高约 128k opus、会员约 256k AAC，没有无损，
//! 所以 Flac 请求按"能拿到的最高码率"处理。流地址里的签名由
//! [`super::decipher`] 用播放器脚本还原；HLS 回退交给 FFmpeg 提取音轨。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, Platform, QrSession, QrStateValue, Quality, ResolveKind,
    ResolveResponse, SongSource,
};
use kdj_core::paths::render_filename;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;

use super::auth::{self, DeviceCode, DevicePoll, OAuthSession};
use super::client::YtmClient;
use crate::net::{create_download_writer, host_is, AtomicDownload};
use crate::provider::{
    effective_limit, full_listing, no_login, str_field, unique_download_path, Capabilities,
    DownloadJob, MusicProvider, ProviderContext,
};
use crate::tags;

const LABEL: &str = "YouTube Music";
const DISABLED_MESSAGE: &str = "未启用，在「下载」里打开开关";
/// 设备码登录会话的进程内保留时长。
const DEVICE_ATTEMPT_TTL_SECS: u64 = 20 * 60;

/// 契约音质 → YouTube Music 现实里最接近的码率目标。
/// 平台没有无损档：flac 和 320 都对准会员上限（约 256k AAC）。
fn target_bitrate(quality: Quality) -> i64 {
    match quality {
        Quality::Flac | Quality::Q320 => 256_000,
        Quality::Q128 => 128_000,
    }
}

/// 一条在途的设备码登录尝试。
struct DeviceAttempt {
    code: DeviceCode,
}

/// 解析出来的音频流形态：直链（可试听/下载）或 HLS（只能下载，交给 FFmpeg）。
enum StreamSource {
    Direct { url: String, ext: String },
    Hls { url: String },
}

pub struct YoutubeMusicProvider {
    ctx: ProviderContext,
    client: YtmClient,
    session: RwLock<Option<OAuthSession>>,
    devices: Mutex<HashMap<String, DeviceAttempt>>,
    /// refresh token 并发共享：所有请求共用一次刷新（single-flight）。
    refresh: tokio::sync::Mutex<()>,
}

impl YoutubeMusicProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        let client = YtmClient::new()?;
        let session_path = ctx.session_file("ytmusic.json");
        let session = std::fs::read_to_string(&session_path)
            .ok()
            .and_then(|text| match serde_json::from_str::<OAuthSession>(&text) {
                Ok(session) if !session.access_token.is_empty() => Some(session),
                Ok(_) => None,
                Err(err) => {
                    tracing::warn!("解析 YouTube Music 登录态失败：{err}");
                    None
                }
            });
        client.set_access_token(session.as_ref().map(|s| s.access_token.clone()));
        Ok(YoutubeMusicProvider {
            ctx,
            client,
            session: RwLock::new(session),
            devices: Mutex::new(HashMap::new()),
            refresh: tokio::sync::Mutex::new(()),
        })
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

    // ------------------------------------------------------------ 登录态

    /// OAuth client 凭据的取值顺序：
    /// 1. 运行时环境变量（调试/自托管换号）；
    /// 2. 打包时注入的编译期默认值（`option_env!`，发布构建开箱即用）。
    ///
    /// 「电视和有限输入设备」client 在 Google 眼里是公开客户端：secret 封进
    /// 二进制是设计允许的——拿它只能发起登录，不能替用户授权；用户 token
    /// 只落在用户自己机器上。真正的风险是 client 被滥用后遭 Google 停用，
    /// 所以每个发布渠道用一个独立 client，别在公开文档里贴 secret。
    fn oauth_credentials(&self) -> Result<(String, String)> {
        let client_id = runtime_or_baked(
            "KDJ_YTM_OAUTH_CLIENT_ID",
            option_env!("KDJ_YTM_OAUTH_CLIENT_ID"),
        );
        let client_secret = runtime_or_baked(
            "KDJ_YTM_OAUTH_CLIENT_SECRET",
            option_env!("KDJ_YTM_OAUTH_CLIENT_SECRET"),
        );
        anyhow::ensure!(
            !client_id.is_empty() && !client_secret.is_empty(),
            "KDJ 尚未配置 YouTube Music 登录服务（需要 KDJ_YTM_OAUTH_CLIENT_ID / \
             KDJ_YTM_OAUTH_CLIENT_SECRET，发布构建需在打包时注入）"
        );
        Ok((client_id, client_secret))
    }

    fn session_path(&self) -> PathBuf {
        self.ctx.session_file("ytmusic.json")
    }

    fn save_session(&self, session: &OAuthSession) -> Result<()> {
        let path = self.session_path();
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(session).context("序列化 YouTube Music 登录态失败")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("创建 YouTube Music 会话目录失败")?;
        }
        std::fs::write(&tmp, body).context("保存 YouTube Music 登录态失败")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .context("保护 YouTube Music 登录态失败")?;
        }
        std::fs::rename(&tmp, &path).context("写入 YouTube Music 登录态失败")?;
        Ok(())
    }

    fn session_snapshot(&self) -> Option<OAuthSession> {
        self.session.read().unwrap().clone()
    }

    fn set_session(&self, session: OAuthSession) -> Result<()> {
        self.client
            .set_access_token(Some(session.access_token.clone()));
        self.save_session(&session)?;
        *self.session.write().unwrap() = Some(session);
        Ok(())
    }

    fn clear_session(&self) {
        self.client.set_access_token(None);
        *self.session.write().unwrap() = None;
        let _ = std::fs::remove_file(self.session_path());
    }

    /// 当前可用的 access token；临过期时 single-flight 刷新一次。
    async fn access_token(&self) -> Result<String> {
        let current = self.session_snapshot().context("YouTube Music 尚未登录")?;
        if !current.expiring() {
            return Ok(current.access_token);
        }
        let _single_flight = self.refresh.lock().await;
        // 等锁期间别的请求可能已经刷完
        let current = self.session_snapshot().context("YouTube Music 尚未登录")?;
        if !current.expiring() {
            return Ok(current.access_token);
        }
        anyhow::ensure!(
            !current.refresh_token.is_empty(),
            "YouTube Music 登录已过期，请重新登录"
        );
        let (client_id, client_secret) = self.oauth_credentials()?;
        let next = auth::refresh_token(
            self.client.http(),
            &client_id,
            &client_secret,
            &current.refresh_token,
        )
        .await
        .context("YouTube Music 登录已过期，请重新登录")?;
        let token = next.access_token.clone();
        self.set_session(next)?;
        Ok(token)
    }

    fn prune_devices(&self) {
        self.devices.lock().unwrap().retain(|_, attempt| {
            attempt.code.created_at.elapsed().as_secs() <= DEVICE_ATTEMPT_TTL_SECS
        });
    }

    // ------------------------------------------------------------ 设备码登录

    /// 发起一次设备码登录。返回给前端的展示信息。
    pub async fn begin_device_login(&self) -> Result<Value> {
        self.ensure_enabled()?;
        let (client_id, _) = self.oauth_credentials()?;
        let code = auth::begin_device_code(self.client.http(), &client_id).await?;
        self.prune_devices();
        let response = json!({
            "device_code": code.device_code,
            "user_code": code.user_code,
            "verification_url": code.verification_url,
            "expires_in": code.expires_in,
        });
        self.devices.lock().unwrap().insert(
            code.device_code.clone(),
            DeviceAttempt { code },
        );
        Ok(response)
    }

    /// 查一次设备码登录状态；成功时落盘会话。
    pub async fn poll_device_login(&self, device_code: &str) -> Value {
        let attempt = {
            self.prune_devices();
            let devices = self.devices.lock().unwrap();
            devices.get(device_code).map(|attempt| attempt.code.clone())
        };
        let Some(code) = attempt else {
            return json!({
                "status": "error",
                "message": "登录会话不存在或已过期，请重新发起",
                "account": Value::Null,
            });
        };
        if code.expired() {
            self.devices.lock().unwrap().remove(device_code);
            return json!({
                "status": "error",
                "message": "登录码已过期，请重新发起",
                "account": Value::Null,
            });
        }
        let (client_id, client_secret) = match self.oauth_credentials() {
            Ok(credentials) => credentials,
            Err(err) => {
                return json!({ "status": "error", "message": err.to_string(), "account": Value::Null })
            }
        };
        match auth::poll_device_code(
            self.client.http(),
            &client_id,
            &client_secret,
            device_code,
        )
        .await
        {
            Ok(DevicePoll::Done(session)) => {
                if let Err(err) = self.set_session(session) {
                    self.devices.lock().unwrap().remove(device_code);
                    return json!({
                        "status": "error",
                        "message": format!("登录成功但保存登录态失败：{err:#}"),
                        "account": Value::Null,
                    });
                }
                self.devices.lock().unwrap().remove(device_code);
                json!({
                    "status": "done",
                    "message": "YouTube Music 登录成功",
                    "account": serde_json::to_value(self.account().await).unwrap_or(Value::Null),
                })
            }
            Ok(DevicePoll::Pending) | Ok(DevicePoll::SlowDown) => json!({
                "status": "pending",
                "message": "等待在浏览器里完成授权",
                "account": Value::Null,
            }),
            Ok(DevicePoll::Failed(message)) => {
                self.devices.lock().unwrap().remove(device_code);
                json!({ "status": "error", "message": message, "account": Value::Null })
            }
            Err(err) => json!({
                "status": "error",
                "message": format!("检查登录状态失败：{err:#}"),
                "account": Value::Null,
            }),
        }
    }

    // ------------------------------------------------------------ 流解析

    /// 解析音频流。返回直链（可试听/下载）或 HLS（下载用）。
    async fn stream_source(
        &self,
        video_id: &str,
        quality: Quality,
        lowest: bool,
    ) -> Result<StreamSource> {
        // 登录态先确保 token 新鲜：过期的 Bearer 会让 player 请求直接 401
        let logged_in = self.session_snapshot().is_some();
        if logged_in {
            self.access_token().await?;
        }
        let player = self.client.player(video_id, logged_in).await?;
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
        if let Some(hls) = player
            .pointer("/streamingData/hlsManifestUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
        {
            return Ok(StreamSource::Hls {
                url: hls.to_string(),
            });
        }
        if self.session_snapshot().is_some() {
            bail!("YouTube Music 没有返回可用音频流（会员可解锁更高码率的自适应流）")
        }
        bail!("YouTube Music 没有返回匿名可用的音频流（YouTube 限制未登录播放；请先登录，或稍后重试）")
    }

    /// 直链直接用；签名串走播放器脚本解密。
    async fn format_url(&self, format: &AudioFormat) -> Result<String> {
        if let Some(url) = &format.url {
            return Ok(url.clone());
        }
        anyhow::ensure!(
            !format.cipher.is_empty(),
            "音频流既没有直链也没有签名参数"
        );
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
        // 解析元数据用 ANDROID：匿名也返回完整的 videoDetails
        let player = self.client.player(video_id, false).await?;
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
        anyhow::ensure!(crate::ffmpeg::available(), "需要 FFmpeg 才能下载 HLS 音频流");
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
        account.login_method = "device".into();
        if !self.ctx.ytm_enabled() {
            account.detail = DISABLED_MESSAGE.into();
            return account;
        }
        let Some(session) = self.session_snapshot() else {
            // AccountRow 已单独显示「未登录」，这里只补一句说明，
            // 避免界面出现「未登录 · 未登录 · …」的重复文案。
            account.detail = "可匿名搜索；登录后解锁播放流".into();
            return account;
        };
        match self.access_token().await {
            Ok(_) => {
                account.state = AccountState::Valid;
                account.detail = "已登录".into();
            }
            Err(err) => {
                account.state = if session.expiring() {
                    AccountState::Expired
                } else {
                    AccountState::Unknown
                };
                account.detail = truncate(&format!("登录态检查失败：{err:#}"), 160);
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
        self.clear_session();
        self.devices.lock().unwrap().clear();
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

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let text = url.trim();
        // music.youtube.com 是 youtube.com 的子域，host_is 已覆盖
        if !host_is(text, "youtube.com") && !host_is(text, "youtu.be") {
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

    /// 试听 = 最低码率那一档。HLS 形态没法直接给 `<audio>` 用，试听跳过。
    async fn preview_url(&self, source: &SongSource) -> Result<Option<String>> {
        self.ensure_enabled()?;
        let key = Self::video_id(source)?;
        match self.stream_source(&key, Quality::Q128, true).await? {
            StreamSource::Direct { url, .. } => Ok(Some(url)),
            StreamSource::Hls { .. } => {
                bail!("YouTube Music 只提供了 HLS 流，试听暂不可用（下载仍可）")
            }
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
            StreamSource::Hls { .. } => {
                bail!("YouTube Music 只提供了 HLS 流，试听暂不可用（下载仍可）")
            }
        }
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
                let response =
                    response.error_for_status().context("YouTube Music 音频下载失败")?;
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
                    str_field(format, "mimeType")
                        .is_some_and(|mime| mime.starts_with("audio/"))
                })
                .map(|format| AudioFormat {
                    bitrate: format
                        .get("bitrate")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    mime: str_field(format, "mimeType").unwrap_or_default().to_string(),
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
    // 只有 YouTube 自己的域名才算；其它站点就算 URL 长得像也不认
    if host != "youtu.be" && host != "youtube.com" && !host.ends_with(".youtube.com") {
        return None;
    }
    let path = parsed.path();
    let query: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();

    if host == "youtu.be" {
        let id = path.trim_matches('/');
        return looks_like_video_id(id).then(|| (ResolveKind::Song, id.to_string()));
    }
    if let Some(id) = path.strip_prefix("/shorts/") {
        return looks_like_video_id(id).then(|| (ResolveKind::Song, id.to_string()));
    }
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

/// 歌单浏览页：标题 + 全部可见歌曲。
///
/// 布局随客户端形态在变：老版是 `singleColumnBrowseResultsRenderer`，
/// 现在网页端是 `twoColumnBrowseResultsRenderer`（主栏放标题头、
/// 次栏放曲目 shelf）。三处 shelf 都扫一遍，标题带 microformat 兜底。
fn playlist_from_browse(body: &Value) -> Option<(String, Vec<SongSource>)> {
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
    if sources.is_empty() {
        return None;
    }
    Some((title, sources))
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let result: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{result}…")
    } else {
        result
    }
}

/// 运行时环境变量优先；没有就用打包时烧进二进制的默认值（`option_env!`）。
fn runtime_or_baked(name: &str, baked: Option<&str>) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| baked.map(|value| value.trim().to_string()))
        .unwrap_or_default()
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
        assert_eq!(
            sources[0].cover,
            "https://i.ytimg.com/vi/ID/hqdefault.jpg"
        );
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
            AudioFormat { bitrate: 70_000, mime: "audio/webm".into(), url: Some("lo".into()), cipher: String::new() },
            AudioFormat { bitrate: 140_000, mime: "audio/mp4".into(), url: Some("mid".into()), cipher: String::new() },
            AudioFormat { bitrate: 260_000, mime: "audio/mp4".into(), url: Some("hi".into()), cipher: String::new() },
        ];
        assert_eq!(pick_format(&formats, Quality::Q128).url.as_deref(), Some("mid"), "128 档选离 128k 最近的");
        assert_eq!(pick_format(&formats, Quality::Q320).url.as_deref(), Some("hi"));
        assert_eq!(pick_format(&formats, Quality::Flac).url.as_deref(), Some("hi"), "无无损档，对准会员上限");
        let low_only = &formats[..1];
        assert_eq!(pick_format(low_only, Quality::Flac).url.as_deref(), Some("lo"), "只有低码率时就它");
    }

    #[test]
    fn ext_follows_the_container() {
        let mp4 = AudioFormat { bitrate: 1, mime: "audio/mp4".into(), url: None, cipher: String::new() };
        let webm = AudioFormat { bitrate: 1, mime: "audio/webm".into(), url: None, cipher: String::new() };
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
            Some((ResolveKind::Playlist, "PLxyz".into()))
        );
        assert_eq!(
            parse_ytm_url("https://youtu.be/abcDEF12345?t=30"),
            Some((ResolveKind::Song, "abcDEF12345".into()))
        );
        assert_eq!(
            parse_ytm_url("https://youtube.com/shorts/abcDEF12345"),
            Some((ResolveKind::Song, "abcDEF12345".into()))
        );
        assert_eq!(
            parse_ytm_url("https://music.youtube.com/playlist?list=PLabc"),
            Some((ResolveKind::Playlist, "PLabc".into()))
        );
        assert_eq!(parse_ytm_url("https://example.com/watch?v=abcDEF12345"), None);
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
    fn empty_browse_is_rejected() {
        assert!(playlist_from_browse(&json!({})).is_none());
    }

    #[test]
    fn baked_credentials_fall_back_cleanly() {
        // 打包时没注入 → 空串；注入了 → 用注入值（运行时覆盖依赖真实环境变量，不在此测）
        assert_eq!(runtime_or_baked("KDJ_YTM_OAUTH_CLIENT_ID", None), "");
        assert_eq!(
            runtime_or_baked("KDJ_YTM_OAUTH_CLIENT_ID", Some("abc.apps.googleusercontent.com")),
            "abc.apps.googleusercontent.com"
        );
        assert_eq!(runtime_or_baked("KDJ_YTM_OAUTH_CLIENT_ID", Some("  ")), "");
    }
}
