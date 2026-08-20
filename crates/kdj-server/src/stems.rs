use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use kdj_core::{StemCompute, StemMode};
use kdj_stems::{ModelStatus, StemKind, StemWaveform, TrackStemStatus};
use serde::Deserialize;

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
pub struct ModelQuery {
    mode: Option<StemMode>,
    compute: Option<StemCompute>,
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
    mode: Option<StemMode>,
    compute: Option<StemCompute>,
}

#[derive(Default, Deserialize)]
pub struct TrackStemQuery {
    position: Option<f64>,
    #[serde(default)]
    playing: bool,
    mode: Option<StemMode>,
    compute: Option<StemCompute>,
}

const fn default_columns() -> usize {
    640
}

pub async fn model_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelQuery>,
) -> Json<ModelStatus> {
    let (mode, compute) = stem_selection(&state, query.mode, query.compute);
    Json(state.stems.model_status(mode, compute))
}

pub async fn activate_runtime(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelQuery>,
) -> Json<ModelStatus> {
    let (mode, compute) = stem_selection(&state, query.mode, query.compute);
    Json(state.stems.activate_runtime(mode, compute))
}

pub async fn download_model(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelQuery>,
) -> ApiResult<Json<ModelStatus>> {
    let (mode, compute) = stem_selection(&state, query.mode, query.compute);
    Ok(Json(state.stems.request_model(mode, compute)?))
}

pub async fn track_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<TrackStemQuery>,
) -> ApiResult<Json<TrackStemStatus>> {
    let track = local_track(&state, id)?;
    let mtime = source_mtime(Path::new(&track.path))?;
    let (mode, compute) = stem_selection(&state, query.mode, query.compute);
    if let Some(position) = query.position {
        Ok(Json(state.stems.retarget_track(
            mode,
            compute,
            id,
            position,
            mtime,
            query.playing,
        )))
    } else {
        Ok(Json(state.stems.track_status(mode, compute, id, mtime)))
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
    let (mode, compute) = stem_selection(&state, request.mode, request.compute);
    Ok(Json(state.stems.request_track(
        mode,
        compute,
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
    let stem = StemKind::parse(&stem).ok_or_else(|| ApiError::bad_request("未知 STEM 轨道"))?;
    if stem != StemKind::Vocals {
        return Err(ApiError::bad_request("Performance 只提供 VOCALS 人声波形"));
    }
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
    let _ = local_track(&state, id)?;
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

fn stem_selection(
    state: &AppState,
    _mode: Option<StemMode>,
    compute: Option<StemCompute>,
) -> (StemMode, StemCompute) {
    let settings = state.config.to_settings();
    (
        StemMode::MobileNetTwo,
        compute.unwrap_or(settings.stem_compute),
    )
}
