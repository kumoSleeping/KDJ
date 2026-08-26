//! Protected media spool session.
//!
//! A WebPO/GVS URL is a short-lived playback capability, not a normal CDN file. Reopening it for
//! every decoder seek can turn an already accepted session into a later 403. This module follows
//! yt-dlp's current 10 MiB bounded GVS transfer contract, continuously spools those sequential
//! chunks to a local file, and serves arbitrary decoder ranges from that growing local file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const RANGE_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const GVS_RANGE_CHUNK_BYTES: u64 = 1024 * 1024;
pub const LOCAL_RANGE_CHUNK_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
struct TransferState {
    available: u64,
    complete: bool,
    error: Option<String>,
}

#[derive(Debug)]
pub struct ProtectedMediaSpool {
    path: PathBuf,
    total: u64,
    content_type: String,
    write_lock: tokio::sync::Mutex<()>,
    state: Mutex<TransferState>,
    changed: Notify,
    persistent: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Debug)]
pub struct ProtectedMediaSlice {
    pub bytes: Vec<u8>,
    pub start: u64,
    pub end: u64,
    pub total: u64,
    pub content_type: String,
}

impl ProtectedMediaSpool {
    /// Opens the first bounded GVS response and returns as soon as its first media chunk is on disk.
    pub async fn start(
        client: &reqwest::Client,
        url: &str,
        alternate_urls: &[String],
        path: PathBuf,
    ) -> Result<Arc<Self>> {
        let total_hint = content_length_hint(url).context("YouTube GVS URL 缺少 clen")?;
        let media_urls = if alternate_urls.is_empty() {
            vec![url.to_string()]
        } else {
            alternate_urls.to_vec()
        };
        let first_url = media_urls.first().map(String::as_str).unwrap_or(url);
        let initial_range = gvs_range(0, total_hint);
        let mut response = tokio::time::timeout(
            CONNECT_TIMEOUT,
            kdj_providers::youtubemusic::gvs_playback_request(client, first_url)
                .header(reqwest::header::RANGE, &initial_range)
                .send(),
        )
        .await
        .context("YouTube GVS 连接超时")?
        .context("连接 YouTube GVS 失败")?;
        let mut status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            tracing::warn!(%status, "受保护媒体首个有界 Range 被 GVS 拒绝，重试一次");
            tokio::time::sleep(Duration::from_millis(300)).await;
            response = tokio::time::timeout(
                CONNECT_TIMEOUT,
                kdj_providers::youtubemusic::gvs_playback_request(client, first_url)
                    .header(reqwest::header::RANGE, &initial_range)
                    .send(),
            )
            .await
            .context("YouTube GVS Range 连接超时")?
            .context("连接 YouTube GVS Range 失败")?;
            status = response.status();
        }
        if matches!(status.as_u16(), 401 | 403) {
            tracing::warn!(%status, "受保护媒体证明被 GVS 拒绝");
            let detail = response.text().await.unwrap_or_default();
            let detail = detail.trim().chars().take(300).collect::<String>();
            bail!(
                "YouTube GVS 播放授权已失效（HTTP {status}{}）",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("：{detail}")
                }
            );
        }
        let (total, content_type) = media_response_metadata(url, status, response.headers())?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("创建媒体会话目录失败：{}", parent.display()))?;
        }
        let mut writer = tokio::fs::File::create(&path)
            .await
            .with_context(|| format!("创建媒体会话文件失败：{}", path.display()))?;
        let first = tokio::time::timeout(CHUNK_TIMEOUT, response.chunk())
            .await
            .context("YouTube GVS 首个媒体块超时")?
            .context("读取 YouTube GVS 首个媒体块失败")?
            .context("YouTube GVS 没有返回媒体内容")?;
        ensure_media_chunk(&first)?;
        anyhow::ensure!(
            first.len() as u64 <= total,
            "YouTube GVS 返回内容超过声明长度"
        );
        writer
            .write_all(&first)
            .await
            .context("写入媒体会话首块失败")?;

        let spool = Arc::new(Self {
            path,
            total,
            content_type,
            write_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(TransferState {
                available: first.len() as u64,
                complete: first.len() as u64 == total,
                error: None,
            }),
            changed: Notify::new(),
            persistent: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        });
        tracing::info!(
            total,
            first_bytes = first.len(),
            mime = %spool.content_type,
            "受保护媒体有界 Range 会话已建立"
        );
        if first.len() as u64 == total {
            writer.flush().await.context("提交媒体会话文件失败")?;
            return Ok(spool);
        }

        let pump = Arc::clone(&spool);
        let pump_client = client.clone();
        let pump_urls = media_urls;
        tokio::spawn(async move {
            let result =
                pump_remaining(&pump, &mut response, &mut writer, &pump_client, &pump_urls).await;
            let mut state = pump.state.lock().unwrap();
            match result {
                Ok(()) if state.available == pump.total => state.complete = true,
                Ok(()) => {
                    state.error = Some(format!(
                        "YouTube GVS 媒体流提前结束（{}/{} 字节）",
                        state.available, pump.total
                    ));
                }
                Err(error) => state.error = Some(error.to_string()),
            }
            if state.complete {
                tracing::info!(bytes = state.available, "受保护媒体单连接会话已完整落盘");
            }
            drop(state);
            pump.changed.notify_waiters();
        });
        Ok(spool)
    }

    /// Creates an empty growing file for a browser SABR/UMP producer. The browser owns the
    /// proprietary session state; Rust owns the bounded local file, decoder ranges, caching, and
    /// cleanup. The first read blocks until the first complete fMP4 prefix is appended.
    pub async fn start_upload(
        path: PathBuf,
        total: u64,
        content_type: String,
    ) -> Result<Arc<Self>> {
        anyhow::ensure!(total > 0 && total <= 512 * 1024 * 1024, "媒体上传长度无效");
        anyhow::ensure!(
            matches!(content_type.as_str(), "audio/mp4" | "audio/webm"),
            "媒体上传类型无效"
        );
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("创建媒体会话目录失败：{}", parent.display()))?;
        }
        tokio::fs::File::create(&path)
            .await
            .with_context(|| format!("创建媒体会话文件失败：{}", path.display()))?;
        Ok(Arc::new(Self {
            path,
            total,
            content_type,
            write_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(TransferState {
                available: 0,
                complete: false,
                error: None,
            }),
            changed: Notify::new(),
            persistent: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        }))
    }

    pub async fn append_upload(&self, bytes: &[u8]) -> Result<(u64, u64)> {
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= 2 * 1024 * 1024,
            "媒体上传分段无效"
        );
        let _guard = self.write_lock.lock().await;
        let offset = {
            let state = self.state.lock().unwrap();
            if let Some(error) = &state.error {
                bail!(error.clone());
            }
            anyhow::ensure!(!state.complete, "媒体上传已经完成");
            anyhow::ensure!(!self.cancelled.load(Ordering::Acquire), "媒体会话已取消");
            anyhow::ensure!(
                state.available.saturating_add(bytes.len() as u64) <= self.total,
                "媒体上传超过声明长度"
            );
            state.available
        };
        let mut writer = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .await
            .context("打开媒体上传会话失败")?;
        writer
            .write_all(bytes)
            .await
            .context("写入媒体上传分段失败")?;
        writer.flush().await.context("提交媒体上传分段失败")?;
        let available = offset + bytes.len() as u64;
        self.state.lock().unwrap().available = available;
        self.changed.notify_waiters();
        Ok((available, self.total))
    }

    pub fn finish_upload(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            state.available == self.total,
            "媒体上传提前结束（{}/{} 字节）",
            state.available,
            self.total
        );
        state.complete = true;
        drop(state);
        self.changed.notify_waiters();
        Ok(())
    }

    pub fn fail_upload(&self, error: impl Into<String>) {
        let mut state = self.state.lock().unwrap();
        if !state.complete {
            state.error = Some(error.into());
        }
        drop(state);
        self.changed.notify_waiters();
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    pub async fn read_range(
        &self,
        start: u64,
        requested_end: Option<u64>,
    ) -> Result<ProtectedMediaSlice> {
        anyhow::ensure!(start < self.total, "请求范围超过媒体长度");
        let desired_end = requested_end
            .unwrap_or_else(|| start.saturating_add(LOCAL_RANGE_CHUNK_BYTES - 1))
            .min(start.saturating_add(LOCAL_RANGE_CHUNK_BYTES - 1))
            .min(self.total - 1);
        let desired_len = desired_end - start + 1;
        let minimum = if start == 0 {
            desired_len.min(64 * 1024)
        } else {
            desired_len.min(256 * 1024)
        };

        let available = tokio::time::timeout(RANGE_WAIT_TIMEOUT, async {
            loop {
                let notified = self.changed.notified();
                {
                    let state = self.state.lock().unwrap();
                    if let Some(error) = &state.error {
                        return Err(anyhow!(error.clone()));
                    }
                    if state.available > start
                        && (state.complete || state.available - start >= minimum)
                    {
                        return Ok(state.available);
                    }
                }
                notified.await;
            }
        })
        .await
        .context("等待受保护媒体数据超时")??;

        let end = desired_end.min(available - 1);
        let length = usize::try_from(end - start + 1).context("媒体分段过大")?;
        let mut file = tokio::fs::File::open(&self.path)
            .await
            .context("打开媒体会话文件失败")?;
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .context("定位媒体会话文件失败")?;
        let mut bytes = vec![0_u8; length];
        file.read_exact(&mut bytes)
            .await
            .context("读取媒体会话文件失败")?;
        Ok(ProtectedMediaSlice {
            bytes,
            start,
            end,
            total: self.total,
            content_type: self.content_type.clone(),
        })
    }

    pub async fn wait_complete(&self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(10 * 60), async {
            loop {
                let notified = self.changed.notified();
                {
                    let state = self.state.lock().unwrap();
                    if let Some(error) = &state.error {
                        return Err(anyhow!(error.clone()));
                    }
                    if state.complete {
                        return Ok(());
                    }
                }
                notified.await;
            }
        })
        .await
        .context("等待受保护媒体下载完成超时")?
    }

    /// Transfers cleanup ownership to the download provider.
    pub fn persist(&self) -> PathBuf {
        self.persistent.store(true, Ordering::Release);
        self.path.clone()
    }

    pub fn progress(&self) -> (u64, u64) {
        (self.state.lock().unwrap().available, self.total)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
}

impl Drop for ProtectedMediaSpool {
    fn drop(&mut self) {
        if !self.persistent.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn content_length_hint(url: &str) -> Option<u64> {
    reqwest::Url::parse(url).ok().and_then(|url| {
        url.query_pairs()
            .find_map(|(key, value)| (key == "clen").then(|| value.parse::<u64>().ok()).flatten())
    })
}

fn gvs_range(start: u64, total: u64) -> String {
    let end = start
        .saturating_add(GVS_RANGE_CHUNK_BYTES - 1)
        .min(total.saturating_sub(1));
    format!("bytes={start}-{end}")
}

async fn pump_remaining(
    spool: &ProtectedMediaSpool,
    response: &mut reqwest::Response,
    writer: &mut tokio::fs::File,
    client: &reqwest::Client,
    urls: &[String],
) -> Result<()> {
    let mut continuation_attempts = 0_u32;
    let mut token_index = 0_usize;
    loop {
        loop {
            if spool.cancelled.load(Ordering::Acquire) {
                bail!("媒体会话已取消");
            }
            let chunk = tokio::time::timeout(CHUNK_TIMEOUT, response.chunk())
                .await
                .context("YouTube GVS 连续 30 秒没有返回数据")?
                .context("YouTube GVS 媒体流中断")?;
            let Some(chunk) = chunk else {
                break;
            };
            writer
                .write_all(&chunk)
                .await
                .context("写入媒体会话文件失败")?;
            let mut state = spool.state.lock().unwrap();
            state.available = state.available.saturating_add(chunk.len() as u64);
            if state.available > spool.total {
                bail!("YouTube GVS 返回内容超过声明长度");
            }
            drop(state);
            spool.changed.notify_waiters();
        }
        let offset = spool.state.lock().unwrap().available;
        if offset >= spool.total {
            break;
        }
        continuation_attempts += 1;
        anyhow::ensure!(
            continuation_attempts <= 8,
            "YouTube GVS 媒体流续传失败次数过多"
        );
        let delay_ms = 150_u64.saturating_mul(1_u64 << continuation_attempts.min(4));
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let range = gvs_range(offset, spool.total);
        token_index += 1;
        let url = urls
            .get(token_index)
            .or_else(|| urls.last())
            .context("YouTube GVS 证明数量不足，无法继续读取整轨")?;
        let next = tokio::time::timeout(
            CONNECT_TIMEOUT,
            kdj_providers::youtubemusic::gvs_playback_request(client, url)
                .header(reqwest::header::RANGE, range)
                .send(),
        )
        .await
        .context("YouTube GVS 续传连接超时")?
        .context("连接 YouTube GVS 续传失败")?;
        if matches!(next.status().as_u16(), 401 | 403) {
            continue;
        }
        validate_continuation(&next, offset, spool.total)?;
        continuation_attempts = 0;
        *response = next;
    }
    writer.flush().await.context("提交媒体会话文件失败")?;
    Ok(())
}

fn validate_continuation(
    response: &reqwest::Response,
    expected_start: u64,
    total: u64,
) -> Result<()> {
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::PARTIAL_CONTENT,
        "YouTube GVS 续传返回 HTTP {}",
        response.status()
    );
    let raw = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .context("YouTube GVS 续传缺少 Content-Range")?;
    let value = raw
        .strip_prefix("bytes ")
        .context("YouTube GVS 续传 Content-Range 无效")?;
    let (span, actual_total) = value
        .split_once('/')
        .context("YouTube GVS 续传 Content-Range 无效")?;
    let (start, end) = span
        .split_once('-')
        .context("YouTube GVS 续传 Content-Range 无效")?;
    let start = start.parse::<u64>().context("YouTube GVS 续传起点无效")?;
    let end = end.parse::<u64>().context("YouTube GVS 续传终点无效")?;
    let actual_total = actual_total
        .parse::<u64>()
        .context("YouTube GVS 续传总长度无效")?;
    anyhow::ensure!(
        start == expected_start && start <= end && actual_total == total,
        "YouTube GVS 续传范围不连续"
    );
    Ok(())
}

fn media_response_metadata(
    url: &str,
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Result<(u64, String)> {
    anyhow::ensure!(
        status == reqwest::StatusCode::OK || status == reqwest::StatusCode::PARTIAL_CONTENT,
        "YouTube GVS 返回 HTTP {status}"
    );
    let total = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let raw = headers
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .context("YouTube GVS 缺少 Content-Range")?;
        let value = raw
            .strip_prefix("bytes 0-")
            .context("YouTube GVS 首段不是从 0 开始")?;
        value
            .split_once('/')
            .and_then(|(_, total)| total.parse::<u64>().ok())
            .context("YouTube GVS Content-Range 无效")?
    } else {
        headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .or_else(|| {
                reqwest::Url::parse(url).ok().and_then(|url| {
                    url.query_pairs().find_map(|(key, value)| {
                        (key == "clen").then(|| value.parse::<u64>().ok()).flatten()
                    })
                })
            })
            .context("YouTube GVS 缺少媒体长度")?
    };
    anyhow::ensure!(total > 0, "YouTube GVS 返回空媒体");
    let declared = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let query_mime = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find_map(|(key, value)| (key == "mime").then(|| value.into_owned()))
        })
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = if declared.starts_with("audio/") {
        declared
    } else if query_mime.starts_with("audio/") {
        query_mime
    } else {
        bail!("YouTube GVS 返回的不是音频（{declared}）");
    };
    Ok((total, content_type))
}

fn ensure_media_chunk(bytes: &[u8]) -> Result<()> {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    anyhow::ensure!(
        !prefix.trim_start().starts_with('<')
            && !prefix.contains("<!doctype html")
            && !prefix.contains("<html"),
        "YouTube GVS 返回了错误页面"
    );
    Ok(())
}

pub fn spool_path(root: &Path, extension: &str) -> PathBuf {
    let extension = extension.trim_start_matches('.');
    root.join("media-spool").join(format!(
        "ytm-{:016x}.{}",
        rand::random::<u64>(),
        if extension.is_empty() {
            "m4a"
        } else {
            extension
        }
    ))
}

pub fn cleanup_stale(root: &Path) {
    let directory = root.join("media-spool");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("ytm-"))
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::http::{header, HeaderMap, Response, StatusCode};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    #[tokio::test]
    async fn one_upstream_request_supports_playback_seeks_and_complete_download() {
        let payload = Arc::new(
            (0..=255_u8)
                .cycle()
                .take(2 * 1024 * 1024)
                .collect::<Vec<_>>(),
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/audio",
            get({
                let payload = Arc::clone(&payload);
                let requests = Arc::clone(&requests);
                move |headers: HeaderMap| {
                    let payload = Arc::clone(&payload);
                    let requests = Arc::clone(&requests);
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers.get(header::RANGE).unwrap(), "bytes=0-1048575");
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "audio/mp4")
                            .header(header::CONTENT_LENGTH, payload.len())
                            .body(Body::from(payload.as_ref().clone()))
                            .unwrap()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = std::env::temp_dir().join(format!(
            "kdj-protected-media-test-{:016x}",
            rand::random::<u64>()
        ));
        let client = reqwest::Client::new();
        let spool = ProtectedMediaSpool::start(
            &client,
            &format!(
                "http://{address}/audio?mime=audio%2Fmp4&clen={}",
                payload.len()
            ),
            &[],
            spool_path(&temp, "m4a"),
        )
        .await
        .unwrap();

        let head = spool.read_range(0, Some(65_535)).await.unwrap();
        assert_eq!(head.bytes, payload[..65_536]);
        let seek = spool
            .read_range(1024 * 1024 + 123, Some(1024 * 1024 + 999))
            .await
            .unwrap();
        assert_eq!(seek.bytes, payload[seek.start as usize..=seek.end as usize]);
        spool.wait_complete().await.unwrap();
        assert_eq!(tokio::fs::read(spool.persist()).await.unwrap(), *payload);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        server.abort();
        let _ = tokio::fs::remove_dir_all(temp).await;
    }

    #[tokio::test]
    async fn capped_gvs_response_recovers_from_transient_continuation_403() {
        let payload = Arc::new((0..=255_u8).cycle().take(768 * 1024).collect::<Vec<_>>());
        let requests = Arc::new(AtomicUsize::new(0));
        let split = 256 * 1024;
        let app = Router::new().route(
            "/audio",
            get({
                let payload = Arc::clone(&payload);
                let requests = Arc::clone(&requests);
                move |headers: HeaderMap| {
                    let payload = Arc::clone(&payload);
                    let requests = Arc::clone(&requests);
                    async move {
                        let request = requests.fetch_add(1, Ordering::SeqCst);
                        match request {
                            0 => {
                                assert_eq!(
                                    headers.get(header::RANGE).unwrap(),
                                    format!("bytes=0-{}", payload.len() - 1).as_str()
                                );
                                Response::builder()
                                    .status(StatusCode::PARTIAL_CONTENT)
                                    .header(header::CONTENT_TYPE, "audio/mp4")
                                    .header(
                                        header::CONTENT_RANGE,
                                        format!("bytes 0-{}/{}", split - 1, payload.len()),
                                    )
                                    .body(Body::from(payload[..split].to_vec()))
                                    .unwrap()
                            }
                            1 => {
                                assert_eq!(
                                    headers.get(header::RANGE).unwrap(),
                                    format!("bytes={split}-{}", payload.len() - 1).as_str()
                                );
                                Response::builder()
                                    .status(StatusCode::FORBIDDEN)
                                    .body(Body::empty())
                                    .unwrap()
                            }
                            2 => Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(header::CONTENT_TYPE, "audio/mp4")
                                .header(
                                    header::CONTENT_RANGE,
                                    format!(
                                        "bytes {split}-{}/{}",
                                        payload.len() - 1,
                                        payload.len()
                                    ),
                                )
                                .body(Body::from(payload[split..].to_vec()))
                                .unwrap(),
                            _ => panic!("unexpected extra GVS request"),
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = std::env::temp_dir().join(format!(
            "kdj-protected-media-retry-test-{:016x}",
            rand::random::<u64>()
        ));
        let spool = ProtectedMediaSpool::start(
            &reqwest::Client::new(),
            &format!(
                "http://{address}/audio?mime=audio%2Fmp4&clen={}",
                payload.len()
            ),
            &[],
            spool_path(&temp, "m4a"),
        )
        .await
        .unwrap();
        spool.wait_complete().await.unwrap();
        assert_eq!(tokio::fs::read(spool.persist()).await.unwrap(), *payload);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        server.abort();
        let _ = tokio::fs::remove_dir_all(temp).await;
    }
}
