//! V4 uses the shared admission/cancellation lane and publishes ordinary analysis progress.
use crate::{
    error::{ApiError, ApiResult},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use kdj_core::work_scheduler::{work_scheduler, WorkClass, WorkRequest};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
};
#[derive(Clone, Serialize)]
pub struct Status {
    pub job_id: String,
    pub phase: String,
    pub error: String,
}
fn statuses() -> &'static Mutex<HashMap<i64, Status>> {
    static S: OnceLock<Mutex<HashMap<i64, Status>>> = OnceLock::new();
    S.get_or_init(Default::default)
}
#[derive(Default, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub precise: bool,
    #[serde(default)]
    pub force: bool,
}
pub async fn read(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let analysis = state.library.rhythm(id)?;
    let status = statuses().lock().unwrap().get(&id).cloned();
    Ok(Json(json!({"analysis":analysis,"status":status})))
}
pub async fn start(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(request): Json<Request>,
) -> ApiResult<Json<serde_json::Value>> {
    if state.library.get(id)?.is_none() {
        return Err(ApiError::not_found("素材不存在"));
    }
    if !request.force
        && state
            .library
            .rhythm(id)?
            .is_some_and(|r| !request.precise || r.precise)
    {
        return Ok(Json(json!({"job_id":null,"queued":0})));
    }
    let job = spawn(state, vec![id], true, request.precise);
    Ok(Json(json!({"job_id":job,"queued":1})))
}
pub fn spawn(state: Arc<AppState>, ids: Vec<i64>, priority: bool, precise: bool) -> String {
    let job = format!("rhythm-{}", format!("{:016x}", rand::random::<u64>()));
    let mut guard = statuses().lock().unwrap();
    if ids.len() == 1 {
        if let Some(old) = guard
            .get(&ids[0])
            .filter(|s| matches!(s.phase.as_str(), "queued" | "analyzing"))
        {
            return old.job_id.clone();
        }
    }
    let ids: Vec<_> = ids
        .into_iter()
        .filter(|id| {
            guard
                .get(id)
                .is_none_or(|s| !matches!(s.phase.as_str(), "queued" | "analyzing"))
        })
        .collect();
    if guard.len() > 2000 {
        guard.retain(|_, s| matches!(s.phase.as_str(), "queued" | "analyzing"));
    }
    for &id in &ids {
        guard.insert(
            id,
            Status {
                job_id: job.clone(),
                phase: "queued".into(),
                error: String::new(),
            },
        );
    }
    drop(guard);
    let done = Arc::new(AtomicUsize::new(0));
    // Editor requests have priority but remain individually cancellable.
    let cancel = state
        .analysis
        .register(&job, ids.len(), done.clone(), false);
    let result_job = job.clone();
    tokio::task::spawn_blocking(move || {
        kdj_core::thread_qos::prefer_background();
        let total = ids.len();
        let mut updated = Vec::new();
        for &id in &ids {
            if cancel.is_cancelled() {
                break;
            }
            let class = if priority {
                WorkClass::WorkstationAnalysis
            } else {
                WorkClass::LibraryAnalysisLight
            };
            let Ok(permit) =
                work_scheduler().acquire(WorkRequest::new(class), || cancel.is_cancelled())
            else {
                break;
            };
            // Keep the extracted features while yielding our slot to urgent audio/visible work.
            // Reacquisition waits only on this background worker, never on a playback thread.
            let permit = Mutex::new(Some(permit));
            let checkpoint = || {
                if cancel.is_cancelled() {
                    return true;
                }
                if !work_scheduler().allows(class) {
                    let mut slot = permit.lock().unwrap();
                    drop(slot.take());
                    match work_scheduler()
                        .acquire(WorkRequest::new(class), || cancel.is_cancelled())
                    {
                        Ok(next) => *slot = Some(next),
                        Err(_) => return true,
                    }
                }
                cancel.is_cancelled()
            };
            if let Some(status) = statuses().lock().unwrap().get_mut(&id) {
                status.phase = "analyzing".into();
            }
            let result = (|| -> anyhow::Result<()> {
                let track = state
                    .library
                    .get(id)?
                    .ok_or_else(|| anyhow::anyhow!("素材不存在"))?;
                let path = std::path::Path::new(&track.path);
                let signature = kdj_library::rhythm::signature(path)?;
                let started = std::time::Instant::now();
                let Some(mut analysis) = kdj_analysis::rhythm::analyze(path, precise, &checkpoint)?
                else {
                    anyhow::bail!("已取消");
                };
                if cancel.is_cancelled() {
                    anyhow::bail!("已取消");
                }
                if matches!(
                    path.extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase()
                        .as_str(),
                    "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi"
                ) {
                    let probe = tokio::runtime::Handle::current()
                        .block_on(crate::compositions::media::probe(path, &cancel))?;
                    if let Some(video) = probe.video() {
                        let shift = probe.audio_shift() as f64 / 1000.;
                        let duration = probe.duration(video) as f64 / 1000.;
                        analysis.audio_offset_seconds = shift;
                        analysis.duration = duration;
                        for events in [&mut analysis.beats, &mut analysis.downbeats] {
                            for t in events.iter_mut() {
                                *t += shift;
                            }
                            events.retain(|t| *t >= 0. && *t <= duration);
                        }
                        for s in &mut analysis.segments {
                            s.start_seconds = (s.start_seconds + shift).max(0.);
                            s.end_seconds = (s.end_seconds + shift).min(duration);
                        }
                        analysis
                            .segments
                            .retain(|s| s.end_seconds > s.start_seconds);
                        analysis.coverage = analysis
                            .segments
                            .iter()
                            .map(|s| [s.start_seconds, s.end_seconds])
                            .collect();
                    }
                }
                let _file_guard = state.folder_operations.lock().unwrap();
                state.library.save_rhythm(id, &signature, &analysis)?;
                tracing::info!(
                    track_id = id,
                    precise,
                    elapsed_ms = started.elapsed().as_millis(),
                    duration = analysis.duration,
                    segments = analysis.segments.len(),
                    "V4 rhythm complete"
                );
                Ok(())
            })();
            let (phase, error) = match result {
                Ok(()) => {
                    updated.push(id);
                    ("complete", String::new())
                }
                Err(e) => (
                    if cancel.is_cancelled() {
                        "canceled"
                    } else {
                        "failed"
                    },
                    format!("{e:#}"),
                ),
            };
            if let Some(status) = statuses().lock().unwrap().get_mut(&id) {
                status.phase = phase.into();
                status.error = error.clone();
            }
            let count = done.fetch_add(1, Ordering::Relaxed) + 1;
            state.hub.publish("analyze.progress",&json!({"job_id":job,"done":count,"total":total,"track_id":id,"version":"v4","error":error}));
        }
        for id in ids {
            if let Some(s) = statuses().lock().unwrap().get_mut(&id) {
                if s.job_id == job && matches!(s.phase.as_str(), "queued" | "analyzing") {
                    s.phase = "canceled".into();
                }
            }
        }
        state.analysis.unregister(&job);
        state.hub.publish_library_updated(&updated);
        state.hub.publish("analyze.progress",&json!({"job_id":job,"done":total,"total":total,"current":"","track_id":null,"version":"v4","cancelled":cancel.is_cancelled()}));
    });
    result_job
}
