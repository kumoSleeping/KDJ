//! Seek-only HS-TasNet layer and immutable whole-track PCM ownership.
//!
//! One worker/session belongs to each physical Deck, but a process-wide admission token allows
//! only one sustained instant stream on M2-class CPUs. A simultaneous second seek uses the same
//! PCM cache as a dry bridge while Spleeter refinement remains queued.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::PcmRandomAccessCache;

pub const INSTANT_HOP_FRAMES: usize = 512;
pub const INSTANT_CONTEXT_FRAMES: usize = 1_024;
pub const INSTANT_INPUT_FRAMES: usize =
    INSTANT_CONTEXT_FRAMES + INSTANT_HOP_FRAMES + INSTANT_CONTEXT_FRAMES;
pub const INSTANT_HANDOFF_FRAMES: usize = 256;
pub const INSTANT_HOP_BUDGET_MS: u64 = 12;

const TARGET_RMS: f32 = 0.251;
const MAX_GAIN: f32 = 100.0;
const MIN_RMS: f32 = 0.000_251;
const TRACK_CACHE_CAPACITY: usize = 2;
const MODEL_VERSION_DIRECTORY: &str = "eaaba4f";
const MODEL_FILE: &str = "model.onnx";
const MODEL_DATA_FILE: &str = "model.onnx.data";
/// StemgenRT output planes are Drums / Bass / Vocals / Other. Values are destination KDJ lanes.
const PLANE_TO_KDJ_LANE: [usize; 4] = [0, 1, 3, 2];

#[derive(Debug)]
pub struct InstantTrack {
    path: PathBuf,
    pcm: Arc<PcmRandomAccessCache>,
}

impl InstantTrack {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn frames(&self) -> u64 {
        self.pcm.frames()
    }

    pub fn frame(&self, index: u64) -> Option<[f32; 2]> {
        self.pcm.frame(index)
    }
}

pub struct InstantStemChunk {
    stems: [Vec<[f32; 2]>; 4],
}

impl InstantStemChunk {
    pub fn stems(&self) -> &[Vec<[f32; 2]>; 4] {
        &self.stems
    }

    pub fn frames(&self) -> usize {
        self.stems[0].len()
    }
}

enum TrackLoadState {
    Loading,
    Ready(Arc<InstantTrack>),
    Failed(String),
}

struct TrackLoadEntry {
    state: Mutex<TrackLoadState>,
}

#[derive(Clone)]
pub struct InstantTrackTicket {
    entry: Arc<TrackLoadEntry>,
}

impl InstantTrackTicket {
    pub fn ready(&self) -> Option<Arc<InstantTrack>> {
        match &*self.entry.state.lock().unwrap() {
            TrackLoadState::Ready(track) => Some(Arc::clone(track)),
            TrackLoadState::Loading | TrackLoadState::Failed(_) => None,
        }
    }

    pub fn wait<F>(&self, cancelled: F) -> Result<Arc<InstantTrack>>
    where
        F: Fn() -> bool,
    {
        loop {
            if cancelled() {
                bail!("HS-TasNet PCM preload cancelled");
            }
            match &*self.entry.state.lock().unwrap() {
                TrackLoadState::Loading => {}
                TrackLoadState::Ready(track) => return Ok(Arc::clone(track)),
                TrackLoadState::Failed(error) => bail!("{error}"),
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
}

#[derive(Default)]
struct TrackCache {
    entries: VecDeque<(PathBuf, Arc<TrackLoadEntry>)>,
}

impl TrackCache {
    fn get(&mut self, path: &Path) -> Option<Arc<TrackLoadEntry>> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == path)?;
        let entry = self.entries.remove(index)?;
        let result = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(result)
    }

    fn insert(&mut self, path: PathBuf, entry: Arc<TrackLoadEntry>) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == &path)
        {
            self.entries.remove(index);
        }
        self.entries.push_back((path, entry));
        while self.entries.len() > TRACK_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

fn normalized_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A local-only model lookup. The exact checkpoint has no archived redistribution grant, so the
/// production downloader does not install it; users/tests may provide the pinned files locally.
pub(crate) fn instant_model_directory(refinement_model: &Path) -> Option<PathBuf> {
    for variable in ["KDJ_HSTASNET_MODEL_DIR", "KDJ_SEEKLAB_HSTASNET_DIR"] {
        if let Ok(value) = std::env::var(variable) {
            if !value.trim().is_empty() {
                let path = PathBuf::from(value);
                if instant_model_files_exist(&path) {
                    return Some(path);
                }
            }
        }
    }
    let models = refinement_model.parent()?.parent()?;
    let candidate = models.join(MODEL_VERSION_DIRECTORY);
    instant_model_files_exist(&candidate).then_some(candidate)
}

fn instant_model_files_exist(path: &Path) -> bool {
    path.join(MODEL_FILE).is_file() && path.join(MODEL_DATA_FILE).is_file()
}

struct AdmissionState(AtomicU8);

impl AdmissionState {
    const fn new() -> Self {
        Self(AtomicU8::new(0))
    }

    fn try_acquire(&self, deck: usize) -> Option<u8> {
        let owner = u8::try_from(deck).ok()?.checked_add(1)?;
        self.0
            .compare_exchange(0, owner, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| owner)
    }

    fn release(&self, owner: u8) {
        let _ = self
            .0
            .compare_exchange(owner, 0, Ordering::AcqRel, Ordering::Acquire);
    }

    fn active(&self) -> bool {
        self.0.load(Ordering::Acquire) != 0
    }
}

static INSTANT_ADMISSION: AdmissionState = AdmissionState::new();

pub struct InstantAdmissionGuard {
    owner: u8,
}

impl Drop for InstantAdmissionGuard {
    fn drop(&mut self) {
        INSTANT_ADMISSION.release(self.owner);
    }
}

pub(crate) fn instant_admission_active() -> bool {
    INSTANT_ADMISSION.active()
}

pub fn try_acquire_instant_admission(deck: usize) -> Option<InstantAdmissionGuard> {
    INSTANT_ADMISSION
        .try_acquire(deck)
        .map(|owner| InstantAdmissionGuard { owner })
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
mod platform {
    use std::sync::mpsc::{
        self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
    };

    use ort::{session::Session, value::Tensor};

    use super::*;

    enum WorkerStatus {
        Loading,
        Ready,
        Failed(String),
    }

    struct InstantJob {
        track: Arc<InstantTrack>,
        frame_index: u64,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
        reply: SyncSender<Result<Arc<InstantStemChunk>>>,
    }

    pub struct InstantStemTicket {
        receiver: Receiver<Result<Arc<InstantStemChunk>>>,
    }

    impl InstantStemTicket {
        pub fn try_wait(&self) -> Result<Option<Arc<InstantStemChunk>>> {
            match self.receiver.try_recv() {
                Ok(result) => result.map(Some),
                Err(TryRecvError::Empty) => Ok(None),
                Err(TryRecvError::Disconnected) => bail!("HS-TasNet worker exited"),
            }
        }
    }

    pub struct InstantStemPool {
        parent_pool_id: u64,
        senders: [SyncSender<InstantJob>; 2],
        worker_statuses: [Arc<Mutex<WorkerStatus>>; 2],
        tracks: Arc<Mutex<TrackCache>>,
        shutdown: Arc<AtomicBool>,
        workers: Mutex<Vec<thread::JoinHandle<()>>>,
    }

    impl InstantStemPool {
        pub fn new(model_directory: &Path) -> Result<Arc<Self>> {
            Self::new_for_parent(model_directory, 0)
        }

        pub(crate) fn new_for_parent(
            model_directory: &Path,
            parent_pool_id: u64,
        ) -> Result<Arc<Self>> {
            if !instant_model_files_exist(model_directory) {
                bail!(
                    "HS-TasNet model files are incomplete: {}",
                    model_directory.display()
                );
            }
            let model = model_directory.join(MODEL_FILE);
            let mut senders = Vec::with_capacity(2);
            let mut statuses = Vec::with_capacity(2);
            let mut workers = Vec::with_capacity(2);
            let shutdown = Arc::new(AtomicBool::new(false));
            for deck in 0..2 {
                let (sender, receiver) = mpsc::sync_channel(2);
                let status = Arc::new(Mutex::new(WorkerStatus::Loading));
                let worker_status = Arc::clone(&status);
                let worker_model = model.clone();
                let worker_shutdown = Arc::clone(&shutdown);
                let handle = thread::Builder::new()
                    .name(format!("kdj-instant-stem-{deck}"))
                    .spawn(move || {
                        run_instant_worker(
                            parent_pool_id,
                            deck,
                            worker_model,
                            receiver,
                            worker_status,
                            worker_shutdown,
                        )
                    })
                    .context("start HS-TasNet worker")?;
                senders.push(sender);
                statuses.push(status);
                workers.push(handle);
            }
            crate::live::record_instant_available(true);
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "instant_pool_created",
                pool_id = parent_pool_id,
                workers = 2,
                model = %model.display(),
                "HS-TasNet instant pool created"
            );
            Ok(Arc::new(Self {
                parent_pool_id,
                senders: senders.try_into().ok().expect("two instant senders"),
                worker_statuses: statuses.try_into().ok().expect("two instant statuses"),
                tracks: Arc::new(Mutex::new(TrackCache::default())),
                shutdown,
                workers: Mutex::new(workers),
            }))
        }

        pub fn shutdown(&self, reason: &'static str) {
            if self.shutdown.swap(true, Ordering::AcqRel) {
                return;
            }
            let cached_tracks = {
                let mut tracks = self.tracks.lock().unwrap();
                let count = tracks.entries.len();
                tracks.entries.clear();
                count
            };
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "instant_pool_shutdown_begin",
                pool_id = self.parent_pool_id,
                reason,
                cached_tracks,
                "HS-TasNet instant pool shutdown begins"
            );
            let handles = std::mem::take(&mut *self.workers.lock().unwrap());
            for handle in handles {
                if handle.join().is_err() {
                    tracing::warn!(
                        target: "kdj_stem_lifecycle",
                        event = "instant_worker_join_panic",
                        pool_id = self.parent_pool_id,
                        "HS-TasNet worker panicked during shutdown"
                    );
                }
            }
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "instant_pool_shutdown_complete",
                pool_id = self.parent_pool_id,
                reason,
                "HS-TasNet sessions unloaded"
            );
        }

        pub fn prepare_track(&self, path: &Path) -> Result<InstantTrackTicket> {
            if self.shutdown.load(Ordering::Acquire) {
                bail!("HS-TasNet pool is shutting down");
            }
            let path = normalized_path(path);
            if !path.is_file() {
                bail!("instant STEM input does not exist: {}", path.display());
            }
            let entry = {
                let mut tracks = self.tracks.lock().unwrap();
                if let Some(entry) = tracks.get(&path) {
                    crate::live::record_instant_pcm_cache_hit();
                    return Ok(InstantTrackTicket { entry });
                }
                let entry = Arc::new(TrackLoadEntry {
                    state: Mutex::new(TrackLoadState::Loading),
                });
                tracks.insert(path.clone(), Arc::clone(&entry));
                entry
            };
            let worker_entry = Arc::clone(&entry);
            let worker_shutdown = Arc::clone(&self.shutdown);
            let pool_id = self.parent_pool_id;
            if let Err(error) = thread::Builder::new()
                .name("kdj-instant-pcm-preload".into())
                .spawn(move || {
                    kdj_core::thread_qos::prefer_background();
                    let started = Instant::now();
                    tracing::info!(
                        target: "kdj_stem_lifecycle",
                        event = "pcm_preload_begin",
                        pool_id,
                        path = %path.display(),
                        "instant STEM PCM preload begins"
                    );
                    let outcome = PcmRandomAccessCache::decode_with_cancel(&path, || {
                        worker_shutdown.load(Ordering::Acquire)
                    })
                    .map(|pcm| {
                        Arc::new(InstantTrack {
                            path,
                            pcm: Arc::new(pcm),
                        })
                    })
                    .map_err(|error| format!("HS-TasNet PCM preload failed: {error:#}"));
                    match outcome {
                        Ok(track) => {
                            if worker_shutdown.load(Ordering::Acquire) {
                                *worker_entry.state.lock().unwrap() = TrackLoadState::Failed(
                                    "HS-TasNet PCM preload cancelled".into(),
                                );
                                tracing::info!(
                                    target: "kdj_stem_lifecycle",
                                    event = "pcm_preload_cancelled",
                                    pool_id,
                                    elapsed_ms = started.elapsed().as_millis(),
                                    "instant STEM PCM preload cancelled"
                                );
                                return;
                            }
                            crate::live::record_instant_pcm_preload(started.elapsed());
                            *worker_entry.state.lock().unwrap() = TrackLoadState::Ready(track);
                            tracing::info!(
                                target: "kdj_stem_lifecycle",
                                event = "pcm_preload_complete",
                                pool_id,
                                elapsed_ms = started.elapsed().as_millis(),
                                "instant STEM PCM preload completed"
                            );
                        }
                        Err(error) => {
                            crate::live::record_instant_failure(&error);
                            *worker_entry.state.lock().unwrap() = TrackLoadState::Failed(error);
                        }
                    }
                })
            {
                let message = format!("start instant STEM PCM preload: {error}");
                *entry.state.lock().unwrap() = TrackLoadState::Failed(message.clone());
                bail!("{message}");
            }
            Ok(InstantTrackTicket { entry })
        }

        pub fn wait_ready<F>(&self, deck: usize, cancelled: F) -> Result<()>
        where
            F: Fn() -> bool,
        {
            let status = self
                .worker_statuses
                .get(deck)
                .context("invalid physical Deck for HS-TasNet")?;
            loop {
                if cancelled() {
                    bail!("HS-TasNet warm-up cancelled");
                }
                match &*status.lock().unwrap() {
                    WorkerStatus::Loading => {}
                    WorkerStatus::Ready => return Ok(()),
                    WorkerStatus::Failed(error) => bail!("{error}"),
                }
                thread::sleep(Duration::from_millis(2));
            }
        }

        pub fn is_ready(&self, deck: usize) -> bool {
            self.worker_statuses
                .get(deck)
                .is_some_and(|status| matches!(*status.lock().unwrap(), WorkerStatus::Ready))
        }

        pub fn submit(
            &self,
            deck: usize,
            track: Arc<InstantTrack>,
            frame_index: u64,
            epoch: Arc<AtomicU64>,
            expected_epoch: u64,
        ) -> Result<InstantStemTicket> {
            if self.shutdown.load(Ordering::Acquire) {
                bail!("HS-TasNet pool is shutting down");
            }
            if epoch.load(Ordering::Acquire) != expected_epoch {
                bail!("HS-TasNet hop cancelled");
            }
            if !self.is_ready(deck) {
                bail!("HS-TasNet Deck worker is not ready");
            }
            let sender = self.senders.get(deck).context("invalid physical Deck")?;
            let (reply, receiver) = mpsc::sync_channel(1);
            let mut job = InstantJob {
                track,
                frame_index,
                epoch,
                expected_epoch,
                reply,
            };
            loop {
                if job.epoch.load(Ordering::Acquire) != job.expected_epoch {
                    bail!("HS-TasNet hop cancelled");
                }
                if self.shutdown.load(Ordering::Acquire) {
                    bail!("HS-TasNet pool is shutting down");
                }
                match sender.try_send(job) {
                    Ok(()) => break,
                    Err(TrySendError::Full(returned)) => {
                        job = returned;
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(TrySendError::Disconnected(_)) => bail!("HS-TasNet worker exited"),
                }
            }
            Ok(InstantStemTicket { receiver })
        }
    }

    impl Drop for InstantStemPool {
        fn drop(&mut self) {
            self.shutdown("last_instant_pool_owner_dropped");
        }
    }

    fn run_instant_worker(
        pool_id: u64,
        deck: usize,
        model: PathBuf,
        receiver: Receiver<InstantJob>,
        status: Arc<Mutex<WorkerStatus>>,
        shutdown: Arc<AtomicBool>,
    ) {
        kdj_core::thread_qos::prefer_live_audio();
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "instant_worker_started",
            pool_id,
            deck,
            "HS-TasNet worker started"
        );
        let load_started = Instant::now();
        let loaded = build_session(&model).and_then(|mut session| {
            let silence =
                PcmRandomAccessCache::from_interleaved(vec![[0.0; 2]; INSTANT_INPUT_FRAMES]);
            let _ = infer_hop(&mut session, &silence, 0)?;
            Ok(session)
        });
        let mut session = match loaded {
            Ok(session) => {
                if shutdown.load(Ordering::Acquire) {
                    tracing::info!(
                        target: "kdj_stem_lifecycle",
                        event = "instant_worker_exited",
                        pool_id,
                        deck,
                        reason = "shutdown_after_load",
                        "HS-TasNet session dropped"
                    );
                    return;
                }
                *status.lock().unwrap() = WorkerStatus::Ready;
                crate::live::record_instant_worker_ready(deck);
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "instant_session_load_complete",
                    pool_id,
                    deck,
                    elapsed_ms = load_started.elapsed().as_millis(),
                    "HS-TasNet CPU session loaded"
                );
                session
            }
            Err(error) => {
                let message = format!("load HS-TasNet Deck {deck}: {error:#}");
                crate::live::record_instant_failure(&message);
                *status.lock().unwrap() = WorkerStatus::Failed(message);
                return;
            }
        };
        loop {
            if shutdown.load(Ordering::Acquire) {
                break;
            }
            let job = match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(job) => job,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if job.epoch.load(Ordering::Acquire) != job.expected_epoch {
                let _ = job
                    .reply
                    .send(Err(anyhow::anyhow!("HS-TasNet hop cancelled")));
                continue;
            }
            let _work = kdj_core::work_scheduler::work_scheduler()
                .activity(kdj_core::work_scheduler::WorkClass::StemInstant);
            let started = Instant::now();
            let result =
                infer_hop(&mut session, &job.track.pcm, job.frame_index).and_then(|chunk| {
                    if job.epoch.load(Ordering::Acquire) != job.expected_epoch {
                        bail!("HS-TasNet hop cancelled");
                    }
                    Ok(Arc::new(chunk))
                });
            let elapsed = started.elapsed();
            match &result {
                Ok(_) => crate::live::record_instant_hop(elapsed),
                Err(error) => crate::live::record_instant_failure(&error.to_string()),
            }
            let _ = job.reply.send(result);
        }
        drop(session);
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "instant_worker_exited",
            pool_id,
            deck,
            reason = if shutdown.load(Ordering::Acquire) {
                "pool_shutdown"
            } else {
                "channel_closed"
            },
            "HS-TasNet session dropped"
        );
    }

    fn build_session(path: &Path) -> Result<Session> {
        let builder = ort_result(Session::builder(), "create HS-TasNet session builder")?;
        let builder = ort_result(
            builder.with_intra_threads(4),
            "set HS-TasNet intra-op threads",
        )?;
        let mut builder = ort_result(
            builder.with_inter_threads(1),
            "set HS-TasNet inter-op threads",
        )?;
        ort_result(builder.commit_from_file(path), "load HS-TasNet CPU model")
    }

    fn infer_hop(
        session: &mut Session,
        pcm: &PcmRandomAccessCache,
        frame_index: u64,
    ) -> Result<InstantStemChunk> {
        let start = i128::from(frame_index) - INSTANT_CONTEXT_FRAMES as i128;
        let (left, right) = pcm.stereo_window(start, INSTANT_INPUT_FRAMES);
        let mut input = vec![0.0; INSTANT_INPUT_FRAMES * 2];
        input[..INSTANT_INPUT_FRAMES].copy_from_slice(&left);
        input[INSTANT_INPUT_FRAMES..].copy_from_slice(&right);
        let rms = (input.iter().map(|value| value * value).sum::<f32>()
            / input.len().max(1) as f32)
            .sqrt();
        let gain = if rms >= MIN_RMS {
            (TARGET_RMS / rms).min(MAX_GAIN)
        } else {
            1.0
        };
        if gain != 1.0 {
            for sample in &mut input {
                *sample *= gain;
            }
        }
        let tensor = ort_result(
            Tensor::from_array(([1_usize, 2, INSTANT_INPUT_FRAMES], input)),
            "create HS-TasNet input tensor",
        )?;
        let outputs = ort_result(
            session.run(ort::inputs!["audio" => tensor]),
            "run HS-TasNet",
        )?;
        let output = outputs
            .get("separated")
            .or_else(|| (outputs.len() > 0).then(|| &outputs[0]))
            .context("HS-TasNet separated output is missing")?;
        let (shape, data) = ort_result(
            output.try_extract_tensor::<f32>(),
            "read HS-TasNet output tensor",
        )?;
        if shape.len() != 4 || shape[0] != 1 || shape[1] != 4 || shape[2] != 2 {
            bail!(
                "HS-TasNet output shape {:?} does not match [1,4,2,M]",
                &**shape
            );
        }
        let output_frames = usize::try_from(shape[3]).context("invalid HS-TasNet frame count")?;
        if output_frames < INSTANT_CONTEXT_FRAMES + INSTANT_HOP_FRAMES {
            bail!("HS-TasNet output is shorter than one context-safe hop");
        }
        if data.iter().any(|sample| !sample.is_finite()) {
            bail!("HS-TasNet output contains non-finite samples");
        }
        let inverse_gain = if gain != 0.0 { 1.0 / gain } else { 1.0 };
        let mut stems: [Vec<[f32; 2]>; 4] =
            std::array::from_fn(|_| vec![[0.0; 2]; INSTANT_HOP_FRAMES]);
        for plane in 0..4 {
            let lane = PLANE_TO_KDJ_LANE[plane];
            for channel in 0..2 {
                let plane_start = (plane * 2 + channel) * output_frames;
                for frame in 0..INSTANT_HOP_FRAMES {
                    stems[lane][frame][channel] =
                        data[plane_start + INSTANT_CONTEXT_FRAMES + frame] * inverse_gain;
                }
            }
        }
        Ok(InstantStemChunk { stems })
    }

    fn ort_result<T, E: std::fmt::Display>(
        result: std::result::Result<T, E>,
        action: &str,
    ) -> Result<T> {
        result.map_err(|error| anyhow::anyhow!("{action}: {error}"))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub use platform::{InstantStemPool, InstantStemTicket};

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
pub struct InstantStemPool;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
pub struct InstantStemTicket;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
impl InstantStemPool {
    pub fn new(_model_directory: &Path) -> Result<Arc<Self>> {
        bail!("HS-TasNet is not available on this platform")
    }

    pub(crate) fn new_for_parent(_model_directory: &Path, _pool_id: u64) -> Result<Arc<Self>> {
        bail!("HS-TasNet is not available on this platform")
    }

    pub fn shutdown(&self, _reason: &'static str) {}

    pub fn prepare_track(&self, _path: &Path) -> Result<InstantTrackTicket> {
        bail!("HS-TasNet is not available on this platform")
    }

    pub fn wait_ready<F>(&self, _deck: usize, _cancelled: F) -> Result<()>
    where
        F: Fn() -> bool,
    {
        bail!("HS-TasNet is not available on this platform")
    }

    pub fn is_ready(&self, _deck: usize) -> bool {
        false
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
impl InstantStemTicket {
    pub fn try_wait(&self) -> Result<Option<Arc<InstantStemChunk>>> {
        bail!("HS-TasNet is not available on this platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_physical_deck_can_hold_instant_admission() {
        let admission = AdmissionState::new();
        let a = admission.try_acquire(0).unwrap();
        assert!(admission.try_acquire(1).is_none());
        admission.release(a);
        let b = admission.try_acquire(1).unwrap();
        assert!(admission.active());
        admission.release(b);
        assert!(!admission.active());
    }

    #[test]
    fn local_model_lookup_uses_the_refinement_model_root() {
        let refinement = Path::new("/tmp/models/refine-version/spleeter4-fp16-onnx");
        assert_eq!(
            refinement.parent().and_then(Path::parent),
            Some(Path::new("/tmp/models"))
        );
    }

    #[test]
    fn pcm_cache_keeps_only_two_recent_tracks() {
        let entry = || {
            Arc::new(TrackLoadEntry {
                state: Mutex::new(TrackLoadState::Loading),
            })
        };
        let mut cache = TrackCache::default();
        cache.insert(PathBuf::from("a"), entry());
        cache.insert(PathBuf::from("b"), entry());
        assert!(cache.get(Path::new("a")).is_some());
        cache.insert(PathBuf::from("c"), entry());
        assert!(cache.get(Path::new("b")).is_none());
        assert!(cache.get(Path::new("a")).is_some());
        assert!(cache.get(Path::new("c")).is_some());
    }

    #[test]
    fn stemgen_planes_map_to_kdj_lane_order_once() {
        assert_eq!(PLANE_TO_KDJ_LANE, [0, 1, 3, 2]);
    }
}
