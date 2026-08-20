use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use kdj_core::work_scheduler::{work_scheduler, QueuedWork, WorkClass};
use kdj_core::{StemCompute, StemMode};
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::dsp::{apply_soft_gate, pack_model_input_for_mode, unpack_model_output};
use crate::instant::{instant_admission_active, instant_model_directory};
use crate::runtime::{
    configure_stem_runtime, recommended_worker_count, PlatformEngine, RuntimeInfo,
};
use crate::runtime::{stem_runtime_preference, StemRuntimePreference};
use crate::{
    StemKind, StemWaveform, SAMPLE_RATE, SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES,
    SEGMENT_HANDOFF_SAMPLES, SEGMENT_SAMPLES,
};

const LIVE_WAVE_COLUMNS_PER_SECOND: usize = 100;
/// Keep the 30-second performance rail while the playhead walks the song; never retain a
/// whole-track PCM/RGB session.
const LIVE_WAVE_RETAIN_SECONDS: f64 = 30.0;
/// The audio worker can finish while its bounded ring still plays the final seconds. Keep the
/// compact completed session long enough for the next UI delta poll (and a quick panel remount)
/// instead of deleting the song tail before it can be painted.
const LIVE_WAVE_COMPLETION_RETENTION: Duration = Duration::from_secs(60);
/// One 46 ms Hann window per 10 ms display column. This follows the same STFT + frequency-colour
/// gradient family used by DJ waveform tools, but runs only on completed Spleeter4 PCM in memory.
const LIVE_STEM_COLOR_FFT_SIZE: usize = 2_048;
const LIVE_STEM_COLOR_MIN_HZ: f32 = 35.0;
const LIVE_STEM_COLOR_MAX_HZ: f32 = 16_000.0;
/// Match the original mix waveform: P99.5 height, then γ < 1 so quiet hits still read.
const LIVE_AMP_GAMMA: f32 = 0.72;
/// Same floor as `kdj_analysis::waveform::COLOR_FLOOR` so STEM rails are not a grey wash.
const LIVE_COLOR_FLOOR: f32 = 0.12;
/// One fixed Spleeter4 tile produces this much retained source. This is a background-cache budget,
/// not callback latency or a promise that a cache miss is instantaneous.
const DIAGNOSTIC_HISTORY: usize = 64;

/// Bounded, user-visible observations from the actual inference workers. These values are
/// intentionally about completed work rather than a synthetic benchmark: testers can report the
/// selected provider, cold block, steady P95, late blocks, output gaps, and memory-like failures
/// from `/stems/model` without enabling a debug build.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemRuntimeDiagnostics {
    pub runtime: String,
    pub provider: String,
    pub model_load_ms: Option<u64>,
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
            model_load_ms: None,
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

/// Snapshot used by the model status endpoint. The callback-side gap count is an atomic counter
/// so the realtime renderer never locks the diagnostics mutex.
pub fn stem_runtime_diagnostics() -> StemRuntimeDiagnostics {
    let mut diagnostics = diagnostics_state().lock().unwrap().clone();
    diagnostics.output_underruns = STEM_OUTPUT_UNDERRUNS.load(Ordering::Acquire);
    diagnostics
}

pub fn any_live_audio_lease_held() -> bool {
    live_audio_lease_count() > 0
}

pub fn live_audio_lease_count() -> usize {
    live_waves()
        .lock()
        .unwrap()
        .values()
        .filter(|session| session.audio_lease)
        .count()
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

fn record_model_loaded(info: RuntimeInfo, elapsed: Duration) {
    let mut diagnostics = diagnostics_state().lock().unwrap();
    diagnostics.runtime = info.runtime;
    diagnostics.provider = info.provider;
    diagnostics.model_load_ms = Some(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
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

struct LiveWaveBlock {
    revision: u64,
    start: f64,
    duration: f64,
    amp: [Vec<f32>; 4],
    rgb: [Vec<[u8; 3]>; 4],
}

struct LiveWaveSession {
    /// Stable public identity for this track's retained waveform timeline. Transport seeks do not
    /// change it, so mounted clients can continue their append cursor without replaying a whole
    /// song of JSON or clearing canvases.
    epoch: u64,
    /// Per-worker cancellation identity. A seek advances this even though the public timeline
    /// epoch stays stable, preventing an old separator from publishing into the new transport.
    worker_epoch: u64,
    revision: u64,
    start: f64,
    duration: f64,
    /// Live playback owns this lease. A completed audio worker may still keep the compact
    /// session briefly so the UI can paint the last tile while the ring drains.
    audio_lease: bool,
    /// Display-only viewport scan. Released immediately on track switch; it must not keep
    /// GPU/PCM tiles after the song has left the Deck.
    scan_lease: bool,
    scan_generation: u64,
    finished_at: Option<Instant>,
    blocks: VecDeque<LiveWaveBlock>,
}

impl LiveWaveSession {
    fn held(&self) -> bool {
        self.audio_lease || self.scan_lease
    }
}

/// Incremental waveform payload for the performance UI. Sending a complete 24,000-column RGB
/// waveform every 200ms made JSON parsing and canvas redraws compete with the compositor. A
/// point is therefore sent only once, when its real Spleeter4 tile is published.
#[derive(Clone, Debug, Serialize)]
pub struct LiveStemWaveformDelta {
    pub track_id: i64,
    pub epoch: u64,
    pub duration: f64,
    pub columns: usize,
    pub revision: u64,
    pub stems: [LiveStemWaveformStem; 4],
    pub analysis_start: f64,
    pub analysis_frontier: f64,
    pub analysis_back_frontier: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct LiveStemWaveformStem {
    pub stem: StemKind,
    pub points: Vec<LiveStemWaveformPoint>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct LiveStemWaveformPoint {
    pub index: usize,
    pub amp: f32,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

fn live_waves() -> &'static Mutex<HashMap<i64, LiveWaveSession>> {
    static WAVES: OnceLock<Mutex<HashMap<i64, LiveWaveSession>>> = OnceLock::new();
    WAVES.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_LIVE_WAVE_EPOCH: AtomicU64 = AtomicU64::new(1);
static NEXT_SCAN_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_live_wave_epoch() -> u64 {
    NEXT_LIVE_WAVE_EPOCH.fetch_add(1, Ordering::AcqRel).max(1)
}

fn next_scan_generation() -> u64 {
    NEXT_SCAN_GENERATION.fetch_add(1, Ordering::AcqRel).max(1)
}

/// A model switch changes the meaning and number of every published lane. Retaining blocks across
/// that boundary makes the new scanner treat old-model coverage as completed work, so invalidate
/// the complete public timeline and force mounted clients onto a fresh epoch.
pub(crate) fn invalidate_live_stem_waveforms(reason: &'static str) {
    let mut sessions = live_waves().lock().unwrap();
    let count = sessions.len();
    sessions.clear();
    drop(sessions);
    work_scheduler().set_live_stem_decks(0);
    tracing::info!(
        target: "kdj_stem_lifecycle",
        event = "waveform_sessions_invalidated",
        count,
        reason,
        "old-model STEM waveform blocks and coverage were invalidated"
    );
}

fn prune_finished_live_wave_sessions(sessions: &mut HashMap<i64, LiveWaveSession>) {
    sessions.retain(|_, session| {
        session.held()
            || session
                .finished_at
                .is_some_and(|finished| finished.elapsed() < LIVE_WAVE_COMPLETION_RETENTION)
    });
}

pub struct LiveStemWaveGuard {
    track_id: i64,
    worker_epoch: u64,
}

impl Drop for LiveStemWaveGuard {
    fn drop(&mut self) {
        let mut sessions = live_waves().lock().unwrap();
        if let Some(session) = sessions
            .get_mut(&self.track_id)
            .filter(|session| session.worker_epoch == self.worker_epoch)
        {
            session.audio_lease = false;
            if !session.held() {
                session.finished_at = Some(Instant::now());
            }
        }
        let decks = sessions
            .values()
            .filter(|session| session.audio_lease)
            .count();
        drop(sessions);
        work_scheduler().set_live_stem_decks(decks);
    }
}

/// Display scan lease. Dropping it (or calling [`release_scan_stem_waveform`]) immediately
/// discards in-memory tiles unless a live audio worker still holds the same track.
pub struct StemScanGuard {
    track_id: i64,
    scan_generation: u64,
}

impl StemScanGuard {
    pub fn generation(&self) -> u64 {
        self.scan_generation
    }
}

impl Drop for StemScanGuard {
    fn drop(&mut self) {
        release_scan_generation(self.track_id, self.scan_generation, true);
    }
}

pub fn begin_live_stem_waveform(
    track_id: i64,
    epoch: u64,
    start: f64,
    duration: f64,
) -> LiveStemWaveGuard {
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let start = start.max(0.0);
    let duration = duration.max(0.0);
    if let Some(session) = sessions.get_mut(&track_id) {
        // A live separator has no random-access model cache, so a real seek needs a new worker
        // epoch. Its already separated waveform columns are still valid for this exact audio
        // file, though. Retaining them avoids blanking all rails every time the performer jogs or
        // SYNC retargets the current Deck.
        session.worker_epoch = epoch;
        session.start = start;
        session.duration = duration.max(session.duration);
        session.audio_lease = true;
        session.finished_at = None;
    } else {
        sessions.insert(
            track_id,
            LiveWaveSession {
                epoch: next_live_wave_epoch(),
                worker_epoch: epoch,
                revision: 0,
                start,
                duration,
                audio_lease: true,
                scan_lease: false,
                scan_generation: 0,
                finished_at: None,
                blocks: VecDeque::new(),
            },
        );
    }
    let decks = sessions
        .values()
        .filter(|session| session.audio_lease)
        .count();
    drop(sessions);
    work_scheduler().set_live_stem_decks(decks);
    LiveStemWaveGuard {
        track_id,
        worker_epoch: epoch,
    }
}

/// Attach a display-only scan to this track's in-memory waveform. Existing tiles stay; a new
/// song identity is created only when no session exists yet.
pub fn begin_scan_stem_waveform(track_id: i64, duration: f64) -> StemScanGuard {
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let duration = duration.max(0.0);
    if let Some(session) = sessions.get_mut(&track_id) {
        session.duration = duration.max(session.duration);
        if !session.scan_lease {
            session.scan_generation = next_scan_generation();
        }
        session.scan_lease = true;
        session.finished_at = None;
        StemScanGuard {
            track_id,
            scan_generation: session.scan_generation,
        }
    } else {
        sessions.insert(
            track_id,
            LiveWaveSession {
                epoch: next_live_wave_epoch(),
                worker_epoch: 0,
                revision: 0,
                start: 0.0,
                duration,
                audio_lease: false,
                scan_lease: true,
                scan_generation: next_scan_generation(),
                finished_at: None,
                blocks: VecDeque::new(),
            },
        );
        let scan_generation = sessions
            .get(&track_id)
            .expect("scan session inserted")
            .scan_generation;
        StemScanGuard {
            track_id,
            scan_generation,
        }
    }
}

/// Cancel in-flight display work and drop the tiles immediately when no audio worker remains.
pub fn release_scan_stem_waveform(track_id: i64) {
    let generation = {
        let sessions = live_waves().lock().unwrap();
        sessions
            .get(&track_id)
            .map(|session| session.scan_generation)
    };
    if let Some(generation) = generation {
        release_scan_generation(track_id, generation, true);
    }
}

fn release_scan_generation(track_id: i64, scan_generation: u64, immediate: bool) {
    let mut sessions = live_waves().lock().unwrap();
    let Some(session) = sessions.get_mut(&track_id) else {
        return;
    };
    if session.scan_generation != scan_generation {
        return;
    }
    session.scan_lease = false;
    session.scan_generation = next_scan_generation();
    if session.audio_lease {
        prune_distant_live_wave_blocks(session, session.start);
        return;
    }
    if immediate {
        sessions.remove(&track_id);
    } else {
        session.finished_at = Some(Instant::now());
    }
}

pub fn extend_scan_stem_waveform(track_id: i64, duration: f64) {
    let mut sessions = live_waves().lock().unwrap();
    if let Some(session) = sessions.get_mut(&track_id) {
        session.duration = duration.max(session.duration);
        session.finished_at = None;
    }
}

pub fn publish_scan_stem_waveform_block(
    track_id: i64,
    scan_generation: u64,
    start: f64,
    stems: &[Vec<[f32; 2]>; 4],
    frame_start: usize,
    frames: usize,
) {
    publish_stem_waveform_block(track_id, start, stems, frame_start, frames, |session| {
        session.scan_lease && session.scan_generation == scan_generation
    });
}

#[derive(Clone, Debug, Default)]
pub struct LiveStemCoverage {
    pub duration: f64,
    pub ranges: Vec<(f64, f64)>,
    pub covered_seconds: f64,
}

pub fn live_stem_coverage(track_id: i64) -> Option<LiveStemCoverage> {
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let session = sessions.get(&track_id)?;
    Some(coverage_from_session(session))
}

pub fn live_stem_range_covered(track_id: i64, start: f64, duration: f64) -> bool {
    live_stem_coverage(track_id).is_some_and(|coverage| {
        range_is_covered(
            &coverage.ranges,
            start,
            (start + duration).min(coverage.duration),
        )
    })
}

fn coverage_from_session(session: &LiveWaveSession) -> LiveStemCoverage {
    let mut ranges: Vec<(f64, f64)> = session
        .blocks
        .iter()
        .map(|block| (block.start, block.start + block.duration))
        .collect();
    ranges.sort_by(|left, right| left.0.total_cmp(&right.0));
    let merged = merge_ranges(&ranges);
    let covered_seconds = merged
        .iter()
        .map(|(start, end)| (end - start).max(0.0))
        .sum();
    LiveStemCoverage {
        duration: session.duration,
        ranges: merged,
        covered_seconds,
    }
}

pub(crate) fn merge_ranges(ranges: &[(f64, f64)]) -> Vec<(f64, f64)> {
    const EPSILON: f64 = 0.002;
    let mut merged = Vec::<(f64, f64)>::new();
    for &(start, end) in ranges {
        if end <= start {
            continue;
        }
        match merged.last_mut() {
            Some((_, current_end)) if start <= *current_end + EPSILON => {
                *current_end = current_end.max(end);
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}

pub(crate) fn range_is_covered(ranges: &[(f64, f64)], start: f64, end: f64) -> bool {
    const EPSILON: f64 = 0.002;
    if end <= start + EPSILON {
        return true;
    }
    ranges.iter().any(|&(range_start, range_end)| {
        range_start <= start + EPSILON && range_end + EPSILON >= end
    })
}

pub fn publish_live_stem_waveform_block(
    track_id: i64,
    epoch: u64,
    start: f64,
    stems: &[Vec<[f32; 2]>; 4],
    frame_start: usize,
    frames: usize,
) {
    publish_stem_waveform_block(track_id, start, stems, frame_start, frames, |session| {
        session.worker_epoch == epoch
    });
}

fn publish_stem_waveform_block(
    track_id: i64,
    start: f64,
    stems: &[Vec<[f32; 2]>; 4],
    frame_start: usize,
    frames: usize,
    accept: impl Fn(&LiveWaveSession) -> bool,
) {
    if frames == 0 {
        return;
    }
    let wave_frames = (SAMPLE_RATE as usize / LIVE_WAVE_COLUMNS_PER_SECOND).max(1);
    let columns = frames.div_ceil(wave_frames);
    let mut amp: [Vec<f32>; 4] = std::array::from_fn(|_| vec![0.0; columns]);
    for offset in 0..frames {
        let column = offset / wave_frames;
        for stem in 0..4 {
            if let Some(frame) = stems[stem].get(frame_start + offset) {
                amp[stem][column] = amp[stem][column].max(frame[0].abs()).max(frame[1].abs());
            }
        }
    }
    // This runs on the decode/inference worker, never in the audio callback. Every stem feeds the
    // same spectrum-to-colour transform: their different colours arise from their different audio
    // spectra, not a drums/vocals source label.
    let mut mono = Vec::with_capacity(frames);
    let rgb = std::array::from_fn(|stem| {
        mono.clear();
        mono.extend((0..frames).map(|offset| {
            stems[stem]
                .get(frame_start + offset)
                .map_or(0.0, |frame| (frame[0] + frame[1]) * 0.5)
        }));
        live_stem_waveform_colours(&mono, columns)
    });
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let Some(session) = sessions
        .get_mut(&track_id)
        .filter(|session| accept(session))
    else {
        return;
    };
    let duration = frames as f64 / f64::from(SAMPLE_RATE);
    session.revision = session.revision.wrapping_add(1);
    // A bounded look-ahead may publish a tile shortly before the audible worker reaches it.
    // Replace that range rather than retaining duplicate columns, but give the replacement a new
    // revision so an already-mounted client receives the authoritative values once more.
    if let Some(index) = session.blocks.iter().position(|block| {
        (block.start - start).abs() < 1.0 / f64::from(SAMPLE_RATE)
            && (block.duration - duration).abs() < 1.0 / f64::from(SAMPLE_RATE)
    }) {
        session.blocks.remove(index);
    }
    session.blocks.push_back(LiveWaveBlock {
        revision: session.revision,
        start,
        duration,
        amp,
        rgb,
    });
    if !session.scan_lease {
        prune_distant_live_wave_blocks(session, start);
    }
    session
        .blocks
        .make_contiguous()
        .sort_by(|left, right| left.start.total_cmp(&right.start));
}

fn prune_distant_live_wave_blocks(session: &mut LiveWaveSession, around: f64) {
    let keep_start = (around - LIVE_WAVE_RETAIN_SECONDS).max(0.0);
    let keep_end = around + LIVE_WAVE_RETAIN_SECONDS;
    session
        .blocks
        .retain(|block| block.start + block.duration >= keep_start && block.start <= keep_end);
}

/// Return the contiguous regions actually backed by completed Spleeter4 tiles. These bounds must
/// come from published blocks rather than elapsed wall-clock time: a slow model must leave the
/// frontier where data really ends instead of making the UI advertise an empty future as loaded.
fn live_waveform_frontiers(session: &LiveWaveSession) -> (f64, f64) {
    const EPSILON_SECONDS: f64 = 1.0 / SAMPLE_RATE as f64;

    let mut forward = session.start;
    for block in session
        .blocks
        .iter()
        .filter(|block| block.start >= session.start - EPSILON_SECONDS)
    {
        if block.start > forward + EPSILON_SECONDS {
            break;
        }
        forward = forward.max(block.start + block.duration);
    }

    let mut backward = session.start;
    for block in session
        .blocks
        .iter()
        .rev()
        .filter(|block| block.start + block.duration <= session.start + EPSILON_SECONDS)
    {
        if block.start + block.duration < backward - EPSILON_SECONDS {
            break;
        }
        backward = backward.min(block.start);
    }

    if session.duration > 0.0 {
        (forward.min(session.duration), backward.max(0.0))
    } else {
        (forward, backward.max(0.0))
    }
}

fn color_fft() -> &'static (std::sync::Arc<dyn Fft<f32>>, Vec<f32>) {
    static FFT: OnceLock<(std::sync::Arc<dyn Fft<f32>>, Vec<f32>)> = OnceLock::new();
    FFT.get_or_init(|| {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(LIVE_STEM_COLOR_FFT_SIZE);
        let window: Vec<f32> = (0..LIVE_STEM_COLOR_FFT_SIZE)
            .map(|index| {
                0.5 - 0.5
                    * (std::f32::consts::TAU * index as f32 / (LIVE_STEM_COLOR_FFT_SIZE - 1) as f32)
                        .cos()
            })
            .collect();
        (fft, window)
    })
}

/// Map a live separated signal to colour by integrating its Hann-windowed FFT power over one
/// shared logarithmic frequency → RGB gradient. It intentionally has no `StemKind` argument:
/// every source follows the same rule, so hue is evidence from its audio rather than a label.
fn live_stem_waveform_colours(samples: &[f32], columns: usize) -> Vec<[u8; 3]> {
    if samples.is_empty() || columns == 0 {
        return vec![[31, 31, 31]; columns];
    }
    let (fft, window) = color_fft();
    let samples_per_column = samples.len() as f32 / columns as f32;
    thread_local! {
        static BUFFER: RefCell<Vec<Complex32>> = const { RefCell::new(Vec::new()) };
    }
    BUFFER.with(|cell| {
        let mut buffer = cell.borrow_mut();
        buffer.resize(LIVE_STEM_COLOR_FFT_SIZE, Complex32::default());
        let mut colours = Vec::with_capacity(columns);
        let mut loudness = Vec::with_capacity(columns);

        for column in 0..columns {
            let centre = ((column as f32 + 0.5) * samples_per_column).round() as isize;
            for (offset, slot) in buffer.iter_mut().enumerate() {
                let sample_index = centre + offset as isize - LIVE_STEM_COLOR_FFT_SIZE as isize / 2;
                let value = if sample_index >= 0 {
                    samples.get(sample_index as usize).copied().unwrap_or(0.0)
                } else {
                    0.0
                };
                *slot = Complex32::new(value * window[offset], 0.0);
            }
            fft.process(&mut buffer);

            let mut total_weight = 0.0f32;
            let mut total_power = 0.0f32;
            let mut colour = [0.0f32; 3];
            for bin in 1..=LIVE_STEM_COLOR_FFT_SIZE / 2 {
                let frequency = bin as f32 * SAMPLE_RATE as f32 / LIVE_STEM_COLOR_FFT_SIZE as f32;
                if !(LIVE_STEM_COLOR_MIN_HZ..=LIVE_STEM_COLOR_MAX_HZ).contains(&frequency) {
                    continue;
                }
                let power = buffer[bin].norm_sqr();
                // Power^0.275 is a log-like compressor. Octave balancing keeps dense treble bins and
                // one enormous bass bin from making every source look like the same flat colour.
                let weight = power.powf(0.275) * (200.0 / frequency).sqrt().clamp(0.18, 1.4);
                if !weight.is_finite() || weight <= 0.0 {
                    continue;
                }
                let bin_colour = spectral_gradient(frequency);
                for channel in 0..3 {
                    colour[channel] += weight * bin_colour[channel];
                }
                total_weight += weight;
                total_power += power;
            }
            if total_weight > 1e-12 {
                for channel in &mut colour {
                    *channel /= total_weight;
                }
            }
            colours.push(colour);
            loudness.push(total_power.sqrt());
        }

        let mut sorted_loudness = loudness.clone();
        sorted_loudness.sort_by(f32::total_cmp);
        let reference = sorted_loudness[((sorted_loudness.len() as f32 * 0.95).floor() as usize)
            .min(sorted_loudness.len() - 1)]
        .max(1e-9);
        let mut previous = [0.0f32; 3];
        colours
            .into_iter()
            .zip(loudness)
            .enumerate()
            .map(|(index, (colour, energy))| {
                // Smooth hue over 30 ms; amplitude still retains the 10 ms transient detail.
                let hue = if index == 0 {
                    colour
                } else {
                    std::array::from_fn(|channel| previous[channel] * 0.62 + colour[channel] * 0.38)
                };
                previous = hue;
                if energy <= 1e-12 {
                    return [18, 18, 18];
                }
                // Same vivid rule as the original mix waveform: the strongest band of this column
                // reaches full scale, weaker bands keep a floor so the hue stays readable on a
                // dark rail. Loudness only rides value, never desaturates the mix into grey.
                let peak = hue.iter().copied().fold(0.0f32, f32::max).max(1e-6);
                let value = LIVE_COLOR_FLOOR
                    + (1.0 - LIVE_COLOR_FLOOR) * (energy / reference).clamp(0.0, 1.0).powf(0.45);
                std::array::from_fn(|channel| {
                    ((hue[channel] / peak) * value * 255.0)
                        .round()
                        .clamp(0.0, 255.0) as u8
                })
            })
            .collect()
    })
}

/// Shared log-frequency gradient: low = red, the vocal presence range moves through green/cyan,
/// and high detail reaches blue/violet. The stops describe frequency alone, never a STEM identity.
fn spectral_gradient(frequency: f32) -> [f32; 3] {
    const STOPS: &[(f32, [f32; 3])] = &[
        (35.0, [1.0, 0.08, 0.10]),
        (180.0, [1.0, 0.12, 0.10]),
        (600.0, [1.0, 0.48, 0.08]),
        (1_400.0, [0.20, 0.95, 0.18]),
        (3_200.0, [0.04, 0.92, 0.72]),
        (6_500.0, [0.08, 0.38, 1.0]),
        (16_000.0, [0.60, 0.18, 1.0]),
    ];
    let frequency = frequency.clamp(STOPS[0].0, STOPS[STOPS.len() - 1].0);
    for pair in STOPS.windows(2) {
        let (low_frequency, low_colour) = pair[0];
        let (high_frequency, high_colour) = pair[1];
        if frequency <= high_frequency {
            let progress =
                (frequency.ln() - low_frequency.ln()) / (high_frequency.ln() - low_frequency.ln());
            return std::array::from_fn(|channel| {
                low_colour[channel] + (high_colour[channel] - low_colour[channel]) * progress
            });
        }
    }
    STOPS[STOPS.len() - 1].1
}

/// Return only blocks that were published since `after_revision`. Unlike the legacy full
/// waveform endpoint this has a bounded payload even for a long track: an ordinary 200ms poll
/// is empty, and a completed Spleeter4 tile contributes only its own timeline columns.
pub fn live_stem_waveform_delta(
    track_id: i64,
    columns: usize,
    after_revision: u64,
    expected_epoch: Option<u64>,
) -> Option<LiveStemWaveformDelta> {
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let session = sessions.get(&track_id)?;
    let columns = columns.clamp(64, 24_000);
    let duration = session.duration.max(0.001);
    let mut stems: [Vec<LiveStemWaveformPoint>; 4] = std::array::from_fn(|_| Vec::new());
    // Transport seeks advance only the private worker epoch; the public timeline epoch and append
    // revision remain stable. A mounted client therefore receives just the newly separated block
    // instead of replaying a whole song or clearing its STEM rails.
    let after_revision = if expected_epoch == Some(session.epoch) {
        after_revision
    } else {
        0
    };
    const MAX_BLOCKS_PER_DELTA: usize = 8;
    let blocks: Vec<_> = session
        .blocks
        .iter()
        .filter(|block| block.revision > after_revision)
        .take(MAX_BLOCKS_PER_DELTA)
        .collect();
    let delivered_revision = blocks.last().map_or(after_revision, |block| block.revision);
    for block in blocks {
        // One scale for all four lanes preserves real inter-stem level. The old per-lane P99.5
        // made a tiny leaked residual look as tall as the dominant source and visually hid bad
        // separation.
        let shared_values = block
            .amp
            .iter()
            .flat_map(|values| values.iter().copied())
            .collect::<Vec<_>>();
        let scale = block_amplitude_scale(&shared_values);
        for stem in StemKind::ALL {
            let values = &block.amp[stem.index()];
            for (index, value) in values.iter().enumerate() {
                let time = block.start
                    + (index as f64 + 0.5) * block.duration / values.len().max(1) as f64;
                let output = ((time / duration) * columns as f64)
                    .floor()
                    .clamp(0.0, (columns - 1) as f64) as usize;
                stems[stem.index()].push(LiveStemWaveformPoint {
                    index: output,
                    amp: display_live_amplitude(*value, scale),
                    r: block.rgb[stem.index()]
                        .get(index)
                        .map_or(31, |color| color[0]),
                    g: block.rgb[stem.index()]
                        .get(index)
                        .map_or(31, |color| color[1]),
                    b: block.rgb[stem.index()]
                        .get(index)
                        .map_or(31, |color| color[2]),
                });
            }
        }
    }
    let (analysis_frontier, analysis_back_frontier) = live_waveform_frontiers(session);
    Some(LiveStemWaveformDelta {
        track_id,
        epoch: session.epoch,
        duration: session.duration,
        columns,
        // The cursor acknowledges only the bounded batch above. A client that opens the lanes
        // after idle whole-track preparation catches up over several small polls instead of
        // parsing several megabytes of points in one compositor-blocking response.
        revision: delivered_revision,
        stems: StemKind::ALL.map(|stem| LiveStemWaveformStem {
            stem,
            points: std::mem::take(&mut stems[stem.index()]),
        }),
        analysis_start: session.start,
        analysis_frontier,
        analysis_back_frontier,
    })
}

pub fn live_stem_waveform(track_id: i64, stem: StemKind, columns: usize) -> Option<StemWaveform> {
    let mut sessions = live_waves().lock().unwrap();
    prune_finished_live_wave_sessions(&mut sessions);
    let session = sessions.get(&track_id)?;
    let requested = columns.clamp(64, 24_000);
    let duration = session.duration.max(0.001);
    let (analysis_frontier, analysis_back_frontier) = live_waveform_frontiers(session);
    let mut amp = vec![0.0f32; requested];
    let mut known = vec![false; requested];
    let mut r = vec![31u8; requested];
    let mut g = vec![31u8; requested];
    let mut b = vec![31u8; requested];
    let shared_values = session
        .blocks
        .iter()
        .flat_map(|block| block.amp.iter())
        .flat_map(|values| values.iter().copied())
        .collect::<Vec<_>>();
    let shared_scale = block_amplitude_scale(&shared_values);
    for block in &session.blocks {
        let values = &block.amp[stem.index()];
        for (index, value) in values.iter().enumerate() {
            let time =
                block.start + (index as f64 + 0.5) * block.duration / values.len().max(1) as f64;
            let output = ((time / duration) * requested as f64)
                .floor()
                .clamp(0.0, (requested - 1) as f64) as usize;
            if !known[output] || *value > amp[output] {
                amp[output] = *value;
                let colour = block.rgb[stem.index()]
                    .get(index)
                    .copied()
                    .unwrap_or([31, 31, 31]);
                r[output] = colour[0];
                g[output] = colour[1];
                b[output] = colour[2];
            }
            known[output] = true;
        }
    }
    for (value, known) in amp.iter_mut().zip(&known) {
        *value = if *known {
            display_live_amplitude(*value, shared_scale)
        } else {
            0.0
        };
    }
    Some(StemWaveform {
        track_id,
        duration: session.duration,
        r,
        g,
        b,
        amp,
        known,
        analysis_start: Some(session.start),
        analysis_frontier: Some(analysis_frontier),
        analysis_back_frontier: Some(analysis_back_frontier),
    })
}

fn block_amplitude_scale(values: &[f32]) -> f32 {
    let mut sorted: Vec<f32> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect();
    if sorted.is_empty() {
        return 1.0;
    }
    sorted.sort_by(f32::total_cmp);
    sorted[((sorted.len() - 1) as f64 * 0.995).round() as usize].max(1e-6)
}

fn display_live_amplitude(value: f32, scale: f32) -> f32 {
    (value / scale).clamp(0.0, 1.0).powf(LIVE_AMP_GAMMA)
}

/// One fixed Spleeter output tile in stable `Drums / Bass / Other / Vocals` slots. Model-only
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

/// Audio-bound chunks must never queue behind optional waveform work. Fill is the current
/// viewport display scan: it yields to both audible tiles and the one-block look-ahead cushion.
#[derive(Clone, Copy, Debug)]
enum InferencePriority {
    Audio,
    LookAhead,
    Fill,
}

fn inference_work_class(priority: InferencePriority) -> WorkClass {
    match priority {
        InferencePriority::Audio => WorkClass::StemAudible,
        InferencePriority::LookAhead => WorkClass::StemLookAhead,
        InferencePriority::Fill => WorkClass::StemViewport,
    }
}

struct InferenceReceivers {
    audio: Mutex<Receiver<InferenceJob>>,
    look_ahead: Mutex<Receiver<InferenceJob>>,
    fill: Mutex<Receiver<InferenceJob>>,
}

/// Result handle lets a playback worker submit overlapping chunks to two persistent model workers
/// before waiting. Model load and inference remain completely outside the audio callback.
pub struct StemInferenceTicket {
    receiver: Receiver<Result<Arc<StemChunk>>>,
    cancelled: Arc<AtomicBool>,
}

impl StemInferenceTicket {
    pub fn try_wait(&self) -> Result<Option<Arc<StemChunk>>> {
        match self.receiver.try_recv() {
            Ok(result) => result.map(Some),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("STEM 后台推理 worker 已退出"),
        }
    }

    pub fn wait(self) -> Result<Arc<StemChunk>> {
        self.receiver
            .recv()
            .context("STEM 后台推理 worker 已退出")?
    }

    /// Wait for at most `timeout` without losing the ticket. Display work uses this to re-check
    /// its scan generation and shutdown state instead of becoming an unbounded `recv()`.
    pub fn wait_timeout(&self, timeout: Duration) -> Result<Option<Arc<StemChunk>>> {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => result.map(Some),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => bail!("STEM 后台推理 worker 已退出"),
        }
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
        // A queued optional ticket that timed out or whose Deck was unmounted must not consume a
        // later inference slot. Native inference itself is not pre-emptible, but its stale result
        // is discarded at the next cancellation fence.
        self.cancelled.store(true, Ordering::Release);
    }
}

/// Small persistent worker pool owned only while one or more live STEM streams exist. Dropping the
/// final pool handle closes the queue; worker-local native models and their GPU resources then
/// leave memory instead of becoming an application-lifetime cache.
pub struct StemInferencePool {
    id: u64,
    audio_sender: SyncSender<InferenceJob>,
    look_ahead_sender: SyncSender<InferenceJob>,
    fill_sender: SyncSender<InferenceJob>,
    cache: Arc<Mutex<TileCache>>,
    preference: StemRuntimePreference,
    instant: Option<Arc<crate::InstantStemPool>>,
    shutdown: Arc<AtomicBool>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

// Two 30-second Deck viewports need about eight retained cores each, plus immediate future/audio
// tiles. Twenty immutable results keep that rolling safety window useful without becoming a
// whole-track cache; cancellation still drops each Deck's lease immediately.
const TILE_CACHE_CAPACITY: usize = 20;

static NEXT_POOL_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_POOL_COUNT: AtomicUsize = AtomicUsize::new(0);
static RESOURCE_SAMPLER_STARTED: AtomicBool = AtomicBool::new(false);
static ALLOCATOR_RELIEF_GENERATION: AtomicU64 = AtomicU64::new(0);

fn effective_worker_count(requested: usize, mode: StemMode, instant: bool) -> usize {
    if cfg!(target_os = "macos") || mode == StemMode::MobileNetTwo || instant {
        1
    } else {
        requested.max(1)
    }
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
            "unavailable (CoreML disabled; ORT CPU path)"
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
                        "unavailable (CoreML disabled; ORT CPU path)"
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

    pub fn new(model_path: &Path, workers: usize) -> Result<Arc<Self>> {
        let preference = stem_runtime_preference();
        let id = NEXT_POOL_ID.fetch_add(1, Ordering::Relaxed);
        if crate::model::platform_model_artifact(preference.mode).is_none() {
            bail!("STEM 已关闭或当前平台尚未接入所选 runtime");
        }
        if workers == 0 {
            bail!("STEM 后台推理 worker 数量必须大于 0");
        }
        reset_stem_runtime_diagnostics();
        let instant = if preference.mode == StemMode::Four {
            instant_model_directory(model_path).and_then(|directory| {
                match crate::InstantStemPool::new_for_parent(&directory, id) {
                    Ok(pool) => Some(pool),
                    Err(error) => {
                        record_instant_failure(&format!("HS-TasNet disabled: {error:#}"));
                        None
                    }
                }
            })
        } else {
            None
        };
        // macOS production is deliberately ORT CPU-only. A second session duplicates native
        // arena/thread-pool memory without being required for the two-Deck retained-core rate.
        // Keep one shared FIFO worker for every macOS mode.
        // Other platforms retain their two-worker accelerator path unless HS layering reserves the
        // CPU budget.
        let workers = effective_worker_count(workers, preference.mode, instant.is_some());
        // Queue capacities are bounded because each fixed Spleeter4 tile is large. Audible cache
        // requests always overtake optional waveform preparation.
        let (audio_sender, audio_receiver) =
            mpsc::sync_channel::<InferenceJob>(workers.saturating_mul(8));
        let (look_ahead_sender, look_ahead_receiver) =
            mpsc::sync_channel::<InferenceJob>(workers.max(1));
        let (fill_sender, fill_receiver) = mpsc::sync_channel::<InferenceJob>(1);
        let receivers = Arc::new(InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
            fill: Mutex::new(fill_receiver),
        });
        let cache = Arc::new(Mutex::new(TileCache::default()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let model_path = model_path.to_path_buf();
        let mut worker_handles = Vec::with_capacity(workers);
        for index in 0..workers {
            let receivers = Arc::clone(&receivers);
            let cache = Arc::clone(&cache);
            let model_path = model_path.clone();
            let worker_preference = preference;
            let worker_shutdown = Arc::clone(&shutdown);
            let handle = std::thread::Builder::new()
                .name(format!("kdj-live-stem-{index}"))
                .spawn(move || {
                    kdj_core::thread_qos::prefer_live_audio();
                    run_worker(
                        id,
                        index,
                        model_path,
                        worker_preference,
                        receivers,
                        cache,
                        worker_shutdown,
                    )
                })
                .context("启动 STEM 后台推理 worker")?;
            worker_handles.push(handle);
        }
        note_pool_started();
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "pool_created",
            pool_id = id,
            mode = ?preference.mode,
            compute = ?preference.compute,
            workers,
            model_path = %model_path.display(),
            instant = instant.is_some(),
            "STEM inference pool created"
        );
        log_pool_resource("pool_created_resource", id);
        Ok(Arc::new(Self {
            id,
            audio_sender,
            look_ahead_sender,
            fill_sender,
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
            mode = ?self.preference.mode,
            compute = ?self.preference.compute,
            reason,
            cache_entries = self.cache.lock().unwrap().entries.len(),
            "STEM inference pool shutdown begins"
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
                    "STEM inference worker panicked during shutdown"
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
            "STEM inference pool sessions unloaded"
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

    /// Reuse PCM already paid for by the visible viewport. This is intentionally an exact-key
    /// lookup: callers may offset inside the retained core, but must never treat a nearby model
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
        .and_then(|ticket| ticket.context("STEM 可听缓存推理已取消"))
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

    /// Lowest-priority viewport display work. A full queue means audio or look-ahead still owns
    /// the device; the scanner retries later instead of blocking playback.
    pub fn submit_fill(
        &self,
        left: Vec<f32>,
        right: Vec<f32>,
        epoch: Arc<AtomicU64>,
        expected_epoch: u64,
    ) -> Result<Option<StemInferenceTicket>> {
        self.submit_fill_for(tile_key(&left, &right), left, right, epoch, expected_epoch)
    }

    pub fn submit_fill_for(
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
            InferencePriority::Fill,
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
            bail!("STEM inference pool is shutting down");
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
            work: work_scheduler().queued(inference_work_class(priority)),
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
            "STEM inference job submitted"
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
                    bail!("STEM inference pool is shutting down");
                }
                match self.audio_sender.try_send(job) {
                    Ok(()) => break,
                    Err(TrySendError::Full(returned)) => {
                        job = returned;
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        bail!("STEM 后台推理 worker 已退出");
                    }
                }
            },
            InferencePriority::LookAhead => match self.look_ahead_sender.try_send(job) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Ok(None),
                Err(TrySendError::Disconnected(_)) => bail!("STEM 后台推理 worker 已退出"),
            },
            InferencePriority::Fill => match self.fill_sender.try_send(job) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Ok(None),
                Err(TrySendError::Disconnected(_)) => bail!("STEM 后台推理 worker 已退出"),
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
    model_path: PathBuf,
    preference: StemRuntimePreference,
    receivers: Arc<InferenceReceivers>,
    cache: Arc<Mutex<TileCache>>,
    shutdown: Arc<AtomicBool>,
) {
    tracing::info!(
        target: "kdj_stem_lifecycle",
        event = "worker_started",
        pool_id,
        worker_index,
        mode = ?preference.mode,
        compute = ?preference.compute,
        "STEM inference worker started"
    );
    let mut engine: Option<PlatformEngine> = None;
    loop {
        let Some(scheduled) = next_inference_job_until(&receivers, Some(&shutdown)) else {
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
                event = "job_cancelled_before_inference",
                pool_id,
                worker_index,
                expected_epoch,
                current_epoch = epoch.load(Ordering::Acquire),
                "stale STEM job cancelled"
            );
            let _ = reply.send(Err(anyhow::anyhow!("STEM 后台推理已取消")));
            continue;
        }
        if shutdown.load(Ordering::Acquire) {
            let _ = reply.send(Err(anyhow::anyhow!("STEM inference pool is shutting down")));
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
                    mode = ?preference.mode,
                    compute = ?preference.compute,
                    "STEM native session load begins"
                );
                let loaded = PlatformEngine::load(&model_path, preference)?;
                record_model_loaded(loaded.info(), load_started.elapsed());
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "session_load_complete",
                    pool_id,
                    worker_index,
                    elapsed_ms = load_started.elapsed().as_millis(),
                    runtime = %loaded.info().runtime,
                    provider = %loaded.info().provider,
                    "STEM native session loaded"
                );
                engine = Some(loaded);
            }
            let infer_started = Instant::now();
            let packed = pack_model_input_for_mode(preference.mode, &left, &right)?;
            let output = engine
                .as_mut()
                .expect("STEM cache engine")
                .predict(&packed.values)?;
            if cancelled.load(Ordering::Acquire) || epoch.load(Ordering::Acquire) != expected_epoch
            {
                bail!("STEM 后台推理已取消");
            }
            let mut stems = unpack_model_output(&output, &packed)?;
            apply_soft_gate(&left, &right, &mut stems);
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
        "STEM inference worker exited and native session was dropped"
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
        // immutable tile; the full-float samples still feed inference on a real miss.
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
/// holding either receiver mutex in `recv`: two model workers must be able to claim separate Deck
/// jobs, and a new seek must not sit behind an idle worker waiting on the low-priority lane.
#[cfg(test)]
fn next_inference_job(receivers: &InferenceReceivers) -> Option<ScheduledInference> {
    next_inference_job_until(receivers, None)
}

fn next_inference_job_until(
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
                let audio = receivers.audio.lock().unwrap().try_recv();
                match audio {
                    Ok(job) => {
                        return Some(ScheduledInference {
                            job,
                            _slot: Some(slot),
                        });
                    }
                    Err(TryRecvError::Disconnected) => {
                        drop(slot);
                        let look_ahead_disconnected = matches!(
                            receivers.look_ahead.lock().unwrap().try_recv(),
                            Err(TryRecvError::Disconnected)
                        );
                        let fill_disconnected = matches!(
                            receivers.fill.lock().unwrap().try_recv(),
                            Err(TryRecvError::Disconnected)
                        );
                        if look_ahead_disconnected && fill_disconnected {
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
        // A lease means a Deck may need another tile soon; it does not mean that work is queued.
        // Give an active Deck one short admission grace period, then keep the worker useful by
        // draining optional work. The old `audio_leases == recommended_workers` fence could hold a
        // submitted fill forever even though the effective macOS pool had one idle worker.
        if live_audio_lease_count() > 0 && !matches!(audio, Err(TryRecvError::Disconnected)) {
            thread::sleep(Duration::from_millis(1));
            if let Ok(job) = receivers.audio.lock().unwrap().try_recv() {
                return Some(ScheduledInference { job, _slot: None });
            }
        }
        let look_ahead = receivers.look_ahead.lock().unwrap().try_recv();
        if let Ok(job) = look_ahead {
            return Some(ScheduledInference { job, _slot: None });
        }
        let fill = receivers.fill.lock().unwrap().try_recv();
        if let Ok(job) = fill {
            return Some(ScheduledInference { job, _slot: None });
        }
        if matches!(audio, Err(TryRecvError::Disconnected))
            && matches!(look_ahead, Err(TryRecvError::Disconnected))
            && matches!(fill, Err(TryRecvError::Disconnected))
        {
            return None;
        }
        std::thread::sleep(Duration::from_millis(2));
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

/// Process-wide inference pool so display scan and live playback share the same worker set.
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
            old_mode = ?retired.preference.mode,
            new_mode = ?preference.mode,
            outstanding_leases = retired.leases,
            "retiring incompatible STEM pool before loading another model"
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

/// Retire the old pool and publish the new preference under one process-wide transition lock.
/// `acquire_stem_pool` cannot observe the old preference after its registry entry disappeared (or
/// the new preference while the old pool is still registered), which closes the model-switch gap
/// between playback recovery and viewport scan requests.
pub(crate) fn switch_current_stem_runtime(
    mode: StemMode,
    compute: StemCompute,
    reason: &'static str,
) -> bool {
    let _transition = stem_pool_transition().lock().unwrap();
    let previous = stem_runtime_preference();
    let next = StemRuntimePreference { mode, compute };
    if previous == next {
        return false;
    }

    let retired = shared_stem_pool().lock().unwrap().take();
    if let Some(retired) = retired {
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "registry_pool_retired",
            pool_id = retired.pool.id,
            mode = ?retired.preference.mode,
            compute = ?retired.preference.compute,
            leases = retired.leases,
            reason,
            "current STEM pool removed from registry during atomic runtime switch"
        );
        // Keep the old geometry/preference visible until its native workers have fully exited.
        // New acquisitions are blocked by `_transition` throughout this join.
        retired.pool.shutdown(reason);
    }
    let changed = configure_stem_runtime(mode, compute);
    debug_assert!(changed);
    invalidate_live_stem_waveforms(reason);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobilenet_and_instant_cpu_paths_never_duplicate_native_sessions() {
        assert_eq!(effective_worker_count(2, StemMode::MobileNetTwo, false), 1);
        assert_eq!(effective_worker_count(2, StemMode::Four, true), 1);
        #[cfg(target_os = "macos")]
        assert_eq!(effective_worker_count(2, StemMode::MobileNetTwo, false), 1);
    }

    #[test]
    #[ignore = "requires KDJ_STEM_TEST_MODEL_DIR pointing at the locked MobileNet ONNX directory"]
    fn configured_mobilenet_runs_the_production_pool_and_reconstructs_two_lanes() {
        let path = std::env::var("KDJ_STEM_TEST_MODEL_DIR")
            .expect("set KDJ_STEM_TEST_MODEL_DIR to the MobileNet model directory");
        crate::runtime::configure_stem_runtime(StemMode::MobileNetTwo, kdj_core::StemCompute::Cpu);
        let geometry = crate::stem_tile_geometry();
        let mut left = vec![0.0; geometry.samples];
        let mut right = vec![0.0; geometry.samples];
        for frame in 0..geometry.samples {
            left[frame] = (std::f32::consts::TAU * 440.0 * frame as f32 / 44_100.0).sin() * 0.1;
            right[frame] = (std::f32::consts::TAU * 660.0 * frame as f32 / 44_100.0).sin() * 0.1;
        }
        let pool = StemInferencePool::new(Path::new(&path), 2).unwrap();
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
                assert!((source - reconstructed).abs() < 1e-6);
            }
        }
        eprintln!(
            "mobilenet production pool first tile including load: {:.1} ms",
            started.elapsed().as_secs_f64() * 1_000.0
        );

        // Regression for the dual-Deck starvation path: production macOS has one effective
        // worker even though two workers are recommended at acquisition. Two leases must not be
        // mistaken for two queued audio jobs; an idle worker still completes viewport fill.
        let _deck_a = begin_live_stem_waveform(-92_001, 1, 0.0, 120.0);
        let _deck_b = begin_live_stem_waveform(-92_002, 1, 0.0, 120.0);
        let mut fill_left = left.clone();
        fill_left[0] = 0.25;
        let fill_ticket = pool
            .submit_fill(fill_left, right, Arc::clone(&epoch), 1)
            .unwrap()
            .expect("dual-Deck viewport fill should be admitted");
        let fill_started = Instant::now();
        let fill_chunk = loop {
            if let Some(chunk) = fill_ticket.wait_timeout(Duration::from_millis(20)).unwrap() {
                break chunk;
            }
            assert!(
                fill_started.elapsed() < Duration::from_secs(2),
                "dual-Deck viewport fill starved behind idle audio leases"
            );
        };
        assert_eq!(fill_chunk.frames(), geometry.core + geometry.handoff);
        pool.shutdown("production_test_complete");
    }

    #[test]
    fn spleeter4_stems_keep_the_models_absolute_level() {
        let chunk = StemChunk {
            stems: std::array::from_fn(|_| vec![[0.09, 0.045], [-0.09, -0.045]]),
            reconstruction_gain: 1.0,
        };
        assert_eq!(chunk.reconstruction_gain(), 1.0);
    }

    #[test]
    fn cached_tiles_drop_model_context_but_keep_the_handoff_tail() {
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
    fn completed_spleeter4_tiles_are_shared_as_immutable_cache_entries() {
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
        let (fill_sender, fill_receiver) = mpsc::sync_channel(2);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
            fill: Mutex::new(fill_receiver),
        };
        fill_sender.send(queued_job(9)).unwrap();
        look_ahead_sender.send(queued_job(10)).unwrap();
        audio_sender.send(queued_job(11)).unwrap();

        let first = next_inference_job(&receivers).expect("queued job");
        let second = next_inference_job(&receivers).expect("queued job");
        let third = next_inference_job(&receivers).expect("queued job");
        assert_eq!(first.job.expected_epoch, 11);
        assert_eq!(second.job.expected_epoch, 10);
        assert_eq!(third.job.expected_epoch, 9);
    }

    #[test]
    fn audio_jobs_from_two_decks_remain_fifo_ahead_of_display_fill() {
        let (audio_sender, audio_receiver) = mpsc::sync_channel(2);
        let (_look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(1);
        let (fill_sender, fill_receiver) = mpsc::sync_channel(1);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
            fill: Mutex::new(fill_receiver),
        };
        audio_sender.send(queued_job(101)).unwrap();
        audio_sender.send(queued_job(202)).unwrap();
        fill_sender.send(queued_job(303)).unwrap();

        assert_eq!(
            next_inference_job(&receivers).unwrap().job.expected_epoch,
            101
        );
        assert_eq!(
            next_inference_job(&receivers).unwrap().job.expected_epoch,
            202
        );
        assert_eq!(
            next_inference_job(&receivers).unwrap().job.expected_epoch,
            303
        );
    }

    #[test]
    fn display_fill_runs_when_two_audio_leases_are_idle() {
        let _guard_a = begin_live_stem_waveform(-91_001, 1, 0.0, 120.0);
        let _guard_b = begin_live_stem_waveform(-91_002, 1, 0.0, 120.0);
        assert!(live_audio_lease_count() >= 2);

        let (_audio_sender, audio_receiver) = mpsc::sync_channel(1);
        let (_look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(1);
        let (fill_sender, fill_receiver) = mpsc::sync_channel(1);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
            fill: Mutex::new(fill_receiver),
        };
        fill_sender.send(queued_job(303)).unwrap();

        let started = Instant::now();
        let scheduled = next_inference_job(&receivers).expect("idle worker should drain fill");
        assert_eq!(scheduled.job.expected_epoch, 303);
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn inference_ticket_timeout_is_bounded_and_drop_cancels_the_job() {
        let (_sender, ticket) = StemInferenceTicket::test_pair();
        let cancelled = Arc::clone(&ticket.cancelled);
        let started = Instant::now();
        assert!(ticket
            .wait_timeout(Duration::from_millis(10))
            .unwrap()
            .is_none());
        assert!(started.elapsed() < Duration::from_millis(100));
        drop(ticket);
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn worker_exits_only_after_all_priority_lanes_close() {
        let (audio_sender, audio_receiver) = mpsc::sync_channel(1);
        let (look_ahead_sender, look_ahead_receiver) = mpsc::sync_channel(1);
        let (fill_sender, fill_receiver) = mpsc::sync_channel(1);
        let receivers = InferenceReceivers {
            audio: Mutex::new(audio_receiver),
            look_ahead: Mutex::new(look_ahead_receiver),
            fill: Mutex::new(fill_receiver),
        };
        drop(audio_sender);
        drop(look_ahead_sender);
        drop(fill_sender);
        assert!(next_inference_job(&receivers).is_none());
    }

    #[test]
    fn live_pool_rejects_wrong_chunk_lengths_before_queueing() {
        let Ok(model) = std::env::var("KDJ_SPLEETER4_MODEL_DIR") else {
            return;
        };
        let pool = StemInferencePool::new(Path::new(&model), 1).unwrap();
        let epoch = Arc::new(AtomicU64::new(1));
        assert!(pool.submit(vec![0.0; 32], vec![0.0; 32], epoch, 1).is_err());
    }

    #[test]
    fn live_waveform_tracks_published_ranges_from_a_seek() {
        let track_id = -88_001;
        let guard = begin_live_stem_waveform(track_id, 7, 2.0, 10.0);
        let empty = live_stem_waveform(track_id, StemKind::Vocals, 100).unwrap();
        assert_eq!(empty.analysis_start, Some(2.0));
        assert!(empty.known.iter().all(|known| !known));

        let stems: [Vec<[f32; 2]>; 4] =
            std::array::from_fn(|stem| vec![[0.1 * (stem + 1) as f32; 2]; SAMPLE_RATE as usize]);
        publish_live_stem_waveform_block(track_id, 7, 2.0, &stems, 0, SAMPLE_RATE as usize);
        publish_live_stem_waveform_block(track_id, 7, 1.0, &stems, 0, SAMPLE_RATE as usize);
        let partial = live_stem_waveform(track_id, StemKind::Vocals, 100).unwrap();
        assert!(partial.known.iter().any(|known| *known));
        assert!(partial.known.iter().any(|known| !*known));
        assert!(partial.analysis_frontier.unwrap() > 2.0);
        assert!(partial.analysis_back_frontier.unwrap() < 2.0);

        drop(guard);
        assert!(
            live_stem_waveform(track_id, StemKind::Vocals, 100).is_some(),
            "the final completed range must survive the audio worker's ring drain"
        );
    }

    #[test]
    fn scan_release_drops_in_memory_tiles_immediately() {
        let track_id = -88_041;
        let guard = begin_scan_stem_waveform(track_id, 12.0);
        let stems: [Vec<[f32; 2]>; 4] =
            std::array::from_fn(|_| vec![[0.2, 0.2]; SAMPLE_RATE as usize]);
        publish_scan_stem_waveform_block(
            track_id,
            guard.scan_generation,
            0.0,
            &stems,
            0,
            SAMPLE_RATE as usize,
        );
        assert!(live_stem_waveform(track_id, StemKind::Vocals, 100).is_some());
        drop(guard);
        assert!(
            live_stem_waveform(track_id, StemKind::Vocals, 100).is_none(),
            "switching songs must free the display scan instead of retaining it"
        );
    }

    #[test]
    fn recreated_waveform_session_rejects_late_old_scan_publication() {
        let track_id = -88_044;
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.2, 0.2]]);
        let first = begin_scan_stem_waveform(track_id, 12.0);
        let first_generation = first.generation();
        let first_epoch = live_stem_waveform_delta(track_id, 100, 0, None)
            .expect("first session")
            .epoch;
        drop(first);

        let second = begin_scan_stem_waveform(track_id, 12.0);
        let second_epoch = live_stem_waveform_delta(track_id, 100, 0, None)
            .expect("replacement session")
            .epoch;
        assert_ne!(first_epoch, second_epoch);
        assert_ne!(first_generation, second.generation());

        publish_scan_stem_waveform_block(track_id, first_generation, 0.0, &stems, 0, 1);
        assert_eq!(live_stem_coverage(track_id).unwrap().covered_seconds, 0.0);
        publish_scan_stem_waveform_block(track_id, second.generation(), 0.0, &stems, 0, 1);
        assert!(live_stem_coverage(track_id).unwrap().covered_seconds > 0.0);
        drop(second);
    }

    #[test]
    fn display_scan_retains_distant_tiles_while_the_track_is_mounted() {
        let track_id = -88_042;
        let guard = begin_scan_stem_waveform(track_id, 120.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.2, 0.2]]);
        publish_scan_stem_waveform_block(track_id, guard.scan_generation, 0.0, &stems, 0, 1);
        publish_scan_stem_waveform_block(track_id, guard.scan_generation, 80.0, &stems, 0, 1);
        let coverage = live_stem_coverage(track_id).unwrap();
        assert!(coverage.ranges.iter().any(|(start, _)| *start < 0.01));
        assert!(coverage.ranges.iter().any(|(start, _)| *start > 79.0));
        drop(guard);
    }

    #[test]
    fn a_late_delta_client_catches_up_in_bounded_batches() {
        let track_id = -88_043;
        let guard = begin_scan_stem_waveform(track_id, 120.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.2, 0.2]]);
        for index in 0..130 {
            publish_scan_stem_waveform_block(
                track_id,
                guard.scan_generation,
                index as f64,
                &stems,
                0,
                1,
            );
        }

        let first = live_stem_waveform_delta(track_id, 640, 0, None).unwrap();
        assert_eq!(first.revision, 8);
        let mut revision = first.revision;
        while revision < 130 {
            let next =
                live_stem_waveform_delta(track_id, 640, revision, Some(first.epoch)).unwrap();
            assert!(next.revision - revision <= 8);
            revision = next.revision;
        }
        assert_eq!(revision, 130);
        drop(guard);
    }

    #[test]
    fn live_waveform_retains_nearby_completed_tiles() {
        let track_id = -88_005;
        let guard = begin_live_stem_waveform(track_id, 15, 0.0, 40.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.1, 0.1]]);
        publish_live_stem_waveform_block(track_id, 15, 0.0, &stems, 0, 1);
        publish_live_stem_waveform_block(track_id, 15, 8.0, &stems, 0, 1);

        let delta = live_stem_waveform_delta(track_id, 100, 0, Some(15)).unwrap();
        for stem in &delta.stems {
            assert!(stem.points.iter().any(|point| point.index == 0));
            assert!(stem.points.iter().any(|point| point.index >= 19));
        }
        drop(guard);
    }

    #[test]
    fn live_waveform_drops_tiles_outside_the_viewport() {
        let track_id = -88_055;
        let guard = begin_live_stem_waveform(track_id, 16, 0.0, 120.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.1, 0.1]]);
        publish_live_stem_waveform_block(track_id, 16, 0.0, &stems, 0, 1);
        publish_live_stem_waveform_block(track_id, 16, 80.0, &stems, 0, 1);

        let coverage = live_stem_coverage(track_id).unwrap();
        assert!(
            coverage.ranges.iter().all(|&(start, _)| start >= 60.0),
            "distant tiles must not accumulate a whole-track session: {:?}",
            coverage.ranges
        );
        drop(guard);
    }

    #[test]
    fn legacy_live_waveform_reuses_published_frequency_colours() {
        let track_id = -88_004;
        let guard = begin_live_stem_waveform(track_id, 14, 0.0, 1.0);
        let frequencies = [120.0, 900.0, 3_600.0, 8_500.0];
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|stem| {
            (0..SAMPLE_RATE as usize)
                .map(|index| {
                    let sample = (std::f32::consts::TAU * frequencies[stem] * index as f32
                        / SAMPLE_RATE as f32)
                        .sin()
                        * 0.2;
                    [sample, sample]
                })
                .collect()
        });
        publish_live_stem_waveform_block(track_id, 14, 0.0, &stems, 0, SAMPLE_RATE as usize);
        let legacy = live_stem_waveform(track_id, StemKind::Vocals, 200).unwrap();
        let delta = live_stem_waveform_delta(track_id, 200, 0, None).unwrap();
        let point = delta
            .stems
            .iter()
            .find(|stem| stem.stem == StemKind::Vocals)
            .and_then(|stem| stem.points.iter().find(|point| legacy.known[point.index]))
            .expect("a revealed vocals point");
        assert_eq!(
            [
                legacy.r[point.index],
                legacy.g[point.index],
                legacy.b[point.index]
            ],
            [point.r, point.g, point.b],
        );
        drop(guard);
    }

    #[test]
    fn live_waveform_delta_sends_each_spleeter4_block_once_and_recovers_after_an_epoch_change() {
        let track_id = -88_002;
        let guard = begin_live_stem_waveform(track_id, 11, 3.0, 20.0);
        let stems: [Vec<[f32; 2]>; 4] =
            std::array::from_fn(|stem| vec![[0.1 * (stem + 1) as f32; 2]; SAMPLE_RATE as usize]);
        publish_live_stem_waveform_block(track_id, 11, 3.0, &stems, 0, SAMPLE_RATE as usize);

        let initial = live_stem_waveform_delta(track_id, 2_000, 0, None).unwrap();
        assert!(initial.epoch > 0);
        assert_eq!(initial.revision, 1);
        assert!(initial.stems.iter().all(|stem| !stem.points.is_empty()));
        assert!(initial
            .stems
            .iter()
            .flat_map(|stem| &stem.points)
            .all(|point| point.index < initial.columns && point.amp > 0.0));

        let unchanged =
            live_stem_waveform_delta(track_id, 2_000, initial.revision, Some(initial.epoch))
                .unwrap();
        assert!(unchanged.stems.iter().all(|stem| stem.points.is_empty()));

        publish_live_stem_waveform_block(track_id, 11, 4.0, &stems, 0, SAMPLE_RATE as usize);
        let next = live_stem_waveform_delta(track_id, 2_000, initial.revision, Some(initial.epoch))
            .unwrap();
        assert_eq!(next.revision, 2);
        assert!(next.stems.iter().all(|stem| !stem.points.is_empty()));

        // A seek starts a new private producer epoch, but the public waveform cursor remains
        // stable: mounted clients receive only the newly separated target window.
        let next_guard = begin_live_stem_waveform(track_id, 12, 8.0, 20.0);
        publish_live_stem_waveform_block(track_id, 12, 8.0, &stems, 0, SAMPLE_RATE as usize);
        let after_seek =
            live_stem_waveform_delta(track_id, 2_000, next.revision, Some(initial.epoch)).unwrap();
        assert_eq!(
            after_seek.epoch, initial.epoch,
            "a seek must retain the public timeline epoch"
        );
        assert_eq!(
            after_seek.revision, 3,
            "a seek must retain the append revision"
        );
        assert!(after_seek.stems.iter().all(|stem| !stem.points.is_empty()));
        for stem in &after_seek.stems {
            assert!(
                stem.points.iter().any(|point| point.index >= 750),
                "the newly sought 8s tile must be appended"
            );
            assert!(
                stem.points.iter().all(|point| point.index >= 750),
                "an unchanged cursor must not replay the old 3s/4s tiles"
            );
        }
        let retained = live_stem_waveform(track_id, StemKind::Vocals, 2_000).unwrap();
        assert!(
            retained.known[300],
            "the original 3s tile must survive the seek"
        );
        assert!(
            retained.known[800],
            "the newly sought 8s tile must be retained too"
        );

        drop(guard);
        drop(next_guard);
        assert!(live_stem_waveform_delta(track_id, 2_000, 0, None).is_some());
    }

    #[test]
    fn live_waveform_delta_preserves_inter_stem_level() {
        let track_id = -88_021;
        let guard = begin_live_stem_waveform(track_id, 21, 0.0, 1.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|stem| {
            (0..SAMPLE_RATE as usize)
                .map(|index| {
                    let scale = if stem == 0 { 0.18 } else { 0.018 };
                    let sample = scale
                        * (std::f32::consts::TAU * 220.0 * index as f32 / SAMPLE_RATE as f32).sin();
                    [sample, sample]
                })
                .collect()
        });
        publish_live_stem_waveform_block(track_id, 21, 0.0, &stems, 0, SAMPLE_RATE as usize);
        let delta = live_stem_waveform_delta(track_id, 200, 0, Some(21)).unwrap();
        let drums_peak = delta.stems[0]
            .points
            .iter()
            .map(|point| point.amp)
            .fold(0.0f32, f32::max);
        let vocals_peak = delta.stems[3]
            .points
            .iter()
            .map(|point| point.amp)
            .fold(0.0f32, f32::max);
        assert!(drums_peak > 0.9, "dominant stem peak={drums_peak}");
        assert!(
            vocals_peak < drums_peak * 0.35,
            "quiet residual must not fill its lane: drums={drums_peak} vocals={vocals_peak}"
        );
        drop(guard);
    }

    #[test]
    fn live_waveform_delta_carries_each_stems_own_frequency_colours() {
        let track_id = -88_003;
        let guard = begin_live_stem_waveform(track_id, 13, 0.0, 4.0);
        let stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|stem| {
            (0..SAMPLE_RATE as usize)
                .map(|index| {
                    let frequency = if index < SAMPLE_RATE as usize / 2 {
                        100.0
                    } else {
                        6_000.0
                    };
                    let sample = 0.2
                        * (std::f32::consts::TAU * frequency * index as f32 / SAMPLE_RATE as f32)
                            .sin();
                    // Give every separated lane genuine audio to analyse, without borrowing the
                    // original mix's colour values.
                    [sample * (stem + 1) as f32 / 4.0; 2]
                })
                .collect()
        });
        publish_live_stem_waveform_block(track_id, 13, 0.0, &stems, 0, SAMPLE_RATE as usize);

        let delta = live_stem_waveform_delta(track_id, 1_000, 0, Some(13)).unwrap();
        let vocals = delta
            .stems
            .iter()
            .find(|stem| stem.stem == StemKind::Vocals)
            .unwrap();
        let middle = vocals.points.len() / 2;
        let bass_colour = vocals.points[middle / 2];
        let treble_colour = vocals.points[middle + middle / 2];
        assert!(bass_colour.r > bass_colour.b, "low band should read redder");
        assert!(
            treble_colour.b > treble_colour.r,
            "high band should read bluer"
        );

        drop(guard);
    }

    #[test]
    fn live_stem_palette_is_frequency_driven_without_source_labels() {
        let tone = |frequency: f32| -> Vec<f32> {
            (0..SAMPLE_RATE as usize)
                .map(|index| {
                    (std::f32::consts::TAU * frequency * index as f32 / SAMPLE_RATE as f32).sin()
                        * 0.2
                })
                .collect()
        };
        let low = live_stem_waveform_colours(&tone(180.0), 100);
        let mid = live_stem_waveform_colours(&tone(1_500.0), 100);
        let high = live_stem_waveform_colours(&tone(8_000.0), 100);
        let average = |colours: &[[u8; 3]], channel: usize| -> f32 {
            colours
                .iter()
                .map(|colour| f32::from(colour[channel]))
                .sum::<f32>()
                / colours.len().max(1) as f32
        };

        // Any stem with the same spectrum gets the same hue; only frequency decides colour.
        assert!(average(&low, 0) > average(&low, 1));
        assert!(average(&mid, 1) > average(&mid, 0));
        assert!(average(&high, 2) > average(&high, 1));
        // Loud columns may reach full scale like the original mix; they must not wash out to white.
        assert!(low
            .iter()
            .any(|colour| colour.iter().copied().max().unwrap_or(0) >= 200));
        assert!(low
            .iter()
            .all(|colour| colour.iter().filter(|channel| **channel >= 250).count() < 3));
    }
}
