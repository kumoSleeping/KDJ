use std::cell::UnsafeCell;
use std::sync::atomic::{
    AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering,
};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

/// One decoded window spans enough source time that its background replacement can stay ahead of
/// an ordinary hand motion. Two fixed buffers are allocated once per Deck; the callback never
/// allocates, locks, decodes, or waits for the worker.
pub const SCRATCH_CACHE_WINDOW_SECONDS: usize = 12;
const SCRATCH_CACHE_MAX_FRAMES: usize = 576_000;
const REQUEST_NONE: i64 = i64::MIN;
const ACTIVE_NONE: u8 = u8::MAX;

#[derive(Debug)]
pub struct DecodedScratchWindow {
    pub start_frame: i64,
    pub frames: Vec<[f32; 2]>,
}

/// An owned mono copy of one already-decoded scratch window.
///
/// This is intentionally a control/UI-side type. Creating it copies PCM and must never happen in
/// the hardware callback; the callback continues to use [`ScratchPcmCache::sample`] without a
/// lock, allocation, decode or `Arc` operation.
#[derive(Clone, Debug)]
pub struct ScratchMonoWindow {
    pub start_frame: i64,
    pub samples: Arc<[f32]>,
}

struct ScratchWindow {
    samples: UnsafeCell<Box<[[f32; 2]]>>,
    start_frame: AtomicI64,
    len: AtomicUsize,
    readers: AtomicU32,
}

struct ScratchReaderPin<'a>(&'a AtomicU32);

impl Drop for ScratchReaderPin<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

impl ScratchWindow {
    fn new(capacity: usize) -> Self {
        Self {
            samples: UnsafeCell::new(vec![[0.0; 2]; capacity].into_boxed_slice()),
            start_frame: AtomicI64::new(0),
            len: AtomicUsize::new(0),
            readers: AtomicU32::new(0),
        }
    }
}

/// Double-buffered, source-indexed PCM around a streaming Deck's platter needle.
///
/// The decode worker is the only writer. It writes the inactive buffer, publishes its metadata,
/// then swaps one atomic index. A callback reader pins the observed active buffer and rechecks the
/// index before touching samples; after a swap the worker waits for old readers before recycling
/// that buffer. This provides random reverse access without a mutex or an Arc operation in the
/// realtime frame loop.
pub struct ScratchPcmCache {
    sample_rate: u32,
    capacity: usize,
    windows: [ScratchWindow; 2],
    active: AtomicU8,
    requested_start: AtomicI64,
    requested_frames: AtomicUsize,
    request_generation: AtomicU64,
    published_generation: AtomicU64,
    failed_generation: AtomicU64,
    urgent: AtomicBool,
    request_count: AtomicU64,
    miss_count: AtomicU64,
    load_count: AtomicU64,
    failure_count: AtomicU64,
    /// Sequential transport-decoder PCM for visualization. It is never read by the audio
    /// callback and therefore stays outside the lock-free scratch double buffer above.
    observed_mono: RwLock<Option<ScratchMonoWindow>>,
}

// SAFETY: ScratchWindow samples follow the double-buffer reader protocol documented above. There
// is exactly one decode worker for a cache, while any callback access is read-only and pinned.
unsafe impl Send for ScratchPcmCache {}
unsafe impl Sync for ScratchPcmCache {}

impl std::fmt::Debug for ScratchPcmCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScratchPcmCache")
            .field("sample_rate", &self.sample_rate)
            .field("capacity", &self.capacity)
            .field("available", &self.available_range())
            .field("request_count", &self.request_count())
            .field("miss_count", &self.miss_count())
            .finish()
    }
}

impl ScratchPcmCache {
    pub fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(1);
        let capacity = (sample_rate as usize * SCRATCH_CACHE_WINDOW_SECONDS)
            .min(SCRATCH_CACHE_MAX_FRAMES)
            .max(4);
        Self {
            sample_rate,
            capacity,
            windows: [ScratchWindow::new(capacity), ScratchWindow::new(capacity)],
            active: AtomicU8::new(ACTIVE_NONE),
            requested_start: AtomicI64::new(REQUEST_NONE),
            requested_frames: AtomicUsize::new(capacity),
            request_generation: AtomicU64::new(0),
            published_generation: AtomicU64::new(0),
            failed_generation: AtomicU64::new(0),
            urgent: AtomicBool::new(false),
            request_count: AtomicU64::new(0),
            miss_count: AtomicU64::new(0),
            load_count: AtomicU64::new(0),
            failure_count: AtomicU64::new(0),
            observed_mono: RwLock::new(None),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn capacity_frames(&self) -> usize {
        self.capacity
    }

    pub fn request_count(&self) -> u64 {
        self.request_count.load(Ordering::Acquire)
    }

    pub fn miss_count(&self) -> u64 {
        self.miss_count.load(Ordering::Acquire)
    }

    pub fn load_count(&self) -> u64 {
        self.load_count.load(Ordering::Acquire)
    }

    pub fn failure_count(&self) -> u64 {
        self.failure_count.load(Ordering::Acquire)
    }

    pub fn urgent(&self) -> bool {
        self.urgent.load(Ordering::Acquire)
    }

    /// Whether an in-flight decoder still owns the newest requested landing.
    ///
    /// Remote Range reads can take much longer than a user takes to issue another seek. Workers
    /// poll this at packet boundaries so obsolete windows never block the final landing.
    pub fn request_is_current(&self, generation: u64) -> bool {
        generation != 0 && generation == self.request_generation.load(Ordering::Acquire)
    }

    pub fn request_prefetch(&self, position_frames: f64) {
        self.request_position(position_frames, 0.0, false);
    }

    /// Request a centred 12-second window around a visual playhead.
    ///
    /// The right-side Manager rail shows only six seconds, so keeping roughly six seconds on
    /// either side lets it reuse one decoded window for several seconds instead of
    /// seeking and decoding on every 30 Hz clock event.
    pub fn request_viewport(&self, position_frames: f64) {
        self.request_position(position_frames, 0.0, false);
    }

    /// Request only the bounded PCM interval needed by the visible Manager waveform.
    ///
    /// Platter motion keeps the full twelve-second cache, but an online first paint should not
    /// download and decode twelve seconds merely to own an 8.5-second viewport. A small leading
    /// quantum and trailing guard absorb compressed packet/seek boundaries while keeping the
    /// generation materially shorter. Marking it urgent also skips the worker's startup grace.
    pub fn request_waveform(&self, required_start_frame: i64, required_end_frame: i64) {
        if required_end_frame <= required_start_frame {
            return;
        }
        let rate = i64::from(self.sample_rate);
        let quantum = (rate / 4).max(1);
        let start = required_start_frame.max(0) / quantum * quantum;
        let guard = (rate / 4).max(1);
        let frames = required_end_frame
            .saturating_sub(start)
            .saturating_add(guard)
            .clamp(1, self.capacity as i64) as usize;
        self.request_start(start, frames, true);
    }

    pub fn request_touch(&self, position_frames: f64) {
        let position = position_frames.floor() as i64;
        if self
            .available_range()
            .is_some_and(|(start, end)| position >= start && position + 2 < end)
        {
            return;
        }
        self.request_position(position_frames, 0.0, false);
        self.urgent.store(true, Ordering::Release);
    }

    fn desired_start(&self, position_frames: f64, velocity: f64) -> i64 {
        let position = if position_frames.is_finite() {
            position_frames.floor().max(0.0) as i64
        } else {
            0
        };
        let rate = i64::from(self.sample_rate);
        let capacity = self.capacity as i64;
        let look_behind = if velocity < -0.01 {
            capacity * 3 / 4
        } else if velocity > 0.01 {
            capacity / 4
        } else {
            capacity / 2
        };
        let raw = position.saturating_sub(look_behind).max(0);
        let quantum = rate.min((capacity / 4).max(1)).max(1);
        raw / quantum * quantum
    }

    fn request_position(&self, position_frames: f64, velocity: f64, urgent: bool) {
        let requested = self.desired_start(position_frames, velocity);
        self.request_start(requested, self.capacity, urgent);
    }

    fn request_start(&self, requested: i64, frames: usize, urgent: bool) {
        let frames = frames.clamp(1, self.capacity);
        let observed = self.requested_start.load(Ordering::Acquire);
        let observed_frames = self.requested_frames.load(Ordering::Acquire);
        let generation = self.request_generation.load(Ordering::Acquire);
        let same_request = observed == requested && observed_frames == frames;
        let retry = same_request
            && generation != 0
            && self.failed_generation.load(Ordering::Acquire) == generation;
        if !same_request || retry {
            self.requested_start.store(requested, Ordering::Release);
            self.requested_frames.store(frames, Ordering::Release);
            self.request_generation.fetch_add(1, Ordering::AcqRel);
            self.failed_generation.store(0, Ordering::Release);
            self.request_count.fetch_add(1, Ordering::Relaxed);
        }
        if urgent && !self.urgent.swap(true, Ordering::AcqRel) {
            self.miss_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn next_request(&self, seen_generation: &mut u64) -> Option<(u64, i64, usize)> {
        let generation = self.request_generation.load(Ordering::Acquire);
        if generation == *seen_generation {
            return None;
        }
        let start = self.requested_start.load(Ordering::Acquire);
        let frames = self.requested_frames.load(Ordering::Acquire);
        if start == REQUEST_NONE {
            return None;
        }
        *seen_generation = generation;
        Some((generation, start.max(0), frames.clamp(1, self.capacity)))
    }

    pub fn publish(&self, generation: u64, decoded: &DecodedScratchWindow) -> bool {
        if decoded.frames.is_empty()
            || generation != self.request_generation.load(Ordering::Acquire)
        {
            return false;
        }
        let active = self.active.load(Ordering::Acquire);
        let target = if active == 0 { 1 } else { 0 };
        let window = &self.windows[target];
        while window.readers.load(Ordering::Acquire) != 0 {
            thread::sleep(Duration::from_micros(50));
        }
        let len = decoded.frames.len().min(self.capacity);
        // SAFETY: target is inactive and has no pinned readers. Only this single worker writes it.
        let samples = unsafe { &mut *window.samples.get() };
        samples[..len].copy_from_slice(&decoded.frames[..len]);
        window
            .start_frame
            .store(decoded.start_frame.max(0), Ordering::Relaxed);
        window.len.store(len, Ordering::Release);
        if generation != self.request_generation.load(Ordering::Acquire) {
            return false;
        }
        self.active.store(target as u8, Ordering::Release);
        self.published_generation
            .store(generation, Ordering::Release);
        self.urgent.store(false, Ordering::Release);
        self.failed_generation.store(0, Ordering::Release);
        self.load_count.fetch_add(1, Ordering::Relaxed);
        true
    }

    pub fn record_failure(&self, generation: u64) {
        if generation == self.request_generation.load(Ordering::Acquire) {
            self.failure_count.fetch_add(1, Ordering::Relaxed);
            self.failed_generation.store(generation, Ordering::Release);
            self.urgent.store(false, Ordering::Release);
        }
    }

    pub fn available_range(&self) -> Option<(i64, i64)> {
        self.with_active(|window, start, len| {
            let _ = window;
            (start, start.saturating_add(len as i64))
        })
    }

    /// Source-frame interval already assigned to the single random-access decoder.
    ///
    /// A Manager waveform miss is polled while its first MP3 seek is still running. Treating an
    /// unpublished request as "nothing pending" moves that request roughly once per second as
    /// the playhead advances; every move invalidates the decoder generation, so a slow seek can
    /// chase playback indefinitely and never publish pixels. Callers use this range to wait for
    /// the existing generation when it already covers their viewport. Failed generations are
    /// deliberately hidden so the normal request path can retry them.
    pub fn pending_request_range(&self) -> Option<(i64, i64)> {
        let generation = self.request_generation.load(Ordering::Acquire);
        if generation == 0
            || self.published_generation.load(Ordering::Acquire) == generation
            || self.failed_generation.load(Ordering::Acquire) == generation
        {
            return None;
        }
        let start = self.requested_start.load(Ordering::Acquire);
        let frames = self.requested_frames.load(Ordering::Acquire);
        (start != REQUEST_NONE).then(|| {
            let start = start.max(0);
            (start, start.saturating_add(frames as i64))
        })
    }

    /// Publish a rolling mono window observed by the *existing* transport decoder.
    ///
    /// Remote Manager waveforms prefer this lane for the forward/playback side of the viewport;
    /// the random-access worker only backfills history that this decoder cannot grow. The caller
    /// batches at source-time intervals; no per-frame lock is taken here or in the decoder hot loop.
    pub fn publish_observed_mono(&self, start_frame: i64, samples: Vec<f32>) {
        if samples.is_empty() {
            return;
        }
        let (start_frame, samples) = if samples.len() > self.capacity {
            let skipped = samples.len() - self.capacity;
            (
                start_frame.saturating_add(skipped as i64),
                samples[skipped..].to_vec(),
            )
        } else {
            (start_frame.max(0), samples)
        };
        if let Ok(mut observed) = self.observed_mono.write() {
            *observed = Some(ScratchMonoWindow {
                start_frame,
                samples: samples.into(),
            });
        }
    }

    pub fn observed_range(&self) -> Option<(i64, i64)> {
        let observed = self.observed_mono.read().ok()?;
        let window = observed.as_ref()?;
        Some((
            window.start_frame,
            window
                .start_frame
                .saturating_add(window.samples.len() as i64),
        ))
    }

    /// Clone the complete immutable transport observation for control-side composition.
    pub fn observed_mono_window(&self) -> Option<ScratchMonoWindow> {
        self.observed_mono.read().ok()?.as_ref().cloned()
    }

    /// Clone one immutable Arc-backed decoder observation without copying its PCM payload.
    pub fn observed_mono_covering(
        &self,
        required_start_frame: i64,
        required_end_frame: i64,
    ) -> Option<ScratchMonoWindow> {
        if required_end_frame <= required_start_frame {
            return None;
        }
        let observed = self.observed_mono.read().ok()?;
        let window = observed.as_ref()?;
        let end = window
            .start_frame
            .saturating_add(window.samples.len() as i64);
        (required_start_frame >= window.start_frame && required_end_frame <= end)
            .then(|| window.clone())
    }

    /// Copy the active decoded window only when it fully covers the requested source range.
    ///
    /// The double-buffer pin makes this coherent with a concurrent decoder publication. This
    /// method is for a background visualization worker; unlike [`Self::sample`], it allocates and
    /// performs an O(window) copy and therefore must never be called by the audio callback.
    pub fn snapshot_mono_covering(
        &self,
        required_start_frame: i64,
        required_end_frame: i64,
    ) -> Option<ScratchMonoWindow> {
        if required_end_frame <= required_start_frame {
            return None;
        }
        self.with_active(|window, start, len| {
            let end = start.saturating_add(len as i64);
            if len == 0 || required_start_frame < start || required_end_frame > end {
                return None;
            }
            let samples: Arc<[f32]> = window
                .iter()
                .map(|frame| (frame[0] + frame[1]) * 0.5)
                .collect::<Vec<_>>()
                .into();
            Some(ScratchMonoWindow {
                start_frame: start,
                samples,
            })
        })
        .flatten()
    }

    /// Copy the complete active random-access window for control-side composition.
    pub fn snapshot_mono_window(&self) -> Option<ScratchMonoWindow> {
        self.with_active(|window, start, len| {
            if len == 0 {
                return None;
            }
            let samples: Arc<[f32]> = window
                .iter()
                .map(|frame| (frame[0] + frame[1]) * 0.5)
                .collect::<Vec<_>>()
                .into();
            Some(ScratchMonoWindow {
                start_frame: start,
                samples,
            })
        })
        .flatten()
    }

    pub fn sample(&self, position_frames: f64, velocity: f64) -> Option<[f32; 2]> {
        if !position_frames.is_finite() || position_frames < 0.0 {
            return None;
        }
        let observed = self.with_active(|window, start, len| {
            (
                sample_window(window, start, len, position_frames),
                (start, start.saturating_add(len as i64)),
            )
        });
        let result = observed.and_then(|(sample, _)| sample);
        let range = observed.map(|(_, range)| range);
        let margin = (i64::from(self.sample_rate) * 2).min((self.capacity as i64 / 6).max(1));
        let position = position_frames.floor() as i64;
        let nearing_edge = match range {
            Some((start, _)) if velocity < -0.01 => position - start < margin,
            Some((_, end)) if velocity > 0.01 => end - position < margin,
            Some(_) => false,
            None => true,
        };
        if result.is_none() || nearing_edge {
            self.request_position(position_frames, velocity, result.is_none());
        }
        result
    }

    fn with_active<R>(&self, operation: impl Fn(&[[f32; 2]], i64, usize) -> R) -> Option<R> {
        for _ in 0..2 {
            let active = self.active.load(Ordering::Acquire);
            if active > 1 {
                return None;
            }
            let window = &self.windows[active as usize];
            window.readers.fetch_add(1, Ordering::AcqRel);
            let pin = ScratchReaderPin(&window.readers);
            if self.active.load(Ordering::Acquire) != active {
                drop(pin);
                continue;
            }
            let start = window.start_frame.load(Ordering::Relaxed);
            let len = window.len.load(Ordering::Acquire).min(self.capacity);
            // SAFETY: this reader pins the active window. The worker cannot recycle it until the
            // reader count returns to zero, and never mutates the active window.
            let samples = unsafe { &*window.samples.get() };
            let value = operation(&samples[..len], start, len);
            drop(pin);
            return Some(value);
        }
        None
    }
}

fn sample_window(samples: &[[f32; 2]], start: i64, len: usize, position: f64) -> Option<[f32; 2]> {
    if len == 0 {
        return None;
    }
    let floor = position.floor() as i64;
    let local = floor.checked_sub(start)?;
    if local < 0 || local as usize >= len {
        return None;
    }
    let index = local as usize;
    let fraction = (position - floor as f64) as f32;
    if index >= 1 && index + 2 < len {
        return Some([
            hermite4(
                fraction,
                samples[index - 1][0],
                samples[index][0],
                samples[index + 1][0],
                samples[index + 2][0],
            ),
            hermite4(
                fraction,
                samples[index - 1][1],
                samples[index][1],
                samples[index + 1][1],
                samples[index + 2][1],
            ),
        ]);
    }
    let a = samples[index];
    let b = samples.get(index + 1).copied().unwrap_or(a);
    Some([
        a[0] + (b[0] - a[0]) * fraction,
        a[1] + (b[1] - a[1]) * fraction,
    ])
}

fn hermite4(fraction: f32, before: f32, current: f32, next: f32, after: f32) -> f32 {
    let tangent = (next - before) * 0.5;
    let delta = current - next;
    let sum = tangent + delta;
    let a = sum + delta + (after - current) * 0.5;
    let b = sum + a;
    (((a * fraction - b) * fraction + tangent) * fraction) + current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(start: i64, frames: usize) -> DecodedScratchWindow {
        DecodedScratchWindow {
            start_frame: start,
            frames: (0..frames)
                .map(|offset| {
                    let value = (start + offset as i64) as f32;
                    [value, -value]
                })
                .collect(),
        }
    }

    #[test]
    fn publishes_and_interpolates_an_absolute_source_window() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(700.0);
        let mut seen = 0;
        let (generation, start, frames) = cache.next_request(&mut seen).unwrap();
        assert_eq!(start, 100);
        assert_eq!(frames, 1_200);
        assert!(cache.publish(generation, &window(100, 1_200)));
        let sample = cache.sample(321.5, -1.0).unwrap();
        assert!((sample[0] - 321.5).abs() < 1e-3);
        assert!((sample[1] + 321.5).abs() < 1e-3);
    }

    #[test]
    fn high_sample_rate_devices_keep_the_same_hard_memory_budget() {
        let cache = ScratchPcmCache::new(192_000);
        assert_eq!(cache.capacity_frames(), SCRATCH_CACHE_MAX_FRAMES);
    }

    #[test]
    fn sequential_decoder_observation_is_arc_backed_and_range_checked() {
        let cache = ScratchPcmCache::new(100);
        cache.publish_observed_mono(250, (0..500).map(|value| value as f32).collect());
        assert_eq!(cache.observed_range(), Some((250, 750)));
        assert!(cache.observed_mono_covering(249, 300).is_none());
        let first = cache.observed_mono_covering(300, 700).unwrap();
        let second = cache.observed_mono_covering(350, 650).unwrap();
        assert!(Arc::ptr_eq(&first.samples, &second.samples));
        assert_eq!(first.samples[0], 0.0);
        assert_eq!(first.samples[499], 499.0);
        // The transport observer is a separate lane; it cannot become platter authority.
        assert_eq!(cache.available_range(), None);
    }

    #[test]
    fn reverse_edge_requests_an_overlapping_lookbehind_without_hard_stopping() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(1_000.0);
        let mut seen = 0;
        let (generation, _, _) = cache.next_request(&mut seen).unwrap();
        assert!(cache.publish(generation, &window(400, 1_200)));
        assert!(cache.sample(450.0, -1.0).is_some());
        let (_, requested, _) = cache.next_request(&mut seen).unwrap();
        assert_eq!(requested, 0);
    }

    #[test]
    fn stale_decode_result_never_replaces_a_newer_request() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(700.0);
        let mut seen = 0;
        let (old_generation, _, _) = cache.next_request(&mut seen).unwrap();
        assert!(cache.request_is_current(old_generation));
        assert!(cache.sample(2_000.0, -1.0).is_none());
        assert!(!cache.request_is_current(old_generation));
        assert!(!cache.publish(old_generation, &window(100, 1_200)));
        assert_eq!(cache.load_count(), 0);
    }

    #[test]
    fn failed_window_can_be_requested_again_without_a_permanent_frozen_cursor() {
        let cache = ScratchPcmCache::new(100);
        cache.request_touch(700.0);
        let mut seen = 0;
        let (failed_generation, _, _) = cache.next_request(&mut seen).unwrap();
        cache.record_failure(failed_generation);
        assert!(cache.sample(700.0, 0.0).is_none());
        let (retry_generation, _, _) = cache.next_request(&mut seen).unwrap();
        assert!(retry_generation > failed_generation);
    }

    #[test]
    fn viewport_request_centres_a_reusable_six_second_view() {
        let cache = ScratchPcmCache::new(100);
        cache.request_viewport(1_000.0);
        let mut seen = 0;
        let (generation, start, frames) = cache.next_request(&mut seen).unwrap();
        assert_eq!(start, 400, "12s cache should keep 6s around the playhead");
        assert_eq!(frames, 1_200);
        assert_eq!(cache.pending_request_range(), Some((400, 1_600)));
        assert!(cache.publish(generation, &window(start, 1_200)));
        assert_eq!(cache.pending_request_range(), None);
    }

    #[test]
    fn visible_waveform_requests_only_its_bounded_interval_and_wakes_the_worker() {
        let cache = ScratchPcmCache::new(100);
        cache.request_waveform(575, 1_425);
        let mut seen = 0;
        let (generation, start, frames) = cache.next_request(&mut seen).unwrap();
        assert_eq!(
            start, 575,
            "quarter-second lattice keeps this exact boundary"
        );
        assert_eq!(frames, 875, "8.5s view plus a 250ms packet guard");
        assert!(frames < cache.capacity_frames());
        assert!(cache.urgent());
        assert_eq!(cache.pending_request_range(), Some((575, 1_450)));
        assert!(cache.publish(generation, &window(start, frames)));
        assert!(!cache.urgent());
    }

    #[test]
    fn pending_viewport_range_prevents_polling_from_retargeting_its_decoder() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(1_000.0);
        let mut seen = 0;
        let (generation, start, _) = cache.next_request(&mut seen).unwrap();
        let requested = cache.pending_request_range().unwrap();
        assert_eq!(requested, (start, start + 1_200));
        assert!(700 >= requested.0 && 1_300 <= requested.1);

        // A UI poll for the same six-second viewport must wait for this generation instead of
        // moving it to a future-biased range and throwing the already-running MP3 seek away.
        assert_eq!(cache.request_count(), 1);
        assert!(cache.next_request(&mut seen).is_none());
        assert_eq!(cache.request_count(), 1);

        cache.record_failure(generation);
        assert_eq!(
            cache.pending_request_range(),
            None,
            "a failed seek remains retryable"
        );
    }

    #[test]
    fn mono_snapshot_requires_complete_coverage_and_keeps_absolute_origin() {
        let cache = ScratchPcmCache::new(100);
        cache.request_viewport(1_000.0);
        let mut seen = 0;
        let (generation, start, _) = cache.next_request(&mut seen).unwrap();
        let decoded = DecodedScratchWindow {
            start_frame: start,
            frames: (0..1_200)
                .map(|offset| {
                    let value = offset as f32 / 100.0;
                    [value, value * 0.5]
                })
                .collect(),
        };
        assert!(cache.publish(generation, &decoded));

        assert!(cache
            .snapshot_mono_covering(start - 1, start + 10)
            .is_none());
        let snapshot = cache
            .snapshot_mono_covering(start + 10, start + 900)
            .expect("covered view");
        assert_eq!(snapshot.start_frame, start);
        assert_eq!(snapshot.samples.len(), 1_200);
        assert!((snapshot.samples[100] - 0.75).abs() < 1e-6);
    }
}
