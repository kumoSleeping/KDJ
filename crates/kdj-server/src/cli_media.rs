//! `kdj peek`：截取视频画面。媒体可以是曲库曲目、本地文件或尚未下载的 B 站视频；
//! 在线视频只按需读取画面帧，不下载成品。
//! 请求被中断（CLI 退出）时，handler 被丢弃，取消令牌随之触发，ffmpeg 一并停下。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::{extract::State, Json};
use kdj_core::models::Platform;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::cli_api::{bilibili_video_input, recall, video_ref_source, Cached};
use crate::compositions::media::{capture, probe};
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
async fn resolve_media(state: &Arc<AppState>, source: &str, cancel: &CancellationToken) -> ApiResult<Media> {
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
        let duration = probe(path, cancel)
            .await
            .ok()
            .and_then(|p| p.format.duration.parse::<f64>().ok());
        return Ok(Media::File {
            path: path.to_path_buf(),
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            duration,
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

fn bilibili_headers(cookies: &str) -> String {
    let mut headers = "Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n".to_string();
    if !cookies.is_empty() {
        headers.push_str(&format!("Cookie: {cookies}\r\n"));
    }
    headers
}

/// ffmpeg 的输入参数：本地文件直接读；B 站带防盗链头读 CDN。
async fn input_args(state: &Arc<AppState>, media: &Media) -> ApiResult<Vec<String>> {
    Ok(match media {
        Media::File { path, .. } => vec!["-i".into(), path.to_string_lossy().into_owned()],
        Media::Bilibili { bvid, page, .. } => {
            let (url, cookies) = state.bilibili_preview.preview_source(bvid, *page).await
            .map_err(|error| ApiError::bad_request(format!("读取哔哩哔哩视频失败：{error:#}")))?;
            vec!["-headers".into(), bilibili_headers(&cookies), "-i".into(), url]
        }
    })
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

fn peek_times(body: &PeekBody, duration: Option<f64>) -> ApiResult<Vec<f64>> {
    let mut times: Vec<f64> = body.at.iter().copied().filter(|t| t.is_finite() && *t >= 0.).collect();
    if let Some(every) = body.every {
        if !(every.is_finite() && every > 0.) {
            return Err(ApiError::bad_request("--every 必须大于 0"));
        }
        let duration = duration.ok_or_else(|| ApiError::bad_request("读不到时长，请改用 --at"))?;
        let mut t = 0.;
        while t < duration && times.len() < MAX_FRAMES {
            times.push(t);
            t += every;
        }
    }
    if times.is_empty() {
        return Err(ApiError::bad_request("需要 --at 或 --every"));
    }
    if let Some(duration) = duration {
        // 末尾那一帧往前收一点，避免 seek 到结尾取不到画面。
        for t in &mut times {
            *t = t.min((duration - 0.1).max(0.));
        }
    }
    times.truncate(MAX_FRAMES);
    Ok(times)
}

pub async fn peek(State(state): State<Arc<AppState>>, Json(body): Json<PeekBody>) -> ApiResult<Json<Value>> {
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let media = resolve_media(&state, &body.source, &cancel).await?;
    let times = peek_times(&body, media.duration())?;
    let width = body.width.unwrap_or(480).clamp(160, 1280);
    sweep_old_peeks();
    let dir = peek_root().join(format!("{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::bad_request(format!("创建截图目录失败：{e}")))?;
    let ffmpeg = kdj_providers::ffmpeg::binary()?;
    let input = input_args(&state, &media).await?;
    let mut frames = Vec::new();
    let mut failed = Vec::new();
    for t in &times {
        let file = dir.join(format!("frame-{:02}.jpg", frames.len() + 1));
        let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-nostdin".into(), "-ss".into(), format!("{t:.3}")];
        args.extend(input.iter().cloned());
        args.extend(
            ["-an", "-frames:v", "1", "-vf"]
                .map(str::to_owned)
                .into_iter()
                .chain([format!("scale={width}:-2"), "-q:v".into(), "4".into(), "-y".into()])
                .chain([file.to_string_lossy().into_owned()]),
        );
        match capture(&ffmpeg, &args, 1024, Duration::from_secs(60), &cancel).await {
            Ok(_) if file.is_file() => frames.push(json!({ "at": round(*t), "path": file })),
            Ok(_) => failed.push(json!({ "at": round(*t), "error": "没有取到画面" })),
            Err(error) => {
                if cancel.is_cancelled() {
                    return Err(ApiError::bad_request("已取消"));
                }
                failed.push(json!({ "at": round(*t), "error": format!("{error:#}") }));
            }
        }
    }
    let mut result = json!({ "source": media.describe(), "frames": frames, "dir": dir });
    if !failed.is_empty() {
        result["failed"] = json!(failed);
    }
    if frames.len() > 1 {
        let columns = SHEET_COLUMNS.min(frames.len());
        let rows = frames.len().div_ceil(columns);
        let sheet = dir.join("sheet.jpg");
        let args: Vec<String> = [
            "-v", "error", "-nostdin", "-framerate", "1", "-start_number", "1", "-i",
        ]
        .map(str::to_owned)
        .into_iter()
        .chain([dir.join("frame-%02d.jpg").to_string_lossy().into_owned()])
        .chain(["-vf".into(), format!("tile={columns}x{rows}:padding=4:margin=4"), "-frames:v".into(), "1".into()])
        .chain(["-q:v".into(), "4".into(), "-y".into(), sheet.to_string_lossy().into_owned()])
        .collect();
        if capture(&ffmpeg, &args, 1024, Duration::from_secs(60), &cancel).await.is_ok() && sheet.is_file() {
            result["sheet"] = json!({
                "path": sheet,
                "columns": columns,
                "rows": rows,
                "order": "从左到右、从上到下，与 frames 顺序一致",
            });
        }
    }
    Ok(Json(result))
}
