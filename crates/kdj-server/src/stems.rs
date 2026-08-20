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
use kdj_core::{StemCompute, StemMode};
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
    mode: Option<StemMode>,
    compute: Option<StemCompute>,
) -> (StemMode, StemCompute) {
    let settings = state.config.to_settings();
    (
        mode.unwrap_or(settings.stem_mode),
        compute.unwrap_or(settings.stem_compute),
    )
}

// ---------- SeekLab（随机跳转 Stem 实验，类 Neural Mix 调度研究） ----------

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
use kdj_stems::seeklab;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabSeekRequest {
    track_id: i64,
    #[serde(default)]
    seek_seconds: f64,
    backend: Option<seeklab::LabBackend>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabSeekResponse {
    session_id: String,
    track_id: i64,
    title: String,
    duration_seconds: f64,
    report: seeklab::SeekTrialReport,
    audio: StemDebugAudioUrls,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub async fn lab_catalog() -> Json<seeklab::LabCatalog> {
    Json(seeklab::lab_catalog())
}

/// 每个 backend 一套常驻 session（与真实 DJ 软件一致：模型常驻，跳转只是调度事件）。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
fn lab_engines() -> &'static Mutex<BTreeMap<&'static str, Arc<Mutex<seeklab::SeekLab>>>> {
    static ENGINES: OnceLock<Mutex<BTreeMap<&'static str, Arc<Mutex<seeklab::SeekLab>>>>> =
        OnceLock::new();
    ENGINES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
fn lab_engine(backend: seeklab::LabBackend) -> ApiResult<Arc<Mutex<seeklab::SeekLab>>> {
    let key = backend.label();
    let mut engines = lab_engines()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(engine) = engines.get(key) {
        return Ok(engine.clone());
    }
    let spleeter_dir = seeklab::spleeter_model_dir()
        .ok_or_else(|| ApiError::bad_request("Spleeter4 模型目录未找到"))?;
    let hstasnet_dir = seeklab::hstasnet_model_dir()
        .ok_or_else(|| ApiError::bad_request("HS-TasNet (StemgenRT) 模型目录未找到"))?;
    let engine = Arc::new(Mutex::new(seeklab::SeekLab::new(
        backend,
        &spleeter_dir,
        &hstasnet_dir,
    )));
    engines.insert(key, engine.clone());
    Ok(engine)
}

/// 最近一首曲目的整轨 PCM 缓存：连续跳转同一首歌时省掉重复解码。
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
fn lab_pcm_cache() -> &'static Mutex<Option<(std::path::PathBuf, Arc<seeklab::LabPcm>)>> {
    static CACHE: OnceLock<Mutex<Option<(std::path::PathBuf, Arc<seeklab::LabPcm>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub async fn lab_seek(
    State(state): State<Arc<AppState>>,
    Json(request): Json<LabSeekRequest>,
) -> ApiResult<Json<LabSeekResponse>> {
    let track = local_track(&state, request.track_id)?;
    let source = std::path::PathBuf::from(&track.path);
    let backend = request.backend.unwrap_or(seeklab::LabBackend::Cpu);
    let engine = lab_engine(backend)?;
    let root = state.config.data_dir.join("stem-lab");
    let session_id = next_debug_session_id();
    let output = root.join(&session_id);
    let task_output = output.clone();
    let title = if track.title.trim().is_empty() {
        track.filename.clone()
    } else {
        track.title.clone()
    };
    let outcome = tokio::task::spawn_blocking(move || {
        static GATE: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = GATE
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pcm = {
            let mut cache = lab_pcm_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let hit = cache
                .as_ref()
                .map(|(path, _)| path == &source)
                .unwrap_or(false);
            if !hit {
                let decoded = seeklab::LabPcm::decode(&source)
                    .map_err(|error| anyhow::anyhow!("解码失败：{error:#}"))?;
                *cache = Some((source.clone(), Arc::new(decoded)));
            }
            cache.as_ref().expect("lab pcm cache").1.clone()
        };
        let duration = pcm.duration_seconds();
        let seek_seconds = request.seek_seconds.clamp(5.0, (duration - 8.0).max(5.0));
        let seek_frame = (seek_seconds * kdj_stems::SAMPLE_RATE as f64) as usize;
        let outcome = engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .run_trial(
                &pcm,
                seek_frame,
                &seeklab::SeekTrialOptions {
                    collect_audio: true,
                    ..Default::default()
                },
            )
            .map_err(|error| anyhow::anyhow!("SeekLab 实验失败：{error:#}"))?;
        if root.exists() {
            let _ = std::fs::remove_dir_all(&root);
        }
        std::fs::create_dir_all(&task_output)
            .map_err(|error| anyhow::anyhow!("创建 SeekLab 会话目录失败：{error}"))?;
        if let Some(audio) = &outcome.audio {
            seeklab::write_lab_float_wav(&task_output.join("original.wav"), &audio.original)
                .map_err(|error| anyhow::anyhow!("写出试听音频失败：{error:#}"))?;
            for (index, lane) in seeklab::LAB_LANES.iter().enumerate() {
                seeklab::write_lab_float_wav(
                    &task_output.join(format!("instant_{lane}.wav")),
                    &audio.instant[index],
                )
                .map_err(|error| anyhow::anyhow!("写出试听音频失败：{error:#}"))?;
                seeklab::write_lab_float_wav(
                    &task_output.join(format!("refined_{lane}.wav")),
                    &audio.refined[index],
                )
                .map_err(|error| anyhow::anyhow!("写出试听音频失败：{error:#}"))?;
            }
        }
        Ok::<_, anyhow::Error>((outcome, duration))
    })
    .await
    .map_err(|error| ApiError::bad_request(format!("SeekLab 任务退出：{error}")))??;
    let (mut outcome, duration) = outcome;
    outcome.report.source = track.path.clone();
    let base = format!("/api/stems/lab/{session_id}");
    let lanes = seeklab::LAB_LANES
        .iter()
        .flat_map(|lane| {
            [
                (format!("instant_{lane}"), format!("{base}/instant_{lane}")),
                (format!("refined_{lane}"), format!("{base}/refined_{lane}")),
            ]
        })
        .collect();
    Ok(Json(LabSeekResponse {
        session_id,
        track_id: track.id,
        title,
        duration_seconds: duration,
        report: outcome.report,
        audio: StemDebugAudioUrls {
            original: format!("{base}/original"),
            lanes,
        },
    }))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub async fn lab_audio(
    State(state): State<Arc<AppState>>,
    AxumPath((session, name)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let valid_name = name == "original"
        || seeklab::LAB_LANES
            .iter()
            .any(|lane| name == format!("instant_{lane}") || name == format!("refined_{lane}"));
    if !valid_debug_token(&session) || !valid_name {
        return Err(ApiError::not_found("SeekLab 音频不存在"));
    }
    let path = state
        .config
        .data_dir
        .join("stem-lab")
        .join(session)
        .join(format!("{name}.wav"));
    let total = tokio::fs::metadata(&path)
        .await
        .map_err(|_| ApiError::not_found("SeekLab 音频不存在"))?
        .len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty());
    crate::routes::audio_response(&path, total, "audio/wav".into(), range).await
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub async fn lab_release(
    State(state): State<Arc<AppState>>,
    AxumPath(session): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    if !valid_debug_token(&session) {
        return Err(ApiError::not_found("SeekLab 会话不存在"));
    }
    let path = state.config.data_dir.join("stem-lab").join(session);
    if path.exists() {
        std::fs::remove_dir_all(&path)
            .map_err(|error| ApiError::bad_request(format!("清理 SeekLab 会话失败：{error}")))?;
    }
    Ok(Json(serde_json::json!({ "released": true })))
}
