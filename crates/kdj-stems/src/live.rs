use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use kdj_core::work_scheduler::{work_scheduler, QueuedWork, WorkClass};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::instant::instant_admission_active;
use crate::runtime::{recommended_worker_count, PlatformEngine, RuntimeInfo};
use crate::runtime::{stem_runtime_preference, StemRuntimePreference};
use crate::SAMPLE_RATE;

/// One fixed classical Redress tile produces this much retained source. This is a background-cache budget,
/// not callback latency or a promise that a cache miss is instantaneous.
const DIAGNOSTIC_HISTORY: usize = 64;

/// Bounded, user-visible observations from the actual separation workers. These values are
/// intentionally about completed work rather than a synthetic benchmark: testers can report the
/// selected provider, cold block, steady P95, late blocks, output gaps, and memory-like failures
/// from `/stems/runtime` without enabling a debug build.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemRuntimeDiagnostics {
    pub runtime: String,
    pub provider: String,
    pub initialization_ms: Option<u64>,
    pub first_block_ms: Option<u64>,
    pub last_block_ms: Option<u64>,
    pub p95_block_ms: Option<u64>,
    pub chunk_budget_ms: u64,
    pub processed_chunks: u64,
    pub late_chunks: u64,
    pub output_underruns: u64,
    pub memory_errors: u64,
    pub last_error: String,
    pub instant_available: bool,
    pub instant_ready_decks: u8,
    pub instant_pcm_preload_ms: Option<u64>,
    pub instant_pcm_cache_hits: u64,
    pub instant_first_hop_ms: Option<u64>,
    pub instant_last_hop_ms: Option<u64>,
    pub instant_p95_hop_ms: Option<u64>,
    pub instant_late_hops: u64,
    pub instant_failures: u64,
    pub refinement_deferred: u64,
    #[serde(skip)]
    recent_block_ms: VecDeque<u64>,
    #[serde(skip)]
    recent_instant_hop_ms: VecDeque<u64>,
}

impl StemRuntimeDiagnostics {
    pub(crate) fn planned() -> Self {
        let RuntimeInfo { runtime, provider } = RuntimeInfo::planned();
        Self {
            runtime,
            provider,
            initialization_ms: None,
            first_block_ms: None,
            last_block_ms: None,
            p95_block_ms: None,
            chunk_budget_ms: (crate::stem_tile_geometry().core as u64 * 1_000) / SAMPLE_RATE as u64,
            processed_chunks: 0,
            late_chunks: 0,
            output_underruns: 0,
            memory_errors: 0,
            last_error: String::new(),
            instant_available: false,
            instant_ready_decks: 0,
            instant_pcm_preload_ms: None,
            instant_pcm_cache_hits: 0,
            instant_first_hop_ms: None,
            instant_last_hop_ms: None,
            instant_p95_hop_ms: None,
            instant_late_hops: 0,
            instant_failures: 0,
            refinement_deferred: 0,
            recent_block_ms: VecDeque::new(),
            recent_instant_hop_ms: VecDeque::new(),
        }
    }

    fn update_p95(&mut self) {
        if self.recent_block_ms.is_empty() {
            self.p95_block_ms = None;
            return;
        }
        let mut samples: Vec<_> = self.recent_block_ms.iter().copied().collect();
        samples.sort_unstable();
        let index = ((samples.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len() - 1);
        self.p95_block_ms = Some(samples[index]);
    }

    fn update_instant_p95(&mut self) {
        if self.recent_instant_hop_ms.is_empty() {
            self.instant_p95_hop_ms = None;
            return;
        }
        let mut samples: Vec<_> = self.recent_instant_hop_ms.iter().copied().collect();
        samples.sort_unstable();
        let index = ((samples.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len() - 1);
        self.instant_p95_hop_ms = Some(samples[index]);
    }
}

fn diagnostics_state() -> &'static Mutex<StemRuntimeDiagnostics> {
    static DIAGNOSTICS: OnceLock<Mutex<StemRuntimeDiagnostics>> = OnceLock::new();
    DIAGNOSTICS.get_or_init(|| Mutex::new(StemRuntimeDiagnostics::planned()))
}

static STEM_OUTPUT_UNDERRUNS: AtomicU64 = AtomicU64::new(0);
static STEM_OUTPUT_UNDERRUNS_BY_DECK: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

/// Snapshot used by the runtime status endpoint. The callback-side gap count is an atomic counter
/// so the realtime renderer never locks the diagnostics mutex.
pub fn stem_runtime_diagnostics() -> StemRuntimeDiagnostics {
    let mut diagnostics = diagnostics_state().lock().unwrap().clone();
    diagnostics.output_underruns = STEM_OUTPUT_UNDERRUNS.load(Ordering::Acquire);
    diagnostics
}

fn live_audio_lease_count() -> usize {
    LIVE_AUDIO_LEASES.load(Ordering::Acquire)
}

pub fn stem_output_underruns() -> u64 {
    STEM_OUTPUT_UNDERRUNS.load(Ordering::Acquire)
}

/// Physical-Deck counters let the coordinator recover only the source that actually starved.
/// A single aggregate counter made one late Deck tear down both otherwise independent STEM
/// streams, which looked exactly like both sides fighting and then disappearing together.
pub fn stem_output_underruns_by_deck() -> [u64; 2] {
    std::array::from_fn(|deck| STEM_OUTPUT_UNDERRUNS_BY_DECK[deck].load(Ordering::Acquire))
}

pub(crate) fn reset_stem_runtime_diagnostics() {
    STEM_OUTPUT_UNDERRUNS.store(0, Ordering::Release);
    for counter in &STEM_OUTPUT_UNDERRUNS_BY_DECK {
        counter.store(0, Ordering::Release);
    }
    *diagnostics_state().lock().unwrap() = StemRuntimeDiagnostics::planned();
}

/// Called only on a transition into an empty live STEM ring. It is safe for the audio callback:
/// one atomic increment, no allocation, lock, logging, or JNI.
pub fn record_stem_output_underrun() {
    record_stem_output_underrun_for_deck(0);
}

/// Called by the callback with its physical Deck index. This stays realtime-safe: two atomics,
/// no lock, allocation, logging, or channel send.
pub fn record_stem_output_underrun_for_deck(deck: usize) {
    STEM_OUTPUT_UNDERRUNS.fetch_add(1, Ordering::Relaxed);
    if let Some(counter) = STEM_OUTPUT_UNDERRUNS_BY_DECK.get(deck) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

fn record_runtime_initialized(info: RuntimeInfo, elapsed: Duration) {
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.runtime = info.runtime;
    diagnostics.provider = info.provider;
    diagnostics.initialization_ms = Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
}

fn record_completed_block(info: RuntimeInfo, elapsed: Duration) {
    let elapsed_ms = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.runtime = info.runtime;
    diagnostics.provider = info.provider;
    diagnostics.first_block_ms.get_or_insert(elapsed_ms);
    diagnostics.last_block_ms = Some(elapsed_ms);
    diagnostics.processed_chunks = diagnostics.processed_chunks.saturating_add(1);
    if elapsed_ms > diagnostics.chunk_budget_ms {
        diagnostics.late_chunks = diagnostics.late_chunks.saturating_add(1);
    }
    diagnostics.recent_block_ms.push_back(elapsed_ms);
    if diagnostics.recent_block_ms.len() > DIAGNOSTIC_HISTORY {
        diagnostics.recent_block_ms.pop_front();
    }
    diagnostics.update_p95();
}

fn record_runtime_error(error: &anyhow::Error) {
    let message = error.to_string();
    if message.contains("已取消") || message.contains("cancelled") {
        return;
    }
    let lower = message.to_ascii_lowercase();
    let memory_error = lower.contains("memory")
        || lower.contains("outofmemory")
        || lower.contains("out of memory")
        || lower.contains("vk_error_out_of_device_memory")
        || lower.contains("e_outofmemory");
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.last_error = message;
    if memory_error {
        diagnostics.memory_errors = diagnostics.memory_errors.saturating_add(1);
    }
}

pub(crate) fn record_instant_available(available: bool) {
    diagnostics_state().lock().unwrap().instant_available = available;
}

pub(crate) fn record_instant_worker_ready(deck: usize) {
    if deck >= 8 {
        return;
    }
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.instant_available = true;
    diagnostics.instant_ready_decks |= 1 << deck;
}

pub(crate) fn record_instant_pcm_preload(elapsed: Duration) {
    diagnostics_state().lock().unwrap().instant_pcm_preload_ms =
        Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
}

pub(crate) fn record_instant_pcm_cache_hit() {
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.instant_pcm_cache_hits = diagnostics.instant_pcm_cache_hits.saturating_add(1);
}

pub(crate) fn record_instant_hop(elapsed: Duration) {
    let elapsed_ms = elapsed.as_millis().min(u128::from(u64::MAX)) as u64;
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.instant_first_hop_ms.get_or_insert(elapsed_ms);
    diagnostics.instant_last_hop_ms = Some(elapsed_ms);
    if elapsed_ms > crate::INSTANT_HOP_BUDGET_MS {
        diagnostics.instant_late_hops = diagnostics.instant_late_hops.saturating_add(1);
    }
    diagnostics.recent_instant_hop_ms.push_back(elapsed_ms);
    if diagnostics.recent_instant_hop_ms.len() > DIAGNOSTIC_HISTORY {
        diagnostics.recent_instant_hop_ms.pop_front();
    }
    diagnostics.update_instant_p95();
}

pub(crate) fn record_instant_failure(error: &str) {
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.instant_failures = diagnostics.instant_failures.saturating_add(1);
    diagnostics.last_error = error.to_string();
}

fn record_refinement_deferred() {
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.refinement_deferred = diagnostics.refinement_deferred.saturating_add(1);
}

static LIVE_AUDIO_LEASES: AtomicUsize = AtomicUsize::new(0);

/// Counts active audio STEM producers for scheduler pressure without retaining any display data.
pub struct LiveStemAudioGuard;

impl Drop for LiveStemAudioGuard {
    fn drop(&mut self) {
        let previous = LIVE_AUDIO_LEASES.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "live STEM audio lease underflow");
        work_scheduler().set_live_stem_decks(LIVE_AUDIO_LEASES.load(Ordering::Acquire));
    }
}

pub fn begin_live_stem_audio_lease() -> LiveStemAudioGuard {
    LIVE_AUDIO_LEASES.fetch_add(1, Ordering::AcqRel);
    work_scheduler().set_live_stem_decks(LIVE_AUDIO_LEASES.load(Ordering::Acquire));
    LiveStemAudioGuard
}

/// One fixed classical Redress output tile in stable `Drums / Bass / Other / Vocals` slots. FFT-only
/// left/right context is removed before caching; each lane retains the audible core plus the short
/// successor handoff tail.
pub struct StemChunk {
    stems: [Vec<[f32; 2]>; 4],
    reconstruction_gain: f32,
}

impl StemChunk {
    pub fn stems(&self) -> &[Vec<[f32; 2]>; 4] {
        &self.stems
    }

    pub fn frames(&self) -> usize {
        self.stems[0].len()
    }

    /// Calibrates the sum of all four lanes back to this input block's original mix level.
    /// Individual lane mutes/gains still take effect after this neutral reconstruction step.
    pub fn reconstruction_gain(&self) -> f32 {
        self.reconstruction_gain
    }
}

struct InferenceJob {
    left: Vec<f32>,
    right: Vec<f32>,
    key: [u8; 32],
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    cancelled: Arc<AtomicBool>,
    work: QueuedWork,
    submitted_at: Instant,
    reply: SyncSender<Result<Arc<StemChunk>>>,
}

/// Audio-bound chunks always overtake the bounded look-ahead queue.
#[derive(Clone, Copy, Debug)]
enum InferencePriority {
    Audio,
    LookAhead,
}

fn separation_work_class(priority: InferencePriority) -> WorkClass {
    match priority {
        InferencePriority::Audio => WorkClass::StemAudible,
        InferencePriority::LookAhead => WorkClass::StemLookAhead,
    }
}

struct InferenceReceivers {
    audio: Mutex<Receiver<InferenceJob>>,
    look_ahead: Mutex<Receiver<InferenceJob>>,
}

/// Result handle lets a playback worker submit overlapping chunks to two persistent separation workers
/// before waiting. Model load and separation remain completely outside the audio callback.
pub struct StemInferenceTicket {
    receiver: Receiver<Result<Arc<StemChunk>>>,
    cancelled: Arc<AtomicBool>,
}

impl StemInferenceTicket {
    pub fn try_wait(&self) -> Result<Option<Arc<StemChunk>>> {
        match self.receiver.try_recv() {
            Ok(result) => result.map(Some),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("STEM 后台分离 worker 已退出"),
        }
    }

    pub fn wait(self) -> Result<Arc<StemChunk>> {
        self.receiver
            .recv()
            .context("STEM 后台分离 worker 已退出")?
    }

    #[cfg(test)]
    pub(crate) fn test_pair() -> (SyncSender<Result<Arc<StemChunk>>>, Self) {
        let (sender, receiver) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        (
            sender,
            Self {
                receiver,
                cancelled,
            },
        )
    }
}

impl Drop for StemInferenceTicket {
    fn drop(&mut self) {
        // A queued look-ahead ticket whose Deck was retargeted must not consume a later
        // separation slot. Native separation itself is not pre-emptible, but its stale result
        // is discarded at the next cancellation fence.
        self.cancelled.store(true, Ordering::Release);
    }
}

/// Small persistent worker pool owned only while one or more live STEM streams exist. Dropping the
/// final pool handle closes the queue; worker-local FFT workspaces then
/// leave memory instead of becoming an application-lifetime cache.
pub struct StemInferencePool {
    id: u64,
    audio_sender: SyncSender<InferenceJob>,
    look_ahead_sender: SyncSender<InferenceJob>,
    cache: Arc<Mutex<TileCache>>,
    preference: StemRuntimePreference,
    instant: Option<Arc<crate::InstantStemPool>>,
    shutdown: Arc<AtomicBool>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

// Two Decks retain their current and immediate future audio tiles. Twenty immutable results
// absorb quick seeks and handoffs without becoming a whole-track cache.
const TILE_CACHE_CAPACITY: usize = 20;

static NEXT_POOL_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_POOL_COUNT: AtomicUsize = AtomicUsize::new(0);
static RESOURCE_SAMPLER_STARTED: AtomicBool = AtomicBool::new(false);
static ALLOCATOR_RELIEF_GENERATION: AtomicU64 = AtomicU64::new(0);

fn effective_worker_count(requested: usize) -> usize {
    requested.clamp(1, recommended_worker_count())
}

#[derive(Clone, Copy, Default)]
struct ProcessResourceSnapshot {
    resident_bytes: u64,
    physical_footprint_bytes: u64,
    user_cpu_ns: u64,
    system_cpu_ns: u64,
}

#[cfg(target_os = "macos")]
fn process_resource_snapshot() -> ProcessResourceSnapshot {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::uninit();
    // SAFETY: proc_pid_rusage writes one rusage_info_v2 for the current PID when it returns 0.
    let result = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            usage.as_mut_ptr() as _,
        )
    };
    if result != 0 {
        return ProcessResourceSnapshot::default();
    }
    // SAFETY: the successful call above initialized the complete structure.
    let usage = unsafe { usage.assume_init() };
    ProcessResourceSnapshot {
        resident_bytes: usage.ri_resident_size,
        physical_footprint_bytes: usage.ri_phys_footprint,
        user_cpu_ns: usage.ri_user_time,
        system_cpu_ns: usage.ri_system_time,
    }
}

#[cfg(not(target_os = "macos"))]
fn process_resource_snapshot() -> ProcessResourceSnapshot {
    ProcessResourceSnapshot::default()
}

#[cfg(target_os = "macos")]
fn release_allocator_pages() -> usize {
    unsafe extern "C" {
        fn malloc_zone_pressure_relief(
            zone: *mut libc::malloc_zone_t,
            goal: libc::size_t,
        ) -> libc::size_t;
    }
    // SAFETY: NULL asks the system allocator to examine every malloc zone; a zero goal requests
    // maximal best-effort relief. This runs after native workers have joined, never in callback.
    unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) }
}

#[cfg(not(target_os = "macos"))]
fn release_allocator_pages() -> usize {
    0
}

fn log_pool_resource(event: &'static str, pool_id: u64) {
    let resource = process_resource_snapshot();
    tracing::info!(
        target: "kdj_stem_lifecycle",
        event,
        pool_id,
        active_pools = ACTIVE_POOL_COUNT.load(Ordering::Acquire),
        rss_mib = resource.resident_bytes as f64 / 1_048_576.0,
        footprint_mib = resource.physical_footprint_bytes as f64 / 1_048_576.0,
        process_user_cpu_ms = resource.user_cpu_ns / 1_000_000,
        process_system_cpu_ms = resource.system_cpu_ns / 1_000_000,
        gpu_telemetry = if cfg!(target_os = "macos") {
            "not used by classical CPU separator"
        } else {
            "unavailable"
        },
        "STEM lifecycle resource snapshot"
    );
}

fn schedule_allocator_pressure_relief(pool_id: u64) {
    let generation = ALLOCATOR_RELIEF_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = thread::Builder::new()
        .name("kdj-stem-memory-relief".into())
        .spawn(move || {
            // Deck replacement workers can briefly retain the final published tile after the
            // native session has dropped. Let those Arcs retire before asking macOS to unmap empty
            // large malloc regions. A newer shutdown supersedes this best-effort pass.
            thread::sleep(Duration::from_secs(1));
            if ALLOCATOR_RELIEF_GENERATION.load(Ordering::Acquire) != generation {
                return;
            }
            let before = process_resource_snapshot();
            let released = release_allocator_pages();
            let after = process_resource_snapshot();
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "delayed_allocator_relief",
                pool_id,
                generation,
                active_pools = ACTIVE_POOL_COUNT.load(Ordering::Acquire),
                allocator_released_mib = released as f64 / 1_048_576.0,
                footprint_before_mib = before.physical_footprint_bytes as f64 / 1_048_576.0,
                footprint_after_mib = after.physical_footprint_bytes as f64 / 1_048_576.0,
                "delayed STEM allocator pressure relief completed"
            );
        });
}

fn note_pool_started() {
    ACTIVE_POOL_COUNT.fetch_add(1, Ordering::AcqRel);
    if RESOURCE_SAMPLER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = thread::Builder::new()
        .name("kdj-stem-resource-log".into())
        .spawn(|| {
            kdj_core::thread_qos::prefer_background();
            let mut previous: Option<(Instant, ProcessResourceSnapshot)> = None;
            loop {
                thread::sleep(Duration::from_secs(5));
                let active_pools = ACTIVE_POOL_COUNT.load(Ordering::Acquire);
                if active_pools == 0 {
                    previous = None;
                    continue;
                }
                let now = Instant::now();
                let resource = process_resource_snapshot();
                let process_cpu_percent = previous
                    .map(|(at, before)| {
                        let cpu_ns = resource
                            .user_cpu_ns
                            .saturating_add(resource.system_cpu_ns)
                            .saturating_sub(
                                before.user_cpu_ns.saturating_add(before.system_cpu_ns),
                            );
                        cpu_ns as f64 / now.saturating_duration_since(at).as_nanos().max(1) as f64
                            * 100.0
                    })
                    .unwrap_or(0.0);
                previous = Some((now, resource));
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "resource_sample",
                    active_pools,
                    process_cpu_percent,
                    rss_mib = resource.resident_bytes as f64 / 1_048_576.0,
                    footprint_mib = resource.physical_footprint_bytes as f64 / 1_048_576.0,
                    gpu_telemetry = if cfg!(target_os = "macos") {
                        "not used by classical CPU separator"
                    } else {
                        "unavailable"
                    },
                    "STEM process resource sample"
                );
            }
        });
}

#[derive(Default)]
struct TileCache {
    entries: VecDeque<([u8; 32], Arc<StemChunk>)>,
}

impl TileCache {
    fn get(&mut self, key: &[u8; 32]) -> Option<Arc<StemChunk>> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == key)?;
        let entry = self.entries.remove(index)?;
        let result = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(result)
    }

    fn insert(&mut self, key: [u8; 32], chunk: Arc<StemChunk>) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == &key)
        {
            self.entries.remove(index);
        }
        self.entries.push_back((key, chunk));
        while self.entries.len() > TILE_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

impl StemInferencePool {
    /// Two workers overlap future tiles. Audible jobs still jump the look-ahead queue.
    pub fn recommended_workers() -> usize {
        recommended_worker_count()
    }

    pub fn new(_runtime_key: &Path, workers: usize) -> Result<Arc<Self>> {
        let preference = stem_runtime_preference();
        let id = NEXT_POOL_ID.fetch_add(1, Ordering::Relaxed);
        if workers == 0 {
            bail!("STEM 后台分离 worker 数量必须大于 0");
        }
        reset_stem_runtime_diagnostics();
        // classical Redress is the sole production path. The retired instant layer is not
        // created, so it cannot load a second separator or compete with the live separator.
        let instant: Option<Arc<crate::InstantStemPool>> = None;
        // macOS production is deliberately ORT CPU-only. A second session duplicates native
        // arena/thread-pool memory without being required for the two-Deck retained-core rate.
        // Keep one shared FIFO worker for every macOS mode.
        // Other platforms retain their two-worker accelerator path unless HS layering reserves the
        // CPU budget.
        let workers = effective_worker_count(workers);
        // Queue capacities are bounded because each fixed classical Redress tile is large.
        // Audible cache requests always overtake look-ahead preparation.
        let (audio_sender, audio_receiver) =
            mpsc::sync_channel::<InferenceJob>(workers.saturating_mul(8));
        let (look_ahead_sender, look_ahead_receiver) =
            mpsc::sync_channel::<InferenceJob>(workers.max(1));
        let receivers = Arc::new(InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
        });
        let cache = Arc::new(Mutex::new(TileCache::default()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut worker_handles = Vec::with_capacity(workers);
        for index in 0..workers {
            let receivers = Arc::clone(&receivers);
            let cache = Arc::clone(&cache);
            let worker_shutdown = Arc::clone(&shutdown);
            let handle = std::thread::Builder::new()
                .name(format!("kdj-live-stem-{index}"))
                .spawn(move || {
                    kdj_core::thread_qos::prefer_live_audio();
                    run_worker(id, index, receivers, cache, worker_shutdown)
                })
                .context("启动 STEM 后台分离 worker")?;
            worker_handles.push(handle);
        }
        note_pool_started();
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "pool_created",
            pool_id = id,
            workers,
            instant = instant.is_some(),
            "classical STEM worker pool created"
        );
        log_pool_resource("pool_created_resource", id);
        Ok(Arc::new(Self {
            id,
            audio_sender,
            look_ahead_sender,
            cache,
            preference,
            instant,
            shutdown,
            workers: Mutex::new(worker_handles),
        }))
    }

    pub fn shutdown(&self, reason: &'static str) {
        if self.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "pool_shutdown_begin",
            pool_id = self.id,
            reason,
            cache_entries = self.cache.lock().unwrap().entries.len(),
            "STEM separation pool shutdown begins"
        );
        self.cache.lock().unwrap().entries.clear();
        if let Some(instant) = &self.instant {
            instant.shutdown(reason);
        }
        let handles = std::mem::take(&mut *self.workers.lock().unwrap());
        for handle in handles {
            if handle.join().is_err() {
                tracing::warn!(
                    target: "kdj_stem_lifecycle",
                    event = "worker_join_panic",
                    pool_id = self.id,
                    "STEM separation worker panicked during shutdown"
                );
            }
        }
        let allocator_released_bytes = release_allocator_pages();
        ACTIVE_POOL_COUNT.fetch_sub(1, Ordering::AcqRel);
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "pool_shutdown_complete",
            pool_id = self.id,
            reason,
            allocator_released_mib = allocator_released_bytes as f64 / 1_048_576.0,
            "STEM separation pool sessions unloaded"
        );
        log_pool_resource("pool_shutdown_resource", self.id);
        schedule_allocator_pressure_relief(self.id);
    }

    pub fn matches_current_preference(&self) -> bool {
        self.preference == stem_runtime_preference()
    }

    pub fn instant_pool(&self) -> Option<Arc<crate::InstantStemPool>> {
        self.instant.as_ref().map(Arc::clone)
    }

    pub fn instant_ready(&self, deck: usize) -> bool {
        self.instant
            .as_ref()
            .is_some_and(|instant| instant.is_ready(deck))
    }

    pub fn submit(
        &self,
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
    ) -> Result<StemInferenceTicket> {
        self.submit_for(tile_key(&left, &right), left, right, epoch, expected_epoch)
    }

    /// Reuse PCM already paid for by the current Deck or its look-ahead. This is an exact-key
    /// lookup: callers may offset inside the retained core, but must never treat a nearby separator
    /// window as if it represented different source samples.
    pub fn cached_for_key(&self, key: &[u8; 32]) -> Option<Arc<StemChunk>> {
        self.cache.lock().unwrap().get(key)
    }

    pub fn submit_for(
        &self,
        key: [u8; 32],
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
    ) -> Result<StemInferenceTicket> {
        self.submit_with_priority(
            key,
            left,
            right,
            epoch,
            expected_epoch,
            InferencePriority::Audio,
        )
        .and_then(|ticket| ticket.context("STEM 可听缓存分离已取消"))
    }

    /// Submit one best-effort future chunk. This is deliberately separate from [`Self::submit`]:
    /// a full optional queue means the active Deck already has more important work, not that
    /// playback should wait or fail. Callers should fall back to an ordinary audio submission
    /// once the block becomes audible.
    pub fn submit_look_ahead(
        &self,
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
    ) -> Result<Option<StemInferenceTicket>> {
        self.submit_look_ahead_for(tile_key(&left, &right), left, right, epoch, expected_epoch)
    }

    pub fn submit_look_ahead_for(
        &self,
        key: [u8; 32],
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
    ) -> Result<Option<StemInferenceTicket>> {
        self.submit_with_priority(
            key,
            left,
            right,
            epoch,
            expected_epoch,
            InferencePriority::LookAhead,
        )
    }

    fn submit_with_priority(
        &self,
        key: [u8; 32],
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
        priority: InferencePriority,
    ) -> Result<Option<StemInferenceTicket>> {
        if self.shutdown.load(Ordering::Acquire) {
            bail!("STEM separation pool is shutting down");
        }
        let expected = crate::stem_tile_geometry().samples;
        if left.len() != expected || right.len() != expected {
            bail!("STEM 固定输入必须是 {expected} stereo frames");
        }
        if epoch.load(Ordering::Acquire) != expected_epoch {
            return Ok(None);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(chunk) = self.cache.lock().unwrap().get(&key) {
            let _ = reply.send(Ok(chunk));
            tracing::debug!("STEM tile cache hit");
            return Ok(Some(StemInferenceTicket {
                receiver,
                cancelled,
            }));
        }
        let mut job = InferenceJob {
            left,
            right,
            key,
            epoch,
            expected_epoch,
            cancelled: Arc::clone(&cancelled),
            work: work_scheduler().queued(separation_work_class(priority)),
            submitted_at: Instant::now(),
            reply,
        };
        tracing::debug!(
            target: "kdj_stem_lifecycle",
            event = "job_submit",
            pool_id = self.id,
            priority = ?priority,
            expected_epoch,
            current_epoch = job.epoch.load(Ordering::Acquire),
            "STEM separation job submitted"
        );
        if matches!(priority, InferencePriority::Audio)
            && instant_admission_active()
            && REFINEMENT_RUNNING.load(Ordering::Acquire)
        {
            record_refinement_deferred();
        }
        match priority {
            InferencePriority::Audio => loop {
                if job.epoch.load(Ordering::Acquire) != job.expected_epoch {
                    return Ok(None);
                }
                if self.shutdown.load(Ordering::Acquire) {
                    bail!("STEM separation pool is shutting down");
                }
                match self.audio_sender.try_send(job) {
                    Ok(()) => break,
                    Err(TrySendError::Full(returned)) => {
                        job = returned;
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        bail!("STEM 后台分离 worker 已退出");
                    }
                }
            },
            InferencePriority::LookAhead => match self.look_ahead_sender.try_send(job) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Ok(None),
                Err(TrySendError::Disconnected(_)) => bail!("STEM 后台分离 worker 已退出"),
            },
        }
        Ok(Some(StemInferenceTicket {
            receiver,
            cancelled,
        }))
    }
}

impl Drop for StemInferencePool {
    fn drop(&mut self) {
        self.shutdown("last_pool_owner_dropped");
    }
}

fn run_worker(
    pool_id: u64,
    worker_index: usize,
    receivers: Arc<InferenceReceivers>,
    cache: Arc<Mutex<TileCache>>,
    shutdown: Arc<AtomicBool>,
) {
    tracing::info!(
        target: "kdj_stem_lifecycle",
        event = "worker_started",
        pool_id,
        worker_index,
        "classical STEM worker started"
    );
    let mut engine: Option<PlatformEngine> = None;
    // Audio always wins; look-ahead runs only when the audible queue is empty.
    loop {
        let Some(scheduled) = next_separation_job_until(&receivers, Some(&shutdown)) else {
            break;
        };
        let ScheduledInference { job, _slot } = scheduled;
        let InferenceJob {
            left,
            right,
            key,
            epoch,
            expected_epoch,
            cancelled,
            work,
            submitted_at,
            reply,
        } = job;
        if cancelled.load(Ordering::Acquire) || epoch.load(Ordering::Acquire) != expected_epoch {
            tracing::debug!(
                target: "kdj_stem_lifecycle",
                event = "job_cancelled_before_separation",
                pool_id,
                worker_index,
                expected_epoch,
                current_epoch = epoch.load(Ordering::Acquire),
                "stale STEM job cancelled"
            );
            let _ = reply.send(Err(anyhow::anyhow!("STEM 后台分离已取消")));
            continue;
        }
        if shutdown.load(Ordering::Acquire) {
            let _ = reply.send(Err(anyhow::anyhow!(
                "STEM separation pool is shutting down"
            )));
            break;
        }
        if let Some(chunk) = cache.lock().unwrap().get(&key) {
            let _ = reply.send(Ok(chunk));
            tracing::debug!("STEM queued tile reused cached PCM");
            continue;
        }
        let _work = work.start();
        let started_at = Instant::now();
        let mut infer_elapsed = Duration::ZERO;
        let result = (|| -> Result<Arc<StemChunk>> {
            if engine.is_none() {
                let load_started = Instant::now();
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "session_load_begin",
                    pool_id,
                    worker_index,
                    "classical STEM workspace initialization begins"
                );
                let loaded = PlatformEngine::load();
                record_runtime_initialized(loaded.info(), load_started.elapsed());
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "session_load_complete",
                    pool_id,
                    worker_index,
                    elapsed_ms = load_started.elapsed().as_millis(),
                    runtime = %loaded.info().runtime,
                    provider = %loaded.info().provider,
                    "classical STEM workspace initialized"
                );
                engine = Some(loaded);
            }
            let infer_started = Instant::now();
            let mut stems = engine
                .as_mut()
                .expect("STEM cache engine")
                .separate(&left, &right)?;
            if cancelled.load(Ordering::Acquire) || epoch.load(Ordering::Acquire) != expected_epoch
            {
                bail!("STEM 后台分离已取消");
            }
            retain_stem_core_and_handoff(&mut stems);
            infer_elapsed = infer_started.elapsed();
            Ok(Arc::new(StemChunk {
                stems,
                reconstruction_gain: 1.0,
            }))
        })();
        if let Ok(chunk) = &result {
            if !cancelled.load(Ordering::Acquire) && epoch.load(Ordering::Acquire) == expected_epoch
            {
                cache.lock().unwrap().insert(key, Arc::clone(chunk));
            }
        }
        match &result {
            Ok(_) => record_completed_block(
                engine
                    .as_ref()
                    .map(PlatformEngine::info)
                    .unwrap_or_else(RuntimeInfo::planned),
                infer_elapsed,
            ),
            Err(error) => record_runtime_error(error),
        }
        tracing::debug!(
            queue_and_work_ms = submitted_at.elapsed().as_millis(),
            worker_ms = started_at.elapsed().as_millis(),
            "STEM background tile completed"
        );
        let _ = reply.send(result);
    }
    let had_engine = engine.is_some();
    drop(engine);
    tracing::info!(
        target: "kdj_stem_lifecycle",
        event = "worker_exited",
        pool_id,
        worker_index,
        session_unloaded = had_engine,
        shutdown = shutdown.load(Ordering::Acquire),
        "classical STEM worker exited and its FFT workspace was dropped"
    );
}

static REFINEMENT_RUNNING: AtomicBool = AtomicBool::new(false);

struct RefinementSlot;

impl Drop for RefinementSlot {
    fn drop(&mut self) {
        REFINEMENT_RUNNING.store(false, Ordering::Release);
    }
}

struct ScheduledInference {
    job: InferenceJob,
    _slot: Option<RefinementSlot>,
}

fn retain_stem_core_and_handoff(stems: &mut [Vec<[f32; 2]>; 4]) {
    let geometry = crate::stem_tile_geometry();
    for stem in stems {
        let end = (geometry.context + geometry.core + geometry.handoff).min(stem.len());
        *stem = stem[geometry.context.min(end)..end].to_vec();
    }
}

pub fn stem_tile_cache_key(path: &Path, core_start: f64) -> [u8; 32] {
    let frame = (core_start.max(0.0) * f64::from(SAMPLE_RATE)).round() as u64;
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(frame.to_le_bytes());
    hasher.finalize().into()
}

fn tile_key(left: &[f32], right: &[f32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for channel in [left, right] {
        // A scan decoder may reopen at an exact tile boundary while the playback cursor extends
        // sequentially from the prior FLAC packet. Their PCM is audibly identical but can differ
        // by a few float mantissa bits. Hash a stable PCM16 identity so both consumers reuse the
        // immutable tile; the full-float samples still feed separation on a real miss.
        let mut bytes = [0u8; 8_192];
        for samples in channel.chunks(bytes.len() / 2) {
            for (index, sample) in samples.iter().enumerate() {
                let quantized = if sample.is_finite() {
                    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
                } else {
                    0
                };
                bytes[index * 2..index * 2 + 2].copy_from_slice(&quantized.to_le_bytes());
            }
            hasher.update(&bytes[..samples.len() * 2]);
        }
    }
    hasher.finalize().into()
}

/// Workers always take ready audio work before look-ahead work. We intentionally poll instead of
/// holding either receiver mutex in `recv`: two separation workers must be able to claim separate
/// Deck jobs, and a new seek must not sit behind an idle worker waiting on the low-priority lane.
#[cfg(test)]
fn next_separation_job(receivers: &InferenceReceivers) -> Option<ScheduledInference> {
    next_separation_job_until(receivers, None)
}

fn next_separation_job_until(
    receivers: &InferenceReceivers,
    shutdown: Option<&AtomicBool>,
) -> Option<ScheduledInference> {
    loop {
        if shutdown.is_some_and(|shutdown| shutdown.load(Ordering::Acquire)) {
            return None;
        }
        if instant_admission_active() {
            let slot = REFINEMENT_RUNNING
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .ok()
                .map(|_| RefinementSlot);
            if let Some(slot) = slot {
                match receivers.audio.lock().unwrap().try_recv() {
                    Ok(job) => {
                        return Some(ScheduledInference {
                            job,
                            _slot: Some(slot),
                        });
                    }
                    Err(TryRecvError::Disconnected) => {
                        drop(slot);
                        if matches!(
                            receivers.look_ahead.lock().unwrap().try_recv(),
                            Err(TryRecvError::Disconnected)
                        ) {
                            return None;
                        }
                    }
                    Err(TryRecvError::Empty) => drop(slot),
                }
            }
            thread::sleep(Duration::from_millis(1));
            continue;
        }
        let audio = receivers.audio.lock().unwrap().try_recv();
        if let Ok(job) = audio {
            return Some(ScheduledInference { job, _slot: None });
        }
        // A lease means a Deck may need another tile soon; give it one short admission grace
        // period before allowing look-ahead to use an otherwise idle worker.
        if live_audio_lease_count() > 0 && !matches!(audio, Err(TryRecvError::Disconnected)) {
            thread::sleep(Duration::from_millis(1));
            if let Ok(job) = receivers.audio.lock().unwrap().try_recv() {
                return Some(ScheduledInference { job, _slot: None });
            }
        }
        let look_ahead = if work_scheduler().allows(WorkClass::StemLookAhead) {
            receivers.look_ahead.lock().unwrap().try_recv()
        } else {
            Err(TryRecvError::Empty)
        };
        if let Ok(job) = look_ahead {
            return Some(ScheduledInference { job, _slot: None });
        }
        if matches!(audio, Err(TryRecvError::Disconnected))
            && matches!(look_ahead, Err(TryRecvError::Disconnected))
        {
            return None;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

struct SharedStemPool {
    path: PathBuf,
    preference: StemRuntimePreference,
    pool: Arc<StemInferencePool>,
    leases: usize,
}

fn shared_stem_pool() -> &'static Mutex<Option<SharedStemPool>> {
    static POOL: OnceLock<Mutex<Option<SharedStemPool>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(None))
}

fn stem_pool_transition() -> &'static Mutex<()> {
    static TRANSITION: OnceLock<Mutex<()>> = OnceLock::new();
    TRANSITION.get_or_init(|| Mutex::new(()))
}

/// Process-wide separation pool shared by the live audio Decks.
pub struct StemPoolGuard {
    pool_id: u64,
    path: PathBuf,
    preference: StemRuntimePreference,
}

impl Drop for StemPoolGuard {
    fn drop(&mut self) {
        let _transition = stem_pool_transition().lock().unwrap();
        let mut registry = shared_stem_pool().lock().unwrap();
        let Some(entry) = registry.as_mut() else {
            return;
        };
        if entry.pool.id != self.pool_id
            || entry.path != self.path
            || entry.preference != self.preference
        {
            tracing::debug!(
                target: "kdj_stem_lifecycle",
                event = "stale_pool_lease_ignored",
                pool_id = self.pool_id,
                registered_pool_id = entry.pool.id,
                "stale STEM pool guard cannot release a replacement pool"
            );
            return;
        }
        entry.leases = entry.leases.saturating_sub(1);
        tracing::debug!(
            target: "kdj_stem_lifecycle",
            event = "pool_lease_released",
            pool_id = entry.pool.id,
            leases = entry.leases,
            "STEM pool lease released"
        );
        if entry.leases == 0 {
            let retired = registry.take();
            drop(registry);
            if let Some(retired) = retired {
                retired.pool.shutdown("last_registry_lease_released");
            }
        }
    }
}

pub fn acquire_stem_pool(path: &Path) -> Result<(StemPoolGuard, Arc<StemInferencePool>)> {
    let _transition = stem_pool_transition().lock().unwrap();
    let preference = stem_runtime_preference();
    let mut registry = shared_stem_pool().lock().unwrap();
    if let Some(entry) = registry.as_mut() {
        if entry.path == path && entry.preference == preference {
            entry.leases = entry.leases.saturating_add(1);
            tracing::debug!(
                target: "kdj_stem_lifecycle",
                event = "pool_lease_acquired",
                pool_id = entry.pool.id,
                leases = entry.leases,
                reused = true,
                "existing STEM pool reused"
            );
            return Ok((
                StemPoolGuard {
                    pool_id: entry.pool.id,
                    path: path.to_path_buf(),
                    preference,
                },
                Arc::clone(&entry.pool),
            ));
        }
        let retired = registry.take().expect("registry entry inspected");
        tracing::warn!(
            target: "kdj_stem_lifecycle",
            event = "incompatible_pool_retired",
            pool_id = retired.pool.id,
            outstanding_leases = retired.leases,
            "retiring incompatible classical STEM pool"
        );
        drop(registry);
        retired.pool.shutdown("incompatible_runtime_requested");
        registry = shared_stem_pool().lock().unwrap();
    }
    let pool = StemInferencePool::new(path, StemInferencePool::recommended_workers())?;
    *registry = Some(SharedStemPool {
        path: path.to_path_buf(),
        preference,
        pool: Arc::clone(&pool),
        leases: 1,
    });
    tracing::debug!(
        target: "kdj_stem_lifecycle",
        event = "pool_lease_acquired",
        pool_id = pool.id,
        leases = 1,
        reused = false,
        "new STEM pool registered"
    );
    Ok((
        StemPoolGuard {
            pool_id: pool.id,
            path: path.to_path_buf(),
            preference,
        },
        pool,
    ))
}

/// Retire every classical worker and clear runtime diagnostics state.
pub(crate) fn reset_current_stem_runtime(reason: &'static str) -> bool {
    let _transition = stem_pool_transition().lock().unwrap();
    let retired = shared_stem_pool().lock().unwrap().take();
    let changed = retired.is_some();
    if let Some(retired) = retired {
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "registry_pool_retired",
            pool_id = retired.pool.id,
            leases = retired.leases,
            reason,
            "current STEM pool removed from registry during atomic runtime switch"
        );
        retired.pool.shutdown(reason);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES, SEGMENT_HANDOFF_SAMPLES, SEGMENT_SAMPLES,
    };

    #[test]
    fn classical_worker_count_is_bounded_for_dual_deck() {
        assert_eq!(effective_worker_count(0), 1);
        assert_eq!(effective_worker_count(2), 2);
        assert_eq!(effective_worker_count(20), 2);
    }

    #[test]
    fn classical_pool_reconstructs_two_lanes_without_external_assets() {
        let geometry = crate::stem_tile_geometry();
        let mut left = vec![0.0; geometry.samples];
        let mut right = vec![0.0; geometry.samples];
        for frame in 0..geometry.samples {
            left[frame] = (std::f32::consts::TAU * 440.0 * frame as f32 / 44_100.0).sin() * 0.1;
            right[frame] = (std::f32::consts::TAU * 660.0 * frame as f32 / 44_100.0).sin() * 0.1;
        }
        let pool = StemInferencePool::new(Path::new(crate::RUNTIME_ID), 2).unwrap();
        let epoch = Arc::new(AtomicU64::new(1));
        let ticket = pool
            .submit_for(
                tile_key(&left, &right),
                left.clone(),
                right.clone(),
                Arc::clone(&epoch),
                1,
            )
            .unwrap();
        let started = Instant::now();
        let chunk = ticket.wait().unwrap();
        assert_eq!(chunk.frames(), geometry.core + geometry.handoff);
        assert!(chunk.stems()[0].iter().all(|frame| *frame == [0.0, 0.0]));
        assert!(chunk.stems()[1].iter().all(|frame| *frame == [0.0, 0.0]));
        for frame in 0..chunk.frames() {
            for channel in 0..2 {
                let source = if channel == 0 {
                    left[geometry.context + frame]
                } else {
                    right[geometry.context + frame]
                };
                let reconstructed =
                    chunk.stems()[2][frame][channel] + chunk.stems()[3][frame][channel];
                assert!((source - reconstructed).abs() < 2e-4);
            }
        }
        eprintln!(
            "classical production pool first tile including init: {:.1} ms",
            started.elapsed().as_secs_f64() * 1_000.0
        );

        pool.shutdown("production_test_complete");
    }

    #[test]
    fn classical_stems_keep_absolute_level() {
        let chunk = StemChunk {
            stems: std::array::from_fn(|_| vec![[0.09, 0.045], [-0.09, -0.045]]),
            reconstruction_gain: 1.0,
        };
        assert_eq!(chunk.reconstruction_gain(), 1.0);
    }

    #[test]
    fn cached_tiles_drop_fft_context_but_keep_the_handoff_tail() {
        let mut stems = std::array::from_fn(|stem| {
            (0..SEGMENT_SAMPLES)
                .map(|frame| [frame as f32, stem as f32])
                .collect::<Vec<_>>()
        });
        retain_stem_core_and_handoff(&mut stems);
        assert_eq!(
            stems[0].len(),
            SEGMENT_CORE_SAMPLES + SEGMENT_HANDOFF_SAMPLES
        );
        assert_eq!(stems[0][0][0], SEGMENT_CONTEXT_SAMPLES as f32);
        assert_eq!(
            stems[0][SEGMENT_CORE_SAMPLES][0],
            (SEGMENT_CONTEXT_SAMPLES + SEGMENT_CORE_SAMPLES) as f32
        );
    }

    #[test]
    fn completed_classical_tiles_are_shared_as_immutable_cache_entries() {
        let key = tile_key(&[0.1, 0.2], &[0.3, 0.4]);
        let chunk = Arc::new(StemChunk {
            stems: std::array::from_fn(|stem| vec![[stem as f32, -(stem as f32)]]),
            reconstruction_gain: 1.0,
        });
        let mut cache = TileCache::default();
        cache.insert(key, Arc::clone(&chunk));
        let reused = cache.get(&key).expect("cached tile");
        assert!(Arc::ptr_eq(&chunk, &reused));
        assert_ne!(key, tile_key(&[0.1, 0.2], &[0.3, 0.5]));
    }

    fn queued_job(expected_epoch: u64) -> InferenceJob {
        let (reply, _receiver) = mpsc::sync_channel(1);
        InferenceJob {
            left: Vec::new(),
            right: Vec::new(),
            key: [0; 32],
            epoch: Arc::new(AtomicU64::new(expected_epoch)),
            expected_epoch,
            cancelled: Arc::new(AtomicBool::new(false)),
            work: work_scheduler().queued(WorkClass::StemAudible),
            submitted_at: Instant::now(),
            reply,
        }
    }

    #[test]
    fn recommended_pool_uses_two_workers_on_supported_platforms() {
        assert_eq!(
            StemInferencePool::recommended_workers(),
            recommended_worker_count()
        );
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
        assert_eq!(StemInferencePool::recommended_workers(), 2);
    }

    #[test]
    fn audio_chunk_overtakes_already_queued_look_ahead_work() {
        let (audio_sender, audio_receiver) = mpsc::sync_channel(2);
        let (look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(2);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
        };
        look_ahead_sender.send(queued_job(10)).unwrap();
        audio_sender.send(queued_job(11)).unwrap();

        let first = next_separation_job(&receivers).expect("queued job");
        let second = next_separation_job(&receivers).expect("queued job");
        assert_eq!(first.job.expected_epoch, 11);
        assert_eq!(second.job.expected_epoch, 10);
    }

    #[test]
    fn audio_jobs_from_two_decks_remain_fifo() {
        let (audio_sender, audio_receiver) = mpsc::sync_channel(2);
        let (_look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(1);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
        };
        audio_sender.send(queued_job(101)).unwrap();
        audio_sender.send(queued_job(202)).unwrap();

        assert_eq!(
            next_separation_job(&receivers).unwrap().job.expected_epoch,
            101
        );
        assert_eq!(
            next_separation_job(&receivers).unwrap().job.expected_epoch,
            202
        );
    }

    #[test]
    fn dropping_a_separation_ticket_cancels_the_job() {
        let (_sender, ticket) = StemInferenceTicket::test_pair();
        let cancelled = Arc::clone(&ticket.cancelled);
        drop(ticket);
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn worker_exits_only_after_both_audio_lanes_close() {
        let (audio_sender, audio_receiver) = mpsc::sync_channel(1);
        let (look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(1);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
        };
        drop(audio_sender);
        drop(look_ahead_sender);
        assert!(next_separation_job(&receivers).is_none());
    }

    #[test]
    fn live_pool_rejects_wrong_chunk_lengths_before_queueing() {
        let pool = StemInferencePool::new(Path::new(crate::RUNTIME_ID), 1).unwrap();
        let epoch = Arc::new(AtomicU64::new(1));
        assert!(pool.submit(vec![0.0; 32], vec![0.0; 32], epoch, 1).is_err());
    }

    #[test]
    fn audio_lease_count_tracks_only_live_producers() {
        let before = live_audio_lease_count();
        let first = begin_live_stem_audio_lease();
        let second = begin_live_stem_audio_lease();
        assert_eq!(live_audio_lease_count(), before + 2);
        drop(first);
        assert_eq!(live_audio_lease_count(), before + 1);
        drop(second);
        assert_eq!(live_audio_lease_count(), before);
    }
}
