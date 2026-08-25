use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::extract::{Path as AxumPath, State};
use axum::Json;
use kdj_stems::{StemRuntimeStatus, TrackStemStatus};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub async fn runtime_status(State(state): State<Arc<AppState>>) -> Json<StemRuntimeStatus> {
    Json(state.stems.runtime_status())
}

pub async fn reset_runtime(State(state): State<Arc<AppState>>) -> Json<StemRuntimeStatus> {
    Json(state.stems.reset_runtime())
}

/// Audio STEM only needs the stable runtime key consumed by the native Deck worker.
/// Display scans and their waveform progress no longer exist.
pub async fn track_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<TrackStemStatus>> {
    let track = local_track(&state, id)?;
    let mtime = source_mtime(Path::new(&track.path))?;
    Ok(Json(state.stems.track_status(id, mtime)))
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
