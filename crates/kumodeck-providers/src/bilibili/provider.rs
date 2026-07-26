//! 哔哩哔哩 provider：视频解析 + 下载 + 音乐管线入口。
//!
//! 「视频就是视频」——B 站来源在音乐下载管线里也**永远下完整视频**，
//! 画面不在下载环节丢掉。落到视频目录、照样入库，播放时曲库自己取音轨。
//! 想要纯 m4a 走视频面板里的「只要音轨」。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use kumodeck_core::models::{
    Account, AccountState, Platform, QrSession, QrStateValue, ResolveResponse, SongSource,
    VideoDownloadRequest, VideoInfo, VideoPage,
};
use kumodeck_core::paths::{finalize_filename, sanitize_filename_value};
use serde_json::Value;
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

use super::client::BiliClient;
use super::streams::{self, MediaStream, PlayUrlData};
use super::url::{
    normalize_bvid, normalize_pic, parse_clock, resolve_video_target, strip_search_markup,
    USER_AGENT,
};
use super::{login, qn_for_height};
use crate::ffmpeg;
use crate::net::{ensure_media_url, AtomicDownload};
use crate::provider::{
    effective_limit, qr_data_url_from_text, str_field, Capabilities, DownloadJob, MusicProvider,
    ProgressSink, ProviderContext,
};

const LABEL: &str = "哔哩哔哩";
const CHUNK_REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
const QR_SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

pub struct BilibiliProvider {
    ctx: ProviderContext,
    client: BiliClient,
    qr_sessions: Mutex<HashMap<String, (String, Instant)>>,
}

impl BilibiliProvider {
    pub fn new(ctx: ProviderContext) -> Result<Self> {
        let session_dir = ctx.session_dir();
        std::fs::create_dir_all(&session_dir).ok();
        Ok(BilibiliProvider {
            client: BiliClient::new(&session_dir)?,
            ctx,
            qr_sessions: Mutex::new(HashMap::new()),
        })
    }

    async fn logged_in(&self) -> bool {
        if !self.client.has_credential() {
            return false;
        }
        matches!(
            self.client.nav().await.ok().and_then(|data| {
                data.get("isLogin").and_then(Value::as_bool)
            }),
            Some(true)
        )
    }

    /// 解析视频信息，供前端画质下拉框用。
    pub async fn resolve_video(&self, url: &str) -> Result<VideoInfo> {
        let target = resolve_video_target(self.client.http(), url).await?;
        let logged_in = self.logged_in().await;
        let info = self.client.view(&target.bvid).await?;

        let pages: Vec<Value> = info
            .get("pages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let index = target.page_index.min(pages.len().saturating_sub(1));
        let cid = cid_at(&info, &pages, index);
        let playurl = self.client.playurl(&target.bvid, cid, 127, true).await?;

        Ok(VideoInfo {
            // 空串要退回请求里的 BV 号（Python 的 `str(info.get("bvid") or target.bvid)`）
            bvid: str_field(&info, "bvid").unwrap_or(&target.bvid).to_string(),
            title: str_field(&info, "title").unwrap_or(&target.bvid).to_string(),
            author: info
                .pointer("/owner/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            cover: normalize_pic(info.get("pic").and_then(Value::as_str).unwrap_or_default()),
            duration: info.get("duration").and_then(Value::as_i64).unwrap_or(0),
            pages: pages
                .iter()
                .enumerate()
                .map(|(position, page)| VideoPage {
                    // 分 P 下标从 0 开始，和 playurl 的 page_index 对齐
                    index: position,
                    title: page
                        .get("part")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("P{}", position + 1)),
                    duration: page.get("duration").and_then(Value::as_i64).unwrap_or(0),
                })
                .collect(),
            options: streams::stream_options(&playurl),
            logged_in,
        })
    }

    /// 视频下载主流程。
    pub async fn download_video(
        &self,
        req: &VideoDownloadRequest,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<PathBuf> {
        let (bvid, requested_index) = self.target_of(req).await?;
        let logged_in = self.logged_in().await;
        let info = self.client.view(&bvid).await?;
        let pages: Vec<Value> = info
            .get("pages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !pages.is_empty() && requested_index >= pages.len() {
            bail!(
                "请求第 {} P，但视频只有 {} P",
                requested_index + 1,
                pages.len()
            );
        }
        let index = requested_index;
        let cid = cid_at(&info, &pages, index);
        let max_height = req.max_height.max(1);

        // 没有 ffmpeg 时只能要单流：DASH 的音画是分开的，不混流就没法用。
        let want_dash = ffmpeg::available();
        let playurl = self.client.playurl(&bvid, cid, qn_for_height(max_height), want_dash).await?;
        if cancel.is_cancelled() {
            bail!("下载已取消");
        }
        let parsed = streams::parse_playurl(&playurl);
        let is_single = matches!(parsed, PlayUrlData::Single { .. });
        // 位置固定的二元组：缺哪个哪个是 None，绝不会错位
        let (video_stream, audio_stream) = streams::pick_best(&parsed, max_height);

        let title = compose_title(&info, &pages, index, &bvid);
        // 视频平铺在设置里指定的视频目录下；只要音轨时回到音频那边的 bilibili/ 子目录
        let output_dir = if req.audio_only {
            self.ctx.platform_dir(Platform::Bilibili)?
        } else {
            self.ctx.video_output_dir()?
        };
        let extension = if req.audio_only {
            "m4a".to_string()
        } else if is_single && !ffmpeg::available() {
            // 没有 ffmpeg 就原样保留容器，别谎称是 mp4
            match &parsed {
                PlayUrlData::Single { container, .. } => container.clone(),
                _ => "mp4".to_string(),
            }
        } else if self.ctx.video_format.is_empty() {
            "mp4".to_string()
        } else {
            self.ctx.video_format.clone()
        };
        let stem = sanitize_filename_value(&title, &bvid);
        let output_path =
            output_dir.join(finalize_filename(&format!("{stem}.{extension}"), &extension));

        // 每个任务一个独立的暂存目录：并发下载时不能互相删对方的 .partial
        let temp_dir = output_dir.join(format!(
            ".partial-{bvid}-p{}-{:08x}",
            index + 1,
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).context("创建暂存目录失败")?;
        let guard = TempDirGuard(temp_dir.clone());
        let staged = temp_dir.join(format!("output.{extension}"));
        let log_path = temp_dir.join("ffmpeg.log");
        let cookies = if logged_in {
            self.client.cookie_header()
        } else {
            String::new()
        };

        if req.audio_only {
            // DJ 最常用的路径：只要音轨。dash 直接拿音频流；单流就整段拉下来再抽。
            let source = if audio_stream.is_some() && !is_single {
                audio_stream.clone()
            } else {
                video_stream.clone()
            };
            let Some(source) = source else {
                bail!("哔哩哔哩没有返回可下载的音频流");
            };
            let source_path = temp_dir.join(if is_single { "source.flv" } else { "audio.m4s" });
            self.fetch_streams(&[(source.url.clone(), source_path.clone())], &cookies, cancel, progress)
                .await?;
            self.extract_audio(&source_path, &staged, &log_path, cancel)
                .await?;
        } else {
            let Some(video) = video_stream.clone() else {
                bail!("哔哩哔哩没有返回可下载的视频流（该视频可能没有可用的画质档位）");
            };
            if is_single && !ffmpeg::available() {
                // 安卓路径：单流本身就是完整文件，直接落盘，不经过 ffmpeg
                let direct = AtomicDownload::new(&output_path);
                self.fetch_streams(
                    &[(video.url.clone(), direct.partial().to_path_buf())],
                    &cookies,
                    cancel,
                    progress,
                )
                .await?;
                return direct.commit();
            }
            let mut plan = Vec::new();
            let inputs = if is_single {
                let source_path = temp_dir.join("source.flv");
                plan.push((video.url.clone(), source_path.clone()));
                vec![source_path]
            } else {
                let video_path = temp_dir.join("video.m4s");
                plan.push((video.url.clone(), video_path.clone()));
                let mut inputs = vec![video_path];
                if let Some(audio) = &audio_stream {
                    let audio_path = temp_dir.join("audio.m4s");
                    plan.push((audio.url.clone(), audio_path.clone()));
                    inputs.push(audio_path);
                }
                inputs
            };
            self.fetch_streams(&plan, &cookies, cancel, progress).await?;
            let args = ffmpeg::mux_args(&inputs, &staged, req.transcode, max_height);
            ffmpeg::run(&args, &log_path, cancel).await?;
        }

        // 校验通过后才原子替换到最终路径：ffmpeg 直接写目标文件的话，
        // 超时/失败会把上一次的成品截断成坏文件并永久留在磁盘上。
        let size = std::fs::metadata(&staged).map(|meta| meta.len()).unwrap_or(0);
        if size == 0 {
            bail!("FFmpeg 没有生成有效的输出文件");
        }
        std::fs::rename(&staged, &output_path).context("移动输出文件失败")?;
        drop(guard);
        Ok(output_path)
    }

    async fn target_of(&self, req: &VideoDownloadRequest) -> Result<(String, usize)> {
        if !req.bvid.trim().is_empty() {
            let bvid = normalize_bvid(&req.bvid);
            anyhow::ensure!(!bvid.is_empty(), "BV 号格式不正确");
            return Ok((bvid, req.page_index));
        }
        let target = resolve_video_target(self.client.http(), &req.url).await?;
        // 前端没显式选分 P（page_index=0）时，沿用链接里 ?p= 带来的下标
        let index = if req.page_index > 0 {
            req.page_index
        } else {
            target.page_index
        };
        Ok((target.bvid, index))
    }

    /// 把这次任务要下的所有流当成一条进度上报（video + audio 字节数累加）。
    async fn fetch_streams(
        &self,
        plan: &[(String, PathBuf)],
        cookies: &str,
        cancel: &CancellationToken,
        progress: &ProgressSink,
    ) -> Result<()> {
        for (url, _) in plan {
            ensure_media_url(url).await?;
        }
        let mut total = 0u64;
        let mut sizes = Vec::with_capacity(plan.len());
        for (url, _) in plan {
            let size = self.probe_size(url, cookies).await;
            sizes.push(size);
            total += size;
        }
        // 有任何一个探测不到，总量就当未知（0），如实上报
        if sizes.iter().any(|size| *size == 0) {
            total = 0;
        }
        progress(0, total);

        let mut done = 0u64;
        for (url, destination) in plan {
            done = self
                .download_stream(url, destination, cookies, cancel, progress, done, total)
                .await?;
        }
        Ok(())
    }

    async fn probe_size(&self, url: &str, cookies: &str) -> u64 {
        let request = |method: reqwest::Method| {
            let mut builder = self
                .client
                .http()
                .request(method, url)
                .header(reqwest::header::REFERER, "https://www.bilibili.com/")
                .header(reqwest::header::USER_AGENT, USER_AGENT);
            if !cookies.is_empty() {
                builder = builder.header(reqwest::header::COOKIE, cookies);
            }
            builder
        };
        if let Ok(response) = request(reqwest::Method::HEAD).send().await {
            if response.status().is_success() {
                if let Some(length) = response.content_length().filter(|len| *len > 0) {
                    return length;
                }
            }
        }
        // B 站 CDN 经常对 HEAD 返回 405，用 1 字节 Range 换 Content-Range 里的总长度。
        // 一定要看 Content-Range 而不是直接读 body：万一对端忽略 Range 回 200，
        // 读 body 就等于把整个视频拉进内存。
        let Ok(response) = request(reqwest::Method::GET)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
            .await
        else {
            return 0;
        };
        if !response.status().is_success() {
            return 0;
        }
        if let Some(range) = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
        {
            if let Some(total) = range.rsplit('/').next().and_then(|t| t.trim().parse().ok()) {
                return total;
            }
        }
        if response.status() == reqwest::StatusCode::OK {
            // Range 被忽略时 content-length 就是完整长度，别白白丢掉进度总量
            return response.content_length().unwrap_or(0);
        }
        0
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_stream(
        &self,
        url: &str,
        destination: &PathBuf,
        cookies: &str,
        cancel: &CancellationToken,
        progress: &ProgressSink,
        offset: u64,
        total: u64,
    ) -> Result<u64> {
        let mut builder = self
            .client
            .http()
            .get(url)
            .header(reqwest::header::REFERER, "https://www.bilibili.com/")
            .header(reqwest::header::USER_AGENT, USER_AGENT);
        if !cookies.is_empty() {
            builder = builder.header(reqwest::header::COOKIE, cookies);
        }
        let response = builder
            .send()
            .await
            .context("哔哩哔哩媒体流请求失败")?
            .error_for_status()
            .context("哔哩哔哩媒体流请求失败")?;

        let mut file = tokio::fs::File::create(destination)
            .await
            .context("创建媒体临时文件失败")?;
        let mut written = offset;
        let mut last_report = Instant::now();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.is_cancelled() {
                bail!("下载已取消");
            }
            let chunk = chunk.context("哔哩哔哩媒体流中断")?;
            file.write_all(&chunk).await.context("写入媒体文件失败")?;
            written += chunk.len() as u64;
            if last_report.elapsed() >= CHUNK_REPORT_INTERVAL {
                last_report = Instant::now();
                // 探测出来的总长度偏小时至少别让进度超过 100%
                progress(written, if total > 0 { total.max(written) } else { 0 });
            }
        }
        file.flush().await.ok();
        progress(written, if total > 0 { total.max(written) } else { 0 });
        Ok(written)
    }

    async fn extract_audio(
        &self,
        source: &PathBuf,
        staged: &PathBuf,
        log_path: &PathBuf,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let copy_args = ffmpeg::extract_audio_args(source, staged, true);
        match ffmpeg::run(&copy_args, log_path, cancel).await {
            Ok(()) => return Ok(()),
            Err(err) if err.to_string().contains("取消") => return Err(err),
            Err(_) => {
                // 源音轨不是 AAC（flv 里常见 mp3）时 m4a 容器装不下，退回重编码
                let _ = std::fs::remove_file(staged);
            }
        }
        let args = ffmpeg::extract_audio_args(source, staged, false);
        ffmpeg::run(&args, log_path, cancel).await
    }
}

#[async_trait]
impl MusicProvider for BilibiliProvider {
    fn platform(&self) -> Platform {
        Platform::Bilibili
    }

    fn label(&self) -> &str {
        LABEL
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::VIDEO
    }

    async fn account(&self) -> Account {
        if !self.client.has_credential() {
            return Account::new(Platform::Bilibili, LABEL, AccountState::Missing, "未登录");
        }
        let data = match self.client.nav().await {
            Ok(data) => data,
            Err(err) => {
                let mut account =
                    Account::new(Platform::Bilibili, LABEL, AccountState::Unknown, "");
                account.detail = err.to_string().chars().take(160).collect();
                return account;
            }
        };
        if data.get("isLogin").and_then(Value::as_bool) != Some(true) {
            return Account::new(
                Platform::Bilibili,
                LABEL,
                AccountState::Expired,
                "登录已失效，请重新扫码",
            );
        }
        let mid = data.get("mid").and_then(Value::as_i64).unwrap_or(0);
        let mut account = Account::new(
            Platform::Bilibili,
            LABEL,
            AccountState::Valid,
            &if mid > 0 { format!("UID {mid}") } else { String::new() },
        );
        account.nickname = data
            .get("uname")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        account.avatar = normalize_pic(data.get("face").and_then(Value::as_str).unwrap_or_default());
        account
    }

    async fn create_qr(&self) -> Result<QrSession> {
        let session = login::create_qr(self.client.http()).await?;
        let session_id = format!("{:032x}", rand::random::<u128>());
        {
            let mut sessions = self.qr_sessions.lock().unwrap();
            sessions.retain(|_, (_, born)| born.elapsed() <= QR_SESSION_TTL);
            sessions.insert(session_id.clone(), (session.qrcode_key, Instant::now()));
        }
        Ok(QrSession {
            platform: Platform::Bilibili,
            session_id,
            image: qr_data_url_from_text(&session.url)?,
            url: session.url,
            expires_in: 180,
        })
    }

    async fn poll_qr(&self, session_id: &str) -> Result<(QrStateValue, String)> {
        let key = {
            let sessions = self.qr_sessions.lock().unwrap();
            sessions.get(session_id).map(|(key, _)| key.clone())
        };
        let Some(key) = key else {
            return Ok((
                QrStateValue::Expired,
                "登录会话不存在或已失效，请重新获取二维码".into(),
            ));
        };
        match login::poll_qr(self.client.http(), &key).await {
            Ok(login::QrPoll::Waiting) => Ok((QrStateValue::Waiting, "等待扫码".into())),
            Ok(login::QrPoll::Scanned) => {
                Ok((QrStateValue::Scanned, "已扫码，请在手机上确认登录".into()))
            }
            Ok(login::QrPoll::Expired) => {
                self.qr_sessions.lock().unwrap().remove(session_id);
                Ok((QrStateValue::Expired, "二维码已过期，请重新获取".into()))
            }
            Ok(login::QrPoll::Done(cookies)) => {
                self.client.store_cookies(&cookies);
                self.qr_sessions.lock().unwrap().remove(session_id);
                Ok((QrStateValue::Done, "登录成功".into()))
            }
            Err(err) => Ok((
                QrStateValue::Error,
                format!("轮询登录状态失败：{err}").chars().take(160).collect(),
            )),
        }
    }

    async fn logout(&self) -> Result<()> {
        self.client.clear_session();
        self.qr_sessions.lock().unwrap().clear();
        Ok(())
    }

    /// B 站关键词搜视频，回和音乐平台同构的 `SongSource`。
    ///
    /// 视频没有"音质档"概念，`max_quality` 留空，混合去重时它自然排在
    /// 有 flac 标记的音乐平台后面。
    async fn search(&self, keyword: &str, limit: usize) -> Result<Vec<SongSource>> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(Vec::new());
        }
        // Python 是 `max(1, min(int(limit or 20), 50))`：0 退回默认 20，再夹到 50
        let limit = effective_limit(limit, 20).min(50);
        let results = self.client.search_videos(keyword).await?;
        Ok(results
            .iter()
            .filter_map(|item| {
                let bvid = item.get("bvid").and_then(Value::as_str)?.trim();
                if bvid.is_empty() {
                    return None;
                }
                let author = item
                    .get("author")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let mut payload = serde_json::Map::new();
                payload.insert("bvid".into(), Value::String(bvid.to_string()));
                Some(SongSource {
                    platform: Platform::Bilibili,
                    key: bvid.to_string(),
                    // 空标题要退回 BV 号（Python 的 `item.get("title") or bvid`），
                    // 否则搜索结果里会出现一行没有名字的条目
                    title: strip_search_markup(str_field(item, "title").unwrap_or(bvid)),
                    artists: if author.is_empty() { vec![] } else { vec![author] },
                    album: String::new(),
                    // Python 是 `_parse_clock(str(item.get("duration") or ""))`：
                    // 搜索接口一般给 "3:52" 这种钟面串，但也见过直接给秒数（数字）。
                    // 只认字符串的话那些条目在列表里就没有时长。
                    duration: parse_clock(&stringify_duration(item.get("duration"))),
                    cover: normalize_pic(item.get("pic").and_then(Value::as_str).unwrap_or_default()),
                    max_quality: None,
                    vip: false,
                    payload,
                })
            })
            .take(limit)
            .collect())
    }

    /// B 站链接由 `/api/video/resolve` 单独处理，音乐管线这里不认领。
    async fn resolve(&self, _url: &str, _limit: usize) -> Result<Option<ResolveResponse>> {
        Ok(None)
    }

    /// 音乐下载管线的统一入口：B 站来源永远下**完整视频**。
    ///
    /// `quality` 对 B 站没有意义，收下忽略，保持和网易云/QQ 同一个签名，
    /// 让 downloader 不用特判平台。
    async fn download(&self, job: DownloadJob<'_>) -> Result<PathBuf> {
        let req = VideoDownloadRequest {
            url: String::new(),
            bvid: job.source.key.clone(),
            page_index: job
                .source
                .payload
                .get("page_index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            // 搜索结果没有逐条选画质的入口，1080 是不吃亏的默认
            max_height: 1080,
            audio_only: false,
            transcode: false,
        };
        self.download_video(&req, &job.cancel, &job.progress).await
    }
}

// ---------------------------------------------------------------- 纯函数

/// 搜索结果的 `duration` 摊成字符串，对应 Python 的 `str(item.get("duration") or "")`。
///
/// 假值（null / 0 / 空串）一律变空串，交给 `parse_clock` 判成"没有时长"。
fn stringify_duration(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64().is_some_and(|v| v != 0.0) => {
            number.to_string()
        }
        _ => String::new(),
    }
}

fn cid_at(info: &Value, pages: &[Value], index: usize) -> i64 {
    pages
        .get(index)
        .and_then(|page| page.get("cid"))
        .and_then(Value::as_i64)
        .or_else(|| info.get("cid").and_then(Value::as_i64))
        .unwrap_or(0)
}

fn compose_title(info: &Value, pages: &[Value], index: usize, bvid: &str) -> String {
    let title = str_field(info, "title").unwrap_or(bvid).to_string();
    if pages.len() <= 1 {
        return title;
    }
    let part = pages
        .get(index)
        .and_then(|page| page.get("part"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if part.is_empty() {
        format!("{title} - P{}", index + 1)
    } else {
        format!("{title} - P{} - {part}", index + 1)
    }
}

/// 暂存目录守卫：无论成功失败都要清掉，别在用户的视频目录里留一堆 `.partial-*`。
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 让编译器确认这些类型确实被用到（`BTreeMap` 来自 login 的回传）。
const _: fn(&BTreeMap<String, String>) = |_| {};
const _: fn(&MediaStream) = |_| {};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn single_page_titles_are_left_alone() {
        let info = json!({"title": "教程"});
        assert_eq!(compose_title(&info, &[], 0, "BV1"), "教程");
        assert_eq!(
            compose_title(&info, &[json!({"part": "只有一P"})], 0, "BV1"),
            "教程"
        );
    }

    #[test]
    fn multi_page_titles_carry_the_part_name() {
        let info = json!({"title": "教程"});
        let pages = vec![json!({"part": "第一讲"}), json!({"part": "第二讲"})];
        assert_eq!(compose_title(&info, &pages, 1, "BV1"), "教程 - P2 - 第二讲");
    }

    #[test]
    fn missing_part_names_still_get_a_page_marker() {
        let info = json!({"title": "教程"});
        let pages = vec![json!({}), json!({"part": "  "})];
        assert_eq!(compose_title(&info, &pages, 1, "BV1"), "教程 - P2");
    }

    #[test]
    fn an_empty_title_falls_back_to_the_bvid() {
        // Python 是 `str(info.get("title") or bvid)`：空串也要退回 BV 号，
        // 否则文件名会被净化成 "track.mp4"
        assert_eq!(compose_title(&json!({"title": ""}), &[], 0, "BV1"), "BV1");
    }

    #[test]
    fn search_durations_survive_both_the_clock_string_and_a_raw_number() {
        // Python 走 `str(...)`，两种形状都能进 _parse_clock
        assert_eq!(parse_clock(&stringify_duration(Some(&json!("3:52")))), Some(232.0));
        assert_eq!(parse_clock(&stringify_duration(Some(&json!(232)))), Some(232.0));
        // 假值一律当"没有时长"，别把 0 当成 0 秒
        assert_eq!(stringify_duration(Some(&json!(0))), "");
        assert_eq!(stringify_duration(Some(&json!(null))), "");
        assert_eq!(stringify_duration(None), "");
        assert_eq!(parse_clock(&stringify_duration(None)), None);
    }

    #[test]
    fn cid_prefers_the_page_then_the_video() {
        let info = json!({"cid": 111});
        let pages = vec![json!({"cid": 222}), json!({"cid": 333})];
        assert_eq!(cid_at(&info, &pages, 1), 333);
        assert_eq!(cid_at(&info, &[], 0), 111, "单 P 视频用顶层 cid");
        assert_eq!(cid_at(&json!({}), &[], 0), 0);
    }

    #[test]
    fn temp_dir_guard_cleans_up_even_on_failure() {
        let dir = std::env::temp_dir().join(format!("kumodeck-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("video.m4s"), b"x").unwrap();
        {
            let _guard = TempDirGuard(dir.clone());
        }
        assert!(!dir.exists(), "暂存目录必须被清掉");
    }
}
