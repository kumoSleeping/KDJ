//! 普通 YouTube 视频：关键词搜索、单视频/Shorts、播放列表与音视频下载。
//!
//! 元数据与流提取由本模块的轻量 InnerTube 客户端完成；不嵌入 JavaScript VM，
//! 也不依赖通用网页抓取器。登录使用普通 YouTube 自己的浏览器 Cookie，不与
//! YouTube Music 共用状态。403 会转成明确提示，而不是留下空文件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, CollectionResolveResponse, CollectionResult, Platform, QrSession,
    QrStateValue, ResolveKind, ResolveResponse, SearchKind, SongSource, StreamPlaylist,
    StreamPlaylistResponse, VideoDownloadRequest, VideoInfo, VideoPage,
};
use kdj_core::paths::{finalize_filename, sanitize_filename_value};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

use crate::provider::{
    effective_limit, full_listing, no_login, unique_download_path, Capabilities, DownloadJob,
    MusicProvider, ProgressSink, ProviderContext, VideoPreviewStream, VideoPreviewTrack,
    VideoProvider,
};
use crate::tags;
use crate::youtubemusic::auth::YoutubeAuth;

use super::client::{
    is_auth_rejection, ProtectedHlsContext, Thumbnail, VideoDetails, VideoFormat, YoutubeClient,
};
#[cfg(test)]
use super::client::{MediaMime, USER_AGENT};
use super::hls_download;

const LABEL: &str = "YouTube Video";
const DISABLED_MESSAGE: &str = "未启用，在「下载源」里打开开关";

fn validated_local_youtube_hls_url(value: &str) -> Result<&str> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= 8 * 1024 && !value.contains(['\r', '\n']),
        "YouTube 本地 HLS 下载来源无效"
    );
    let url = url::Url::parse(value).context("YouTube 本地 HLS 下载来源无效")?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    );
    let ticket = url
        .path()
        .strip_prefix("/api/video/youtube/hls/")
        .unwrap_or_default();
    let mut query = url.query_pairs();
    let media_capability = query
        .next()
        .is_some_and(|(key, token)| key == "kdj_media_token" && !token.is_empty());
    anyhow::ensure!(
        url.scheme() == "http"
            && loopback
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && ticket.len() == 64
            && ticket.bytes().all(|byte| byte.is_ascii_hexdigit())
            && media_capability
            && query.next().is_none(),
        "YouTube 本地 HLS 下载来源不受信任"
    );
    Ok(value)
}

const YOUTUBE_SEARCH_KINDS: &[SearchKind] = &[SearchKind::Song];

pub struct YoutubeProvider {
    ctx: ProviderContext,
    auth: Arc<YoutubeAuth>,
    client: YoutubeClient,
}

impl YoutubeProvider {
    pub fn new(ctx: ProviderContext, auth: Arc<YoutubeAuth>) -> Result<Self> {
        let client = YoutubeClient::new(auth.clone())?;
        Ok(Self { ctx, auth, client })
    }

    fn cached_account_snapshot(&self) -> Account {
        let mut account = Account::new(Platform::Youtube, LABEL, AccountState::Missing, "未登录");
        account.login_method = "browser".into();
        account.credential_kind = "anonymous".into();
        if let Some(session) = self.auth.snapshot() {
            account.state = AccountState::Valid;
            if let Some(profile) = self.auth.cached_profile(&session) {
                account.nickname = profile.nickname;
                account.avatar = profile.avatar;
            }
            account.account_key = session.x_goog_authuser;
            account.credential_kind = "browser_session".into();
            account.detail = String::new();
        } else if !self.ctx.youtube_enabled() {
            account.detail = DISABLED_MESSAGE.into();
        } else {
            account.detail = "公开内容可匿名访问；登录后可读取账号受限内容".into();
        }
        account
    }

    pub async fn validate_browser_session(
        &self,
        session: &crate::youtubemusic::auth::BrowserSession,
    ) -> Result<()> {
        self.client.validate_browser_session(session).await
    }

    fn ensure_enabled(&self) -> Result<()> {
        anyhow::ensure!(self.ctx.youtube_enabled(), "{DISABLED_MESSAGE}");
        Ok(())
    }

    pub async fn protected_preview_player_script(&self, player_url: &str) -> Result<String> {
        self.ensure_enabled()?;
        self.client.protected_player_script(player_url).await
    }

    pub async fn protected_hls_context(
        &self,
        video_id: &str,
        user_agent: &str,
    ) -> Result<ProtectedHlsContext> {
        self.ensure_enabled()?;
        self.client
            .protected_hls_context(video_id, user_agent)
            .await
    }

    async fn video_source(&self, id: &str) -> Result<SongSource> {
        if let Some(info) = self.client.cached_video(id) {
            return Ok(source_from_details(&info.video_details));
        }
        let metadata = self.client.watch_metadata(id).await?;
        source_from_watch_metadata(&metadata, id)
            .context("YouTube 没有返回这个视频的元数据")
    }

    async fn playlist_sources(
        &self,
        id_or_url: &str,
        limit: usize,
    ) -> Result<(String, Vec<SongSource>)> {
        let playlist_id = if id_or_url.starts_with("http://") || id_or_url.starts_with("https://") {
            match parse_youtube_url(id_or_url) {
                Some(YoutubeTarget::Playlist(id)) => id,
                _ => bail!("YouTube 播放列表链接无效"),
            }
        } else {
            id_or_url.trim().to_string()
        };
        anyhow::ensure!(!playlist_id.is_empty(), "YouTube 播放列表 ID 为空");
        let body = json!({
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": web_client_version(),
                    "hl": "zh-CN",
                    "gl": "US"
                }
            },
            "browseId": format!("VL{playlist_id}")
        });
        let context = body.get("context").cloned().unwrap_or(Value::Null);
        let body = self
            .client
            .post_web("browse", &body)
            .await
            .context("读取 YouTube 播放列表失败")?;
        let title = body
            .pointer("/metadata/playlistMetadataRenderer/title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("YouTube 播放列表 {playlist_id}"));
        let mut sources = Vec::new();
        collect_playlist_lockups(&body, &mut sources, limit);
        let mut continuation = playlist_continuation(&body);
        let mut seen_tokens = std::collections::HashSet::new();
        while sources.len() < limit {
            let Some(token) = continuation.take() else {
                break;
            };
            if !seen_tokens.insert(token.clone()) {
                break;
            }
            let page_body = json!({ "context": context.clone(), "continuation": token });
            let page = self
                .client
                .post_web("browse", &page_body)
                .await
                .context("继续读取 YouTube 播放列表失败")?;
            let before = sources.len();
            collect_playlist_lockups(&page, &mut sources, limit);
            continuation = playlist_continuation(&page);
            if sources.len() == before && continuation.is_none() {
                break;
            }
        }
        anyhow::ensure!(
            !sources.is_empty(),
            "YouTube 播放列表没有可用视频；私密列表需要先导入有权限的浏览器会话"
        );
        Ok((title, sources))
    }

    async fn library_playlists(&self) -> Result<Vec<StreamPlaylist>> {
        let body = self
            .client
            .account_playlist_directory()
            .await
            .context("读取 YouTube 播放列表目录失败")?;
        Ok(youtube_library_playlists(&body))
    }

    pub async fn resolve_video(&self, url_or_id: &str) -> Result<VideoInfo> {
        self.ensure_enabled()?;
        let video_id = video_id_from_input(url_or_id)?;
        let source = self.video_source(&video_id).await?;
        let duration = source.duration.unwrap_or(0.0) as i64;
        Ok(VideoInfo {
            platform: Platform::Youtube,
            bvid: source.key.clone(),
            title: source.title.clone(),
            author: source.artist_text(),
            cover: source.cover.clone(),
            duration,
            pages: vec![VideoPage {
                index: 0,
                title: source.title,
                duration,
            }],
            // Native HLS chooses quality at playback/download time, not during link lookup.
            options: Vec::new(),
            logged_in: self.auth.is_logged_in(),
        })
    }

    /// 普通 YouTube 预览只有原生 HLS 一条路径；旧的 DASH + MediaSource 入口永久关闭。
    pub async fn preview_stream_at_height(
        &self,
        input: &str,
        max_height: i64,
        track: VideoPreviewTrack,
        range: Option<&str>,
    ) -> Result<VideoPreviewStream> {
        self.ensure_enabled()?;
        let _ = (input, max_height, track, range);
        bail!("YouTube 视频预览只允许使用受保护的原生 HLS 链路")
    }

    pub async fn download_video(
        &self,
        req: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<PathBuf> {
        self.download_video_with_source(req, cancel, progress, None)
            .await
    }

    async fn download_video_with_source(
        &self,
        req: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
        prepared_source_url: Option<&str>,
    ) -> Result<PathBuf> {
        self.ensure_enabled()?;
        anyhow::ensure!(!req.video_only, "YouTube 暂不支持纯视频下载");
        anyhow::ensure!(
            req.offset_ms == 0,
            "原生 YouTube 下载暂不支持音画时间偏移；请关闭音画匹配后重试"
        );
        // Older queued tasks may still carry `transcode=true` from the shared Bilibili control.
        // The fixed native YouTube path already guarantees an MP4 container, so migrate that
        // legacy compatibility intent to the decode-free path instead of making Retry fail.
        let target = if !req.url.trim().is_empty() {
            req.url.trim()
        } else {
            req.bvid.trim()
        };
        anyhow::ensure!(!target.is_empty(), "缺少 YouTube 视频链接或 ID");
        let video_id = video_id_from_input(target)?;
        let protected_hls = prepared_source_url
            .map(validated_local_youtube_hls_url)
            .transpose()?;
        if cancel.is_cancelled() {
            bail!("下载已取消");
        }
        // A prepared video already has an authenticated, proof-bound source. Do not gate it
        // on an unrelated player request: that client may be rejected even while the
        // exact same video plays through protected HLS. Only direct-format downloads need it.
        let info = if protected_hls.is_some() && !req.audio_only {
            None
        } else {
            Some(self.client.download_info(&video_id).await?)
        };
        if cancel.is_cancelled() {
            bail!("下载已取消");
        }
        let formats = info.as_ref().map(|info| info.formats.as_slice()).unwrap_or(&[]);
        let title = if req.title.trim().is_empty() {
            info.as_ref()
                .map(|info| info.video_details.title.as_str())
                .filter(|title| !title.trim().is_empty())
                .unwrap_or(&video_id)
        } else {
            req.title.trim()
        };
        let output_dir = if req.audio_only {
            self.ctx.platform_dir(Platform::Youtube)?
        } else {
            self.ctx.video_output_dir()?
        };
        let extension = if req.audio_only {
            "m4a"
        } else {
            // This path intentionally has one deterministic container. A legacy/global video
            // format preference must not turn an otherwise valid native YouTube download into a
            // failure or reintroduce a transcoder.
            "mp4"
        };
        let stem = sanitize_filename_value(title, &video_id);
        let filename = finalize_filename(&format!("{stem}.{extension}"), extension);
        let output = unique_download_path(&output_dir, &filename);
        let temp = output_dir.join(format!(
            ".partial-youtube-{}-{:08x}",
            video_id,
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&temp).context("创建 YouTube 下载暂存目录失败")?;
        let _guard = TempDirGuard(temp.clone());
        // A playable fMP4 grows here before the final rename. Give it a non-media
        // extension as defense in depth against filesystem watchers importing it.
        let staged = temp.join("output.part");
        if req.audio_only {
            self.download_direct_audio(formats, &temp, &staged, cancel, progress)
                .await?;
        } else if let Some(hls) = protected_hls {
            // 一个已经准备好的受保护 HLS 会话（旧任务/外部准备）仍按原路径封装。上游
            // URL、proof 与固定 Safari 身份都留在本地服务里。
            // HLS 没有可靠 Content-Length，但从这里开始已经不再是解析。先报告
            // 未知总量的下载起点，让任务条切到「解析完成 → 下载中」。
            progress(0, 0);
            hls_download::download_muxed_h264_aac(hls, &staged, cancel, progress).await?;
            let size = std::fs::metadata(&staged)
                .map(|meta| meta.len())
                .unwrap_or(0);
            progress(size, size);
        } else {
            self.download_direct_video(formats, req.max_height, &temp, &staged, cancel, progress)
                .await?;
        }
        if cancel.is_cancelled() {
            bail!("下载已取消");
        }
        anyhow::ensure!(
            std::fs::metadata(&staged)
                .map(|meta| meta.len())
                .unwrap_or(0)
                > 0,
            "YouTube 下载没有生成有效文件"
        );
        anyhow::ensure!(!cancel.is_cancelled(), "下载已取消");
        let output = crate::net::commit_download(&staged, &output)?;
        Ok(output)
    }

    async fn fetch_format(
        &self,
        format: &VideoFormat,
        output: &Path,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<()> {
        anyhow::ensure!(!format.url.is_empty(), "YouTube 流缺少下载地址");
        let mut downloaded = 0u64;
        let mut expected_total = format.content_length.unwrap_or(0);
        let mut file = crate::net::create_download_writer(output)
            .await
            .context("创建 YouTube 暂存文件失败")?;
        for _ in 0..4096 {
            // googlevideo throttles one long open range to roughly real-time speed; bounded
            // ranges of this size come at full speed (26 MB: 108 s open, 15 s in 10 MB ranges).
            let range_end = downloaded + RANGE_CHUNK - 1;
            let mut request = self
                .client
                .http()
                .get(&format.url)
                .header(reqwest::header::REFERER, "https://www.youtube.com/")
                .header(reqwest::header::RANGE, format!("bytes={downloaded}-{range_end}"));
            if let Some(session) = self.auth.snapshot() {
                request = request.header(reqwest::header::COOKIE, session.cookie);
            }
            let response = request.send().await.context("YouTube 流请求失败")?;
            let status = response.status();
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(StreamForbidden.into());
            }
            if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE
                && downloaded > 0
                && expected_total == 0
            {
                // The previous range ended exactly at the end of a stream of unknown length.
                break;
            }
            anyhow::ensure!(status.is_success(), "YouTube 流请求返回 {status}");
            let partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
            anyhow::ensure!(
                downloaded == 0 || partial,
                "YouTube 续传请求被错误地从头返回"
            );
            let range_total = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.rsplit_once('/'))
                .and_then(|(_, total)| total.parse::<u64>().ok())
                .unwrap_or(0);
            expected_total = expected_total.max(range_total);
            if !partial {
                // The whole body, whatever range was asked for.
                expected_total = expected_total.max(response.content_length().unwrap_or(0));
            }
            progress(downloaded, expected_total);
            let segment_start = downloaded;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancel.is_cancelled() {
                    bail!("下载已取消");
                }
                let chunk = chunk.context("YouTube 流中断")?;
                file.write_all(&chunk)
                    .await
                    .context("写入 YouTube 暂存文件失败")?;
                downloaded += chunk.len() as u64;
                progress(downloaded, expected_total.max(downloaded));
            }
            if !partial
                || (expected_total > 0 && downloaded >= expected_total)
                || (expected_total == 0 && downloaded - segment_start < RANGE_CHUNK)
            {
                break;
            }
            anyhow::ensure!(downloaded > segment_start, "YouTube 流续传没有取得新数据");
        }
        anyhow::ensure!(
            expected_total == 0 || downloaded >= expected_total,
            "YouTube 流没有完整下载"
        );
        file.flush().await.context("提交 YouTube 暂存缓冲失败")?;
        Ok(())
    }

    /// 不经 HLS 的视频下载：分轨 H.264 + AAC 下完后原样封装成 MP4（kdj-media，与 B 站相同）。
    /// 分轨被拒（音乐类视频在没有 GVS PO Token 时一律 403）时，
    /// 改下单文件 H.264/AAC MP4（itag 18，360p）。
    async fn download_direct_video(
        &self,
        formats: &[VideoFormat],
        max_height: i64,
        temp: &Path,
        staged: &Path,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<()> {
        if let Some((video, audio)) = adaptive_h264_aac_pair(formats, max_height) {
            match self
                .fetch_and_mux(&video, &audio, temp, staged, cancel, progress)
                .await
            {
                Ok(()) => return Ok(()),
                Err(error) if is_stream_forbidden(&error) => tracing::info!(
                    video_itag = video.itag,
                    audio_itag = audio.itag,
                    "YouTube 分轨下载被拒绝，改用单文件 MP4"
                ),
                Err(error) => return Err(error),
            }
        }
        let format = native_progressive_mp4(formats, max_height)
            .or_else(|| native_progressive_mp4(formats, i64::MAX))
            .context("YouTube 没有返回可下载的 H.264/AAC 视频流")?;
        self.fetch_format(&format, staged, cancel, progress).await
    }

    async fn fetch_and_mux(
        &self,
        video: &VideoFormat,
        audio: &VideoFormat,
        temp: &Path,
        staged: &Path,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<()> {
        let audio_path = temp.join("audio.m4s");
        let video_path = temp.join("video.m4s");
        let total = match (audio.content_length, video.content_length) {
            (Some(audio), Some(video)) => audio + video,
            _ => 0,
        };
        // The small audio track first: a refused stream is then known before the large one.
        self.fetch_format(audio, &audio_path, cancel, &offset_progress(progress, 0, total))
            .await?;
        let audio_size = std::fs::metadata(&audio_path).map(|meta| meta.len()).unwrap_or(0);
        self.fetch_format(
            video,
            &video_path,
            cancel,
            &offset_progress(progress, audio_size, total),
        )
        .await?;
        let muxed = temp.join("muxed.mp4");
        let height = video.height.unwrap_or(0) as i64;
        crate::finish::mux(&[video_path, audio_path], &muxed, false, false, height, 0, &temp.join("ffmpeg.log"), cancel).await?;
        std::fs::rename(&muxed, staged).context("提交 YouTube 封装结果失败")
    }

    /// 只要音轨：直接保存 AAC 分轨；被拒时从单文件 MP4 里原样抽出 AAC。
    async fn download_direct_audio(
        &self,
        formats: &[VideoFormat],
        temp: &Path,
        staged: &Path,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<()> {
        const NO_AUDIO: &str =
            "YouTube 没有返回可直接保存的 AAC/M4A 音轨；该视频可能需要重新连接浏览器";
        if let Some(format) = native_audio_format(formats) {
            match self.fetch_format(&format, staged, cancel, progress).await {
                Ok(()) => return Ok(()),
                Err(error) if is_stream_forbidden(&error) => {}
                Err(error) => return Err(error),
            }
        }
        let progressive = native_progressive_mp4(formats, i64::MAX).context(NO_AUDIO)?;
        let source = temp.join("progressive.m4s");
        self.fetch_format(&progressive, &source, cancel, progress)
            .await?;
        let extracted = temp.join("audio.m4a");
        crate::finish::extract_audio(&source, &extracted, 0, &temp.join("ffmpeg.log"), cancel).await?;
        std::fs::rename(&extracted, staged).context("提交 YouTube 音轨失败")
    }
}

/// googlevideo answers a stream URL without the PO token it requires with 403.
#[derive(Debug, thiserror::Error)]
#[error("YouTube 返回 403：请重新连接已登录的浏览器；若仍失败，该视频当前需要 PO Token")]
struct StreamForbidden;

fn is_stream_forbidden(error: &anyhow::Error) -> bool {
    error.downcast_ref::<StreamForbidden>().is_some()
}

const RANGE_CHUNK: u64 = 10 * 1024 * 1024;

/// One task bar over several sequential streams: each stream's bytes count after `offset`.
fn offset_progress(progress: &ProgressSink, offset: u64, total: u64) -> ProgressSink {
    let progress = progress.clone();
    Arc::new(move |done, _| {
        let done = offset + done;
        progress(done, if total > 0 { total.max(done) } else { 0 });
    })
}

#[async_trait]
impl MusicProvider for YoutubeProvider {
    fn platform(&self) -> Platform {
        Platform::Youtube
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Video downloads are direct (ANDROID streams, muxed by kdj-media); nothing has to be
            // prepared by the webview any more.
            external_download_preparation: false,
            search_kinds: YOUTUBE_SEARCH_KINDS,
            ..Capabilities::VIDEO
        }
    }

    async fn account(&self) -> Account {
        let mut account = self.cached_account_snapshot();
        if account.state != AccountState::Valid {
            return account;
        }
        let Some(session) = self.auth.snapshot() else { return self.cached_account_snapshot(); };
        let library = self.client.account_playlist_directory().await;
        if !self.auth.is_current(&session) { return self.cached_account_snapshot(); }
        match library {
            Ok(_) => {
                let profile = self.client.account_menu(&session).await
                    .and_then(|body| crate::youtubemusic::account_profile::AccountProfile::from_menu(&body));
                match profile {
                    Ok(profile) => {
                        match self.auth.save_profile(&session, &profile) {
                            Ok(false) => return self.cached_account_snapshot(),
                            Err(_) => account.detail.push_str(" · 账号资料缓存保存失败"),
                            Ok(true) => {}
                        }
                        account.nickname = profile.nickname;
                        account.avatar = profile.avatar;
                    }
                    Err(_) => account.detail.push_str(" · 账号资料读取失败"),
                }
                if !self.auth.is_current(&session) { return self.cached_account_snapshot(); }
                account
            },
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
        self.cached_account_snapshot()
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
        if keyword.is_empty() || !self.ctx.youtube_enabled() {
            return Ok(Vec::new());
        }
        let limit = effective_limit(limit, 20);
        let body = self.client.search(keyword).await?;
        let mut rows = Vec::new();
        collect_video_renderers(&body, &mut rows, limit);
        Ok(rows)
    }

    async fn search_collections(
        &self,
        _keyword: &str,
        _kind: SearchKind,
        _limit: usize,
    ) -> Result<Vec<CollectionResult>> {
        // 普通关键词搜索返回视频；播放列表通过 URL 完整展开。
        Ok(Vec::new())
    }

    async fn resolve_collection(
        &self,
        kind: SearchKind,
        key: &str,
        limit: usize,
    ) -> Result<Option<CollectionResolveResponse>> {
        if kind != SearchKind::Playlist || key.trim().is_empty() {
            return Ok(None);
        }
        self.ensure_enabled()?;
        let limit = full_listing(limit);
        let (title, sources) = self.playlist_sources(key, limit).await?;
        Ok(Some(CollectionResolveResponse {
            kind,
            platform: Platform::Youtube,
            title,
            sources,
        }))
    }

    async fn stream_playlists(&self) -> Result<Vec<StreamPlaylist>> {
        // 侧栏账号浏览与「下载源」开关正交；开关只门禁搜索、解析和下载。
        if !self.auth.is_logged_in() {
            return Ok(Vec::new());
        }
        self.library_playlists().await
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
        let (title, sources) = self.playlist_sources(key, full_listing(limit)).await?;
        Ok(Some(StreamPlaylistResponse {
            platform: Platform::Youtube,
            key: key.to_string(),
            title,
            sources,
        }))
    }

    async fn remove_stream_playlist_track(&self, key: &str, source: &SongSource) -> Result<()> {
        anyhow::ensure!(self.auth.is_logged_in(), "请先连接 YouTube 登录态");
        anyhow::ensure!(source.platform == Platform::Youtube, "歌曲来源不是 YouTube");
        let playlist_id = key.trim().trim_start_matches("VL");
        let video_id = source.key.trim();
        // 普通 YouTube 目录目前只能可靠证明 LL 的写语义：它是账号 Like 状态的
        // 投影视图。其它列表尚不能稳定区分“本人创建”和“收藏”，因此拒绝猜测。
        anyhow::ensure!(playlist_id == "LL", "这个 YouTube 播放列表暂不支持移除歌曲");
        anyhow::ensure!(!video_id.is_empty(), "YouTube 视频 ID 为空");
        let playlists = self.stream_playlists().await?;
        anyhow::ensure!(
            playlists
                .iter()
                .any(|playlist| playlist.key == "LL" && playlist.origin == "favorite"),
            "当前账号目录里没有 YouTube 喜欢的视频"
        );
        let mut body = YoutubeClient::web_context();
        body.as_object_mut()
            .expect("WEB context is an object")
            .insert("target".into(), json!({"videoId": video_id}));
        self.client
            .post_web("like/removelike", &body)
            .await
            .context("从 YouTube 喜欢的视频中移除失败")?;
        Ok(())
    }

    async fn resolve(&self, url: &str, limit: usize) -> Result<Option<ResolveResponse>> {
        let Some(target) = parse_youtube_url(url) else {
            return Ok(None);
        };
        self.ensure_enabled()?;
        match target {
            YoutubeTarget::Video(id) => {
                let source = self.video_source(&id).await?;
                Ok(Some(ResolveResponse {
                    kind: ResolveKind::Song,
                    platform: Platform::Youtube,
                    title: source.title.clone(),
                    sources: vec![source],
                }))
            }
            YoutubeTarget::Playlist(id) => {
                let (title, sources) = self.playlist_sources(&id, full_listing(limit)).await?;
                Ok(Some(ResolveResponse {
                    kind: ResolveKind::Playlist,
                    platform: Platform::Youtube,
                    title,
                    sources,
                }))
            }
        }
    }

    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        let mut req = VideoDownloadRequest {
            platform: Platform::Youtube,
            bvid: job.source.key.clone(),
            max_height: job
                .source
                .payload
                .get("max_height")
                .and_then(Value::as_i64)
                .unwrap_or(1080),
            audio_only: job
                .source
                .payload
                .get("audio_only")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            transcode: job
                .source
                .payload
                .get("transcode")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            title: job.source.title.clone(),
            artist: job.source.artist_text(),
            cover: job.source.cover.clone(),
            ..Default::default()
        };
        // 音频下载管线里的 YouTube 来源默认取音频；视频结果批量入口会显式写 false。
        if !job.source.payload.contains_key("audio_only") {
            req.audio_only = true;
        }
        let path = self
            .download_video(&req, &job.cancel, &job.progress)
            .await?;
        if req.audio_only {
            let cover = if job.source.cover.is_empty() {
                None
            } else {
                match self.client.http().get(&job.source.cover).send().await {
                    Ok(response) if response.status().is_success() => {
                        response.bytes().await.ok().map(|bytes| bytes.to_vec())
                    }
                    _ => None,
                }
            };
            let artists = if job.source.artists.is_empty() {
                vec!["Unknown".into()]
            } else {
                job.source.artists.clone()
            };
            if let Err(err) = tags::embed_metadata(
                &path,
                &job.source.title,
                &artists,
                &job.source.album,
                cover.as_deref(),
            ) {
                tracing::warn!("YouTube 写标签失败 video={}: {err}", job.source.key);
            }
        }
        Ok(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum YoutubeTarget {
    Video(String),
    Playlist(String),
}

fn parse_youtube_url(text: &str) -> Option<YoutubeTarget> {
    let parsed = url::Url::parse(text.trim()).ok()?;
    let host = parsed
        .host_str()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "music.youtube.com" {
        return None;
    }
    if host != "youtu.be" && host != "youtube.com" && !host.ends_with(".youtube.com") {
        return None;
    }
    let path = parsed.path();
    if host == "youtu.be" {
        return valid_video_id(path.trim_matches('/')).map(YoutubeTarget::Video);
    }
    if let Some(id) = path.strip_prefix("/shorts/") {
        return valid_video_id(id.trim_matches('/')).map(YoutubeTarget::Video);
    }
    let query: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if path.starts_with("/playlist") {
        return query
            .get("list")
            .filter(|id| !id.is_empty())
            .cloned()
            .map(YoutubeTarget::Playlist);
    }
    if path.ends_with("/watch") {
        if let Some(video) = query.get("v").and_then(|id| valid_video_id(id)) {
            return Some(YoutubeTarget::Video(video));
        }
        return query
            .get("list")
            .filter(|id| !id.is_empty())
            .cloned()
            .map(YoutubeTarget::Playlist);
    }
    None
}

fn valid_video_id(text: &str) -> Option<String> {
    (text.len() == 11
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
    .then(|| text.to_string())
}

fn video_id_from_input(text: &str) -> Result<String> {
    let text = text.trim();
    if let Some(id) = valid_video_id(text) {
        return Ok(id);
    }
    match parse_youtube_url(text) {
        Some(YoutubeTarget::Video(id)) => Ok(id),
        Some(YoutubeTarget::Playlist(_)) => bail!("这里需要单个 YouTube 视频，不是播放列表"),
        None => bail!("YouTube 视频链接或 ID 无效"),
    }
}

fn web_client_version() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("2.{year:04}{month:02}{day:02}.00.00")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn renderer_text(value: &Value) -> String {
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

fn renderer_count(value: &Value) -> usize {
    fn text_count(text: &str) -> usize {
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
    for field in [
        "videoCountText",
        "videoCountShortText",
        "thumbnailText",
        "videoCount",
    ] {
        let count = value
            .get(field)
            .map(renderer_text)
            .map_or(0, |text| text_count(&text));
        if count > 0 {
            return count;
        }
    }
    fn visit(value: &Value) -> usize {
        match value {
            Value::String(text)
                if text.contains("视频") || text.to_ascii_lowercase().contains("video") =>
            {
                text_count(text)
            }
            Value::Object(map) => map
                .values()
                .map(visit)
                .find(|count| *count > 0)
                .unwrap_or(0),
            Value::Array(items) => items
                .iter()
                .map(visit)
                .find(|count| *count > 0)
                .unwrap_or(0),
            _ => 0,
        }
    }
    visit(value)
}

fn renderer_thumbnail(value: &Value) -> String {
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

fn youtube_playlist_renderer(renderer: &Value) -> Option<StreamPlaylist> {
    let key = renderer.get("playlistId").and_then(Value::as_str)?.trim();
    let title = renderer.get("title").map(renderer_text).unwrap_or_default();
    if key.is_empty() || title.is_empty() {
        return None;
    }
    let favorite = key == "LL";
    Some(StreamPlaylist {
        platform: Platform::Youtube,
        key: key.to_string(),
        title,
        cover: renderer_thumbnail(renderer),
        count: renderer_count(renderer),
        is_favorite: favorite,
        origin: if favorite { "favorite" } else { "other" }.into(),
    })
}

fn youtube_playlist_lockup(lockup: &Value) -> Option<StreamPlaylist> {
    if lockup.get("contentType").and_then(Value::as_str) != Some("LOCKUP_CONTENT_TYPE_PLAYLIST") {
        return None;
    }
    let key = lockup.get("contentId").and_then(Value::as_str)?.trim();
    let title = lockup
        .pointer("/metadata/lockupMetadataViewModel/title")
        .map(renderer_text)
        .unwrap_or_default();
    if key.is_empty() || title.is_empty() {
        return None;
    }
    let favorite = key == "LL";
    Some(StreamPlaylist {
        platform: Platform::Youtube,
        key: key.to_string(),
        title,
        cover: renderer_thumbnail(lockup.get("contentImage").unwrap_or(&Value::Null)),
        count: renderer_count(lockup),
        is_favorite: favorite,
        origin: if favorite { "favorite" } else { "other" }.into(),
    })
}

fn youtube_library_playlists(body: &Value) -> Vec<StreamPlaylist> {
    fn visit(value: &Value, playlists: &mut Vec<StreamPlaylist>) {
        match value {
            Value::Object(map) => {
                let parsed = map
                    .get("gridPlaylistRenderer")
                    .or_else(|| map.get("playlistRenderer"))
                    .and_then(youtube_playlist_renderer)
                    .or_else(|| map.get("lockupViewModel").and_then(youtube_playlist_lockup));
                if let Some(playlist) = parsed {
                    if !playlists.iter().any(|item| item.key == playlist.key) {
                        playlists.push(playlist);
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

fn youtube_playlist_video_renderer(renderer: &Value) -> Option<SongSource> {
    let id = renderer
        .get("videoId")
        .and_then(Value::as_str)
        .and_then(valid_video_id)?;
    let title = renderer
        .get("title")
        .map(renderer_text)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| id.clone());
    let artist = renderer
        .get("shortBylineText")
        .map(renderer_text)
        .unwrap_or_default();
    let duration = renderer
        .get("lengthText")
        .map(renderer_text)
        .and_then(|text| parse_clock_seconds(&text));
    let cover = renderer_thumbnail(renderer.get("thumbnail").unwrap_or(&Value::Null));
    let mut payload = serde_json::Map::new();
    payload.insert("video_id".into(), json!(id));
    payload.insert("audio_only".into(), json!(false));
    Some(SongSource {
        platform: Platform::Youtube,
        key: id,
        title,
        artists: if artist.is_empty() {
            Vec::new()
        } else {
            vec![artist]
        },
        album: String::new(),
        duration,
        cover,
        max_quality: None,
        vip: false,
        payload,
    })
}

fn collect_playlist_lockups(value: &Value, out: &mut Vec<SongSource>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    match value {
        Value::Object(map) => {
            if let Some(renderer) = map
                .get("videoRenderer")
                .or_else(|| map.get("compactVideoRenderer"))
            {
                if let Some(source) = youtube_playlist_video_renderer(renderer) {
                    if !out.iter().any(|item| item.key == source.key) {
                        out.push(source);
                    }
                }
                return;
            }
            if let Some(renderer) = map.get("playlistVideoRenderer") {
                if let Some(source) = youtube_playlist_video_renderer(renderer) {
                    if !out.iter().any(|item| item.key == source.key) {
                        out.push(source);
                    }
                }
                return;
            }
            if let Some(lockup) = map.get("lockupViewModel") {
                if lockup.get("contentType").and_then(Value::as_str)
                    == Some("LOCKUP_CONTENT_TYPE_VIDEO")
                {
                    if let Some(id) = lockup
                        .get("contentId")
                        .and_then(Value::as_str)
                        .and_then(valid_video_id)
                    {
                        if !out.iter().any(|source| source.key == id) {
                            let title = lockup
                                .pointer("/metadata/lockupMetadataViewModel/title/content")
                                .and_then(Value::as_str)
                                .unwrap_or(&id)
                                .to_string();
                            let artist = lockup
                                .pointer("/metadata/lockupMetadataViewModel/metadata/contentMetadataViewModel/metadataRows/0/metadataParts/0/text/content")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                            let cover = lockup
                                .pointer("/contentImage/thumbnailViewModel/image/sources")
                                .and_then(Value::as_array)
                                .and_then(|items| {
                                    items.iter().max_by_key(|item| {
                                        item.get("width").and_then(Value::as_u64).unwrap_or(0)
                                            * item
                                                .get("height")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0)
                                    })
                                })
                                .and_then(|item| item.get("url"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let duration = first_badge_text(lockup).and_then(parse_clock_seconds);
                            let mut payload = serde_json::Map::new();
                            payload.insert("video_id".into(), json!(id));
                            payload.insert("audio_only".into(), json!(false));
                            out.push(SongSource {
                                platform: Platform::Youtube,
                                key: id,
                                title,
                                artists: if artist.is_empty() {
                                    Vec::new()
                                } else {
                                    vec![artist]
                                },
                                album: String::new(),
                                duration,
                                cover,
                                max_quality: None,
                                vip: false,
                                payload,
                            });
                        }
                    }
                }
                return;
            }
            for child in map.values() {
                collect_playlist_lockups(child, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_playlist_lockups(child, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn collect_video_renderers(value: &Value, out: &mut Vec<SongSource>, limit: usize) {
    collect_playlist_lockups(value, out, limit);
}

fn playlist_continuation(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => {
            let has_video = items.iter().any(|item| {
                item.get("playlistVideoRenderer").is_some()
                    || item
                        .get("lockupViewModel")
                        .and_then(|lockup| lockup.get("contentType"))
                        .and_then(Value::as_str)
                        == Some("LOCKUP_CONTENT_TYPE_VIDEO")
            });
            if has_video {
                for item in items {
                    if let Some(token) = item
                        .pointer("/continuationItemViewModel/continuationCommand/innertubeCommand/continuationCommand/token")
                        .or_else(|| item.pointer("/continuationItemRenderer/continuationEndpoint/continuationCommand/token"))
                        .and_then(Value::as_str)
                        .filter(|token| !token.is_empty())
                    {
                        return Some(token.to_string());
                    }
                }
            }
            items.iter().find_map(playlist_continuation)
        }
        Value::Object(map) => map.values().find_map(playlist_continuation),
        _ => None,
    }
}

fn first_badge_text(value: &Value) -> Option<&str> {
    match value {
        Value::Object(map) => {
            if let Some(text) = map
                .get("thumbnailBadgeViewModel")
                .and_then(|badge| badge.get("text"))
                .and_then(Value::as_str)
            {
                return Some(text);
            }
            map.values().find_map(first_badge_text)
        }
        Value::Array(items) => items.iter().find_map(first_badge_text),
        _ => None,
    }
}

fn parse_clock_seconds(text: &str) -> Option<f64> {
    let parts: Vec<u64> = text
        .split(':')
        .map(str::trim)
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    match parts.as_slice() {
        [minutes, seconds] => Some((minutes * 60 + seconds) as f64),
        [hours, minutes, seconds] => Some((hours * 3600 + minutes * 60 + seconds) as f64),
        _ => None,
    }
}

fn source_from_details(details: &VideoDetails) -> SongSource {
    let mut payload = serde_json::Map::new();
    payload.insert("video_id".into(), json!(details.video_id));
    payload.insert("audio_only".into(), json!(false));
    SongSource {
        platform: Platform::Youtube,
        key: details.video_id.clone(),
        title: details.title.clone(),
        artists: if details.owner_channel_name.trim().is_empty() {
            Vec::new()
        } else {
            vec![details.owner_channel_name.clone()]
        },
        album: String::new(),
        duration: details
            .length_seconds
            .parse::<f64>()
            .ok()
            .filter(|duration| *duration > 0.0),
        cover: best_thumbnail(&details.thumbnails),
        max_quality: None,
        vip: false,
        payload,
    }
}

fn best_thumbnail(items: &[Thumbnail]) -> String {
    items
        .iter()
        .max_by_key(|item| item.width.saturating_mul(item.height))
        .map(|item| item.url.clone())
        .unwrap_or_default()
}

fn source_from_watch_metadata(body: &Value, video_id: &str) -> Option<SongSource> {
    if body
        .pointer("/currentVideoEndpoint/watchEndpoint/videoId")?
        .as_str()?
        != video_id
    {
        return None;
    }
    if let Some(items) = body
        .pointer("/contents/twoColumnWatchNextResults/playlist/playlist/contents")
        .and_then(Value::as_array)
    {
        for item in items {
            let renderer = item.get("playlistPanelVideoRenderer").or_else(|| {
                item.pointer(
                    "/playlistPanelVideoWrapperRenderer/primaryRenderer/playlistPanelVideoRenderer",
                )
            });
            if let Some(source) = renderer.and_then(youtube_playlist_video_renderer) {
                if source.key == video_id {
                    return Some(source);
                }
            }
        }
    }
    // Some videos cannot create a Mix but still have a normal watch-page metadata section.
    let contents = body
        .pointer("/contents/twoColumnWatchNextResults/results/results/contents")?
        .as_array()?;
    let title = contents
        .iter()
        .find_map(|item| item.pointer("/videoPrimaryInfoRenderer/title"))
        .map(renderer_text)
        .filter(|title| !title.is_empty())?;
    let author = contents
        .iter()
        .find_map(|item| {
            item.pointer("/videoSecondaryInfoRenderer/owner/videoOwnerRenderer/title")
        })
        .map(renderer_text)
        .unwrap_or_default();
    youtube_playlist_video_renderer(&json!({
        "videoId": video_id,
        "title": { "simpleText": title },
        "shortBylineText": { "simpleText": author },
        "thumbnail": { "thumbnails": [{ "url": format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg") }] }
    }))
}

fn native_audio_format(formats: &[VideoFormat]) -> Option<VideoFormat> {
    let usable = |format: &&VideoFormat| !format.url.is_empty() && !format.is_live;
    formats
        .iter()
        .filter(usable)
        .filter(|format| format.has_audio && !format.has_video)
        .filter(|format| format.mime_type.container.eq_ignore_ascii_case("mp4"))
        .filter(|format| {
            format
                .mime_type
                .audio_codec
                .as_deref()
                .is_some_and(|codec| codec.to_ascii_lowercase().starts_with("mp4a"))
        })
        .max_by_key(|format| format.audio_bitrate.unwrap_or(format.bitrate))
        .cloned()
}

fn is_h264(format: &VideoFormat) -> bool {
    format.mime_type.video_codec.as_deref().is_some_and(|codec| {
        let codec = codec.to_ascii_lowercase();
        codec.starts_with("avc1") || codec.starts_with("avc3")
    })
}

/// The tallest H.264 MP4 video track within `max_height` and the best AAC track, for a stream
/// copy into one MP4. VP9/AV1 tracks are not taken: the result must play through the system
/// decoders on every platform, and YouTube offers H.264 up to 1080p.
fn adaptive_h264_aac_pair(
    formats: &[VideoFormat],
    max_height: i64,
) -> Option<(VideoFormat, VideoFormat)> {
    let ceiling = max_height.max(1) as u64;
    let video = formats
        .iter()
        .filter(|format| !format.url.is_empty() && !format.is_live)
        .filter(|format| format.has_video && !format.has_audio)
        .filter(|format| format.mime_type.container.eq_ignore_ascii_case("mp4"))
        .filter(|format| is_h264(format))
        .filter(|format| format.height.unwrap_or(0) <= ceiling)
        .max_by_key(|format| (format.height.unwrap_or(0), format.bitrate))
        .cloned()?;
    Some((video, native_audio_format(formats)?))
}

fn native_progressive_mp4(formats: &[VideoFormat], max_height: i64) -> Option<VideoFormat> {
    let usable = |format: &&VideoFormat| !format.url.is_empty() && !format.is_live;
    let ceiling = max_height.max(1) as u64;
    formats
        .iter()
        .filter(usable)
        .filter(|format| format.has_video && format.has_audio)
        .filter(|format| format.height.unwrap_or(0) <= ceiling)
        .filter(|format| format.mime_type.container.eq_ignore_ascii_case("mp4"))
        .filter(|format| {
            format
                .mime_type
                .video_codec
                .as_deref()
                .is_some_and(|codec| {
                    let codec = codec.to_ascii_lowercase();
                    codec.starts_with("avc1") || codec.starts_with("avc3")
                })
        })
        .filter(|format| {
            format
                .mime_type
                .audio_codec
                .as_deref()
                .is_some_and(|codec| codec.to_ascii_lowercase().starts_with("mp4a"))
        })
        .max_by_key(|format| (format.height.unwrap_or(0), format.bitrate))
        .cloned()
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[async_trait]
impl VideoProvider for YoutubeProvider {
    fn platform(&self) -> Platform {
        Platform::Youtube
    }

    async fn resolve_video(&self, input: &str) -> Result<VideoInfo> {
        YoutubeProvider::resolve_video(self, input).await
    }

    async fn preview_stream(
        &self,
        input: &str,
        _page_index: usize,
        max_height: i64,
        track: VideoPreviewTrack,
        range: Option<&str>,
    ) -> Result<VideoPreviewStream> {
        YoutubeProvider::preview_stream_at_height(self, input, max_height, track, range).await
    }

    async fn download_video(
        &self,
        request: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<PathBuf> {
        YoutubeProvider::download_video(self, request, cancel, progress).await
    }

    async fn download_video_prepared(
        &self,
        request: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
        prepared_source_url: Option<&str>,
    ) -> Result<PathBuf> {
        // Downloads are no longer prepared outside (the Safari HLS manifest is gone); a source
        // that still arrives, from an older task, is used as before.
        self.download_video_with_source(request, cancel, progress, prepared_source_url)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_hls_download_source_must_be_a_single_loopback_capability() {
        let ticket = "a".repeat(64);
        let valid =
            format!("http://127.0.0.1:41234/api/video/youtube/hls/{ticket}?kdj_media_token=secret");
        assert_eq!(validated_local_youtube_hls_url(&valid).unwrap(), valid);
        for invalid in [
            format!(
                "https://127.0.0.1:41234/api/video/youtube/hls/{ticket}?kdj_media_token=secret"
            ),
            format!(
                "http://example.com:41234/api/video/youtube/hls/{ticket}?kdj_media_token=secret"
            ),
            format!(
                "http://127.0.0.1:41234/api/video/youtube/hls/{ticket}?kdj_media_token=secret&extra=1"
            ),
            format!("http://127.0.0.1:41234/api/video/youtube/hls/{ticket}"),
        ] {
            assert!(validated_local_youtube_hls_url(&invalid).is_err());
        }
    }

    #[tokio::test]
    async fn cached_account_keeps_login_visible_when_download_source_is_disabled() {
        use crate::provider::ProviderLiveSettings;
        use crate::youtubemusic::auth::BrowserSession;

        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-account-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let ctx = ProviderContext::new(
            root.clone(),
            ProviderLiveSettings {
                download_dir: root.join("downloads"),
                filename_template: "{title}".into(),
                default_quality: kdj_core::models::Quality::Q128,
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
        let auth = Arc::new(YoutubeAuth::new(&ctx, Platform::Youtube).unwrap());
        auth.save(BrowserSession {
            cookie: "SAPISID=test-session".into(),
            x_goog_authuser: "2".into(),
            user_agent: USER_AGENT.into(),
            visitor_data: String::new(),
            imported_from: "测试浏览器".into(),
            created_at: 1,
        })
        .unwrap();
        let provider = YoutubeProvider::new(ctx, auth).unwrap();

        let account = provider.cached_account().await;
        assert_eq!(account.state, AccountState::Valid);
        assert_eq!(account.account_key, "2");
        assert_eq!(account.credential_kind, "browser_session");
        assert_eq!(account.detail, "", "已登录的一行不写登录来源");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn direct_download_batches_small_network_chunks() {
        use crate::provider::ProviderLiveSettings;
        use tokio::io::AsyncReadExt as _;
        const CHUNK: usize = 16 * 1024;
        const CHUNKS: usize = 256; // 4 MiB

        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-direct-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let _cleanup = TempDirGuard(root.clone());
        std::fs::create_dir_all(&root).unwrap();
        let ctx = ProviderContext::new(
            root.clone(),
            ProviderLiveSettings {
                download_dir: root.join("downloads"),
                filename_template: "{title}".into(),
                default_quality: kdj_core::models::Quality::Q128,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: false,
                youtube_enabled: true,
                video_dir: None,
                video_format: "mp4".into(),
            },
        );
        let auth = Arc::new(YoutubeAuth::new(&ctx, Platform::Youtube).unwrap());
        let mut provider = YoutubeProvider::new(ctx, auth).unwrap();
        provider.client.set_test_http(reqwest::Client::builder().no_proxy().build().unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/videoplayback", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 8192];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            // Chunked framing keeps every body frame the client sees at <= 16 KiB.
            let mut frame = format!("{CHUNK:x}\r\n").into_bytes();
            frame.extend(std::iter::repeat_n(7u8, CHUNK));
            frame.extend_from_slice(b"\r\n");
            for _ in 0..CHUNKS { stream.write_all(&frame).await.unwrap(); }
            stream.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let output = root.join("direct.part");
        // Unbuffered, the file trails the network by at most one 16 KiB chunk (one write per chunk,
        // ~3700 write(2) for 50 MiB under strace); the 512 KiB download buffer lets it trail far more.
        let lag = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let (seen, path) = (lag.clone(), output.clone());
        let progress: ProgressSink = Arc::new(move |done, _| {
            let on_disk = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            seen.fetch_max(done.saturating_sub(on_disk), std::sync::atomic::Ordering::Relaxed);
        });
        let format = VideoFormat { url, ..Default::default() };
        provider.fetch_format(&format, &output, &CancellationToken::new(), &progress).await.unwrap();
        assert_eq!(std::fs::metadata(&output).unwrap().len(), (CHUNK * CHUNKS) as u64);
        let lag = lag.load(std::sync::atomic::Ordering::Relaxed);
        assert!(lag >= 256 * 1024, "writes are not batched: file trailed the stream by only {lag} B");
    }

    #[tokio::test]
    async fn prepared_hls_download_does_not_request_legacy_player_metadata() {
        use crate::provider::ProviderLiveSettings;
        use std::time::Duration;
        use tokio::io::AsyncReadExt as _;

        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-prepared-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let _cleanup = TempDirGuard(root.clone());
        let ctx = ProviderContext::new(
            root.clone(),
            ProviderLiveSettings {
                download_dir: root.join("downloads"),
                filename_template: "{title}".into(),
                default_quality: kdj_core::models::Quality::Q128,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: true,
                youtube_enabled: true,
                video_dir: Some(root.join("videos")),
                video_format: "mp4".into(),
            },
        );
        let auth = Arc::new(YoutubeAuth::new(&ctx, Platform::Youtube).unwrap());
        let mut provider = YoutubeProvider::new(ctx, auth).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        // Every legacy API request is trapped by this local proxy, never sent to YouTube.
        provider.client.set_test_http(
            reqwest::Client::builder()
                .no_proxy()
                .proxy(reqwest::Proxy::all(&origin).unwrap())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 8192];
            let length = stream.read(&mut request).await.unwrap();
            stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            String::from_utf8_lossy(&request[..length]).into_owned()
        });
        let req = VideoDownloadRequest {
            platform: Platform::Youtube,
            bvid: "abcDEF12345".into(),
            // Even missing display metadata must not cause an extra player request.
            title: String::new(),
            ..Default::default()
        };
        let progress: ProgressSink = Arc::new(|_, _| {});
        let cancel = CancellationToken::new();
        let invalid = provider.download_video_with_source(
            &req, &cancel, &progress, Some("https://example.com/untrusted.m3u8"),
        ).await.unwrap_err();
        assert!(invalid.to_string().contains("不受信任"));
        let source = format!("{origin}/api/video/youtube/hls/{}?kdj_media_token=test", "a".repeat(64));
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            provider.download_video_with_source(&req, &cancel, &progress, Some(&source)),
        ).await;
        assert!(outcome.unwrap().is_err(), "the fixture deliberately rejects the HLS request");
        let request = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
        assert!(request.starts_with("GET /api/video/youtube/hls/"), "must request HLS, not CONNECT to the legacy player");
        assert_eq!(std::fs::read_dir(root.join("videos")).unwrap().count(), 0);
    }

    #[test]
    fn music_and_video_hosts_do_not_overlap() {
        assert_eq!(
            parse_youtube_url("https://music.youtube.com/watch?v=abcDEF12345"),
            None
        );
        assert_eq!(
            parse_youtube_url("https://www.youtube.com/watch?v=abcDEF12345"),
            Some(YoutubeTarget::Video("abcDEF12345".into()))
        );
        assert_eq!(
            parse_youtube_url("https://youtu.be/abcDEF12345?t=2"),
            Some(YoutubeTarget::Video("abcDEF12345".into()))
        );
        assert_eq!(
            parse_youtube_url("https://youtube.com/shorts/abcDEF12345"),
            Some(YoutubeTarget::Video("abcDEF12345".into()))
        );
    }

    #[test]
    fn playlist_links_are_owned_by_video_provider() {
        assert_eq!(
            parse_youtube_url("https://www.youtube.com/playlist?list=PLxyz"),
            Some(YoutubeTarget::Playlist("PLxyz".into()))
        );
    }

    #[test]
    fn video_entry_points_normalize_urls_before_calling_innertube() {
        assert_eq!(
            video_id_from_input("https://www.youtube.com/watch?v=abcDEF12345").unwrap(),
            "abcDEF12345"
        );
        assert_eq!(video_id_from_input("abcDEF12345").unwrap(), "abcDEF12345");
        assert!(video_id_from_input("https://www.youtube.com/playlist?list=PLxyz").is_err());
    }

    #[test]
    fn playlist_directory_accepts_legacy_and_current_renderers() {
        let body = json!({"items": [
            {"gridPlaylistRenderer": {
                "playlistId": "LL",
                "title": {"runs": [{"text": "喜欢的视频"}]},
                "videoCountText": {"simpleText": "1,234 个视频"},
                "thumbnail": {"thumbnails": [
                    {"url": "https://i.ytimg.com/small.jpg", "width": 120, "height": 90},
                    {"url": "https://i.ytimg.com/large.jpg", "width": 480, "height": 360}
                ]}
            }},
            {"lockupViewModel": {
                "contentId": "PLSECOND",
                "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST",
                "contentImage": {"collectionThumbnailViewModel": {"primaryThumbnail": {
                    "thumbnailViewModel": {"image": {"sources": [
                        {"url": "https://i.ytimg.com/second.jpg", "width": 336, "height": 188}
                    ]}}
                }}},
                "metadata": {"lockupMetadataViewModel": {
                    "title": {"content": "第二个列表"},
                    "metadata": {"contentMetadataViewModel": {"metadataRows": [{
                        "metadataParts": [{"text": {"content": "42 个视频"}}]
                    }]}}
                }}
            }},
            {"playlistRenderer": {
                "playlistId": "PLSECOND",
                "title": {"simpleText": "重复项"}
            }}
        ]});
        let playlists = youtube_library_playlists(&body);
        assert_eq!(playlists.len(), 2);
        assert!(playlists[0].is_favorite);
        assert_eq!(playlists[0].origin, "favorite");
        assert_eq!(playlists[0].count, 1_234);
        assert_eq!(playlists[0].cover, "https://i.ytimg.com/large.jpg");
        assert_eq!(playlists[1].title, "第二个列表");
        assert_eq!(playlists[1].count, 42);
    }

    #[test]
    fn current_playlist_lockups_and_continuation_are_parsed() {
        let body = json!({
            "contents": [{
                "lockupViewModel": {
                    "contentId": "abcDEF12345",
                    "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
                    "contentImage": {"thumbnailViewModel": {"image": {"sources": [
                        {"url": "https://i.ytimg.com/x.jpg", "width": 336, "height": 188}
                    ]}, "overlays": [{"thumbnailBadgeViewModel": {"text": "1:02"}}]}},
                    "metadata": {"lockupMetadataViewModel": {
                        "title": {"content": "Video title"},
                        "metadata": {"contentMetadataViewModel": {"metadataRows": [{
                            "metadataParts": [{"text": {"content": "Channel"}}]
                        }]}}
                    }}
                }
            }, {
                "continuationItemViewModel": {"continuationCommand": {"innertubeCommand": {
                    "continuationCommand": {"token": "next-page"}
                }}}
            }]
        });
        let mut sources = Vec::new();
        collect_playlist_lockups(&body, &mut sources, usize::MAX);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].title, "Video title");
        assert_eq!(sources[0].artists, vec!["Channel"]);
        assert_eq!(sources[0].duration, Some(62.0));
        assert_eq!(playlist_continuation(&body).as_deref(), Some("next-page"));
    }

    #[test]
    fn legacy_playlist_video_renderers_are_parsed() {
        let body = json!({"contents": [{
            "playlistVideoRenderer": {
                "videoId": "abcDEF12345",
                "title": {"runs": [{"text": "Watch later video"}]},
                "shortBylineText": {"runs": [{"text": "Channel"}]},
                "lengthText": {"simpleText": "6:57:15"},
                "thumbnail": {"thumbnails": [
                    {"url": "https://i.ytimg.com/small.jpg", "width": 120, "height": 90},
                    {"url": "https://i.ytimg.com/large.jpg", "width": 480, "height": 360}
                ]}
            }
        }, {
            "continuationItemRenderer": {"continuationEndpoint": {
                "continuationCommand": {"token": "legacy-next"}
            }}
        }]});
        let mut sources = Vec::new();
        collect_playlist_lockups(&body, &mut sources, usize::MAX);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].title, "Watch later video");
        assert_eq!(sources[0].artists, vec!["Channel"]);
        assert_eq!(sources[0].duration, Some(25_035.0));
        assert_eq!(sources[0].cover, "https://i.ytimg.com/large.jpg");
        assert_eq!(playlist_continuation(&body).as_deref(), Some("legacy-next"));
    }

    #[test]
    fn native_format_selection_requires_mp4_compatible_codecs() {
        let format = |height: u64,
                      video: bool,
                      audio: bool,
                      bitrate: u64,
                      container: &str,
                      video_codec: Option<&str>,
                      audio_codec: Option<&str>| VideoFormat {
            itag: height,
            mime_type: MediaMime {
                container: container.into(),
                video_codec: video_codec.map(str::to_string),
                audio_codec: audio_codec.map(str::to_string),
            },
            bitrate,
            height: Some(height),
            content_length: None,
            init_range: None,
            index_range: None,
            approx_duration_ms: None,
            quality_label: Some(format!("{height}p")),
            audio_bitrate: None,
            cipher: String::new(),
            url: "https://cdn.example/x".into(),
            has_video: video,
            has_audio: audio,
            is_live: false,
        };
        let formats = vec![
            format(1080, true, true, 40, "webm", Some("vp9"), Some("opus")),
            format(
                720,
                true,
                true,
                20,
                "mp4",
                Some("avc1.4d401f"),
                Some("mp4a.40.2"),
            ),
            format(0, false, true, 30, "mp4", None, Some("mp4a.40.2")),
            format(0, false, true, 50, "webm", None, Some("opus")),
        ];
        assert_eq!(
            native_progressive_mp4(&formats, 720).unwrap().height,
            Some(720)
        );
        assert_eq!(native_audio_format(&formats).unwrap().bitrate, 30);
    }

    fn stream(itag: u64, mime: &str, height: Option<u64>, bitrate: u64) -> VideoFormat {
        let (container, codecs) = mime.split_once(' ').unwrap();
        let codec = |prefixes: &[&str]| {
            codecs
                .split(',')
                .find(|codec| prefixes.iter().any(|prefix| codec.starts_with(prefix)))
                .map(str::to_string)
        };
        let video_codec = codec(&["avc", "vp", "av01"]);
        let audio_codec = codec(&["mp4a", "opus"]);
        VideoFormat {
            itag,
            mime_type: MediaMime {
                container: container.into(),
                video_codec: video_codec.clone(),
                audio_codec: audio_codec.clone(),
            },
            bitrate,
            height,
            url: format!("https://cdn.example/{itag}"),
            has_video: video_codec.is_some(),
            has_audio: audio_codec.is_some(),
            ..Default::default()
        }
    }

    #[test]
    fn direct_download_pairs_the_tallest_h264_track_within_the_ceiling_with_aac() {
        let formats = vec![
            stream(18, "mp4 avc1.42001E,mp4a.40.2", Some(360), 500),
            stream(137, "mp4 avc1.640028", Some(1080), 4000),
            stream(299, "mp4 avc1.64002a", Some(1080), 6000),
            stream(136, "mp4 avc1.4d401f", Some(720), 2000),
            stream(248, "webm vp9", Some(1080), 3000),
            stream(313, "webm vp9", Some(2160), 9000),
            stream(140, "mp4 mp4a.40.2", None, 128),
            stream(139, "mp4 mp4a.40.5", None, 48),
            stream(251, "webm opus", None, 160),
        ];
        let (video, audio) = adaptive_h264_aac_pair(&formats, 1080).unwrap();
        assert_eq!((video.itag, audio.itag), (299, 140), "60 fps beats 30 fps at one height");
        let (video, _) = adaptive_h264_aac_pair(&formats, 2160).unwrap();
        assert_eq!(video.itag, 299, "VP9 is never taken, however tall");
        let (video, _) = adaptive_h264_aac_pair(&formats, 720).unwrap();
        assert_eq!(video.itag, 136);
        assert!(adaptive_h264_aac_pair(&formats, 480).is_none());
        // Without an AAC track there is nothing to pair; the progressive file remains.
        let no_aac: Vec<_> = formats.iter().filter(|f| f.itag != 140 && f.itag != 139).cloned().collect();
        assert!(adaptive_h264_aac_pair(&no_aac, 1080).is_none());
        assert_eq!(native_progressive_mp4(&no_aac, 1080).unwrap().itag, 18);
        // A track whose URL could not be recovered is never chosen.
        let mut unusable = formats.clone();
        unusable.iter_mut().filter(|f| f.itag == 299).for_each(|f| f.url.clear());
        assert_eq!(adaptive_h264_aac_pair(&unusable, 1080).unwrap().0.itag, 137);
    }

    fn test_provider(root: &Path) -> YoutubeProvider {
        use crate::provider::ProviderLiveSettings;
        let ctx = ProviderContext::new(
            root.to_path_buf(),
            ProviderLiveSettings {
                download_dir: root.join("downloads"),
                filename_template: "{title}".into(),
                default_quality: kdj_core::models::Quality::Q128,
                netease_use_download_api: false,
                soundcloud_enabled: false,
                soundcloud_client_id: String::new(),
                soundcloud_client_secret: String::new(),
                ytm_enabled: false,
                youtube_enabled: true,
                video_dir: None,
                video_format: "mp4".into(),
            },
        );
        let auth = Arc::new(YoutubeAuth::new(&ctx, Platform::Youtube).unwrap());
        let mut provider = YoutubeProvider::new(ctx, auth).unwrap();
        provider
            .client
            .set_test_http(reqwest::Client::builder().no_proxy().build().unwrap());
        provider
    }

    /// Serves `/progressive` as ranged 206 responses and answers every other path with 403.
    async fn stream_fixture(body: Vec<u8>) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::AsyncReadExt as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let mut buffer = [0; 8192];
                let length = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..length]).into_owned();
                let line = request.lines().next().unwrap_or_default().to_string();
                let range = request
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string))
                    .unwrap_or_default();
                seen.lock().unwrap().push(format!("{line} {range}"));
                if !line.starts_with("GET /progressive ") {
                    let _ = socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    continue;
                }
                let (start, end) = range.split_once('-').unwrap();
                let start: usize = start.parse().unwrap();
                let end = end.parse::<usize>().map_or(body.len() - 1, |end| end.min(body.len() - 1));
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nConnection: close\r\n\r\n",
                    end + 1 - start,
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body[start..=end]).await;
            }
        });
        (origin, requests)
    }

    #[tokio::test]
    async fn refused_tracks_fall_back_to_the_progressive_file_in_bounded_ranges() {
        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-fallback-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let _cleanup = TempDirGuard(root.clone());
        std::fs::create_dir_all(&root).unwrap();
        let provider = test_provider(&root);
        let body: Vec<u8> = (0..300_000u32).map(|n| n as u8).collect();
        let (origin, requests) = stream_fixture(body.clone()).await;
        let mut formats = vec![
            stream(137, "mp4 avc1.640028", Some(1080), 4000),
            stream(140, "mp4 mp4a.40.2", None, 128),
            stream(18, "mp4 avc1.42001E,mp4a.40.2", Some(360), 500),
        ];
        formats[0].url = format!("{origin}/video");
        formats[1].url = format!("{origin}/audio");
        formats[2].url = format!("{origin}/progressive");
        let staged = root.join("output.part");
        let last = Arc::new(std::sync::Mutex::new((0, 0)));
        let report = last.clone();
        let progress: ProgressSink = Arc::new(move |done, total| *report.lock().unwrap() = (done, total));
        provider
            .download_direct_video(&formats, 1080, &root, &staged, &CancellationToken::new(), &progress)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), body);
        assert_eq!(*last.lock().unwrap(), (300_000, 300_000));
        let requests = requests.lock().unwrap().clone();
        assert_eq!(
            requests.last().unwrap(),
            &format!("GET /progressive HTTP/1.1 0-{}", RANGE_CHUNK - 1),
            "a stream is asked for in bounded ranges: {requests:?}"
        );
        // The small audio track goes first, so a refusal costs no video bytes.
        assert!(requests[0].starts_with("GET /audio "), "{requests:?}");
        assert_eq!(requests.len(), 2, "{requests:?}");

        // A refusal is typed, so the caller can fall back instead of failing.
        let error = provider
            .fetch_format(&formats[1], &root.join("a.part"), &CancellationToken::new(), &progress)
            .await
            .unwrap_err();
        assert!(is_stream_forbidden(&error));
    }
}
