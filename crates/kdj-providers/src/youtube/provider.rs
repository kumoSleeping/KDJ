//! 普通 YouTube 视频：关键词搜索、单视频/Shorts、播放列表与音视频下载。
//!
//! 元数据与流提取使用社区 Rust 实现 rusty_ytdl；登录使用普通 YouTube 自己的
//! 浏览器 Cookie，不与 YouTube Music 共用状态。YouTube 的 PO Token 策略持续变化，403 会转成明确的
//! 重新连接浏览器/PO Token 提示，而不是留下空文件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kdj_core::models::{
    Account, AccountState, CollectionResolveResponse, CollectionResult, Platform, QrSession,
    QrStateValue, ResolveKind, ResolveResponse, SearchKind, SongSource, StreamPlaylist,
    StreamPlaylistResponse, VideoDownloadRequest, VideoInfo, VideoPage, VideoStreamOption,
};
use kdj_core::paths::{finalize_filename, sanitize_filename_value};
use rusty_ytdl::search::{SearchOptions, SearchResult, SearchType, YouTube};
use rusty_ytdl::{RequestOptions, Video, VideoFormat, VideoOptions};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

use crate::ffmpeg;
use crate::net::http_timeouts;
use crate::provider::{
    effective_limit, full_listing, no_login, unique_download_path, Capabilities, DownloadJob,
    MusicProvider, ProgressSink, ProviderContext,
};
use crate::tags;
use crate::youtubemusic::auth::YoutubeAuth;

const LABEL: &str = "YouTube Video";
const DISABLED_MESSAGE: &str = "未启用，在「下载源」里打开开关";
const YOUTUBE_SEARCH_KINDS: &[SearchKind] = &[SearchKind::Song];
const INNERTUBE_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct YoutubeProvider {
    ctx: ProviderContext,
    auth: Arc<YoutubeAuth>,
    http: reqwest::Client,
}

impl YoutubeProvider {
    pub fn new(ctx: ProviderContext, auth: Arc<YoutubeAuth>) -> Result<Self> {
        let http = http_timeouts(reqwest::Client::builder().user_agent(USER_AGENT))
            .build()
            .context("构建 YouTube 视频客户端失败")?;
        Ok(Self { ctx, auth, http })
    }

    fn ensure_enabled(&self) -> Result<()> {
        anyhow::ensure!(self.ctx.youtube_enabled(), "{DISABLED_MESSAGE}");
        Ok(())
    }

    fn request_options(&self) -> RequestOptions {
        RequestOptions {
            cookies: self.auth.snapshot().map(|session| session.cookie),
            max_retries: Some(3),
            ..Default::default()
        }
    }

    fn video(&self, url_or_id: &str) -> Result<Video> {
        Video::new_with_options(
            url_or_id,
            VideoOptions {
                request_options: self.request_options(),
                ..Default::default()
            },
        )
        .map_err(|err| anyhow::anyhow!(youtube_error(err)))
    }

    fn search_client(&self) -> Result<YouTube> {
        YouTube::new_with_options(&self.request_options())
            .map_err(|err| anyhow::anyhow!(youtube_error(err)))
    }

    async fn video_source(&self, id: &str) -> Result<SongSource> {
        let info = self
            .video(id)?
            .get_info()
            .await
            .map_err(|err| anyhow::anyhow!(youtube_error(err)))?;
        Ok(source_from_details(&info.video_details))
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
        let url = format!(
            "https://www.youtube.com/youtubei/v1/browse?key={INNERTUBE_KEY}&prettyPrint=false"
        );
        let mut request = self.http.post(&url).json(&body);
        for (name, value) in self.auth.request_headers("https://www.youtube.com") {
            request = request.header(name, value);
        }
        let response = request.send().await.context("读取 YouTube 播放列表失败")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("YouTube 播放列表响应不是合法 JSON")?;
        if !status.is_success() {
            bail!("YouTube 播放列表接口返回 {status}");
        }
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
            let mut request = self.http.post(&url).json(&page_body);
            for (name, value) in self.auth.request_headers("https://www.youtube.com") {
                request = request.header(name, value);
            }
            let response = request
                .send()
                .await
                .context("继续读取 YouTube 播放列表失败")?;
            let status = response.status();
            let page: Value = response
                .json()
                .await
                .context("YouTube 播放列表分页响应不是合法 JSON")?;
            if !status.is_success() {
                bail!("YouTube 播放列表分页接口返回 {status}");
            }
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
        let body = json!({
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": web_client_version(),
                    "hl": "zh-CN",
                    "gl": "US"
                }
            },
            "browseId": "FEplaylist_aggregation"
        });
        let url = format!(
            "https://www.youtube.com/youtubei/v1/browse?key={INNERTUBE_KEY}&prettyPrint=false"
        );
        let mut request = self.http.post(&url).json(&body);
        for (name, value) in self.auth.request_headers("https://www.youtube.com") {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .context("读取 YouTube 播放列表目录失败")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("YouTube 播放列表目录响应不是合法 JSON")?;
        if !status.is_success() {
            bail!("YouTube 播放列表目录接口返回 {status}");
        }
        Ok(youtube_library_playlists(&body))
    }

    pub async fn resolve_video(&self, url_or_id: &str) -> Result<VideoInfo> {
        self.ensure_enabled()?;
        let info = self
            .video(url_or_id)?
            .get_info()
            .await
            .map_err(|err| anyhow::anyhow!(youtube_error(err)))?;
        let details = &info.video_details;
        let mut options: Vec<VideoStreamOption> = info
            .formats
            .iter()
            .filter(|format| format.has_video)
            .filter_map(|format| {
                let height = format.height? as i64;
                Some(VideoStreamOption {
                    quality_id: format.itag as i64,
                    label: format
                        .quality_label
                        .clone()
                        .unwrap_or_else(|| format!("{height}P")),
                    height,
                    codec: format.mime_type.video_codec.clone().unwrap_or_default(),
                })
            })
            .collect();
        options.sort_by_key(|option| option.height);
        options.dedup_by_key(|option| option.height);
        let duration = details.length_seconds.parse::<i64>().unwrap_or(0);
        Ok(VideoInfo {
            platform: Platform::Youtube,
            bvid: details.video_id.clone(),
            title: details.title.clone(),
            author: details.owner_channel_name.clone(),
            cover: best_thumbnail(&details.thumbnails),
            duration,
            pages: vec![VideoPage {
                index: 0,
                title: details.title.clone(),
                duration,
            }],
            options,
            logged_in: self.auth.is_logged_in(),
        })
    }

    pub async fn download_video(
        &self,
        req: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<PathBuf> {
        self.ensure_enabled()?;
        anyhow::ensure!(
            ffmpeg::available(),
            "YouTube 音视频流需要 FFmpeg 合并或提取；请安装 FFmpeg 后重试"
        );
        let target = if !req.url.trim().is_empty() {
            req.url.trim()
        } else {
            req.bvid.trim()
        };
        anyhow::ensure!(!target.is_empty(), "缺少 YouTube 视频链接或 ID");
        let info = self
            .video(target)?
            .get_info()
            .await
            .map_err(|err| anyhow::anyhow!(youtube_error(err)))?;
        if cancel.is_cancelled() {
            bail!("下载已取消");
        }

        let details = &info.video_details;
        let title = if req.title.trim().is_empty() {
            &details.title
        } else {
            req.title.trim()
        };
        let output_dir = if req.audio_only {
            self.ctx.platform_dir(Platform::Youtube)?
        } else {
            self.ctx.video_output_dir()?
        };
        let extension = if req.audio_only {
            "m4a".to_string()
        } else {
            let configured = self.ctx.video_format();
            if configured.is_empty() {
                "mp4".into()
            } else {
                configured
            }
        };
        let stem = sanitize_filename_value(title, &details.video_id);
        let filename = finalize_filename(&format!("{stem}.{extension}"), &extension);
        let output = unique_download_path(&output_dir, &filename);
        let temp = output_dir.join(format!(
            ".partial-youtube-{}-{:08x}",
            details.video_id,
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&temp).context("创建 YouTube 下载暂存目录失败")?;
        let _guard = TempDirGuard(temp.clone());
        let staged = temp.join(format!("output.{extension}"));
        let log = temp.join("ffmpeg.log");

        // HLS 是当前不依赖 GVS PO Token 的优先退路。拿得到时让 FFmpeg 自己处理分片。
        if let Some(hls) = info
            .hls_manifest_url
            .as_deref()
            .filter(|url| !url.is_empty())
        {
            self.download_hls(hls, &staged, req, &log, cancel).await?;
            let size = std::fs::metadata(&staged)
                .map(|meta| meta.len())
                .unwrap_or(0);
            progress(size, size);
        } else {
            let selected = select_formats(&info.formats, req.max_height, req.audio_only)?;
            let mut inputs = Vec::new();
            for (index, format) in selected.iter().enumerate() {
                let input = temp.join(format!("input-{index}.{}", format.mime_type.container));
                self.fetch_format(format, &input, cancel, progress).await?;
                inputs.push(input);
            }
            if req.audio_only {
                let args = ffmpeg::extract_audio_args(&inputs[0], &staged, false, req.offset_ms);
                ffmpeg::run(&args, &log, cancel)
                    .await
                    .context("FFmpeg 提取 YouTube 音轨失败")?;
            } else {
                let args = ffmpeg::mux_args(
                    &inputs,
                    &staged,
                    req.transcode,
                    req.max_height,
                    req.offset_ms,
                );
                ffmpeg::run(&args, &log, cancel)
                    .await
                    .context("FFmpeg 合并 YouTube 音视频失败")?;
            }
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
        std::fs::rename(&staged, &output).context("提交 YouTube 下载文件失败")?;
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
        let mut request = self
            .http
            .get(&format.url)
            .header(reqwest::header::REFERER, "https://www.youtube.com/");
        if let Some(session) = self.auth.snapshot() {
            request = request.header(reqwest::header::COOKIE, session.cookie);
        }
        let response = request.send().await.context("YouTube 流请求失败")?;
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            bail!("YouTube 返回 403：请重新连接已登录的浏览器；若仍失败，该视频当前需要 PO Token")
        }
        let response = response.error_for_status().context("YouTube 流下载失败")?;
        let total = response.content_length().unwrap_or(0);
        let mut downloaded = 0u64;
        let mut file = tokio::fs::File::create(output)
            .await
            .context("创建 YouTube 暂存文件失败")?;
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
            progress(downloaded, total.max(downloaded));
        }
        file.flush().await.context("提交 YouTube 暂存缓冲失败")?;
        Ok(())
    }

    async fn download_hls(
        &self,
        url: &str,
        output: &Path,
        req: &VideoDownloadRequest,
        log: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut args = vec!["-y".to_string()];
        if let Some(session) = self.auth.snapshot() {
            args.extend([
                "-headers".into(),
                format!("Cookie: {}\r\nUser-Agent: {USER_AGENT}\r\n", session.cookie),
            ]);
        }
        if req.offset_ms > 0 {
            args.extend([
                "-ss".into(),
                format!("{:.3}", req.offset_ms as f64 / 1000.0),
            ]);
        }
        args.extend(["-i".into(), url.into()]);
        if req.audio_only {
            args.extend([
                "-vn".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "128k".into(),
            ]);
            if req.offset_ms < 0 {
                args.extend(["-af".into(), format!("adelay={}:all=1", -req.offset_ms)]);
            }
        } else if req.transcode || req.offset_ms != 0 {
            let mut filter = format!(r"scale=-2:min({}\,ih)", req.max_height.max(1));
            if req.offset_ms < 0 {
                filter = format!(
                    "tpad=start_duration={:.3},{filter}",
                    -req.offset_ms as f64 / 1000.0
                );
            }
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "20".into(),
                "-vf".into(),
                filter,
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ]);
            if req.offset_ms < 0 {
                args.extend(["-af".into(), format!("adelay={}:all=1", -req.offset_ms)]);
            }
        } else {
            args.extend(["-c".into(), "copy".into()]);
        }
        args.extend([
            "-movflags".into(),
            "+faststart".into(),
            output.to_string_lossy().into_owned(),
        ]);
        ffmpeg::run(&args, log, cancel)
            .await
            .context("FFmpeg 下载 YouTube HLS 失败")
    }
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
            search_kinds: YOUTUBE_SEARCH_KINDS,
            ..Capabilities::VIDEO
        }
    }

    async fn account(&self) -> Account {
        let mut account = Account::new(Platform::Youtube, LABEL, AccountState::Missing, "未登录");
        account.login_method = "browser".into();
        account.credential_kind = "anonymous".into();
        if let Some(session) = self.auth.snapshot() {
            account.state = AccountState::Valid;
            account.account_key = session.x_goog_authuser;
            account.credential_kind = "browser_session".into();
            account.detail = session.imported_from;
        } else if !self.ctx.youtube_enabled() {
            account.detail = DISABLED_MESSAGE.into();
        } else {
            account.detail = "公开内容可匿名访问；登录后可读取账号受限内容".into();
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
        if keyword.is_empty() || !self.ctx.youtube_enabled() {
            return Ok(Vec::new());
        }
        let options = SearchOptions {
            limit: effective_limit(limit, 20) as u64,
            search_type: SearchType::Video,
            safe_search: false,
        };
        let rows = self
            .search_client()?
            .search(keyword, Some(&options))
            .await
            .map_err(|err| anyhow::anyhow!(youtube_error(err)))?;
        Ok(rows
            .iter()
            .filter_map(|row| match row {
                SearchResult::Video(video) => Some(source_from_search_video(video)),
                _ => None,
            })
            .collect())
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
                match self.http.get(&job.source.cover).send().await {
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

fn source_from_search_video(video: &rusty_ytdl::search::Video) -> SongSource {
    let mut payload = serde_json::Map::new();
    payload.insert("video_id".into(), json!(video.id));
    payload.insert("audio_only".into(), json!(false));
    SongSource {
        platform: Platform::Youtube,
        key: video.id.clone(),
        title: video.title.clone(),
        artists: if video.channel.name.trim().is_empty() {
            Vec::new()
        } else {
            vec![video.channel.name.clone()]
        },
        album: String::new(),
        duration: Some(video.duration as f64 / 1000.0).filter(|duration| *duration > 0.0),
        cover: best_thumbnail(&video.thumbnails),
        max_quality: None,
        vip: false,
        payload,
    }
}

fn source_from_details(details: &rusty_ytdl::VideoDetails) -> SongSource {
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

fn best_thumbnail(items: &[rusty_ytdl::Thumbnail]) -> String {
    items
        .iter()
        .max_by_key(|item| item.width.saturating_mul(item.height))
        .map(|item| item.url.clone())
        .unwrap_or_default()
}

fn select_formats(
    formats: &[VideoFormat],
    max_height: i64,
    audio_only: bool,
) -> Result<Vec<VideoFormat>> {
    let usable = |format: &&VideoFormat| !format.url.is_empty() && !format.is_live;
    let best_audio = || {
        formats
            .iter()
            .filter(usable)
            .filter(|format| format.has_audio && !format.has_video)
            .max_by_key(|format| format.audio_bitrate.unwrap_or(format.bitrate))
            .cloned()
    };
    if audio_only {
        return best_audio()
            .or_else(|| {
                formats
                    .iter()
                    .filter(usable)
                    .filter(|format| format.has_audio)
                    .max_by_key(|format| format.audio_bitrate.unwrap_or(format.bitrate))
                    .cloned()
            })
            .map(|format| vec![format])
            .context("YouTube 没有返回可下载的音频流；请重新导入浏览器会话");
    }
    let ceiling = max_height.max(1) as u64;
    if let Some(progressive) = formats
        .iter()
        .filter(usable)
        .filter(|format| format.has_video && format.has_audio)
        .filter(|format| format.height.unwrap_or(0) <= ceiling)
        .max_by_key(|format| (format.height.unwrap_or(0), format.bitrate))
        .cloned()
    {
        return Ok(vec![progressive]);
    }
    let video = formats
        .iter()
        .filter(usable)
        .filter(|format| format.has_video && !format.has_audio)
        .filter(|format| format.height.unwrap_or(0) <= ceiling)
        .max_by_key(|format| (format.height.unwrap_or(0), format.bitrate))
        .cloned()
        .context("YouTube 没有返回可下载的视频流；该视频可能需要 PO Token")?;
    let audio = best_audio().context("YouTube 没有返回可下载的音频流")?;
    Ok(vec![video, audio])
}

fn youtube_error(error: rusty_ytdl::VideoError) -> String {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("403") || lower.contains("not a bot") || lower.contains("source empty") {
        format!("YouTube 风控拒绝了请求；请连接已登录的浏览器。若仍失败，该内容当前需要 PO Token（{text}）")
    } else if lower.contains("private") {
        format!("这是私密或账号受限内容，请连接有访问权限的浏览器 Profile（{text}）")
    } else {
        format!("YouTube 请求失败：{text}")
    }
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_download_source_does_not_hide_its_own_login() {
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

        let account = provider.account().await;
        assert_eq!(account.state, AccountState::Valid);
        assert_eq!(account.account_key, "2");
        assert_eq!(account.credential_kind, "browser_session");
        assert_eq!(account.detail, "测试浏览器");

        let _ = std::fs::remove_dir_all(root);
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
    fn format_selection_prefers_progressive_under_ceiling() {
        let format = |height: u64, video: bool, audio: bool, bitrate: u64| VideoFormat {
            itag: height,
            mime_type: serde_json::from_str(r#""video/mp4; codecs=\"avc1.4d401f, mp4a.40.2\"""#)
                .unwrap(),
            bitrate,
            width: Some(height * 16 / 9),
            height: Some(height),
            init_range: None,
            index_range: None,
            last_modified: None,
            content_length: None,
            quality: None,
            fps: None,
            quality_label: Some(format!("{height}p")),
            projection_type: None,
            average_bitrate: None,
            high_replication: None,
            audio_quality: None,
            color_info: None,
            approx_duration_ms: None,
            audio_sample_rate: None,
            audio_channels: None,
            audio_bitrate: None,
            loudness_db: None,
            url: "https://cdn.example/x".into(),
            has_video: video,
            has_audio: audio,
            is_live: false,
            is_hls: false,
            is_dash_mpd: false,
        };
        let formats = vec![
            format(1080, true, true, 10),
            format(720, true, true, 20),
            format(0, false, true, 30),
        ];
        let picked = select_formats(&formats, 720, false).unwrap();
        assert_eq!(picked[0].height, Some(720));
    }
}
