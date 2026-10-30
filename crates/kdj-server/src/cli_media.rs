//! `kdj peek`（截取视频画面）和 `kdj align`（声学定位：把视频或音频的声音对到参考曲上）。
//! 媒体可以是曲库曲目、本地文件或尚未下载的 B 站视频；在线视频只按需读取画面帧或音轨，
//! 不下载成品。定位的声音由 symphonia 解码，B 站只取 DASH 的纯音频流。
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

use kdj_analysis::alignment::{self, AudioFeatures, FuzzyPlacement, RecordingMatch};
use tokio_util::sync::CancellationToken;

use crate::cli_api::{bilibili_video_input, recall, video_ref_source, Cached};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_FRAMES: usize = 48;
const SHEET_COLUMNS: usize = 4;
/// `kdj align` reads at most the first half hour of each sound.
const MAX_AUDIO_SECONDS: usize = 1800;
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

// ---------------------------------------------------------------- align

#[derive(Deserialize)]
pub struct AlignBody {
    reference: String,
    video: String,
}

/// The first `MAX_AUDIO_SECONDS` of a file's sound, mono at the alignment's rate, decoded by
/// symphonia from where players start it. KDJ has no FFmpeg.
fn decode_mono(path: &Path, cancel: &CancellationToken) -> anyhow::Result<Vec<f32>> {
    let channels = kdj_media::pcm::inspect(path)?.channels as usize;
    let mut mono = Vec::new();
    kdj_media::pcm::decode_played(path, Some(alignment::SAMPLE_RATE as u32), Some((alignment::SAMPLE_RATE * MAX_AUDIO_SECONDS) as u64), &|| cancel.is_cancelled(), &mut |pcm| {
        mono.extend(pcm.chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32));
        Ok(())
    })?;
    Ok(mono)
}

/// A B 站 video's sound, without its picture: the DASH audio stream (an M4A of a few MB) is
/// fetched with the site's headers into a scratch file and decoded there. A video that only
/// has a single FLV stream has its audio taken out first (kdj-media's FLV reader).
async fn bilibili_sound(state: &Arc<AppState>, bvid: &str, page: usize, cancel: &CancellationToken) -> anyhow::Result<Vec<f32>> {
    let (url, cookies) = state.bilibili_preview.calibration_audio_source(bvid, page).await?;
    let scratch = std::env::temp_dir().join(format!("kdj-align-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&scratch)?;
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _remove = Remove(scratch.clone());
    let file = scratch.join("sound");
    let mut request = state.preview_http.get(&url)
        .header("Referer", "https://www.bilibili.com/")
        .header("User-Agent", "Mozilla/5.0");
    if !cookies.is_empty() {
        request = request.header("Cookie", cookies);
    }
    let response = request.send().await?;
    anyhow::ensure!(response.status().is_success(), "HTTP {}", response.status().as_u16());
    let mut out = tokio::fs::File::create(&file).await?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        anyhow::ensure!(!cancel.is_cancelled(), "已取消");
        tokio::io::AsyncWriteExt::write_all(&mut out, &chunk?).await?;
    }
    tokio::io::AsyncWriteExt::flush(&mut out).await?;
    drop(out);
    let token = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let path = if kdj_media::flv::looks_like_flv(&file) {
            let m4a = scratch.join("sound.m4a");
            kdj_media::flv::to_mp4(&file, &m4a, false, true, &|| token.is_cancelled())?;
            m4a
        } else {
            file
        };
        decode_mono(&path, &token)
    })
    .await?
}

async fn pcm(state: &Arc<AppState>, media: &Media, cancel: &CancellationToken) -> ApiResult<Vec<f32>> {
    let decoded = match media {
        Media::File { path, .. } => {
            let (path, token) = (path.clone(), cancel.clone());
            tokio::task::spawn_blocking(move || decode_mono(&path, &token))
                .await
                .map_err(|error| ApiError::bad_request(format!("读取音轨失败：{error}")))?
        }
        Media::Bilibili { bvid, page, .. } => bilibili_sound(state, bvid, *page, cancel).await,
    };
    decoded.map_err(|error| ApiError::bad_request(format!("读取音轨失败：{error:#}")))
}

struct Segment {
    video_in: f64,
    video_out: f64,
    ref_at: f64,
    speed: f64,
}

impl Segment {
    fn from_fuzzy(p: &FuzzyPlacement) -> Self {
        Segment { video_in: p.source_start_ms, video_out: p.source_end_ms, ref_at: p.reference_start_ms, speed: p.speed }
    }
}

/// 参考曲的小节号（1 起，带小数）。没有节拍网格时不给。
fn bar_at(downbeats: &[f64], seconds: f64) -> Option<f64> {
    if downbeats.len() < 2 || seconds < downbeats[0] {
        return None;
    }
    let i = downbeats.partition_point(|d| *d <= seconds).saturating_sub(1);
    let start = downbeats[i];
    // 最后一小节沿用前一小节的长度。
    let next = downbeats.get(i + 1).copied().unwrap_or_else(|| start + (start - downbeats[i - 1]));
    let fraction = ((seconds - start) / (next - start).max(0.001)).clamp(0., 0.999);
    Some((((i + 1) as f64 + fraction) * 100.).round() / 100.)
}

/// A speed to a millionth: one rounded to a ten-thousandth drifts several milliseconds a minute.
fn speed_value(speed: f64) -> f64 {
    (speed * 1e6).round() / 1e6
}

fn plan(id: &str, label: &str, evidence: &str, auto: bool, similarity: Option<f64>, segments: &[Segment], downbeats: &[f64]) -> Value {
    let first = &segments[0];
    let speed = first.speed;
    let mut value = json!({
        "id": id,
        "label": label,
        "evidence": evidence,
        "auto": auto,
        "speed": speed_value(speed),
        // 视频 0 秒对应参考曲的时间（秒）。
        "offset": round((first.ref_at - first.video_in / speed) / 1000.),
        "segments": segments.iter().map(|s| {
            let ref_at = s.ref_at / 1000.;
            let mut seg = json!({
                "video_in": round(s.video_in / 1000.),
                "video_out": round(s.video_out / 1000.),
                "ref_at": round(ref_at),
                "speed": speed_value(s.speed),
            });
            if let Some(bar) = bar_at(downbeats, ref_at) {
                seg["ref_bar"] = json!(bar);
            }
            seg
        }).collect::<Vec<_>>(),
    });
    if let Some(similarity) = similarity {
        value["similarity"] = json!((similarity * 1000.).round() / 1000.);
    }
    value
}

fn plans(found: &RecordingMatch, video_ms: f64, reference_ms: f64, downbeats: &[f64]) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(offset) = found.offset_ms {
        let video_in = (-offset).max(0.);
        let video_out = video_ms.min(reference_ms - offset);
        if video_out > video_in {
            out.push(plan("whole", "完整对齐", "verified", true, None,
                &[Segment { video_in, video_out, ref_at: video_in + offset, speed: 1. }], downbeats));
        }
    }
    if found.sections.len() > 1 {
        let segments: Vec<Segment> = found
            .sections
            .iter()
            .map(|s| Segment {
                video_in: s.video_start_ms as f64,
                video_out: (s.video_start_ms + s.duration_ms) as f64,
                ref_at: s.audio_start_ms as f64,
                speed: 1.,
            })
            .collect();
        out.push(plan("sections", "裁切匹配段", "verified", true, None, &segments, downbeats));
    }
    let verified = &found.fuzzy.verified;
    if let Some(longest) = verified
        .iter()
        .max_by(|a, b| (a.source_end_ms - a.source_start_ms).total_cmp(&(b.source_end_ms - b.source_start_ms)))
    {
        let similarity = verified.iter().map(|p| p.similarity).sum::<f64>() / verified.len() as f64;
        // Only the part of the video that lands inside the reference: a video longer than the song
        // (an intro scene, a staff card) would otherwise be laid past the song's end.
        let speed = longest.speed;
        let zero = longest.reference_start_ms - longest.source_start_ms / speed;
        let video_in = (-zero * speed).max(0.);
        let video_out = video_ms.min((reference_ms - zero) * speed);
        let mut whole = plan(
            "speed-whole",
            "变速对齐 · 保留完整",
            "verified",
            true,
            Some(similarity),
            &[Segment { video_in, video_out, ref_at: zero + video_in / speed, speed }],
            downbeats,
        );
        whole["verified"] = json!(verified
            .iter()
            .map(|p| [round(p.source_start_ms / 1000.), round(p.source_end_ms / 1000.)])
            .collect::<Vec<_>>());
        out.push(whole);
        if verified.len() > 1 {
            let segments: Vec<Segment> = verified.iter().map(Segment::from_fuzzy).collect();
            out.push(plan("speed-sections", "变速分段匹配", "verified", true, Some(similarity), &segments, downbeats));
        }
    }
    for (n, candidate) in found.fuzzy.review.iter().enumerate() {
        out.push(plan(&format!("melody-{}", n + 1), &format!("旋律候选 {}", n + 1), "melody", false,
            Some(candidate.similarity), &[Segment::from_fuzzy(candidate)], downbeats));
    }
    for (n, pieces) in found.short_review.iter().enumerate().filter(|(_, p)| !p.is_empty()) {
        let segments: Vec<Segment> = pieces.iter().map(Segment::from_fuzzy).collect();
        let similarity = pieces.iter().map(|p| p.similarity).sum::<f64>() / pieces.len() as f64;
        out.push(plan(&format!("short-{}", n + 1), "短版分段匹配", "partial", false, Some(similarity), &segments, downbeats));
    }
    out
}

/// The beats of a file in its own timeline (a video's in video time, its sound shifted by the
/// start of the sound stream): the library's analysis for a row, else one made now and kept for
/// as long as the file does not change. None for what is not a local file, or has no beats.
async fn beats_of(state: &Arc<AppState>, media: &Media, shift: f64) -> Option<Vec<f64>> {
    let Media::File { path, track_id, .. } = media else { return None };
    if let Some(id) = track_id {
        // The library's analysis of a video row is already in video time.
        return crate::rhythm::analysis(state, *id).await.ok().flatten().map(|a| a.beats).filter(|b| b.len() >= 16);
    }
    static MADE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, (String, Vec<f64>)>>> = std::sync::OnceLock::new();
    let signature = kdj_library::rhythm::signature(path).ok()?;
    if let Some((known, beats)) = MADE.get_or_init(Default::default).lock().unwrap().get(path) {
        if *known == signature {
            return Some(beats.clone());
        }
    }
    let file = path.clone();
    let analysis = tokio::task::spawn_blocking(move || kdj_analysis::rhythm::analyze(&file, true, &|| false)).await.ok()?.ok()??;
    let beats: Vec<f64> = analysis.beats.iter().map(|b| b + shift).filter(|b| *b >= 0.).collect();
    MADE.get_or_init(Default::default).lock().unwrap().insert(path.clone(), (signature, beats.clone()));
    (beats.len() >= 16).then_some(beats)
}

/// Where a file's sound starts after its picture, in seconds (an MP4's leading empty edits): the
/// sound decoded for matching starts there, the file's own timeline does not.
fn sound_shift(media: &Media) -> f64 {
    let Media::File { path, .. } = media else { return 0. };
    let Ok(movie) = kdj_media::mp4::read::Movie::open(path) else { return 0. };
    match (movie.video(), movie.audio()) {
        (Some(video), Some(audio)) => audio.start_secs() - video.start_secs(),
        _ => 0.,
    }
}

fn clock(seconds: f64) -> String {
    let seconds = seconds.max(0.);
    format!("{:02}:{:05.2}", (seconds / 60.).floor() as u64, seconds % 60.)
}

fn segment_value(piece: &kdj_analysis::beat_lock::Piece, downbeats: &[f64]) -> Value {
    let mut seg = json!({
        "video_in": round(piece.video_in), "video_out": round(piece.video_out),
        "ref_at": round(piece.ref_at), "speed": speed_value(piece.speed),
    });
    if let Some(bar) = bar_at(downbeats, piece.ref_at) {
        seg["ref_bar"] = json!(bar);
    }
    seg
}

fn pieces_of(plan: &Value) -> Vec<kdj_analysis::beat_lock::Piece> {
    plan["segments"].as_array().into_iter().flatten().map(|s| kdj_analysis::beat_lock::Piece {
        video_in: s["video_in"].as_f64().unwrap_or(0.), video_out: s["video_out"].as_f64().unwrap_or(0.),
        ref_at: s["ref_at"].as_f64().unwrap_or(0.), speed: s["speed"].as_f64().unwrap_or(1.),
    }).collect()
}

/// A plan laid as `pieces`, under `id` and `label`, with how well its beats sit (`locked`).
fn locked_plan(base: &Value, id: String, label: &str, pieces: &[kdj_analysis::beat_lock::Piece], locked: &kdj_analysis::beat_lock::Locked, downbeats: &[f64]) -> Value {
    let mut plan = base.clone();
    let first = pieces[0];
    plan["id"] = json!(id);
    plan["label"] = json!(label);
    plan["speed"] = json!(speed_value(first.speed));
    plan["offset"] = json!(round(first.ref_at - first.video_in / first.speed));
    plan["segments"] = json!(pieces.iter().map(|p| segment_value(p, downbeats)).collect::<Vec<_>>());
    plan["beat"] = json!({ "error_ms": (locked.error_ms * 10.).round() / 10., "matched": locked.matched, "beats": locked.beats });
    plan.as_object_mut().map(|o| o.remove("verified"));
    plan
}

/**
 * Every plan found by listening, as the workshop offered it, in groups: each found placement
 * (`group` says which: how it was found, where, how fast, how alike) with its ways of laying the
 * video. One that is not the same recording (a remix, a melody match) is also locked to the
 * song's beats (kdj-analysis beat_lock.rs): 保留完整 — the whole video at the fitted speed, as
 * far as the song goes; 裁切匹配段 — only what was matched; 分段变速 — pieces each at its own
 * speed where the remix re-times the music. Its `beat` says how close the beats sit (median ms)
 * and how many paired. The same recording (whole, sections) is matched to the sample already.
 */
fn lock_plans(plans: Vec<Value>, video: Option<&[f64]>, song: Option<&[f64]>, video_s: f64, song_s: f64, downbeats: &[f64]) -> Vec<Value> {
    use kdj_analysis::beat_lock::{bend, lock, Piece};
    let mut out = vec![];
    for (n, mut plan) in plans.into_iter().enumerate() {
        let group = format!("g{}", n + 1);
        let pieces = pieces_of(&plan);
        let Some(first) = pieces.first().copied() else { continue };
        let similarity = plan["similarity"].as_f64().map(|s| format!(" · 相似度 {s:.2}")).unwrap_or_default();
        let parts = if pieces.len() > 1 { format!(" · {} 段", pieces.len()) } else { String::new() };
        let title = format!("{} · {} · {:.4}×{similarity}{parts}", plan["label"].as_str().unwrap_or(""), clock(first.ref_at), first.speed);
        plan["group"] = json!(group);
        plan["group_label"] = json!(title);
        let same_recording = matches!(plan["id"].as_str(), Some("whole" | "sections"));
        let (Some(video), Some(song), false) = (video, song, same_recording) else {
            out.push(plan);
            continue;
        };
        let mut found = vec![];
        if pieces.len() == 1 {
            if let Some(locked) = lock(video, song, &first) {
                let piece = locked.pieces[0];
                // The whole video at that speed, from where it can start in the song to where the song ends.
                let from = (piece.video_in - piece.ref_at * piece.speed).max(0.);
                let to = video_s.min(piece.video_in + (song_s - piece.ref_at) * piece.speed);
                if to > from {
                    let whole = Piece { video_in: from, video_out: to, ref_at: piece.at(from), speed: piece.speed };
                    found.push(locked_plan(&plan, format!("{}-beat-whole", plan["id"].as_str().unwrap_or("")), "保留完整", &[whole], &locked, downbeats));
                }
                found.push(locked_plan(&plan, format!("{}-beat", plan["id"].as_str().unwrap_or("")), "裁切匹配段", &[piece], &locked, downbeats));
                if let Some(bent) = bend(video, song, &locked) {
                    found.push(locked_plan(&plan, format!("{}-beat-bend", plan["id"].as_str().unwrap_or("")), "分段变速", &bent.pieces, &bent, downbeats));
                }
            }
        } else {
            // Each piece locked on its own; all of them, or the plan is left as it was heard.
            let locked: Vec<_> = pieces.iter().map(|p| lock(video, song, p)).collect();
            if locked.iter().all(Option::is_some) {
                let locked: Vec<_> = locked.into_iter().flatten().collect();
                let laid: Vec<Piece> = locked.iter().map(|l| l.pieces[0]).collect();
                let mut errors: Vec<f64> = locked.iter().map(|l| l.error_ms).collect();
                let summary = kdj_analysis::beat_lock::Locked {
                    pieces: laid.clone(),
                    error_ms: kdj_analysis::dsp::median(&mut errors),
                    matched: locked.iter().map(|l| l.matched).sum(),
                    beats: locked.iter().map(|l| l.beats).sum(),
                };
                found.push(locked_plan(&plan, format!("{}-beat", plan["id"].as_str().unwrap_or("")), "对拍分段", &laid, &summary, downbeats));
            }
        }
        // A verified placement locked to the beats goes in by itself in place of the heard one.
        let auto = plan["auto"].as_bool().unwrap_or(false);
        if !found.is_empty() {
            for (k, locked) in found.iter_mut().enumerate() {
                locked["auto"] = json!(auto && k == 0);
            }
            plan["auto"] = json!(false);
            plan["label"] = json!("不对拍");
        }
        out.extend(found);
        out.push(plan);
    }
    out
}

/// Where `video`'s sound is heard in `reference`'s (both mono at the alignment's rate).
fn find(video: &[f32], reference: &[f32], cancel: &CancellationToken) -> anyhow::Result<RecordingMatch> {
    let canceled = || cancel.is_cancelled();
    let source = AudioFeatures::prepare(video, canceled)?;
    let target = AudioFeatures::prepare(reference, canceled)?;
    let mut found = alignment::compare_blocks(&source, &target, true, false, &canceled)?;
    if found.fuzzy.verified.len() == 1 {
        for candidate in found.fuzzy.review.clone() {
            if let Some(plan) = alignment::short_review_pair(&source, &target, &found.fuzzy.verified[0], &candidate, &canceled)? {
                found.short_review.push(plan);
            }
        }
    }
    Ok(found)
}

pub async fn align(State(state): State<Arc<AppState>>, Json(body): Json<AlignBody>) -> ApiResult<Json<Value>> {
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let reference = resolve_media(&state, &body.reference).await?;
    let video = resolve_media(&state, &body.video).await?;
    let (reference_pcm, video_pcm) = tokio::try_join!(pcm(&state, &reference, &cancel), pcm(&state, &video, &cancel))?;
    let reference_ms = reference_pcm.len() as f64 * 1000. / alignment::SAMPLE_RATE as f64;
    let video_ms = video_pcm.len() as f64 * 1000. / alignment::SAMPLE_RATE as f64;
    let worker_cancel = cancel.clone();
    let found = tokio::task::spawn_blocking(move || {
        let _background = kdj_core::thread_qos::prefer_background();
        find(&video_pcm, &reference_pcm, &worker_cancel)
    })
    .await
    .map_err(|error| ApiError::bad_request(format!("对齐任务失败：{error}")))??;
    let downbeats = match &reference {
        Media::File { track_id: Some(id), .. } => crate::rhythm::analysis(&state, *id).await.ok().flatten().map(|r| r.downbeats).unwrap_or_default(),
        _ => Vec::new(),
    };
    // The matched sound starts with each file's sound stream; the plans are in the files' own time.
    let (video_shift, reference_shift) = (sound_shift(&video), sound_shift(&reference));
    let mut plans = plans(&found, video_ms, reference_ms, &downbeats);
    for plan in &mut plans {
        for seg in plan["segments"].as_array_mut().into_iter().flatten() {
            for key in ["video_in", "video_out"] {
                seg[key] = json!(round((seg[key].as_f64().unwrap_or(0.) + video_shift).max(0.)));
            }
            seg["ref_at"] = json!(round(seg["ref_at"].as_f64().unwrap_or(0.) + reference_shift));
        }
        if let Some(first) = pieces_of(plan).first() {
            plan["offset"] = json!(round(first.ref_at - first.video_in / first.speed));
        }
    }
    let (video_beats, song_beats) = tokio::join!(beats_of(&state, &video, video_shift), beats_of(&state, &reference, reference_shift));
    let plans = lock_plans(plans, video_beats.as_deref(), song_beats.as_deref(),
        video_ms / 1000. + video_shift, reference_ms / 1000. + reference_shift, &downbeats);
    // A library row may not know its length yet; the decoded sound always does, and the caller
    // needs it to see where the song runs without picture.
    let described = |media: &Media, ms: f64| {
        let mut value = media.describe();
        if value["duration"].is_null() {
            value["duration"] = json!(round(ms / 1000.));
        }
        value
    };
    let mut result = json!({
        "reference": described(&reference, reference_ms),
        "video": described(&video, video_ms),
        "matched": !plans.is_empty(),
        "formula": "ref = ref_at + (video - video_in) / speed，单位秒",
        "plans": plans,
    });
    if !found.reason.is_empty() {
        result["reason"] = json!(found.reason);
    }
    if downbeats.is_empty() {
        result["note"] = json!("参考曲没有小节线（还没分析，或网格里没有找到小节），ref_bar 未给出；可先 kdj library get 该曲目");
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_analysis::alignment::MatchedSection;

    /// 16-bit stereo WAV at 44.1 kHz of `samples` (mono, -1..1).
    fn wav(path: &Path, samples: &[f32]) {
        let rate = 44_100u32;
        let data: Vec<u8> = samples.iter().flat_map(|s| {
            let v = ((s.clamp(-1., 1.)) * i16::MAX as f32) as i16;
            [v.to_le_bytes(), v.to_le_bytes()].concat()
        }).collect();
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        for v in [16u32] { out.extend_from_slice(&v.to_le_bytes()); }
        for v in [1u16, 2] { out.extend_from_slice(&v.to_le_bytes()); }
        for v in [rate, rate * 4] { out.extend_from_slice(&v.to_le_bytes()); }
        for v in [4u16, 16] { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        std::fs::write(path, out).unwrap();
    }

    /// `kdj align` with no FFmpeg anywhere: two files decoded by symphonia, the video's sound
    /// found 5 s into the song, and the plan says so.
    #[test]
    fn a_video_cut_from_the_song_is_found_where_it_starts() {
        // A minute of "music": notes of changing pitch and loudness, one every 250 ms.
        let rate = 44_100usize;
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; (seed % 1000) as f32 / 1000. };
        let notes: Vec<(f32, f32)> = (0..240).map(|_| (110. + next() * 880., 0.2 + next() * 0.6)).collect();
        let song: Vec<f32> = (0..rate * 60).map(|n| {
            let t = n as f32 / rate as f32;
            let (pitch, loud) = notes[(t / 0.25) as usize % notes.len()];
            let within = (t % 0.25) / 0.25;
            loud * (1. - within) * (2. * std::f32::consts::PI * pitch * t).sin()
        }).collect();
        let dir = std::env::temp_dir().join(format!("kdj-align-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (reference, video) = (dir.join("song.wav"), dir.join("clip.wav"));
        wav(&reference, &song);
        wav(&video, &song[rate * 5..rate * 45]);
        let cancel = CancellationToken::new();
        let found = find(&decode_mono(&video, &cancel).unwrap(), &decode_mono(&reference, &cancel).unwrap(), &cancel).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let laid = plans(&found, 40_000., 60_000., &[]);
        assert!(!laid.is_empty(), "matched: {}", found.reason);
        let first = &laid[0];
        assert_eq!(first["auto"], true, "{first}");
        assert!((first["offset"].as_f64().unwrap() - 5.0).abs() < 0.05, "{first}");
    }

    #[test]
    fn bars_count_from_one_with_a_fraction() {
        let downbeats = [1.0, 3.0, 5.0, 7.0];
        assert_eq!(bar_at(&downbeats, 0.5), None);
        assert_eq!(bar_at(&downbeats, 1.0), Some(1.0));
        assert_eq!(bar_at(&downbeats, 4.0), Some(2.5));
        assert_eq!(bar_at(&[], 4.0), None);
    }

    #[test]
    fn an_exact_offset_becomes_one_whole_segment_in_seconds() {
        let found = RecordingMatch { offset_ms: Some(-12_000.), ..Default::default() };
        let plans = plans(&found, 200_000., 300_000., &[]);
        assert_eq!(plans.len(), 1);
        let whole = &plans[0];
        assert_eq!(whole["id"], "whole");
        assert_eq!(whole["offset"], json!(-12.0));
        assert_eq!(whole["segments"][0]["video_in"], json!(12.0));
        assert_eq!(whole["segments"][0]["ref_at"], json!(0.0));
        assert_eq!(whole["segments"][0]["video_out"], json!(200.0));
    }

    #[test]
    fn sections_and_speed_plans_keep_their_evidence() {
        let found = RecordingMatch {
            offset_ms: Some(0.),
            sections: vec![
                MatchedSection { audio_start_ms: 0, video_start_ms: 0, duration_ms: 10_000 },
                MatchedSection { audio_start_ms: 20_000, video_start_ms: 10_000, duration_ms: 10_000 },
            ],
            ..Default::default()
        };
        let ids: Vec<_> = plans(&found, 20_000., 40_000., &[]).iter().map(|p| p["id"].clone()).collect();
        assert_eq!(ids, vec![json!("whole"), json!("sections")]);

        let mut found = RecordingMatch::default();
        let span = FuzzyPlacement {
            source_start_ms: 10_000., source_end_ms: 70_000., reference_start_ms: 30_000.,
            speed: 1.02, similarity: 0.8, anchors: 4,
        };
        found.fuzzy.verified = vec![span.clone()];
        found.fuzzy.review = vec![FuzzyPlacement { similarity: 0.4, ..span }];
        let plans = plans(&found, 100_000., 200_000., &[]);
        assert_eq!(plans[0]["id"], "speed-whole");
        assert_eq!(plans[0]["auto"], true);
        assert_eq!(plans[0]["verified"], json!([[10.0, 70.0]]));
        assert_eq!(plans[1]["id"], "melody-1");
        assert_eq!(plans[1]["evidence"], "melody");
        assert_eq!(plans[1]["auto"], false);
    }

    #[test]
    fn a_melody_match_is_offered_locked_to_the_beats() {
        // A 160 BPM opening under a 145 BPM remix: its 20 s at the song's 37.379 s.
        let speed = 145. / 160.;
        let video: Vec<f64> = (0..).map(|i| 0.2 + i as f64 * 0.375).take_while(|t| *t < 90.).collect();
        let song: Vec<f64> = video.iter().map(|v| 37.379 + (v - 20.) / speed).filter(|t| *t >= 0. && *t < 275.).collect();
        let mut found = RecordingMatch::default();
        found.fuzzy.review = vec![FuzzyPlacement {
            source_start_ms: 20_000., source_end_ms: 78_000., reference_start_ms: 37_379. + 80.,
            speed: 0.9062, similarity: 0.56, anchors: 4,
        }];
        let heard = plans(&found, 92_139., 275_142., &[]);
        let laid = lock_plans(heard, Some(&video), Some(&song), 92.139, 275.142, &[]);
        let labels: Vec<_> = laid.iter().map(|p| p["label"].as_str().unwrap().to_string()).collect();
        assert_eq!(labels, ["保留完整", "裁切匹配段", "不对拍"]);
        assert!(laid.iter().all(|p| p["group"] == "g1" && p["auto"] == false));
        let cut = &laid[1]["segments"][0];
        assert!((cut["speed"].as_f64().unwrap() - speed).abs() < 1e-5, "{cut}");
        assert!((cut["ref_at"].as_f64().unwrap() - 37.379).abs() < 0.003, "{cut}");
        assert!(laid[1]["beat"]["error_ms"].as_f64().unwrap() < 2.);
        // 保留完整 starts the video where it can and runs to its end.
        let whole = &laid[0]["segments"][0];
        assert_eq!(whole["video_in"], json!(0.0));
        assert_eq!(whole["video_out"], json!(92.139));
    }

    #[test]
    fn a_whole_slowed_video_stops_where_the_song_ends() {
        // A 263 s PV slowed to 0.9065 from 14.4 s would run to 304.8 s of a 275.1 s song.
        let speed = 0.9065;
        let mut found = RecordingMatch::default();
        found.fuzzy.verified = vec![FuzzyPlacement {
            source_start_ms: 14_000., source_end_ms: 78_000., reference_start_ms: 14_401. + 14_000. / speed,
            speed, similarity: 0.4, anchors: 4,
        }];
        let laid = plans(&found, 263_275., 275_140., &[]);
        let segment = &laid[0]["segments"][0];
        assert_eq!((segment["video_in"].clone(), segment["ref_at"].clone()), (json!(0.0), json!(14.401)));
        assert_eq!(segment["video_out"], json!(round((275_140. - 14_401.) * speed / 1000.)));

        // A video whose opening comes before the song starts begins where the song does.
        found.fuzzy.verified[0].reference_start_ms = 14_000. / speed - 5_000.;
        let laid = plans(&found, 263_275., 275_140., &[]);
        let segment = &laid[0]["segments"][0];
        assert_eq!((segment["video_in"].clone(), segment["ref_at"].clone()), (json!(round(5_000. * speed / 1000.)), json!(0.0)));
    }
}
