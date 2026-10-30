//! `kdj peek`：截取视频画面。媒体可以是曲库曲目、本地文件或尚未下载的 B 站视频；
//! 在线视频只按需读取画面帧，不下载成品。
//!
//! KDJ 没有 FFmpeg：截帧交给打开着的 KDJ 窗口（`--no-gui` 时隐藏的主窗口也算），由它用系统
//! 解码器（WebCodecs，src/lib/cliPeek.ts）解出各时间点的画面，一张张传回来写成 JPEG。
//! 请求被中断（CLI 退出）时，handler 被丢弃，登记随之撤销，窗口那边的上传被拒。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use kdj_core::models::Platform;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cli_api::{bilibili_video_input, recall, video_ref_source, Cached};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_FRAMES: usize = 48;
const SHEET_COLUMNS: usize = 4;
const PEEK_KEEP: Duration = Duration::from_secs(24 * 3600);

enum Media {
    File { path: PathBuf, title: String, duration: Option<f64>, track_id: Option<i64> },
    Bilibili { bvid: String, page: usize, title: String, duration: Option<f64> },
}

impl Media {
    fn describe(&self) -> Value {
        match self {
            Media::File { path, title, duration, track_id } => {
                json!({ "path": path, "title": title, "duration": duration.map(round), "track_id": track_id })
            }
            Media::Bilibili { bvid, page, title, duration } => json!({
                "ref": if *page > 0 { format!("bilibili:{bvid}:p{}", page + 1) } else { format!("bilibili:{bvid}") },
                "title": title,
                "duration": duration.map(round),
                "online": true,
            }),
        }
    }

    fn duration(&self) -> Option<f64> {
        match self {
            Media::File { duration, .. } | Media::Bilibili { duration, .. } => *duration,
        }
    }
}

fn round(seconds: f64) -> f64 {
    (seconds * 1000.).round() / 1000.
}

fn url_page(text: &str) -> usize {
    reqwest::Url::parse(text)
        .ok()
        .and_then(|url| url.query_pairs().find(|(k, _)| k == "p").and_then(|(_, v)| v.parse::<usize>().ok()))
        .and_then(|p| p.checked_sub(1))
        .unwrap_or(0)
}

/// 曲库 id、本地路径、B 站引用或链接。YouTube 在线视频需要界面准备来源，先 download。
async fn resolve_media(state: &Arc<AppState>, source: &str) -> ApiResult<Media> {
    let source = source.trim();
    if let Ok(id) = source.parse::<i64>() {
        let track = state.library.get(id)?.ok_or_else(|| ApiError::not_found(format!("曲库里没有 id {id}")))?;
        return Ok(Media::File {
            path: PathBuf::from(&track.path),
            title: track.title,
            duration: track.duration,
            track_id: Some(id),
        });
    }
    let path = Path::new(source);
    if path.is_absolute() {
        if !path.is_file() {
            return Err(ApiError::not_found(format!("文件不存在：{source}")));
        }
        return Ok(Media::File {
            path: path.to_path_buf(),
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            duration: None,
            track_id: None,
        });
    }
    let (bvid, page) = if let Some(Cached::Song(song)) = recall(source).filter(|c| matches!(c, Cached::Song(s) if s.platform == Platform::Bilibili)) {
        let page = song.payload.get("page_index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let bvid = song.payload.get("bvid").and_then(Value::as_str).unwrap_or(&song.key).to_string();
        (bvid, page)
    } else if let Some(song) = video_ref_source(source) {
        if song.platform != Platform::Bilibili {
            return Err(ApiError::bad_request("YouTube 在线视频请先 download，再用曲库 id 或文件路径"));
        }
        let page = song.payload.get("page_index").and_then(Value::as_u64).unwrap_or(0) as usize;
        (song.key, page)
    } else if bilibili_video_input(source) {
        (String::new(), url_page(source))
    } else {
        return Err(ApiError::bad_request(format!(
            "无法识别的媒体：{source}；可用曲库 id、绝对路径、bilibili 引用或链接"
        )));
    };
    let provider = state
        .video_provider(Platform::Bilibili)
        .ok_or_else(|| ApiError::bad_request("哔哩哔哩不可用"))?;
    let info = provider.resolve_video(if bvid.is_empty() { source } else { bvid.as_str() }).await?;
    let duration = info
        .pages
        .iter()
        .find(|p| p.index == page)
        .map(|p| p.duration as f64)
        .or(Some(info.duration as f64))
        .filter(|d| *d > 0.);
    Ok(Media::Bilibili { bvid: info.bvid, page, title: info.title, duration })
}

// ---------------------------------------------------------------- peek

#[derive(Deserialize)]
pub struct PeekBody {
    source: String,
    #[serde(default)]
    at: Vec<f64>,
    #[serde(default)]
    every: Option<f64>,
    #[serde(default)]
    width: Option<u32>,
}

fn peek_root() -> PathBuf {
    std::env::temp_dir().join("kdj-peek")
}

/// 截图只给 AI 当场看，留一天就清掉。
fn sweep_old_peeks() {
    let Ok(entries) = std::fs::read_dir(peek_root()) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > PEEK_KEEP);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// What the window is asked for: the times, or every how many seconds (it knows the length).
fn check_times(body: &PeekBody) -> ApiResult<Vec<f64>> {
    let times: Vec<f64> = body.at.iter().copied().filter(|t| t.is_finite() && *t >= 0.).take(MAX_FRAMES).collect();
    if let Some(every) = body.every {
        if !(every.is_finite() && every > 0.) {
            return Err(ApiError::bad_request("--every 必须大于 0"));
        }
    } else if times.is_empty() {
        return Err(ApiError::bad_request("需要 --at 或 --every"));
    }
    Ok(times)
}

/// A peek handed to a window: claimed once, its frames written as they come, answered once.
struct WindowPeek {
    claim: Option<tokio::sync::oneshot::Sender<()>>,
    done: Option<tokio::sync::oneshot::Sender<Result<Value, String>>>,
    dir: PathBuf,
    /// A local file that is not in the library, served to the window by this peek's own address.
    file: Option<PathBuf>,
}

fn window_peeks() -> &'static Mutex<HashMap<String, WindowPeek>> {
    static PEEKS: std::sync::OnceLock<Mutex<HashMap<String, WindowPeek>>> = std::sync::OnceLock::new();
    PEEKS.get_or_init(Default::default)
}

/// How long the windows have to take a peek. A hidden main window (`--no-gui`) is there from the
/// start; a window still loading takes a few seconds.
const WINDOW_CLAIM: Duration = Duration::from_secs(20);
/// How long the frames may take once a window has the peek.
const WINDOW_WORK: Duration = Duration::from_secs(10 * 60);

pub async fn peek(State(state): State<Arc<AppState>>, Json(body): Json<PeekBody>) -> ApiResult<Json<Value>> {
    let media = resolve_media(&state, &body.source).await?;
    let at = check_times(&body)?;
    let width = body.width.unwrap_or(480).clamp(160, 1280);
    sweep_old_peeks();
    let dir = peek_root().join(format!("{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::bad_request(format!("创建截图目录失败：{e}")))?;
    let id = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
    let (claim, claimed) = tokio::sync::oneshot::channel();
    let (done, finished) = tokio::sync::oneshot::channel();
    let (file, from) = match &media {
        Media::File { track_id: Some(track_id), .. } => (None, json!({ "track_id": track_id })),
        Media::File { path, .. } => (Some(path.clone()), json!({ "path": format!("/api/cli/peek/{id}/source") })),
        Media::Bilibili { bvid, page, .. } => (None, json!({ "bilibili": { "bvid": bvid, "page": page } })),
    };
    window_peeks().lock().unwrap().insert(id.clone(), WindowPeek { claim: Some(claim), done: Some(done), dir: dir.clone(), file });
    struct Forget(String);
    impl Drop for Forget {
        fn drop(&mut self) {
            window_peeks().lock().unwrap().remove(&self.0);
        }
    }
    let _forget = Forget(id.clone());
    state.hub.publish("peek.requested", &json!({
        "id": id, "from": from, "at": at, "every": body.every, "width": width,
        "max_frames": MAX_FRAMES, "sheet_columns": SHEET_COLUMNS, "duration": media.duration(),
    }));
    if !matches!(tokio::time::timeout(WINDOW_CLAIM, claimed).await, Ok(Ok(()))) {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "没有 KDJ 窗口接手截帧：截帧由 KDJ 的窗口用系统解码器完成，请确认 KDJ 正在运行"));
    }
    let report = match tokio::time::timeout(WINDOW_WORK, finished).await {
        Ok(Ok(Ok(report))) => report,
        Ok(Ok(Err(error))) => return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("截帧失败：{error}"))),
        Ok(Err(_)) => return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "截帧的窗口已关闭")),
        Err(_) => return Err(ApiError::new(StatusCode::GATEWAY_TIMEOUT, "截帧超时")),
    };
    let mut frames = Vec::new();
    for frame in report["frames"].as_array().into_iter().flatten() {
        let n = frame["n"].as_u64().unwrap_or(0);
        let path = dir.join(format!("frame-{n:02}.jpg"));
        if path.is_file() {
            frames.push(json!({ "at": round(frame["at"].as_f64().unwrap_or(0.)), "path": path }));
        }
    }
    let mut result = json!({ "source": media.describe(), "frames": frames, "dir": dir });
    let failed: Vec<Value> = report["failed"].as_array().cloned().unwrap_or_default()
        .into_iter()
        .map(|f| json!({ "at": round(f["at"].as_f64().unwrap_or(0.)), "error": f["error"] }))
        .collect();
    if !failed.is_empty() {
        result["failed"] = json!(failed);
    }
    let sheet = dir.join("sheet.jpg");
    if frames.len() > 1 && sheet.is_file() {
        result["sheet"] = json!({
            "path": sheet,
            "columns": report["sheet"]["columns"],
            "rows": report["sheet"]["rows"],
            "order": "从左到右、从上到下，与 frames 顺序一致",
        });
    }
    if frames.is_empty() {
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, failed.first()
            .and_then(|f| f["error"].as_str()).map(|e| format!("一张也没有截到：{e}")).unwrap_or_else(|| "一张也没有截到".into())));
    }
    Ok(Json(result))
}

pub async fn claim_peek(AxumPath(id): AxumPath<String>) -> ApiResult<Json<Value>> {
    let claim = window_peeks().lock().unwrap().get_mut(&id).and_then(|peek| peek.claim.take());
    Ok(Json(json!({ "claimed": claim.is_some_and(|claim| claim.send(()).is_ok()) })))
}

/// The local file a peek reads, with Range, for the window that took it.
pub async fn peek_source(AxumPath(id): AxumPath<String>, headers: HeaderMap) -> ApiResult<Response> {
    let path = window_peeks().lock().unwrap().get(&id).and_then(|peek| peek.file.clone())
        .ok_or_else(|| ApiError::not_found("截帧请求已结束"))?;
    let total = tokio::fs::metadata(&path).await.map_err(|e| ApiError::not_found(format!("读不到文件：{e}")))?.len();
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).filter(|v| !v.trim().is_empty());
    crate::routes::audio_response(&path, total, "application/octet-stream".into(), range).await
}

#[derive(Deserialize)]
pub struct PeekPicture {
    /// 1-based frame number; absent for the contact sheet.
    #[serde(default)]
    n: Option<u32>,
}

/// One JPEG from the window: a frame, or the contact sheet.
pub async fn peek_picture(AxumPath(id): AxumPath<String>, Query(picture): Query<PeekPicture>, body: Bytes) -> ApiResult<Json<Value>> {
    let dir = window_peeks().lock().unwrap().get(&id).map(|peek| peek.dir.clone())
        .ok_or_else(|| ApiError::not_found("截帧请求已结束"))?;
    if !body.starts_with(&[0xff, 0xd8]) {
        return Err(ApiError::bad_request("不是 JPEG"));
    }
    let name = match picture.n {
        Some(n) if (1..=MAX_FRAMES as u32).contains(&n) => format!("frame-{n:02}.jpg"),
        Some(_) => return Err(ApiError::bad_request("帧序号无效")),
        None => "sheet.jpg".into(),
    };
    std::fs::write(dir.join(name), &body).map_err(|e| ApiError::bad_request(format!("写截图失败：{e}")))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PeekDone {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    report: Option<Value>,
}

pub async fn finish_peek(AxumPath(id): AxumPath<String>, Json(result): Json<PeekDone>) -> ApiResult<Json<Value>> {
    let done = window_peeks().lock().unwrap().get_mut(&id).and_then(|peek| peek.done.take());
    let answer = match (result.error, result.report) {
        (None, Some(report)) => Ok(report),
        (error, _) => Err(error.unwrap_or_else(|| "截帧失败".into())),
    };
    Ok(Json(json!({ "delivered": done.is_some_and(|done| done.send(answer).is_ok()) })))
}
