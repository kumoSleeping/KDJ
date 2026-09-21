//! Authenticated editor transport. A bounded demand/response RGBA slot supplies
//! the existing replayable FFmpeg pipe; no frame sequence is retained on disk.
use super::{check, destination, source, Stage};
use crate::{error::{ApiError, ApiResult}, state::AppState};
use crate::compositions::{acceleration, frame_pipe::{FrameSource, FramePixels}, media};
use anyhow::{Context, Result, ensure, bail};
use axum::{Router, Extension, Json, body::Bytes, extract::{State, Path, Query, DefaultBodyLimit}, routing::{get, post}};
use kdj_core::{audio_visualizer::{Scene, Spectrum}, composition::EncodingAcceleration, work_scheduler::{work_scheduler, WorkClass, WorkRequest}};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, Condvar}, time::{Duration, Instant}};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_FRAME: usize = 2560 * 1440 * 4;
const MAX_DURATION_MS: i64 = 30 * 60 * 1000;
fn api_check(condition: bool, detail: &str) -> ApiResult<()> {
    if condition { Ok(()) } else { Err(ApiError::bad_request(detail)) }
}

#[derive(Clone, Serialize)]
struct Demand { token: u64, index: u64 }
#[derive(Clone, Serialize)]
struct Snapshot {
    id: String, phase: String, status: String, progress: f64,
    demand: Option<Demand>, output_path: String, error: String,
}
impl Snapshot { fn terminal(&self) -> bool { matches!(self.phase.as_str(), "done" | "failed" | "canceled") } }
struct Exchange { snapshot: Snapshot, token: u64, pixels: Option<(u64, Bytes)> }
struct Job {
    inner: Mutex<Exchange>, changed: Notify, ready: Condvar,
    cancel: CancellationToken, count: u64, bytes: usize, created: Instant,
    last_seen: Mutex<Instant>,
}
impl Job {
    fn new(id: String, count: u64, bytes: usize) -> Self {
        Self { inner: Mutex::new(Exchange { snapshot: Snapshot { id, phase: "queued".into(), status: "等待编码资源".into(), progress: 0., demand: None, output_path: String::new(), error: String::new() }, token: 0, pixels: None }), changed: Notify::new(), ready: Condvar::new(), cancel: CancellationToken::new(), count, bytes, created: Instant::now(), last_seen: Mutex::new(Instant::now()) }
    }
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
    fn update(&self, f: impl FnOnce(&mut Snapshot)) { f(&mut self.inner.lock().unwrap().snapshot); self.changed.notify_waiters(); }
    fn submit(&self, token: u64, index: u64, pixels: Bytes) -> Result<()> {
        ensure!(pixels.len() == self.bytes, "RGBA 帧长度不匹配");
        let mut g = self.inner.lock().unwrap();
        ensure!(!self.cancel.is_cancelled() && !g.snapshot.terminal(), "导出任务已结束");
        ensure!(g.snapshot.demand.as_ref().is_some_and(|d| d.token == token && d.index == index) && g.pixels.is_none(), "过期或重复的视频帧");
        g.pixels = Some((token, pixels)); self.ready.notify_all(); Ok(())
    }
    fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.snapshot.terminal() { return; }
        self.cancel.cancel(); g.pixels = None; g.snapshot.demand = None;
        g.snapshot.phase = "canceled".into(); g.snapshot.status = "已取消，正在清理临时文件".into();
        self.ready.notify_all(); self.changed.notify_waiters();
    }
    fn receive_frame(&self, index: u64, attempt: &CancellationToken) -> Result<Bytes> {
        ensure!(index < self.count, "帧索引无效");
        let mut g = self.inner.lock().unwrap();
        ensure!(!self.cancel.is_cancelled() && !attempt.is_cancelled(), "可视化导出已取消");
        g.token += 1; let token = g.token;
        g.pixels = None; g.snapshot.demand = Some(Demand { token, index });
        self.ready.notify_all(); self.changed.notify_waiters();
        let started = Instant::now();
        loop {
            ensure!(!self.cancel.is_cancelled() && !attempt.is_cancelled() && !g.snapshot.terminal(), "可视化导出已取消");
            ensure!(g.token == token, "本次编码尝试已被替代");
            if let Some((received, pixels)) = g.pixels.take() {
                ensure!(received == token, "帧代次不匹配");
                g.snapshot.demand = None; return Ok(pixels);
            }
            if started.elapsed() > Duration::from_secs(40) { self.cancel.cancel(); bail!("编辑器超过 40 秒未提供画面，已终止导出"); }
            g = self.ready.wait_timeout(g, Duration::from_millis(200)).unwrap().0;
        }
    }
}
impl FrameSource for Job {
    fn frame_count(&self) -> u64 { self.count }
    fn frame_bytes(&self) -> usize { self.bytes }
    fn draw(&self, index: u64, rgba: &mut [u8]) -> Result<()> {
        ensure!(rgba.len() == self.bytes, "RGBA 帧长度不匹配");
        rgba.copy_from_slice(&self.receive_frame(index, &self.cancel)?);
        Ok(())
    }
    fn pixels(&self, index: u64, _buffer: Vec<u8>, attempt: &CancellationToken) -> Result<FramePixels> {
        Ok(FramePixels::Uploaded(self.receive_frame(index, attempt)?))
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
        .route("/api/visualizer/jobs/{id}", get(poll))
        .route("/api/visualizer/jobs/{id}/cancel", post(cancel))
        .route("/api/visualizer/jobs/{id}/frames/{token}/{index}", post(frame).layer(DefaultBodyLimit::max(MAX_FRAME)))
        .layer(Extension(Arc::new(Jobs::default())))
}
fn fingerprint(path: &std::path::Path) -> Result<String> {
    let s = media::signature(path)?;
    // Opaque string: nanosecond mtimes and u64 hashes must not round through JS Number.
    Ok(format!("{}:{}:{}", s.size, s.modified_ns, s.edge_hash))
}
fn track_audio(state: &AppState, id: i64) -> Result<PathBuf> {
    let track = state.library.get(id)?.context("曲目不存在")?;
    source(&track.path).context("请先把完整歌曲下载到本地曲库，不能使用流媒体占位或在线试听地址")
}
#[derive(Deserialize)]
struct Analyze { track_id: i64, spectrum: Spectrum }
async fn analyze(State(state): State<Arc<AppState>>, Json(p): Json<Analyze>) -> ApiResult<Json<Value>> {
    let scene = Scene { spectrum: p.spectrum.clone(), ..Scene::with_image(std::env::temp_dir().join("kdj-studio-validation.png").to_string_lossy().into_owned()) };
    scene.validate().map_err(ApiError::bad_request)?;
    let audio = track_audio(&state, p.track_id)?;
    let cancel = CancellationToken::new(); let _guard = cancel.clone().drop_guard();
    let probe = media::probe(&audio, &cancel).await?;
    let duration = probe.check(false)?;
    api_check((1..=MAX_DURATION_MS).contains(&duration), "初版支持最长 30 分钟的完整音频")?;
    let signature = fingerprint(&audio)?;
    static ANALYSIS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _slot = ANALYSIS.get_or_init(|| tokio::sync::Semaphore::new(1)).acquire().await.map_err(anyhow::Error::from)?;
    let path = audio.clone(); let token = cancel.clone();
    let timeline = tokio::task::spawn_blocking(move || kdj_analysis::visualizer::analyze_at_fps(&path, &p.spectrum, 60, &|| token.is_cancelled())).await.map_err(anyhow::Error::from)??;
    api_check(fingerprint(&audio)? == signature, "分析期间歌曲已变化，请重新打开工程")?;
    api_check((timeline.duration_seconds() * 1000. - duration as f64).abs() <= 250., "音轨解码不完整，不能导出")?;
    Ok(Json(json!({ "timeline": timeline, "signature": signature })))
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    track_id: i64, signature: String, duration: f64, output_path: String,
    width: u32, height: u32, fps: u32,
    #[serde(default)] acceleration: EncodingAcceleration,
}
impl Export {
    fn validate(&self) -> Result<()> {
        ensure!(self.width >= 320 && self.width <= 2560 && self.height >= 180 && self.height <= 1440 && self.width % 2 == 0 && self.height % 2 == 0 && [30, 60].contains(&self.fps), "输出画布或帧率无效");
        ensure!(self.duration.is_finite() && self.duration > 0. && self.duration <= MAX_DURATION_MS as f64 / 1000., "输出时长无效");
        Ok(())
    }
}
async fn start(State(state): State<Arc<AppState>>, Extension(jobs): Extension<Arc<Jobs>>, Json(p): Json<Export>) -> ApiResult<Json<Snapshot>> {
    api_check(cfg!(any(target_os = "macos", target_os = "windows")), "视频导出仅支持 Windows 和 macOS")?;
    p.validate()?;
    let audio = track_audio(&state, p.track_id)?;
    api_check(fingerprint(&audio)? == p.signature, "歌曲已变化，请重新分析后导出")?;
    let output = destination(&p.output_path)?;
    let job = Arc::new(Job::new(format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>()), (p.duration * p.fps as f64).ceil() as u64, p.width as usize * p.height as usize * 4));
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
        let result = render(&p, &audio, &output, job.clone()).await;
        let mut g = job.inner.lock().unwrap(); g.pixels = None; g.snapshot.demand = None;
        if let Err(error) = result {
            if g.snapshot.phase != "done" {
                g.snapshot.phase = if job.cancel.is_cancelled() { "canceled" } else { "failed" }.into();
                g.snapshot.error = format!("{error:#}"); g.snapshot.status = if job.cancel.is_cancelled() { "已取消并清理临时文件" } else { "导出失败" }.into();
            }
        }
        job.ready.notify_all(); job.changed.notify_waiters();
    });
    Ok(Json(first))
}
#[derive(Deserialize)]
struct Poll { #[serde(default)] since: u64 }
async fn poll(Extension(jobs): Extension<Arc<Jobs>>, Path(id): Path<String>, Query(p): Query<Poll>) -> ApiResult<Json<Snapshot>> {
    let job = jobs.get(&id)?;
    Ok(Json(job.next_snapshot(p.since).await))
}
async fn frame(Extension(jobs): Extension<Arc<Jobs>>, Path((id, token, index)): Path<(String, u64, u64)>, pixels: Bytes) -> ApiResult<Json<Snapshot>> {
    let job = jobs.get(&id)?;
    job.submit(token, index, pixels)?;
    // Return the next demand with the upload response: no separate poll round trip
    // for every frame. Initial queueing and occasional progress-only wakes still poll.
    Ok(Json(job.next_snapshot(token).await))
}
async fn cancel(Extension(jobs): Extension<Arc<Jobs>>, Path(id): Path<String>) -> ApiResult<Json<Snapshot>> {
    let job = jobs.get(&id)?; job.stop(); Ok(Json(job.snapshot()))
}

fn render_args(p: &Export, audio: &std::path::Path, stage: &std::path::Path) -> Vec<String> {
    let mut args: Vec<String> = ["-v", "error", "-nostdin", "-n", "-progress", "pipe:1", "-filter_complex_threads", "2", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size"].into_iter().map(str::to_string).collect();
    args.extend([format!("{}x{}", p.width, p.height), "-framerate".into(), p.fps.to_string(), "-i".into(), "pipe:0".into(), "-i".into(), audio.to_string_lossy().into_owned(), "-filter_complex".into(), format!("[0:v]setpts=PTS-STARTPTS,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[vout];[1:a:0]asetpts=PTS-STARTPTS,atrim=duration={:.9}[aout]", p.duration)]);
    args.extend(["-map", "[vout]", "-map", "[aout]", "-map_metadata", "-1", "-map_chapters", "-1", "-c:v:0", "libx264", "-preset", "veryfast", "-crf", "19", "-threads:v:0", "2", "-pix_fmt:v:0", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-t"].into_iter().map(str::to_string));
    args.extend([format!("{:.9}", p.duration), "-movflags".into(), "+faststart".into(), stage.join("render.mp4").to_string_lossy().into_owned()]); args
}
async fn render(p: &Export, audio: &std::path::Path, output: &std::path::Path, job: Arc<Job>) -> Result<()> {
    let token = job.cancel.clone();
    let _work = tokio::task::spawn_blocking(move || work_scheduler().acquire(WorkRequest::new(WorkClass::MediaComposition), || token.is_cancelled()).map_err(|_| anyhow::anyhow!("可视化导出已取消"))).await??;
    check(&job.cancel)?;
    let probe = media::probe(audio, &job.cancel).await?;
    ensure!(probe.streams.iter().filter(|s| s.codec_type == "audio").count() == 1, "需要只有一条音轨的完整音频文件");
    ensure!((probe.check(false)? as f64 - p.duration * 1000.).abs() <= 250., "音频时长已变化或不完整");
    ensure!(fingerprint(audio)? == p.signature, "音频已变化，未开始编码");
    let stage = Stage::new(output.parent().context("输出目录无效")?)?;
    job.update(|s| { s.phase = "encoding".into(); s.status = "绘制与编码".into(); });
    acceleration::render_frames(&render_args(p, audio, &stage.0), (p.duration * 1000.).round() as i64, &job.cancel, p.acceleration,
        |v| job.update(|s| s.progress = s.progress.max(v * 0.96)),
        |message| job.update(|s| s.status = message.to_owned()), job.clone(), (p.width, p.height, p.fps as f64)).await?;
    check(&job.cancel)?;
    job.update(|s| { s.phase = "validating".into(); s.status = "校验画面、音轨和文件版本".into(); s.progress = 0.97; s.demand = None; });
    let temporary = stage.0.join("render.mp4");
    let actual = media::probe(&temporary, &job.cancel).await?;
    let expected = media::Probe { streams: vec![media::Stream { codec_type: "video".into(), width: p.width, height: p.height, avg_frame_rate: format!("{}/1", p.fps), ..Default::default() }], ..Default::default() };
    media::validate(&expected, &actual, (p.duration * 1000.).round() as i64)?;
    ensure!(actual.video().is_some_and(|v| v.codec_name == "h264" && v.pix_fmt == "yuv420p") && actual.audio().is_some_and(|a| a.codec_name == "aac"), "成品缺少 H.264 画面或 AAC 音轨");
    ensure!(fingerprint(audio)? == p.signature, "导出期间音频已变化，未提交成品");
    std::fs::File::open(&temporary)?.sync_all()?;
    // Cancellation and atomic no-clobber publication share this very short lock.
    let mut g = job.inner.lock().unwrap(); check(&job.cancel)?;
    kdj_providers::net::rename_download_noclobber(&temporary, output).context("目标已存在或无法安全提交，未覆盖")?;
    g.snapshot.phase = "done".into(); g.snapshot.status = "完成".into(); g.snapshot.progress = 1.; g.snapshot.output_path = output.to_string_lossy().into_owned(); g.snapshot.demand = None;
    #[cfg(unix)] if let Err(e) = std::fs::File::open(output.parent().unwrap()).and_then(|d| d.sync_all()) { g.snapshot.status = format!("成品已生成，目录同步警告：{e}"); }
    job.changed.notify_waiters(); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_editor_heartbeat_and_terminal_cancel() {
        let job = Job::new("heartbeat".into(), 1, 4);
        *job.last_seen.lock().unwrap() = Instant::now() - Duration::from_secs(46);
        assert!(job.editor_idle()); job.touch(); assert!(!job.editor_idle());
        job.update(|s| s.phase = "done".into()); job.stop();
        assert_eq!(job.snapshot().phase, "done"); assert!(!job.cancel.is_cancelled());
    }
    #[test]
    fn studio_canvas_limits() {
        let mut p = Export { track_id: 1, signature: String::new(), duration: 3., output_path: String::new(), width: 1920, height: 840, fps: 60, acceleration: EncodingAcceleration::default() };
        assert!(p.validate().is_ok()); p.width = 1921; assert!(p.validate().is_err()); p.width = 1920; p.duration = f64::NAN; assert!(p.validate().is_err());
    }
    #[test]
    fn studio_transport_is_bounded_and_replayable() {
        let job = Arc::new(Job::new("test".into(), 2, 16));
        for index in [0, 1, 0] {
            let source = job.clone(); let draw = std::thread::spawn(move || { let mut rgba = [0; 16]; source.draw(index, &mut rgba).unwrap(); rgba });
            let demand = loop { if let Some(d) = job.snapshot().demand { break d; } std::thread::sleep(Duration::from_millis(1)); };
            assert!(job.submit(demand.token + 1, index, Bytes::from(vec![3; 16])).is_err());
            assert!(job.submit(demand.token, index, Bytes::from(vec![3; 15])).is_err());
            job.submit(demand.token, index, Bytes::from(vec![3; 16])).unwrap();
            assert_eq!(draw.join().unwrap(), [3; 16]);
        }
        job.stop(); assert!(job.draw(0, &mut [0; 16]).is_err());
    }
    #[test]
    fn studio_graph_uses_only_argv_paths_and_no_overwrite() {
        let p = Export { track_id: 1, signature: String::new(), duration: 2., output_path: String::new(), width: 320, height: 180, fps: 30, acceleration: EncodingAcceleration::default() };
        let args = render_args(&p, std::path::Path::new("odd ' [audio].wav"), std::path::Path::new("stage"));
        assert!(!args.contains(&"-y".into())); assert_eq!(args.windows(2).filter(|a| a[0] == "-i" && a[1] == "pipe:0").count(), 1);
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1]; assert!(!graph.contains("odd"));
    }
}
