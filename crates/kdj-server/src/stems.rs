use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::Json;
use kdj_stems::{
    ModelStatus, StemDebugModel, StemDebugModelCatalog, StemDebugRender, StemKind, StemWaveform,
    TrackStemStatus,
};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct WaveformQuery {
    #[serde(default = "default_columns")]
    buckets: usize,
}

#[derive(Deserialize)]
pub struct LiveWaveformQuery {
    #[serde(default = "default_columns")]
    buckets: usize,
    #[serde(default)]
    after: u64,
    epoch: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateTrackRequest {
    #[serde(default)]
    position: f64,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    deck: u8,
    #[serde(default)]
    playing: bool,
}

#[derive(Default, Deserialize)]
pub struct TrackStemQuery {
    position: Option<f64>,
    #[serde(default)]
    playing: bool,
}

const fn default_columns() -> usize {
    640
}

pub async fn model_status(State(state): State<Arc<AppState>>) -> Json<ModelStatus> {
    Json(state.stems.model_status())
}

pub async fn download_model(State(state): State<Arc<AppState>>) -> ApiResult<Json<ModelStatus>> {
    Ok(Json(state.stems.request_model()?))
}

pub async fn debug_model_status() -> Json<StemDebugModelCatalog> {
    Json(kdj_stems::stem_debug_model_catalog())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugRequest {
    track_id: i64,
    model: StemDebugModel,
    #[serde(default)]
    duration: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugAudioUrls {
    original: String,
    lanes: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugResponse {
    session_id: String,
    track_id: i64,
    title: String,
    artist: String,
    audio: StemDebugAudioUrls,
    #[serde(flatten)]
    render: StemDebugRender,
}

/// One disposable offline render at a time. The audition page intentionally does not share the
/// live Deck worker, model installation, cache headers, or scheduling state.
pub async fn debug_separate(
    State(state): State<Arc<AppState>>,
    Json(request): Json<StemDebugRequest>,
) -> ApiResult<Json<StemDebugResponse>> {
    let track = local_track(&state, request.track_id)?;
    let source = std::path::PathBuf::from(&track.path);
    let root = state.config.data_dir.join("stem-debug");
    let session_id = next_debug_session_id();
    let output = root.join(&session_id);
    let task_output = output.clone();
    let max_duration = (request.duration.is_finite() && request.duration > 0.0)
        .then_some(request.duration.clamp(5.0, 600.0));
    let model = request.model;
    let render = tokio::task::spawn_blocking(move || {
        static GATE: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = GATE
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if root.exists() {
            std::fs::remove_dir_all(&root)
                .map_err(|error| anyhow::anyhow!("清理上一个 Stem 调试会话失败：{error}"))?;
        }
        let result = kdj_stems::render_stem_debug(model, &source, &task_output, max_duration);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&task_output);
        }
        result
    })
    .await
    .map_err(|error| ApiError::bad_request(format!("Stem 调试任务退出：{error}")))??;
    let base = format!("/api/stems/debug/{session_id}");
    let lanes = render
        .lanes
        .iter()
        .map(|lane| (lane.id.clone(), format!("{base}/{}", lane.id)))
        .collect();
    Ok(Json(StemDebugResponse {
        session_id,
        track_id: track.id,
        title: if track.title.trim().is_empty() {
            track.filename
        } else {
            track.title
        },
        artist: track.artist,
        audio: StemDebugAudioUrls {
            original: format!("{base}/original"),
            lanes,
        },
        render,
    }))
}

pub async fn debug_audio(
    State(state): State<Arc<AppState>>,
    AxumPath((session, lane)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if !valid_debug_token(&session)
        || !matches!(
            lane.as_str(),
            "original" | "drums" | "bass" | "other" | "vocals" | "instrumental"
        )
    {
        return Err(ApiError::not_found("Stem 调试音频不存在"));
    }
    let path = state
        .config
        .data_dir
        .join("stem-debug")
        .join(session)
        .join(format!("{lane}.wav"));
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|_| ApiError::not_found("Stem 调试音频不存在"))?
        .len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty());
    crate::routes::audio_response(&path, total, "audio/wav".into(), range).await
}

pub async fn debug_release(
    State(state): State<Arc<AppState>>,
    AxumPath(session): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_debug_token(&session) {
        return Err(ApiError::not_found("Stem 调试会话不存在"));
    }
    let path = state.config.data_dir.join("stem-debug").join(session);
    let released = if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|error| ApiError::bad_request(format!("清理 Stem 调试会话失败：{error}")))?;
        true
    } else {
        false
    };
    Ok(Json(serde_json::json!({ "released": released })))
}

fn next_debug_session_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{clock:032x}{sequence:016x}")
}

fn valid_debug_token(value: &str) -> bool {
    value.len() == 48 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub async fn track_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<TrackStemQuery>,
) -> ApiResult<Json<TrackStemStatus>> {
    let track = local_track(&state, id)?;
    let mtime = source_mtime(Path::new(&track.path))?;
    if let Some(position) = query.position {
        Ok(Json(state.stems.retarget_track(
            id,
            position,
            mtime,
            query.playing,
        )))
    } else {
        Ok(Json(state.stems.track_status(id, mtime)))
    }
}

pub async fn separate_track(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Json(request): Json<SeparateTrackRequest>,
) -> ApiResult<Json<TrackStemStatus>> {
    let track = local_track(&state, id)?;
    let path = Path::new(&track.path);
    let mtime = source_mtime(path)?;
    Ok(Json(state.stems.request_track(
        id,
        path,
        mtime,
        request.position,
        request.duration.max(track.duration.unwrap_or(0.0)),
        request.deck.min(1),
        request.playing,
    )?))
}

pub async fn release_track(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let _ = local_track(&state, id)?;
    state.stems.release_track(id);
    Ok(Json(serde_json::json!({ "released": true })))
}

pub async fn stem_waveform(
    State(state): State<Arc<AppState>>,
    AxumPath((id, stem)): AxumPath<(i64, String)>,
    Query(query): Query<WaveformQuery>,
) -> ApiResult<Json<StemWaveform>> {
    let track = local_track(&state, id)?;
    let mtime = source_mtime(Path::new(&track.path))?;
    let status = state.stems.track_status(id, mtime);
    if !matches!(status.state.as_str(), "separating" | "ready") {
        return Err(ApiError::bad_request("STEM 波形尚未开始生成"));
    }
    let stem = StemKind::parse(&stem).ok_or_else(|| ApiError::bad_request("未知 STEM 轨道"))?;
    let waveform = state.stems.track_waveform(id, mtime, stem, query.buckets)?;
    Ok(Json(waveform))
}

/// Small delta endpoint used only by the performance STEM lanes. Keeping it separate preserves
/// the old full-waveform response for callers outside the live player while preventing a 200ms
/// polling loop from repeatedly serializing an entire song four times.
pub async fn live_stem_waveform(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<LiveWaveformQuery>,
) -> ApiResult<Json<kdj_stems::LiveStemWaveformDelta>> {
    let track = local_track(&state, id)?;
    let mtime = source_mtime(Path::new(&track.path))?;
    let status = state.stems.track_status(id, mtime);
    if !matches!(status.state.as_str(), "separating" | "ready") {
        return Err(ApiError::bad_request("STEM 波形尚未开始生成"));
    }
    let waveform = kdj_stems::live_stem_waveform_delta(id, query.buckets, query.after, query.epoch)
        .ok_or_else(|| ApiError::bad_request("实时 STEM 波形尚未生成"))?;
    Ok(Json(waveform))
}

fn local_track(state: &AppState, id: i64) -> ApiResult<kdj_core::Track> {
    let track = state
        .library
        .get(id)?
        .ok_or_else(|| ApiError::not_found("曲目不存在"))?;
    if track.path.trim().is_empty() || !Path::new(&track.path).is_file() {
        return Err(ApiError::bad_request("曲目文件不存在，无法生成 STEM"));
    }
    Ok(track)
}

fn source_mtime(path: &Path) -> ApiResult<i64> {
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| ApiError::bad_request(format!("读取曲目时间戳失败：{error}")))?;
    let since_epoch = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ApiError::bad_request("曲目时间戳无效"))?;
    let value =
        i128::from(since_epoch.as_secs()) * 1_000_000_000 + i128::from(since_epoch.subsec_nanos());
    Ok(value.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64)
}
