//! In-memory STEM waveform scan.
//!
//! Every mounted Deck paints and retains the current 30-second viewport. Tiles live in the live
//! waveform session, stay bounded to that window, and are dropped as soon as the track leaves
//! the Deck. Playback inference always wins: the scanner never opens a file or occupies the
//! model while the audible path is already late.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::Serialize;

use crate::audio::{decode_stereo_region_cached, StereoRegionDecoder};
use crate::live::{
    acquire_stem_pool, begin_scan_stem_waveform, live_stem_coverage, merge_ranges,
    publish_scan_stem_waveform_block, range_is_covered, stem_tile_cache_key, LiveStemCoverage,
    StemPoolGuard, StemScanGuard,
};
use crate::{stem_tile_geometry, SAMPLE_RATE};

/// Same visible window as the performance waveform rail (30 seconds, playhead-centred).
pub const SCAN_VIEWPORT_SECONDS: f64 = 30.0;
/// One model call normally completes well inside its retained-audio budget. This fence is long
/// enough for first-session warm-up but prevents a native/provider failure from pinning the sole
/// display scanner forever.
const SCAN_TICKET_TIMEOUT: Duration = Duration::from_secs(10);
const SCAN_TICKET_POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScanWork {
    Window { track_id: i64, start: f64 },
}

#[derive(Clone, Debug)]
pub struct ScanJobView {
    pub track_id: i64,
    pub deck: u8,
    pub duration: f64,
    pub anchor: f64,
    pub playing: bool,
    pub covered: Vec<(f64, f64)>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemScanStatus {
    pub phase: String,
    pub covered_seconds: f64,
    pub duration: f64,
    pub window_start: f64,
    pub window_end: f64,
    pub window_covered_seconds: f64,
    pub waiting_for_deck: Option<u8>,
    pub error: String,
}

struct ScanJob {
    track_id: i64,
    path: PathBuf,
    duration: f64,
    anchor: f64,
    deck: u8,
    playing: bool,
    model_path: PathBuf,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    guard: StemScanGuard,
    error: String,
}

struct ScanState {
    jobs: HashMap<i64, ScanJob>,
    order: Vec<i64>,
    pool: Option<(StemPoolGuard, Arc<crate::StemInferencePool>)>,
    stop: bool,
}

pub struct StemScanScheduler {
    inner: Arc<Mutex<ScanState>>,
    wakeup: Arc<Condvar>,
}

impl StemScanScheduler {
    pub fn new() -> Self {
        let inner = Arc::new(Mutex::new(ScanState {
            jobs: HashMap::new(),
            order: Vec::new(),
            pool: None,
            stop: false,
        }));
        let wakeup = Arc::new(Condvar::new());
        let worker_state = Arc::clone(&inner);
        let worker_wakeup = Arc::clone(&wakeup);
        std::thread::Builder::new()
            .name("kdj-stem-scan".into())
            .spawn(move || run_scan_worker(worker_state, worker_wakeup))
            .expect("spawn STEM display scan worker");
        Self { inner, wakeup }
    }

    pub fn mount(
        &self,
        track_id: i64,
        path: &Path,
        model_path: &Path,
        position: f64,
        duration: f64,
        deck: u8,
        playing: bool,
    ) -> Result<()> {
        let mut state = self.inner.lock().unwrap();
        let runtime_changed = state
            .pool
            .as_ref()
            .is_some_and(|(_, pool)| !pool.matches_current_preference())
            || state.jobs.values().any(|job| job.model_path != model_path);
        if runtime_changed {
            for (_, job) in state.jobs.drain() {
                job.epoch.fetch_add(1, Ordering::Release);
            }
            state.order.clear();
            state.pool = None;
        }
        if let Some(job) = state.jobs.get_mut(&track_id) {
            job.anchor = position.max(0.0);
            job.duration = duration.max(job.duration);
            job.deck = deck;
            job.playing = playing;
            job.path = path.to_path_buf();
            crate::live::extend_scan_stem_waveform(track_id, job.duration);
            self.wakeup.notify_one();
            return Ok(());
        }
        let epoch = Arc::new(AtomicU64::new(1));
        let job = ScanJob {
            track_id,
            path: path.to_path_buf(),
            duration: duration.max(0.0),
            anchor: position.max(0.0),
            deck,
            playing,
            model_path: model_path.to_path_buf(),
            epoch,
            expected_epoch: 1,
            guard: begin_scan_stem_waveform(track_id, duration.max(0.0)),
            error: String::new(),
        };
        state.order.push(track_id);
        state.jobs.insert(track_id, job);
        self.wakeup.notify_one();
        Ok(())
    }

    pub fn retarget(&self, track_id: i64, position: f64, playing: bool) {
        let mut state = self.inner.lock().unwrap();
        if let Some(job) = state.jobs.get_mut(&track_id) {
            job.anchor = position.max(0.0);
            job.playing = playing;
            self.wakeup.notify_one();
        }
    }

    pub fn unmount(&self, track_id: i64) {
        let mut state = self.inner.lock().unwrap();
        if let Some(job) = state.jobs.remove(&track_id) {
            job.epoch.fetch_add(1, Ordering::Release);
            drop(job);
        }
        state.order.retain(|id| *id != track_id);
        if state.jobs.is_empty() {
            state.pool = None;
        }
        self.wakeup.notify_one();
    }

    pub fn cancel_all(&self, reason: &'static str) {
        let mut state = self.inner.lock().unwrap();
        let jobs = state.jobs.len();
        for (_, job) in state.jobs.drain() {
            job.epoch.fetch_add(1, Ordering::Release);
        }
        state.order.clear();
        state.pool = None;
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "scan_cancel_all",
            jobs,
            reason,
            "all STEM display scan leases cancelled"
        );
        drop(state);
        self.wakeup.notify_all();
    }

    pub fn status(&self, track_id: i64) -> Option<StemScanStatus> {
        let state = self.inner.lock().unwrap();
        let job = state.jobs.get(&track_id)?;
        let coverage = live_stem_coverage(track_id).unwrap_or_default();
        let views: Vec<ScanJobView> = state
            .order
            .iter()
            .filter_map(|id| {
                let job = state.jobs.get(id)?;
                Some(job_view(job, live_stem_coverage(*id).unwrap_or_default()))
            })
            .collect();
        Some(status_from_view(
            &job_view(job, coverage),
            &views,
            &job.error,
        ))
    }
}

impl Drop for StemScanScheduler {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.lock() {
            state.stop = true;
            let ids: Vec<_> = state.order.clone();
            for id in ids {
                if let Some(job) = state.jobs.remove(&id) {
                    job.epoch.fetch_add(1, Ordering::Release);
                    drop(job);
                }
            }
            state.order.clear();
            state.pool = None;
        }
        self.wakeup.notify_all();
    }
}

fn job_view(job: &ScanJob, coverage: LiveStemCoverage) -> ScanJobView {
    ScanJobView {
        track_id: job.track_id,
        deck: job.deck,
        duration: job.duration.max(coverage.duration),
        anchor: job.anchor,
        playing: job.playing,
        covered: coverage.ranges,
    }
}

pub fn tile_stride_seconds() -> f64 {
    stem_tile_geometry().core as f64 / f64::from(SAMPLE_RATE)
}

pub fn window_bounds(anchor: f64, duration: f64) -> (f64, f64) {
    let duration = duration.max(0.0);
    let half = SCAN_VIEWPORT_SECONDS / 2.0;
    let start = (anchor - half).max(0.0);
    let end = (anchor + half).clamp(start, duration.max(start));
    (start, end)
}

pub fn next_scan_work(jobs: &[ScanJobView]) -> Option<ScanWork> {
    if jobs.is_empty() {
        return None;
    }
    jobs.iter()
        .filter_map(|job| next_window_tile(job).map(|tile| (job, tile)))
        .min_by(|(left, _), (right, _)| {
            let left_playing = if left.playing { 0 } else { 1 };
            let right_playing = if right.playing { 0 } else { 1 };
            left_playing
                .cmp(&right_playing)
                .then_with(|| covered_in_window(left).total_cmp(&covered_in_window(right)))
                .then_with(|| left.deck.cmp(&right.deck))
        })
        .map(|(_, tile)| tile)
        .map(|(track_id, start)| ScanWork::Window { track_id, start })
}

fn window_met(job: &ScanJobView) -> bool {
    overlapping_tiles(job.anchor, job.duration)
        .into_iter()
        .all(|start| {
            range_is_covered(
                &job.covered,
                start,
                (start + tile_length(start, job.duration)).min(job.duration),
            )
        })
}

fn next_window_tile(job: &ScanJobView) -> Option<(i64, f64)> {
    let mut tiles = overlapping_tiles(job.anchor, job.duration);
    // A moving centred viewport exposes its right edge immediately after READY. Keep exactly one
    // retained tile beyond that edge so generated STEM remains visible while the playhead moves;
    // this is bounded look-ahead, not whole-track fill.
    if job.playing {
        let stride = tile_stride_seconds();
        let next = tiles
            .last()
            .map(|start| start + stride)
            .unwrap_or_else(|| (job.anchor / stride).floor().max(0.0) * stride);
        if next < job.duration && !tiles.iter().any(|start| (*start - next).abs() < 1e-6) {
            tiles.push(next);
        }
    }
    tiles.sort_by(|left, right| {
        let priority = |start: f64| {
            let end = start + tile_length(start, job.duration);
            if !job.playing {
                return (
                    0,
                    ((start + tile_stride_seconds() / 2.0) - job.anchor).abs(),
                );
            }
            if start <= job.anchor && end > job.anchor {
                (0, 0.0)
            } else if start > job.anchor {
                (1, start - job.anchor)
            } else {
                (2, job.anchor - end)
            }
        };
        let left_priority = priority(*left);
        let right_priority = priority(*right);
        left_priority
            .0
            .cmp(&right_priority.0)
            .then_with(|| left_priority.1.total_cmp(&right_priority.1))
    });
    tiles.into_iter().find_map(|start| {
        let end = (start + tile_length(start, job.duration)).min(job.duration);
        (!range_is_covered(&job.covered, start, end)).then_some((job.track_id, start))
    })
}

fn overlapping_tiles(anchor: f64, duration: f64) -> Vec<f64> {
    let (window_start, window_end) = window_bounds(anchor, duration);
    let stride = tile_stride_seconds();
    if duration <= 0.0 || !stride.is_finite() || stride <= 0.0 || window_end <= window_start {
        return Vec::new();
    }
    let first_index = ((window_start / stride).floor() as i64 - 1).max(0);
    let mut tiles = Vec::new();
    let mut index = first_index;
    loop {
        let start = index as f64 * stride;
        if start >= duration || start >= window_end {
            break;
        }
        let end = start + tile_length(start, duration);
        if end > window_start {
            tiles.push(start);
        }
        index += 1;
    }
    tiles
}

fn tile_length(start: f64, duration: f64) -> f64 {
    tile_stride_seconds().min((duration - start).max(0.0))
}

fn covered_in_window(job: &ScanJobView) -> f64 {
    let (start, end) = window_bounds(job.anchor, job.duration);
    merge_ranges(&job.covered)
        .into_iter()
        .map(|(range_start, range_end)| range_end.min(end) - range_start.max(start))
        .filter(|overlap| *overlap > 0.0)
        .sum()
}

fn covered_in_track(job: &ScanJobView) -> f64 {
    merge_ranges(&job.covered)
        .into_iter()
        .map(|(start, end)| end.min(job.duration) - start.max(0.0))
        .filter(|overlap| *overlap > 0.0)
        .sum::<f64>()
        .min(job.duration.max(0.0))
}

fn status_from_view(job: &ScanJobView, all: &[ScanJobView], error: &str) -> StemScanStatus {
    let (window_start, window_end) = window_bounds(job.anchor, job.duration);
    let window_covered_seconds = covered_in_window(job);
    let covered_seconds = covered_in_track(job);
    let waiting_for_deck = all
        .iter()
        .filter(|other| other.track_id != job.track_id && !window_met(other))
        .map(|other| other.deck)
        .min();
    let phase = if !error.is_empty() {
        "error"
    } else if !window_met(job) {
        "window"
    } else if waiting_for_deck.is_some() {
        "waiting"
    } else {
        "done"
    };
    StemScanStatus {
        phase: phase.into(),
        covered_seconds,
        duration: job.duration,
        window_start,
        window_end,
        window_covered_seconds,
        waiting_for_deck,
        error: error.into(),
    }
}

fn run_scan_worker(state: Arc<Mutex<ScanState>>, wakeup: Arc<Condvar>) {
    kdj_core::thread_qos::prefer_background();
    let mut decoder: Option<StereoRegionDecoder> = None;
    loop {
        let work = {
            let guard = state.lock().unwrap();
            if guard.stop {
                return;
            }
            let views = current_views(&guard);
            let work = next_scan_work(&views);
            if work.is_none() {
                decoder = None;
                let _ = wakeup
                    .wait_timeout(guard, Duration::from_millis(250))
                    .expect("STEM scan condvar");
                continue;
            }
            work
        };
        let Some(work) = work else {
            continue;
        };
        let result = run_one_tile(&state, work, &mut decoder);
        let mut guard = state.lock().unwrap();
        let ScanWork::Window { track_id, .. } = work;
        if let Some(job) = guard.jobs.get_mut(&track_id) {
            update_scan_error(&mut job.error, &result);
        }
        if result.is_err() && !guard.stop {
            // Avoid a decode/resubmit hot loop while an already-running native call crosses its
            // timeout. A mount/retarget/cancel notification wakes this backoff immediately.
            let _ = wakeup
                .wait_timeout(guard, Duration::from_millis(100))
                .expect("STEM scan retry condvar");
        }
        // The shared pool gives audible cache misses priority. Optional rail work only starts when
        // no Deck tile is queued, so no arbitrary sleep is needed here.
    }
}

fn update_scan_error(error: &mut String, result: &Result<()>) {
    match result {
        Ok(()) => error.clear(),
        Err(failure) => {
            let message = failure.to_string();
            if !message.contains("已取消") && !message.contains("cancelled") {
                *error = message;
            }
        }
    }
}

fn current_views(state: &ScanState) -> Vec<ScanJobView> {
    state
        .order
        .iter()
        .filter_map(|id| {
            let job = state.jobs.get(id)?;
            Some(job_view(job, live_stem_coverage(*id).unwrap_or_default()))
        })
        .collect()
}

fn run_one_tile(
    state: &Mutex<ScanState>,
    work: ScanWork,
    decoder: &mut Option<StereoRegionDecoder>,
) -> Result<()> {
    let ScanWork::Window { track_id, start } = work;
    let snapshot = {
        let mut guard = state.lock().unwrap();
        let (path, duration, epoch, expected_epoch, generation, model_path) = {
            let job = guard
                .jobs
                .get(&track_id)
                .ok_or_else(|| anyhow!("STEM 扫描已取消"))?;
            if live_stem_coverage(track_id).is_some_and(|coverage| {
                range_is_covered(
                    &coverage.ranges,
                    start,
                    (start + tile_length(start, job.duration)).min(job.duration),
                )
            }) {
                return Ok(());
            }
            (
                job.path.clone(),
                job.duration,
                Arc::clone(&job.epoch),
                job.expected_epoch,
                job.guard.generation(),
                job.model_path.clone(),
            )
        };
        if guard.pool.is_none() {
            guard.pool = Some(acquire_stem_pool(&model_path)?);
        }
        ScanTileSnapshot {
            path,
            duration,
            epoch,
            expected_epoch,
            generation,
            pool: Arc::clone(&guard.pool.as_ref().expect("scan pool").1),
        }
    };
    if snapshot.epoch.load(Ordering::Acquire) != snapshot.expected_epoch {
        return Ok(());
    }
    // Fill yields to audible and look-ahead tiles. With two workers, a free engine can still take
    // this viewport job while the other Deck's successor is in flight. The same completed PCM is
    // published to the rail; the UI never invokes a second model for an already-paid audio tile.
    let (left, right) = decode_scan_window(decoder, &snapshot.path, start)?;
    if snapshot.epoch.load(Ordering::Acquire) != snapshot.expected_epoch {
        return Ok(());
    }
    let Some(ticket) = snapshot.pool.submit_fill_for(
        stem_tile_cache_key(&snapshot.path, start),
        left,
        right,
        Arc::clone(&snapshot.epoch),
        snapshot.expected_epoch,
    )?
    else {
        std::thread::sleep(Duration::from_millis(8));
        return Ok(());
    };
    let chunk = wait_for_scan_ticket(
        &ticket,
        &snapshot.epoch,
        snapshot.expected_epoch,
        SCAN_TICKET_TIMEOUT,
    )?;
    if snapshot.epoch.load(Ordering::Acquire) != snapshot.expected_epoch {
        return Ok(());
    }
    let geometry = stem_tile_geometry();
    let frames = if snapshot.duration.is_finite() && snapshot.duration > 0.0 {
        ((snapshot.duration - start).max(0.0) * f64::from(SAMPLE_RATE))
            .ceil()
            .min(geometry.core as f64) as usize
    } else {
        geometry.core
    };
    publish_scan_stem_waveform_block(
        track_id,
        snapshot.generation,
        start,
        chunk.stems(),
        0,
        frames.min(geometry.core).min(chunk.frames()),
    );
    Ok(())
}

fn wait_for_scan_ticket(
    ticket: &crate::StemInferenceTicket,
    epoch: &AtomicU64,
    expected_epoch: u64,
    timeout: Duration,
) -> Result<Arc<crate::StemChunk>> {
    let started = Instant::now();
    loop {
        if epoch.load(Ordering::Acquire) != expected_epoch {
            return Err(anyhow!("STEM 扫描已取消"));
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(anyhow!("STEM 波形扫描推理超时，稍后重试"));
        }
        if let Some(chunk) = ticket.wait_timeout(SCAN_TICKET_POLL.min(remaining))? {
            return Ok(chunk);
        }
    }
}

/// Display scan feeds ByteDance one fixed 512-frame (11.96-second) STFT window centred on the
/// retained 169-hop (3.92-second) tile, then publishes only that context-safe interior.
fn decode_scan_window(
    decoder: &mut Option<StereoRegionDecoder>,
    path: &Path,
    unique_start: f64,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let geometry = stem_tile_geometry();
    let window_start = unique_start - geometry.context as f64 / f64::from(SAMPLE_RATE);
    let leading = if window_start < 0.0 {
        ((-window_start * f64::from(SAMPLE_RATE)).round() as usize).min(geometry.samples)
    } else {
        0
    };
    let (decoded_left, decoded_right) = decode_stereo_region_cached(
        decoder,
        path,
        window_start.max(0.0),
        geometry.samples - leading,
    )?;
    let mut left = vec![0.0; geometry.samples];
    let mut right = vec![0.0; geometry.samples];
    let copied = decoded_left
        .len()
        .min(decoded_right.len())
        .min(geometry.samples - leading);
    left[leading..leading + copied].copy_from_slice(&decoded_left[..copied]);
    right[leading..leading + copied].copy_from_slice(&decoded_right[..copied]);
    Ok((left, right))
}

struct ScanTileSnapshot {
    path: PathBuf,
    duration: f64,
    epoch: Arc<AtomicU64>,
    expected_epoch: u64,
    generation: u64,
    pool: Arc<crate::StemInferencePool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(
        track_id: i64,
        deck: u8,
        duration: f64,
        anchor: f64,
        covered: Vec<(f64, f64)>,
    ) -> ScanJobView {
        ScanJobView {
            track_id,
            deck,
            duration,
            anchor,
            playing: false,
            covered,
        }
    }

    fn covered_window(duration: f64, anchor: f64) -> Vec<(f64, f64)> {
        let tiles = overlapping_tiles(anchor, duration);
        let Some(first) = tiles.first().copied() else {
            return Vec::new();
        };
        let end = tiles
            .into_iter()
            .map(|start| (start + tile_length(start, duration)).min(duration))
            .fold(first, f64::max);
        vec![(first, end)]
    }

    #[test]
    fn unmet_window_beats_a_ready_deck() {
        let a = job(1, 0, 180.0, 0.0, covered_window(180.0, 0.0));
        let b = job(2, 1, 180.0, 0.0, Vec::new());
        assert_eq!(
            next_scan_work(&[a.clone(), b.clone()]),
            Some(ScanWork::Window {
                track_id: 2,
                start: 0.0
            })
        );
        let filled_window = job(2, 1, 180.0, 0.0, covered_window(180.0, 0.0));
        assert_eq!(next_scan_work(&[a, filled_window]), None);
    }

    #[test]
    fn fill_waits_while_the_other_deck_window_is_unmet() {
        let ready = job(1, 0, 180.0, 12.0, vec![(0.0, 180.0)]);
        let unmet = job(2, 1, 180.0, 0.0, Vec::new());
        assert_eq!(
            next_scan_work(&[ready, unmet]),
            Some(ScanWork::Window {
                track_id: 2,
                start: 0.0
            })
        );
        let still_waiting = job(1, 0, 180.0, 0.0, covered_window(180.0, 0.0));
        let other_unmet = job(2, 1, 180.0, 30.0, Vec::new());
        assert!(matches!(
            next_scan_work(&[still_waiting, other_unmet]),
            Some(ScanWork::Window { track_id: 2, .. })
        ));
    }

    #[test]
    fn two_playing_decks_take_turns_instead_of_finishing_a_before_b() {
        let mut a = job(1, 0, 180.0, 30.0, Vec::new());
        let mut b = job(2, 1, 180.0, 30.0, Vec::new());
        a.playing = true;
        b.playing = true;
        let Some(ScanWork::Window {
            track_id: first_id,
            start,
        }) = next_scan_work(&[a.clone(), b.clone()])
        else {
            panic!("first playing Deck should receive work");
        };
        assert_eq!(first_id, 1);
        a.covered = vec![(start, start + tile_length(start, a.duration))];
        assert!(matches!(
            next_scan_work(&[a, b]),
            Some(ScanWork::Window { track_id: 2, .. })
        ));
    }

    #[test]
    fn a_playing_deck_fills_the_playhead_then_the_future_edge() {
        let mut view = job(1, 0, 180.0, 30.0, Vec::new());
        view.playing = true;
        let Some(ScanWork::Window { start, .. }) = next_scan_work(&[view.clone()]) else {
            panic!("playhead tile should be scheduled");
        };
        let end = start + tile_length(start, view.duration);
        assert!(start <= view.anchor && end > view.anchor);
        view.covered = vec![(start, end)];
        let Some(ScanWork::Window {
            start: future_start,
            ..
        }) = next_scan_work(&[view])
        else {
            panic!("future tile should follow the playhead tile");
        };
        assert!(future_start >= end - 1e-6);
    }

    #[test]
    fn ready_windows_do_not_enqueue_speculative_whole_track_fill() {
        let a = job(1, 0, 180.0, 0.0, covered_window(180.0, 0.0));
        let b = job(2, 1, 180.0, 0.0, covered_window(180.0, 0.0));
        assert_eq!(next_scan_work(&[b.clone(), a.clone()]), None);
        let a_done = job(1, 0, 180.0, 0.0, vec![(0.0, 180.0)]);
        assert_eq!(next_scan_work(&[a_done, b]), None);
    }

    #[test]
    fn window_tiles_stay_near_the_playhead_on_a_long_track() {
        let work = next_scan_work(&[job(1, 0, 36_000.0, 1_800.0, Vec::new())]);
        let Some(ScanWork::Window { start, .. }) = work else {
            panic!("expected viewport work, got {work:?}");
        };
        let stride = tile_stride_seconds();
        assert!(
            start >= 1_800.0 - stride * 2.0,
            "walked from the start of a 10h track: {start}"
        );
        assert!(start <= 1_800.0);
    }

    #[test]
    fn waiting_status_names_the_unmet_deck() {
        let a = job(1, 0, 180.0, 0.0, covered_window(180.0, 0.0));
        let b = job(2, 1, 180.0, 40.0, Vec::new());
        let status = status_from_view(&a, &[a.clone(), b], "");
        assert_eq!(status.phase, "waiting");
        assert_eq!(status.waiting_for_deck, Some(1));
    }

    #[test]
    fn covered_viewport_is_ready_without_scanning_the_rest_of_the_song() {
        let view = job(1, 0, 180.0, 0.0, covered_window(180.0, 0.0));
        let status = status_from_view(&view, &[view.clone()], "");
        assert_eq!(status.phase, "done");
    }

    #[test]
    fn a_playing_deck_gets_one_bounded_future_tile_but_not_whole_track_fill() {
        let mut view = job(1, 0, 180.0, 30.0, Vec::new());
        view.playing = true;
        assert!(next_scan_work(&[view.clone()]).is_some());

        view.covered = covered_window(180.0, 30.0);
        let Some(ScanWork::Window { start, .. }) = next_scan_work(&[view]) else {
            panic!("playing viewport should keep one future tile ready");
        };
        let (_, window_end) = window_bounds(30.0, 180.0);
        assert!(start >= window_end - tile_stride_seconds());
        assert!(start < window_end + tile_stride_seconds());
    }

    #[test]
    fn a_successful_retry_clears_the_transient_tile_error() {
        let mut error = "ByteDance bass 输出含非有限数值".to_owned();
        update_scan_error(&mut error, &Ok(()));
        assert!(error.is_empty());

        update_scan_error(&mut error, &Err(anyhow!("temporary failure")));
        assert_eq!(error, "temporary failure");
        update_scan_error(&mut error, &Ok(()));
        assert!(error.is_empty());
    }

    #[test]
    fn scan_ticket_wait_times_out_instead_of_blocking_forever() {
        let (_sender, ticket) = crate::StemInferenceTicket::test_pair();
        let epoch = AtomicU64::new(1);
        let started = Instant::now();
        let error = match wait_for_scan_ticket(&ticket, &epoch, 1, Duration::from_millis(15)) {
            Ok(_) => panic!("pending scan ticket unexpectedly completed"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("超时"));
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn scan_ticket_wait_observes_generation_cancellation() {
        let (_sender, ticket) = crate::StemInferenceTicket::test_pair();
        let epoch = Arc::new(AtomicU64::new(1));
        let cancelling_epoch = Arc::clone(&epoch);
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            cancelling_epoch.fetch_add(1, Ordering::Release);
        });
        let started = Instant::now();
        let error = match wait_for_scan_ticket(&ticket, &epoch, 1, Duration::from_secs(1)) {
            Ok(_) => panic!("cancelled scan ticket unexpectedly completed"),
            Err(error) => error,
        };
        canceller.join().unwrap();
        assert!(error.to_string().contains("已取消"));
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
