//! Single-flight, disk-backed transport for one protected YouTube HLS segment.
//!
//! WebKit can issue overlapping GETs for the same local HLS URL. Reopening the path-bound GVS
//! capability for each GET makes an otherwise valid playback nondeterministic: one duplicate may
//! be rejected with 403. A segment spool opens the upstream URL exactly once, writes it to a
//! session-owned temporary file, and lets every local reader follow the same growing file.

use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::StatusCode;
use futures_util::stream::{self, Stream};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_SEGMENT_BYTES: u64 = 128 * 1024 * 1024;
const READER_CHUNK_BYTES: usize = 128 * 1024;
const UPSTREAM_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct YoutubeHlsCachedFailure {
    pub status: StatusCode,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub enum YoutubeHlsCachedBody {
    Playlist(Bytes),
    Segment(Arc<YoutubeHlsSegmentSpool>),
}

#[derive(Debug, Clone)]
pub struct YoutubeHlsCachedResponse {
    pub content_type: String,
    pub body: YoutubeHlsCachedBody,
}

pub type YoutubeHlsCachedResult = Result<YoutubeHlsCachedResponse, YoutubeHlsCachedFailure>;

#[derive(Debug, Clone)]
struct TransferState {
    available: u64,
    total: Option<u64>,
    complete: bool,
    error: Option<String>,
}

#[derive(Debug)]
pub struct YoutubeHlsSegmentSpool {
    path: PathBuf,
    state: Mutex<TransferState>,
    changed: Notify,
    cancel: CancellationToken,
}

pub type YoutubeHlsSegmentStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>;

struct ReadCursor {
    spool: Arc<YoutubeHlsSegmentSpool>,
    file: tokio::fs::File,
    offset: u64,
    end: Option<u64>,
    done: bool,
}

impl YoutubeHlsSegmentSpool {
    /// Starts one and only one upstream body transfer. The returned spool is immediately readable;
    /// readers wait on the growing file rather than opening another GoogleVideo request.
    pub async fn start(
        mut response: reqwest::Response,
        total_hint: Option<u64>,
        path: PathBuf,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>, YoutubeHlsCachedFailure> {
        let total = response.content_length().or(total_hint);
        if total.is_some_and(|total| total == 0 || total > MAX_SEGMENT_BYTES) {
            return Err(YoutubeHlsCachedFailure {
                status: StatusCode::BAD_GATEWAY,
                detail: "YouTube HLS 媒体分片长度异常".into(),
            });
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| YoutubeHlsCachedFailure {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    detail: "创建 YouTube HLS 临时目录失败".into(),
                })?;
        }
        let writer = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .await
            .map_err(|_| YoutubeHlsCachedFailure {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "创建 YouTube HLS 临时分片失败".into(),
            })?;
        let spool = Arc::new(Self {
            path,
            state: Mutex::new(TransferState {
                available: 0,
                total,
                complete: false,
                error: None,
            }),
            changed: Notify::new(),
            cancel,
        });
        let pump = Arc::clone(&spool);
        tokio::spawn(async move {
            let result = pump_response(&pump, &mut response, writer).await;
            let mut state = pump.state.lock().unwrap_or_else(|lock| lock.into_inner());
            match result {
                Ok(()) => {
                    let total = state.total.unwrap_or(state.available);
                    state.total = Some(total);
                    if state.available == 0 {
                        state.error = Some("YouTube HLS 上游返回空分片".into());
                    } else if state.available == total {
                        state.complete = true;
                    } else {
                        state.error = Some("YouTube HLS 媒体分片提前结束".into());
                    }
                }
                Err(error) => state.error = Some(error),
            }
            drop(state);
            pump.changed.notify_waiters();
        });
        Ok(spool)
    }

    pub fn total(&self) -> Option<u64> {
        self.state
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .total
    }

    pub async fn wait_total(&self) -> io::Result<u64> {
        loop {
            let notified = self.changed.notified();
            let (total, error) = {
                let state = self.state.lock().unwrap_or_else(|lock| lock.into_inner());
                (state.total, state.error.clone())
            };
            if let Some(error) = error {
                return Err(io::Error::other(error));
            }
            if let Some(total) = total {
                return Ok(total);
            }
            notified.await;
        }
    }

    pub async fn stream(
        self: &Arc<Self>,
        start: u64,
        end: Option<u64>,
    ) -> io::Result<YoutubeHlsSegmentStream> {
        let total = self.total();
        if end.is_some_and(|end| start > end || total.is_some_and(|total| end >= total)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "YouTube HLS 本地读取范围无效",
            ));
        }
        let mut file = tokio::fs::File::open(&self.path).await?;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let cursor = ReadCursor {
            spool: Arc::clone(self),
            file,
            offset: start,
            end,
            done: false,
        };
        Ok(Box::pin(stream::unfold(cursor, |mut cursor| async move {
            if cursor.done || cursor.end.is_some_and(|end| cursor.offset > end) {
                return None;
            }
            match cursor.read_next().await {
                Ok(Some(bytes)) => Some((Ok(bytes), cursor)),
                Ok(None) => None,
                Err(error) => {
                    cursor.done = true;
                    Some((Err(error), cursor))
                }
            }
        })))
    }
}

impl ReadCursor {
    async fn read_next(&mut self) -> io::Result<Option<Bytes>> {
        loop {
            if self.spool.cancel.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "YouTube HLS 播放会话已撤销",
                ));
            }
            let notified = self.spool.changed.notified();
            let (available, complete, error) = {
                let state = self
                    .spool
                    .state
                    .lock()
                    .unwrap_or_else(|lock| lock.into_inner());
                (state.available, state.complete, state.error.clone())
            };
            if let Some(error) = error {
                return Err(io::Error::other(error));
            }
            if available > self.offset {
                let remaining = self
                    .end
                    .map(|end| end - self.offset + 1)
                    .unwrap_or(READER_CHUNK_BYTES as u64);
                let available_now = available - self.offset;
                let length = remaining.min(available_now).min(READER_CHUNK_BYTES as u64) as usize;
                let mut bytes = vec![0_u8; length];
                self.file.read_exact(&mut bytes).await?;
                self.offset += length as u64;
                return Ok(Some(Bytes::from(bytes)));
            }
            if complete {
                return Ok(None);
            }
            notified.await;
        }
    }
}

impl Drop for YoutubeHlsSegmentSpool {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn pump_response(
    spool: &YoutubeHlsSegmentSpool,
    response: &mut reqwest::Response,
    mut writer: tokio::fs::File,
) -> Result<(), String> {
    loop {
        if spool.cancel.is_cancelled() {
            return Err("YouTube HLS 播放会话已撤销".into());
        }
        let chunk = tokio::select! {
            _ = spool.cancel.cancelled() => return Err("YouTube HLS 播放会话已撤销".into()),
            result = tokio::time::timeout(UPSTREAM_CHUNK_TIMEOUT, response.chunk()) => {
                result
                    .map_err(|_| "YouTube HLS 上游连续 30 秒没有返回分片数据".to_string())?
                    .map_err(|_| "读取 YouTube HLS 上游分片失败".to_string())?
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        let (next, limit) = {
            let state = spool.state.lock().unwrap_or_else(|lock| lock.into_inner());
            (
                state.available.saturating_add(chunk.len() as u64),
                state.total.unwrap_or(MAX_SEGMENT_BYTES),
            )
        };
        if next > limit {
            return Err("YouTube HLS 上游分片超过声明长度".into());
        }
        writer
            .write_all(&chunk)
            .await
            .map_err(|_| "写入 YouTube HLS 临时分片失败".to_string())?;
        // Tokio's file writer has an internal buffer. Do not publish `available` until a second
        // file handle can actually observe those bytes; otherwise a reader can hit regular-file
        // EOF after seeing a larger logical length and fail nondeterministically.
        writer
            .flush()
            .await
            .map_err(|_| "刷新 YouTube HLS 临时分片失败".to_string())?;
        spool
            .state
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .available = next;
        spool.changed.notify_waiters();
    }
    writer
        .flush()
        .await
        .map_err(|_| "提交 YouTube HLS 临时分片失败".to_string())?;
    Ok(())
}

pub fn spool_path(root: &Path) -> PathBuf {
    root.join("media-spool").join(format!(
        "yt-hls-{:016x}{:016x}.segment",
        rand::random::<u64>(),
        rand::random::<u64>()
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::{to_bytes, Body};
    use axum::http::{header, Response};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    #[tokio::test]
    async fn youtube_hls_segment_spool_serves_two_readers_from_one_transfer() {
        let payload = Arc::new((0..=255_u8).cycle().take(512 * 1024).collect::<Vec<_>>());
        let upstream_requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/segment",
            get({
                let payload = Arc::clone(&payload);
                let upstream_requests = Arc::clone(&upstream_requests);
                move || {
                    let payload = Arc::clone(&payload);
                    let upstream_requests = Arc::clone(&upstream_requests);
                    async move {
                        upstream_requests.fetch_add(1, Ordering::SeqCst);
                        let chunks = payload
                            .chunks(64 * 1024)
                            .map(Bytes::copy_from_slice)
                            .map(Ok::<_, io::Error>)
                            .collect::<Vec<_>>();
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "video/mp2t")
                            .body(Body::from_stream(stream::iter(chunks)))
                            .unwrap()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        kdj_core::ensure_rustls_ring();
        let response = reqwest::Client::new()
            .get(format!("http://{address}/segment"))
            .send()
            .await
            .unwrap();
        assert!(response.content_length().is_none());
        let root = std::env::temp_dir().join(format!(
            "kdj-youtube-hls-spool-test-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let path = spool_path(&root);
        let cancel = CancellationToken::new();
        let spool = YoutubeHlsSegmentSpool::start(response, None, path.clone(), cancel.clone())
            .await
            .unwrap();
        let first = spool.stream(0, None).await.unwrap();
        let second = spool.stream(0, None).await.unwrap();
        let limit = payload.len() + 1;
        let (first, second) = tokio::join!(
            to_bytes(Body::from_stream(first), limit),
            to_bytes(Body::from_stream(second), limit)
        );
        assert_eq!(first.unwrap().as_ref(), payload.as_slice());
        assert_eq!(second.unwrap().as_ref(), payload.as_slice());
        assert_eq!(upstream_requests.load(Ordering::SeqCst), 1);
        assert_eq!(spool.wait_total().await.unwrap(), payload.len() as u64);

        cancel.cancel();
        drop(spool);
        for _ in 0..20 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
        server.abort();
    }
}
