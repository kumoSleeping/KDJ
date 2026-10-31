//! Authenticated editor transport. A bounded window of uploaded GOPs supplies the export; no
//! frame sequence is retained on disk. The window's renderers encode H.264 themselves (closed
//! GOPs in Annex B, WebCodecs), which `kdj-media` puts into an MP4 with the song's AAC (copied,
//! or encoded by the system encoder). Nothing here runs FFmpeg.
use super::{check, destination, source, Stage};
use crate::{error::{ApiError, ApiResult}, state::AppState};
use anyhow::{Context, Result, ensure, bail};
use axum::{Router, Extension, Json, body::Bytes, extract::{State, Path, Query, DefaultBodyLimit}, routing::{get, post}, http::HeaderMap};
use kdj_core::{audio_visualizer::{Scene, Spectrum}, work_scheduler::{work_scheduler, WorkClass, WorkRequest}};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, HashMap}, path::PathBuf, sync::{Arc, Mutex, Condvar}, time::{Duration, Instant}};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_DURATION_MS: i64 = 30 * 60 * 1000;
/// Uploaded GOPs the muxer has not taken yet: wider than the window's renderer count, so one
/// slow GOP does not idle every other renderer.
const MAX_WINDOW: u64 = 12;
/// One editor-encoded GOP. A second of the largest canvas at 60 fps stays well below.
const MAX_CHUNK: usize = 32 * 1024 * 1024;
fn api_check(condition: bool, detail: &str) -> ApiResult<()> {
    if condition { Ok(()) } else { Err(ApiError::bad_request(detail)) }
}

/// GOPs `index..end` may be uploaded with any token from `attempt` to `token`.
/// `token` grows whenever the window moves; `attempt` changes when an encoder
/// retry replays the sequence, which invalidates uploads for the previous pass.
#[derive(Clone, Serialize)]
struct Demand { token: u64, index: u64, end: u64, attempt: u64 }
#[derive(Clone, Serialize)]
struct Snapshot {
    id: String, phase: String, status: String, progress: f64,
    demand: Option<Demand>, output_path: String, error: String,
    /// Concurrent uploads and polls can answer out of order; the editor keeps the newest.
    version: u64,
}
impl Snapshot { fn terminal(&self) -> bool { matches!(self.phase.as_str(), "done" | "failed" | "canceled") } }
struct Exchange {
    snapshot: Snapshot, token: u64,
    /// First token of the encoder's current pass, and the frame it takes next.
    attempt: u64, next: u64,
    pending: BTreeMap<u64, Bytes>,
}
/// Editor-encoded video: unit `index` is the closed GOP of frames `index * per ..`.
/// Renderers encode GOPs in separate encoder sessions, so every one is checked before
/// it is muxed: a wrong frame count would shift the picture against the audio, and
/// differing parameter sets would not survive stream copy into one MP4 track.
struct Chunks { frames: u64, per: u64, parameters: Mutex<Option<Vec<u8>>> }
impl Chunks {
    fn check(&self, index: u64, bytes: &[u8]) -> Result<()> {
        let (pictures, parameters) = inspect_h264(bytes)?;
        let expected = self.per.min(self.frames.saturating_sub(index * self.per));
        ensure!(pictures == expected, "视频分段帧数不符：第 {index} 段应为 {expected} 帧，实际 {pictures} 帧");
        let mut first = self.parameters.lock().unwrap();
        ensure!(*first.get_or_insert_with(|| parameters.clone()) == parameters, "视频分段的编码参数不一致");
        Ok(())
    }
}
/// Pictures and leading parameter sets of one Annex B GOP. Emulation prevention keeps
/// start codes out of NAL payloads, so a plain scan finds every unit.
fn inspect_h264(bytes: &[u8]) -> Result<(u64, Vec<u8>)> {
    let mut starts = Vec::new();
    let mut i = 2;
    while i < bytes.len() {
        match bytes[i] {
            0 => i += 1,
            1 if bytes[i - 1] == 0 && bytes[i - 2] == 0 => { starts.push(i + 1); i += 3; }
            _ => i += 3,
        }
    }
    ensure!(starts.first().is_some_and(|&first| first <= 4), "视频分段不是 Annex B 码流");
    let (mut pictures, mut parameters, mut sets) = (0_u64, Vec::new(), [false; 2]);
    for (n, &start) in starts.iter().enumerate() {
        let unit = &bytes[start..starts.get(n + 1).map_or(bytes.len(), |next| next - 3)];
        let Some(&header) = unit.first() else { continue; };
        ensure!(header & 0x80 == 0, "视频分段码流损坏");
        match header & 0x1f {
            kind @ (7 | 8) if pictures == 0 => {
                // A four-byte start code leaves its first zero at the end of the previous unit.
                let unit = &unit[..unit.iter().rposition(|&b| b != 0).map_or(0, |last| last + 1)];
                parameters.extend_from_slice(&(unit.len() as u32).to_be_bytes()); parameters.extend_from_slice(unit);
                sets[(kind - 7) as usize] = true;
            }
            // first_mb_in_slice == 0 (a leading 1 bit) opens a new picture.
            kind @ (1 | 5) if unit.get(1).is_some_and(|b| b & 0x80 != 0) => {
                ensure!(pictures > 0 || (kind == 5 && sets == [true; 2]), "视频分段必须以带参数集的关键帧开始");
                pictures += 1;
            }
            _ => {}
        }
    }
    Ok((pictures, parameters))
}
struct Job {
    inner: Mutex<Exchange>, changed: Notify, ready: Condvar,
    cancel: CancellationToken, count: u64, window: u64, created: Instant,
    last_seen: Mutex<Instant>,
    chunks: Chunks,
}
impl Job {
    /// `frames` in GOPs of `per`. Compressed GOPs are small: the window is as wide as it gets.
    fn new(id: String, frames: u64, per: u64) -> Self {
        Self { inner: Mutex::new(Exchange { snapshot: Snapshot { id, phase: "queued".into(), status: "等待编码资源".into(), progress: 0., demand: None, output_path: String::new(), error: String::new(), version: 0 }, token: 0, attempt: 0, next: 0, pending: BTreeMap::new() }), changed: Notify::new(), ready: Condvar::new(), cancel: CancellationToken::new(), count: frames.div_ceil(per), window: MAX_WINDOW, created: Instant::now(), last_seen: Mutex::new(Instant::now()), chunks: Chunks { frames, per, parameters: Mutex::new(None) } }
    }
    /// A GOP is a second of video drawn and encoded by one renderer. One that does not come for
    /// this long means a renderer is stuck: the export stops instead of waiting for ever.
    fn patience(&self) -> Duration { Duration::from_secs(120) }
    fn touch(&self) { *self.last_seen.lock().unwrap() = Instant::now(); }
    fn editor_idle(&self) -> bool { self.last_seen.lock().unwrap().elapsed() > Duration::from_secs(45) }
    fn snapshot(&self) -> Snapshot { self.inner.lock().unwrap().snapshot.clone() }
    async fn next_snapshot(&self, since: u64) -> Snapshot {
        let notified = self.changed.notified(); tokio::pin!(notified); notified.as_mut().enable();
        let snapshot = self.snapshot();
        if !snapshot.terminal() && !snapshot.demand.as_ref().is_some_and(|d| d.token > since) {
            let _ = tokio::time::timeout(Duration::from_secs(12), notified).await;
        }
        self.snapshot()
    }
    fn publish(&self, g: &mut Exchange) { g.snapshot.version += 1; self.changed.notify_waiters(); }
    fn update(&self, f: impl FnOnce(&mut Snapshot)) { let mut g = self.inner.lock().unwrap(); f(&mut g.snapshot); self.publish(&mut g); }
    /// Opens the window at `g.next`, or closes it after the last frame.
    fn advertise(&self, g: &mut Exchange) {
        g.token += 1;
        g.snapshot.demand = (g.next < self.count).then(|| Demand { token: g.token, index: g.next, end: (g.next + self.window).min(self.count), attempt: g.attempt });
        self.publish(g);
    }
    fn submit(&self, token: u64, index: u64, pixels: Bytes) -> Result<()> {
        ensure!(index < self.count && (1..=MAX_CHUNK).contains(&pixels.len()), "视频分段长度或序号无效");
        self.chunks.check(index, &pixels)?;
        let mut g = self.inner.lock().unwrap();
        ensure!(!self.cancel.is_cancelled() && !g.snapshot.terminal(), "导出任务已结束");
        let open = g.snapshot.demand.as_ref().is_some_and(|d| (d.attempt..=d.token).contains(&token) && (d.index..d.end).contains(&index));
        ensure!(open && !g.pending.contains_key(&index), "过期或重复的视频帧");
        g.pending.insert(index, pixels); self.ready.notify_all(); Ok(())
    }
    fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.snapshot.terminal() { return; }
        self.cancel.cancel(); g.pending.clear(); g.snapshot.demand = None;
        g.snapshot.phase = "canceled".into(); g.snapshot.status = "已取消，正在清理临时文件".into();
        self.ready.notify_all(); self.publish(&mut g);
    }
    fn receive_frame(&self, index: u64, attempt: &CancellationToken) -> Result<Bytes> {
        ensure!(index < self.count, "视频分段序号无效");
        let mut g = self.inner.lock().unwrap();
        ensure!(!self.cancel.is_cancelled() && !attempt.is_cancelled(), "可视化导出已取消");
        if g.snapshot.demand.is_none() || index != g.next {
            // A retry replays from frame 0. Uploads still in flight for the old pass
            // carry tokens below the new attempt and are rejected rather than reused.
            g.pending.clear(); g.next = index; g.attempt = g.token + 1;
            self.advertise(&mut g);
        }
        let pass = g.attempt;
        let started = Instant::now();
        loop {
            ensure!(!self.cancel.is_cancelled() && !attempt.is_cancelled() && !g.snapshot.terminal(), "可视化导出已取消");
            ensure!(g.attempt == pass, "本次编码尝试已被替代");
            if let Some(pixels) = g.pending.remove(&index) {
                g.next = index + 1;
                // The GOPs handed to the muxer are the progress.
                g.snapshot.progress = g.snapshot.progress.max(g.next as f64 / self.count as f64 * 0.96);
                self.advertise(&mut g);
                return Ok(pixels);
            }
            if started.elapsed() > self.patience() { self.cancel.cancel(); bail!("编辑器超过 {} 秒未提供画面，已终止导出", self.patience().as_secs()); }
            g = self.ready.wait_timeout(g, Duration::from_millis(200)).unwrap().0;
        }
    }
}
#[derive(Default)]
struct Jobs { jobs: Mutex<HashMap<String, Arc<Job>>> }
impl Jobs {
    fn get(&self, id: &str) -> ApiResult<Arc<Job>> {
        let job = self.jobs.lock().unwrap().get(id).cloned().ok_or_else(|| ApiError::not_found("可视化任务不存在或已经回收"))?;
        job.touch(); Ok(job)
    }
    fn insert(&self, job: Arc<Job>) -> Result<()> {
        let mut jobs = self.jobs.lock().unwrap();
        ensure!(!jobs.values().any(|j| !j.snapshot().terminal()), "已有可视化视频正在导出，请先取消或等待完成");
        if jobs.len() >= 8 { if let Some(oldest) = jobs.iter().min_by_key(|(_, j)| j.created).map(|(id, _)| id.clone()) { jobs.remove(&oldest); } }
        jobs.insert(job.snapshot().id, job); Ok(())
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/visualizer/analyze", post(analyze))
        .route("/api/visualizer/export", post(start))
        .route("/api/visualizer/render", post(cover_render))
        .route("/api/visualizer/render/{id}/claim", post(claim_cover_render))
        .route("/api/visualizer/render/{id}/done", post(finish_cover_render))
        .route("/api/visualizer/jobs/{id}", get(poll))
        .route("/api/visualizer/jobs/{id}/cancel", post(cancel))
        .route("/api/visualizer/jobs/{id}/frames", post(frame).layer(DefaultBodyLimit::max(MAX_CHUNK)))
        .layer(Extension(Arc::new(Jobs::default())))
}
fn fingerprint(path: &std::path::Path) -> Result<String> {
    let s = super::signature(path)?;
    // Opaque string: nanosecond mtimes and u64 hashes must not round through JS Number.
    Ok(format!("{}:{}:{}", s.size, s.modified_ns, s.edge_hash))
}
fn track_audio(state: &AppState, id: i64) -> Result<PathBuf> {
    let track = state.library.get(id)?.context("曲目不存在")?;
    source(&track.path).context("请先把完整歌曲下载到本地曲库，不能使用流媒体占位或在线试听地址")
}
/// `kdj visualizer render`: the song's own cover in the studio's default project, rendered and
/// encoded by a KDJ window exactly as the studio exports (WebCodecs). The main window takes it
/// also while it is hidden (`--no-gui`); no window, no render.
#[derive(Deserialize)]
struct CoverRender { track_id: i64, output_path: String, #[serde(default)] width: Option<u32>, #[serde(default)] height: Option<u32> }

/// A render handed to a window: claimed once, answered once. Dropping the CLI request forgets it.
struct WindowRender { claim: Option<tokio::sync::oneshot::Sender<()>>, done: Option<tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>> }
fn window_renders() -> &'static Mutex<HashMap<String, WindowRender>> {
    static RENDERS: std::sync::OnceLock<Mutex<HashMap<String, WindowRender>>> = std::sync::OnceLock::new();
    RENDERS.get_or_init(Default::default)
}
/// How long a window has to take the render.
const WINDOW_CLAIM: Duration = Duration::from_secs(30);

async fn render_in_window(state: &AppState, p: &CoverRender) -> ApiResult<serde_json::Value> {
    let id = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
    let (claim, claimed) = tokio::sync::oneshot::channel();
    let (done, finished) = tokio::sync::oneshot::channel();
    window_renders().lock().unwrap().insert(id.clone(), WindowRender { claim: Some(claim), done: Some(done) });
    struct Forget(String);
    impl Drop for Forget { fn drop(&mut self) { window_renders().lock().unwrap().remove(&self.0); } }
    let _forget = Forget(id.clone());
    state.hub.publish("visualizer.render.requested", &serde_json::json!({ "id": id, "track_id": p.track_id, "output_path": p.output_path, "width": p.width, "height": p.height }));
    if !matches!(tokio::time::timeout(WINDOW_CLAIM, claimed).await, Ok(Ok(()))) {
        return Err(ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, "没有 KDJ 窗口接手渲染可视化：请打开 KDJ 后重试"));
    }
    match finished.await {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(error)) => Err(ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, error)),
        Err(_) => Err(ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, "渲染可视化的窗口已关闭")),
    }
}
async fn claim_cover_render(Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    let claim = window_renders().lock().unwrap().get_mut(&id).and_then(|render| render.claim.take());
    let taken = claim.is_some_and(|claim| claim.send(()).is_ok());
    Ok(Json(serde_json::json!({ "claimed": taken })))
}
#[derive(Deserialize)]
struct WindowRenderResult { #[serde(default)] error: Option<String>, #[serde(default)] report: Option<serde_json::Value> }
async fn finish_cover_render(Path(id): Path<String>, Json(result): Json<WindowRenderResult>) -> ApiResult<Json<serde_json::Value>> {
    let done = window_renders().lock().unwrap().get_mut(&id).and_then(|render| render.done.take());
    let answer = match (result.error, result.report) {
        (None, Some(report)) => Ok(report),
        (error, _) => Err(error.unwrap_or_else(|| "可视化渲染失败".into())),
    };
    Ok(Json(serde_json::json!({ "delivered": done.is_some_and(|done| done.send(answer).is_ok()) })))
}

async fn cover_render(State(state): State<Arc<AppState>>, Json(p): Json<CoverRender>) -> ApiResult<Json<serde_json::Value>> {
    let audio = track_audio(&state, p.track_id)?;
    api_check(std::path::Path::new(&p.output_path).is_absolute(), "输出路径要是绝对路径")?;
    kdj_providers::tags::read_cover(&audio).context("这首歌没有内嵌封面，可视化需要一张图片")?;
    Ok(Json(render_in_window(&state, &p).await?))
}

#[derive(Deserialize)]
struct Analyze { track_id: i64, spectrum: Spectrum }
// Typed body: a json! Value tree of an 18k-frame timeline peaks ~6x higher and widens every f32 to 17 digits.
#[derive(Serialize)]
struct Analyzed {
    timeline: kdj_analysis::visualizer::FeatureTimeline,
    signature: String,
    /// Seconds the file states but does not hold: it ends early (cut off while it was downloaded or
    /// copied). Everything that does decode is drawn and exported; the window says what is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    missing_tail: Option<f64>,
}

// Cache the serialized response: a warm reopen needs neither decode/FFT nor a second
// allocation of thousands of JSON feature objects. File signatures invalidate replacements.
#[derive(Default)]
struct AnalysisCache(std::collections::VecDeque<(String, Bytes)>);
impl AnalysisCache {
    fn get(&mut self, key: &str) -> Option<Bytes> {
        let index = self.0.iter().position(|(cached, _)| cached == key)?;
        let entry = self.0.remove(index)?;
        let bytes = entry.1.clone();
        self.0.push_back(entry);
        Some(bytes)
    }
    fn insert(&mut self, key: String, bytes: Bytes) {
        const LIMIT: usize = 32 * 1024 * 1024;
        if bytes.len() > LIMIT { return; }
        self.0.retain(|(cached, _)| cached != &key);
        self.0.push_back((key, bytes));
        while self.0.len() > 4 || self.0.iter().map(|(_, value)| value.len()).sum::<usize>() > LIMIT {
            self.0.pop_front();
        }
    }
}
fn analysis_response(bytes: Bytes) -> axum::response::Response {
    use axum::response::IntoResponse;
    ([(axum::http::header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
async fn analyze(State(state): State<Arc<AppState>>, Json(p): Json<Analyze>) -> ApiResult<axum::response::Response> {
    let scene = Scene { spectrum: p.spectrum.clone(), ..Scene::with_image(std::env::temp_dir().join("kdj-studio-validation.png").to_string_lossy().into_owned()) };
    scene.validate().map_err(ApiError::bad_request)?;
    let audio = track_audio(&state, p.track_id)?;
    let signature = fingerprint(&audio)?;
    let key = serde_json::to_string(&("studio-60-v1", &audio, &signature, p.spectrum.bands, p.spectrum.sensitivity, p.spectrum.smoothing)).map_err(anyhow::Error::from)?;
    static CACHE: std::sync::OnceLock<Mutex<AnalysisCache>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(AnalysisCache::default()));
    if let Some(bytes) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(analysis_response(bytes));
    }
    let cancel = CancellationToken::new(); let _guard = cancel.clone().drop_guard();
    static ANALYSIS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let asked = Instant::now();
    let _slot = ANALYSIS.get_or_init(|| tokio::sync::Semaphore::new(1)).acquire().await.map_err(anyhow::Error::from)?;
    let queued_ms = asked.elapsed().as_millis();
    // Concurrent previews share the completed result instead of queuing the same whole song.
    if let Some(bytes) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(analysis_response(bytes));
    }
    // The length the file states exactly (stated_duration): an MP3 without a Xing / VBRI tag only
    // lets symphonia guess it, and a fragmented MP4 says nothing; then the decode alone counts.
    let header = { let path = audio.clone(); tokio::task::spawn_blocking(move || kdj_analysis::decode::stated_duration(&path)).await.map_err(anyhow::Error::from)?? };
    let header_ms = header.map(|secs| secs * 1000.);
    let length = |ms: f64| api_check(ms >= 1. && ms <= MAX_DURATION_MS as f64, "初版支持最长 30 分钟的完整音频");
    if let Some(ms) = header_ms { length(ms)?; }
    let path = audio.clone(); let token = cancel.clone();
    let started = Instant::now();
    let timeline = tokio::task::spawn_blocking(move || {
        let _background = kdj_core::thread_qos::prefer_background();
        // The picture on screen waits for this, as the bar waits for its waveform: library
        // analysis steps aside at its next checkpoint instead of sharing the phone's cores with it.
        let _visible = work_scheduler().activity(WorkClass::VisibleWaveform);
        kdj_analysis::visualizer::analyze_at_fps(&path, &p.spectrum, 60, &|| token.is_cancelled())
    }).await.map_err(anyhow::Error::from)??;
    // Like the waveform's: a phone's timing is seen only in its report.
    crate::diagnostics::record("info", "analysis", "visualizer.timing", &format!(
        "audio_s={:.1} queued_ms={queued_ms} analysis_ms={}", timeline.duration_seconds(), started.elapsed().as_millis()));
    api_check(fingerprint(&audio)? == signature, "分析期间歌曲已变化，请重新打开工程")?;
    let decoded_ms = timeline.duration_seconds() * 1000.;
    length(decoded_ms)?;
    // A file that ends before the length it states is played, drawn and exported as far as it
    // goes, as every player plays it; a decode that fails midway has already failed above.
    let missing_tail = header_ms.map(|ms| (ms - decoded_ms) / 1000.).filter(|secs| *secs > 0.25);
    let bytes = Bytes::from(serde_json::to_vec(&Analyzed { timeline, signature, missing_tail }).map_err(anyhow::Error::from)?);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, bytes.clone());
    Ok(analysis_response(bytes))
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    track_id: i64, signature: String, duration: f64, output_path: String,
    width: u32, height: u32, fps: u32,
    /// Frames in each uploaded GOP.
    chunk_frames: u32,
    /// What the encoder is held to, from the project's quality; 0 leaves it to the canvas.
    #[serde(default)] video_bitrate: u64,
    /// Video sites offer their high-quality audio tiers only for 48 kHz uploads.
    /// Off keeps the song's own rate.
    #[serde(default = "yes")] audio_48k: bool,
}
fn yes() -> bool { true }
impl Export {
    fn frames(&self) -> u64 { (self.duration * self.fps as f64).ceil() as u64 }
    fn job(&self, id: String) -> Job { Job::new(id, self.frames(), self.chunk_frames as u64) }
    fn validate(&self) -> Result<()> {
        ensure!((1..=600).contains(&self.chunk_frames), "视频分段长度无效");
        ensure!(self.video_bitrate == 0 || (1_000_000..=80_000_000).contains(&self.video_bitrate), "视频码率无效");
        ensure!(self.width >= 320 && self.width <= 2560 && self.height >= 180 && self.height <= 1440 && self.width % 2 == 0 && self.height % 2 == 0 && [30, 60].contains(&self.fps), "输出画布或帧率无效");
        ensure!(self.duration.is_finite() && self.duration > 0. && self.duration <= MAX_DURATION_MS as f64 / 1000., "输出时长无效");
        Ok(())
    }
}
async fn start(State(state): State<Arc<AppState>>, Extension(jobs): Extension<Arc<Jobs>>, Json(p): Json<Export>) -> ApiResult<Json<Snapshot>> {
    p.validate()?;
    let audio = track_audio(&state, p.track_id)?;
    api_check(fingerprint(&audio)? == p.signature, "歌曲已变化，请重新分析后导出")?;
    // Known before any frame is drawn: where the sound comes from, or why there is none.
    let sound = editor_sound(&p, &audio).await?
        .ok_or_else(|| ApiError::bad_request(NO_SOUND))?;
    let output = destination(&p.output_path)?;
    let job = Arc::new(p.job(format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>())));
    jobs.insert(job.clone())?;
    // Cover editor disconnects even while queued for the shared encoder.
    let weak = Arc::downgrade(&job);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(job) = weak.upgrade() else { break; };
            if job.snapshot().terminal() { break; }
            if job.editor_idle() { job.stop(); break; }
        }
    });
    let first = job.snapshot();
    tokio::spawn(async move {
        // Tear down pending producers after, not before, classifying the result;
        // otherwise every encoder failure would be mislabeled as user cancel.
        let _lifetime = job.cancel.clone().drop_guard();
        let result = render(&p, sound, &audio, &output, job.clone()).await;
        let mut g = job.inner.lock().unwrap(); g.pending.clear(); g.snapshot.demand = None;
        if let Err(error) = result {
            if !job.cancel.is_cancelled() { tracing::error!(error = %format!("{error:#}"), phase = %g.snapshot.phase, "可视化合成导出失败"); }
            if g.snapshot.phase != "done" {
                g.snapshot.phase = if job.cancel.is_cancelled() { "canceled" } else { "failed" }.into();
                g.snapshot.error = format!("{error:#}"); g.snapshot.status = if job.cancel.is_cancelled() { "已取消并清理临时文件" } else { "导出失败" }.into();
            }
        }
        job.ready.notify_all(); job.publish(&mut g);
    });
    Ok(Json(first))
}
#[derive(Deserialize)]
struct Poll { #[serde(default)] since: u64 }
async fn poll(Extension(jobs): Extension<Arc<Jobs>>, Path(id): Path<String>, Query(p): Query<Poll>) -> ApiResult<Json<Snapshot>> {
    let job = jobs.get(&id)?;
    Ok(Json(job.next_snapshot(p.since).await))
}
async fn frame(Extension(jobs): Extension<Arc<Jobs>>, Path(id): Path<String>, headers: HeaderMap, pixels: Bytes) -> ApiResult<Json<Snapshot>> {
    // Keep the upload URL stable: per-frame URLs defeat the WebView's CORS
    // preflight cache. Generation/index still gate the single bounded slot.
    let (token, index) = headers.get("x-kdj-video-frame")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(':'))
        .and_then(|(token, index)| Some((token.parse::<u64>().ok()?, index.parse::<u64>().ok()?)))
        .ok_or_else(|| ApiError::bad_request("视频帧代次或索引无效"))?;
    let job = jobs.get(&id)?;
    job.submit(token, index, pixels)?;
    // Answer at once with the current window: the uploader renders the next free
    // frame instead of waiting for the encoder to take this one.
    Ok(Json(job.snapshot()))
}
async fn cancel(Extension(jobs): Extension<Arc<Jobs>>, Path(id): Path<String>) -> ApiResult<Json<Snapshot>> {
    let job = jobs.get(&id)?; job.stop(); Ok(Json(job.snapshot()))
}

async fn render(p: &Export, sound: Sound, audio: &std::path::Path, output: &std::path::Path, job: Arc<Job>) -> Result<()> {
    let token = job.cancel.clone();
    let _work = tokio::task::spawn_blocking(move || work_scheduler().acquire(WorkRequest::new(WorkClass::MediaComposition), || token.is_cancelled()).map_err(|_| anyhow::anyhow!("可视化导出已取消"))).await??;
    check(&job.cancel)?;
    // `p.duration` is the length the analysis decoded, which a file cut short holds less of than it
    // states; the fingerprint below says whether the song changed since.
    ensure!(fingerprint(audio)? == p.signature, "音频已变化，未开始编码");
    let stage = Stage::new(output.parent().context("输出目录无效")?)?;
    job.update(|s| { s.phase = "encoding".into(); s.status = "绘制与编码".into(); });
    mux_editor_video(p, sound, audio, &stage.0, job.clone()).await?;
    check(&job.cancel)?;
    job.update(|s| { s.phase = "validating".into(); s.status = "校验画面、音轨和文件版本".into(); s.progress = 0.97; s.demand = None; });
    let temporary = stage.0.join("render.mp4");
    let checked = { let path = temporary.clone(); tokio::task::spawn_blocking(move || kdj_media::export::check(&path)).await?? };
    validate_output(p, &checked)?;
    ensure!(fingerprint(audio)? == p.signature, "导出期间音频已变化，未提交成品");
    // Windows FlushFileBuffers requires GENERIC_WRITE.
    std::fs::File::options().write(true).open(&temporary)
        .with_context(|| format!("无法打开成品进行落盘同步：{}", temporary.display()))?
        .sync_all().context("成品落盘同步失败")?;
    // Cancellation and atomic no-clobber publication share this very short lock.
    let mut g = job.inner.lock().unwrap(); check(&job.cancel)?;
    kdj_providers::net::rename_download_noclobber(&temporary, output).context("目标已存在或无法安全提交，未覆盖")?;
    g.snapshot.phase = "done".into(); g.snapshot.status = "完成".into(); g.snapshot.progress = 1.; g.snapshot.output_path = output.to_string_lossy().into_owned(); g.snapshot.demand = None;
    #[cfg(unix)] if let Err(e) = std::fs::File::open(output.parent().unwrap()).and_then(|d| d.sync_all()) { g.snapshot.status = format!("成品已生成，目录同步警告：{e}"); }
    job.publish(&mut g); Ok(())
}

/// The read-back export against the request: picture size, every frame, both tracks
/// as long as the song within a frame and a bit.
fn validate_output(p: &Export, checked: &kdj_media::export::Checked) -> Result<()> {
    let expected = p.duration * 1000.;
    let tolerance = (2000. / p.fps as f64).ceil() + 60.;
    ensure!((checked.width, checked.height) == (p.width, p.height), "成品画面尺寸 {}x{} 与画布不符", checked.width, checked.height);
    ensure!(checked.frames == p.frames(), "成品帧数 {} 与预期 {} 不符", checked.frames, p.frames());
    ensure!((checked.video_secs * 1000. - expected).abs() <= tolerance && (checked.audio_secs * 1000. - expected).abs() <= tolerance,
        "成品时长校验失败：预期 {expected:.0} ms，视频 {:.0} ms，音频 {:.0} ms", checked.video_secs * 1000., checked.audio_secs * 1000.);
    ensure!(!p.audio_48k || checked.audio_rate == 48_000, "成品音轨不是 48 kHz");
    Ok(())
}

/// Where the export's AAC comes from. Both present the song exactly as symphonia decoded
/// it for the analysis, so the picture keeps the timing the editor previewed.
enum Sound {
    /// The song already is AAC at the wanted rate: its frames are copied.
    Copy(kdj_media::mp4::write::OutTrack),
    /// The system encoder makes it, alongside the video.
    Encode { rate: u32, frames: u64 },
}

/// Why an export has no sound: neither an AAC song to copy nor a system AAC encoder (Linux).
const NO_SOUND: &str = "这台设备没有系统 AAC 编码器，只能导出原曲是 AAC（M4A）的歌";

/// `None` where neither is possible (no AAC song, no system encoder: Linux).
async fn editor_sound(p: &Export, audio: &std::path::Path) -> Result<Option<Sound>> {
    let (duration, audio_48k, audio) = (p.duration, p.audio_48k, audio.to_path_buf());
    tokio::task::spawn_blocking(move || {
        let source = kdj_media::pcm::inspect(&audio)?;
        let rate = if audio_48k || ![44_100, 48_000].contains(&source.sample_rate) { 48_000 } else { source.sample_rate };
        let frames = (duration * rate as f64).round() as u64;
        Ok(match kdj_media::audio::copy(&audio, 1, Some(rate), Some(frames)) {
            Some(track) => Some(Sound::Copy(track)),
            None if kdj_media::aac::available() => Some(Sound::Encode { rate, frames }),
            None => None,
        })
    }).await?
}

/// Takes the editor's GOPs in order as they arrive, encodes the audio meanwhile, and
/// writes the MP4 when the last GOP is in.
async fn mux_editor_video(p: &Export, sound: Sound, audio: &std::path::Path, stage: &std::path::Path, job: Arc<Job>) -> Result<()> {
    let (p, audio, stage) = (p.clone(), audio.to_path_buf(), stage.to_path_buf());
    tokio::task::spawn_blocking(move || {
        let samples = stage.join("video.h264s");
        let scratch = stage.join("audio.aac");
        let encoding = match &sound {
            Sound::Copy(_) => None,
            &Sound::Encode { rate, frames } => {
                let (audio, scratch, cancel) = (audio.clone(), scratch.clone(), job.cancel.clone());
                Some(std::thread::Builder::new().name("visualizer-aac".into()).spawn(move || {
                    let _background = kdj_core::thread_qos::prefer_background();
                    let shape = kdj_media::audio::Shape { frames: Some(frames), ..Default::default() };
                    kdj_media::audio::encode(&audio, &scratch, 1, Some(rate), 256_000, shape, &|| cancel.is_cancelled())
                })?)
            }
        };
        let video = (|| {
            let mut video = kdj_media::export::VideoTrack::create(&samples, 0, p.width, p.height, p.fps)?;
            for index in 0..job.count {
                let gop = job.receive_frame(index, &job.cancel)?;
                video.push_gop(&gop).with_context(|| format!("第 {index} 段视频无法封装"))?;
            }
            ensure!(video.frames() == p.frames(), "编辑器提供了 {} 帧，应为 {} 帧", video.frames(), p.frames());
            video.finish()
        })();
        // Joined on every path: the encoder must be done with its scratch file before it is removed.
        let encoded = encoding.map(|thread| thread.join().map_err(|_| anyhow::anyhow!("音频编码线程异常退出")).and_then(|r| r.context("音轨编码失败")));
        let result = (|| {
            let video = video?;
            let (audio, audio_source) = match (sound, encoded) {
                (Sound::Copy(track), _) => (track, audio.clone()),
                (_, Some(encoded)) => (encoded?, scratch.clone()),
                (_, None) => unreachable!(),
            };
            kdj_media::mp4::write::write(&stage.join("render.mp4"), &[samples.as_path(), audio_source.as_path()], &[video, audio], kdj_media::mp4::write::Brand::Mp4, &|| job.cancel.is_cancelled())
        })();
        let _ = std::fs::remove_file(&samples);
        let _ = std::fs::remove_file(&scratch);
        result
    }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_analysis_body_keeps_f32_features_typed() {
        // A json! Value tree widened each f32 to f64 (0.5341235399246216) and peaked ~6x the typed body.
        use kdj_analysis::visualizer::{FeatureFrame, FeatureTimeline};
        let frame = FeatureFrame { bands: vec![0.53412354; 3], bass: 0.1, rms: 0.2, onset: 0.3 };
        let timeline = FeatureTimeline { version: 1, sample_rate: 22050, sample_count: 22050, fps: 60, frames: vec![frame; 2] };
        let body = serde_json::to_string(&Analyzed { timeline, signature: "1:2:3".into(), missing_tail: None }).unwrap();
        assert!(body.contains("[0.53412354,0.53412354,0.53412354]") && !body.contains("0.5341235399"), "{body}");
        let back: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(back["signature"], "1:2:3"); assert_eq!(back["timeline"]["frames"][1]["onset"].as_f64().unwrap() as f32, 0.3);
    }
    #[test]
    fn studio_analysis_cache_is_bounded_and_promotes_hits() {
        let mut cache = AnalysisCache::default();
        for key in ["a", "b", "c", "d"] { cache.insert(key.into(), Bytes::from_static(b"{}")); }
        assert!(cache.get("a").is_some());
        cache.insert("e".into(), Bytes::from_static(b"{}"));
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert!(cache.get("a-changed-file").is_none());
        cache.insert("a".into(), Bytes::from_static(b"new"));
        assert_eq!(cache.get("a").unwrap(), Bytes::from_static(b"new"));
        cache.insert("large".into(), Bytes::from(vec![0; 33 * 1024 * 1024]));
        assert!(cache.get("large").is_none());
        assert!(cache.0.len() <= 4);
    }

    /// Parameter sets, a key picture, then delta pictures of two slices each.
    fn gop(frames: u64, sps: u8) -> Vec<u8> {
        let mut bytes = vec![0, 0, 0, 1, 0x67, 0x64, sps, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88, 0x84];
        for _ in 1..frames { bytes.extend([0, 0, 1, 0x41, 0x9a, 0x21, 0, 0, 1, 0x41, 0x05, 0x33]); }
        bytes
    }
    fn h264(duration: f64, chunk_frames: u32) -> Export {
        Export { track_id: 1, signature: String::new(), duration, output_path: String::new(), width: 1920, height: 1080, fps: 30, chunk_frames, video_bitrate: 0, audio_48k: true }
    }
    /// The GOP of one frame, told apart by a trailing SEI byte the inspection ignores.
    fn tagged(tag: u8) -> Bytes {
        let mut bytes = gop(1, 0x1f);
        bytes.extend([0, 0, 1, 0x06, tag]);
        Bytes::from(bytes)
    }
    fn tag(bytes: &Bytes) -> u8 { *bytes.last().unwrap() }
    fn demand(job: &Job) -> Demand { loop { if let Some(d) = job.snapshot().demand { break d; } std::thread::sleep(Duration::from_millis(1)); } }

    #[test]
    fn studio_editor_heartbeat_and_terminal_cancel() {
        let job = Job::new("heartbeat".into(), 1, 1);
        *job.last_seen.lock().unwrap() = Instant::now() - Duration::from_secs(46);
        assert!(job.editor_idle()); job.touch(); assert!(!job.editor_idle());
        job.update(|s| s.phase = "done".into()); job.stop();
        assert_eq!(job.snapshot().phase, "done"); assert!(!job.cancel.is_cancelled());
    }
    #[test]
    fn studio_canvas_limits() {
        let mut p = Export { track_id: 1, signature: String::new(), duration: 3., output_path: String::new(), width: 1920, height: 840, fps: 60, chunk_frames: 60, video_bitrate: 0, audio_48k: true };
        assert!(p.validate().is_ok()); p.width = 1921; assert!(p.validate().is_err()); p.width = 1920;
        p.video_bitrate = 8_000_000; assert!(p.validate().is_ok()); p.video_bitrate = 900_000; assert!(p.validate().is_err(), "a bitrate no encoder holds a picture at"); p.video_bitrate = 0;
        p.chunk_frames = 0; assert!(p.validate().is_err(), "every export uploads GOPs"); p.chunk_frames = 60;
        p.duration = f64::NAN; assert!(p.validate().is_err());
    }
    #[test]
    fn studio_takes_only_window_encoded_gops() {
        let request = serde_json::json!({ "track_id": 1, "signature": "s", "duration": 2.0, "output_path": "/o.mp4", "width": 1920, "height": 1080, "fps": 30, "chunk_frames": 30 });
        let p: Export = serde_json::from_value(request.clone()).unwrap();
        assert_eq!((p.frames(), p.job("id".into()).count), (60, 2));
        // Raw frames for a server-side encoder are gone with it: such a request is refused.
        for (key, value) in [("pixel_format", "rgba"), ("acceleration", "software")] {
            let mut raw = request.clone(); raw[key] = value.into();
            assert!(serde_json::from_value::<Export>(raw).is_err(), "{key}");
        }
        let mut no_chunks = request; no_chunks.as_object_mut().unwrap().remove("chunk_frames");
        assert!(serde_json::from_value::<Export>(no_chunks).is_err());
    }
    #[test]
    fn studio_transport_is_bounded_and_replayable() {
        let job = Arc::new(Job::new("test".into(), 2, 1));
        for index in [0, 1, 0] {
            let source = job.clone(); let take = std::thread::spawn(move || source.receive_frame(index, &source.cancel).map(|b| tag(&b)));
            let demand = demand(&job);
            assert!(job.submit(demand.token + 1, index, tagged(3)).is_err());
            assert!(job.submit(demand.token, index, Bytes::from(gop(2, 0x1f))).is_err(), "a GOP of the wrong length");
            job.submit(demand.token, index, tagged(3)).unwrap();
            assert_eq!(take.join().unwrap().unwrap(), 3);
        }
        job.stop(); assert!(job.receive_frame(0, &job.cancel).is_err());
    }
    #[test]
    fn studio_window_accepts_out_of_order_uploads_once() {
        let job = Arc::new(Job::new("window".into(), 5, 1));
        assert_eq!(job.window, MAX_WINDOW);
        let source = job.clone();
        let muxer = std::thread::spawn(move || (0..5).map(|i| tag(&source.receive_frame(i, &source.cancel).unwrap())).collect::<Vec<_>>());
        let demand = demand(&job);
        assert_eq!((demand.index, demand.end, demand.attempt), (0, 5, demand.token));
        // Renderers finish in any order; the muxer still takes GOPs in sequence.
        for index in [3, 1, 4, 2, 0] { job.submit(demand.token, index, tagged(index as u8)).unwrap(); }
        assert_eq!(muxer.join().unwrap(), [0, 1, 2, 3, 4]);
        let done = job.snapshot();
        assert!(done.demand.is_none() && done.version > demand.token);
        assert!(job.submit(demand.token, 4, tagged(0)).is_err(), "consumed GOP accepted twice");
    }
    #[test]
    fn studio_window_is_bounded_and_rejects_duplicates() {
        let job = Arc::new(Job::new("bounded".into(), 100, 1));
        let source = job.clone();
        let muxer = std::thread::spawn(move || source.receive_frame(0, &source.cancel).map(|_| ()));
        let demand = demand(&job);
        assert_eq!(demand.end - demand.index, MAX_WINDOW);
        assert!(job.submit(demand.token, demand.end, tagged(0)).is_err(), "GOP beyond the window accepted");
        job.submit(demand.token, demand.end - 1, tagged(0)).unwrap();
        assert!(job.submit(demand.token, demand.end - 1, tagged(0)).is_err(), "duplicate GOP accepted");
        job.submit(demand.token, 0, tagged(0)).unwrap();
        muxer.join().unwrap().unwrap();
        let moved = job.snapshot().demand.unwrap();
        assert_eq!((moved.index, moved.end, moved.attempt), (1, demand.end + 1, demand.attempt));
        assert!(moved.token > demand.token);
        job.stop();
    }
    #[test]
    fn studio_retry_discards_the_previous_pass() {
        let job = Arc::new(Job::new("retry".into(), 3, 1));
        let source = job.clone();
        let first = std::thread::spawn(move || source.receive_frame(0, &source.cancel).map(|_| ()));
        let old = demand(&job);
        job.submit(old.token, 0, tagged(1)).unwrap();
        job.submit(old.token, 2, tagged(1)).unwrap();
        first.join().unwrap().unwrap();
        // Asking for GOP 0 again replays the sequence: uploads of the old pass are void.
        let source = job.clone();
        let retry = std::thread::spawn(move || source.receive_frame(0, &source.cancel).map(|b| tag(&b)));
        let new = loop { match job.snapshot().demand { Some(d) if d.attempt > old.attempt => break d, _ => std::thread::sleep(Duration::from_millis(1)) } };
        assert_eq!((new.index, new.end), (0, 3));
        assert!(job.submit(old.token, 1, tagged(1)).is_err(), "upload for the old pass accepted");
        job.submit(new.token, 0, tagged(2)).unwrap();
        assert_eq!(retry.join().unwrap().unwrap(), 2);
        assert!(job.inner.lock().unwrap().pending.is_empty(), "GOP 2 of the old pass survived the retry");
        job.stop();
    }
    #[test]
    fn studio_h264_gops_are_counted_and_must_open_with_their_parameter_sets() {
        let (pictures, parameters) = inspect_h264(&gop(30, 0x1f)).unwrap();
        assert_eq!(pictures, 30, "a second slice is not a second picture");
        assert_eq!(parameters, [0, 0, 0, 3, 0x67, 0x64, 0x1f, 0, 0, 0, 2, 0x68, 0xee]);
        assert!(inspect_h264(&[0, 0, 0, 9, 0x67, 0x64, 0x1f]).is_err(), "length-prefixed units accepted");
        assert!(inspect_h264(&gop(30, 0x1f)[13..]).is_err(), "key picture without parameter sets accepted");
        assert!(inspect_h264(&[0, 0, 1, 0x41, 0x9a, 0x21]).is_err(), "GOP opening with a delta picture accepted");
    }
    #[test]
    fn studio_h264_gops_must_have_their_frames_and_one_set_of_parameters() {
        let chunks = Chunks { frames: 70, per: 30, parameters: Mutex::new(None) };
        chunks.check(0, &gop(30, 0x1f)).unwrap();
        chunks.check(2, &gop(10, 0x1f)).unwrap();
        assert!(chunks.check(1, &gop(29, 0x1f)).is_err(), "a dropped frame would shift the picture against the audio");
        assert!(chunks.check(2, &gop(30, 0x1f)).is_err(), "a full GOP accepted as the ten-frame tail");
        assert!(chunks.check(1, &gop(30, 0x20)).is_err(), "another encoder's parameter sets accepted");
        chunks.check(1, &gop(30, 0x1f)).unwrap();
    }
    #[test]
    fn studio_h264_job_moves_whole_gops_of_any_length() {
        let p = h264(2.5, 30);
        p.validate().unwrap();
        assert!(h264(2.5, 0).validate().is_err());
        let job = Arc::new(p.job("gops".into()));
        assert_eq!((job.count, job.window, job.patience()), (3, MAX_WINDOW, Duration::from_secs(120)));
        let source = job.clone();
        let muxer = std::thread::spawn(move || (0..3).map(|i| source.receive_frame(i, &source.cancel).unwrap().len()).collect::<Vec<_>>());
        let demand = demand(&job);
        assert_eq!((demand.index, demand.end), (0, 3));
        assert!(job.submit(demand.token, 2, Bytes::from(gop(30, 0x1f))).is_err(), "a full GOP accepted as the 15-frame tail");
        assert!(job.submit(demand.token, 3, Bytes::from(gop(30, 0x1f))).is_err() && job.submit(demand.token, 0, Bytes::new()).is_err());
        for (index, frames) in [(2, 15), (0, 30), (1, 30)] { job.submit(demand.token, index, Bytes::from(gop(frames, 0x1f))).unwrap(); }
        assert_eq!(muxer.join().unwrap(), [gop(30, 0x1f).len(), gop(30, 0x1f).len(), gop(15, 0x1f).len()]);
        assert!((job.snapshot().progress - 0.96).abs() < 1e-9, "the GOPs handed to the muxer are the progress");
    }
}
