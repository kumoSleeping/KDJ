use std::cell::UnsafeCell;
use std::sync::atomic::{
    AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering,
};
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
    request_generation: AtomicU64,
    failed_generation: AtomicU64,
    urgent: AtomicBool,
    request_count: AtomicU64,
    miss_count: AtomicU64,
    load_count: AtomicU64,
    failure_count: AtomicU64,
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
            request_generation: AtomicU64::new(0),
            failed_generation: AtomicU64::new(0),
            urgent: AtomicBool::new(false),
            request_count: AtomicU64::new(0),
            miss_count: AtomicU64::new(0),
            load_count: AtomicU64::new(0),
            failure_count: AtomicU64::new(0),
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

    pub fn request_prefetch(&self, position_frames: f64) {
        self.request_position(position_frames, 0.0, false);
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
        let observed = self.requested_start.load(Ordering::Acquire);
        let generation = self.request_generation.load(Ordering::Acquire);
        let retry = observed == requested
            && generation != 0
            && self.failed_generation.load(Ordering::Acquire) == generation;
        let previous = if observed == requested {
            observed
        } else {
            self.requested_start.swap(requested, Ordering::AcqRel)
        };
        if previous != requested || retry {
            self.request_generation.fetch_add(1, Ordering::AcqRel);
            self.failed_generation.store(0, Ordering::Release);
            self.request_count.fetch_add(1, Ordering::Relaxed);
        }
        if urgent && !self.urgent.swap(true, Ordering::AcqRel) {
            self.miss_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn next_request(&self, seen_generation: &mut u64) -> Option<(u64, i64)> {
        let generation = self.request_generation.load(Ordering::Acquire);
        if generation == *seen_generation {
            return None;
        }
        let start = self.requested_start.load(Ordering::Acquire);
        if start == REQUEST_NONE {
            return None;
        }
        *seen_generation = generation;
        Some((generation, start.max(0)))
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
        let (generation, start) = cache.next_request(&mut seen).unwrap();
        assert_eq!(start, 100);
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
    fn reverse_edge_requests_an_overlapping_lookbehind_without_hard_stopping() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(1_000.0);
        let mut seen = 0;
        let (generation, _) = cache.next_request(&mut seen).unwrap();
        assert!(cache.publish(generation, &window(400, 1_200)));
        assert!(cache.sample(450.0, -1.0).is_some());
        let (_, requested) = cache.next_request(&mut seen).unwrap();
        assert_eq!(requested, 0);
    }

    #[test]
    fn stale_decode_result_never_replaces_a_newer_request() {
        let cache = ScratchPcmCache::new(100);
        cache.request_prefetch(700.0);
        let mut seen = 0;
        let (old_generation, _) = cache.next_request(&mut seen).unwrap();
        assert!(cache.sample(2_000.0, -1.0).is_none());
        assert!(!cache.publish(old_generation, &window(100, 1_200)));
        assert_eq!(cache.load_count(), 0);
    }

    #[test]
    fn failed_window_can_be_requested_again_without_a_permanent_frozen_cursor() {
        let cache = ScratchPcmCache::new(100);
        cache.request_touch(700.0);
        let mut seen = 0;
        let (failed_generation, _) = cache.next_request(&mut seen).unwrap();
        cache.record_failure(failed_generation);
        assert!(cache.sample(700.0, 0.0).is_none());
        let (retry_generation, _) = cache.next_request(&mut seen).unwrap();
        assert!(retry_generation > failed_generation);
    }
}
