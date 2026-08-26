//! Process-wide admission and state middleware for non-callback DJ work.
//!
//! Specialist owners keep their own execution context (ORT sessions stay on STEM workers,
//! Rubber Band stays on its Deck worker, and library analysis stays in `spawn_blocking`). This
//! module supplies the shared policy boundary: latest Deck tempo state, realtime activity, a
//! priority/fairness queue for heavy CPU/IO work, cooperative cancellation, and diagnostics.
//! Nothing in the hardware audio callback may wait on this scheduler.

use std::cmp::Ordering as CmpOrdering;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const CLASS_COUNT: usize = 8;
const WAIT_POLL: Duration = Duration::from_millis(20);

/// Process-wide output-ring pressure published by the playback coordinator. The hardware callback
/// never touches this scheduler; control/background workers use it only to avoid starting optional
/// work while an audible Deck has little rendered PCM left.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum AudioPressure {
    #[default]
    Normal = 0,
    Low = 1,
    Critical = 2,
}

/// Stable task classes shared by playback, STEM and server analysis. Lower `priority()` values
/// are admitted first; the enum order is also the diagnostics order.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkClass {
    TempoStretch,
    StemInstant,
    StemAudible,
    StemLookAhead,
    InteractiveWaveform,
    NowPlayingAnalysis,
    LibraryAnalysis,
    Maintenance,
}

impl WorkClass {
    pub const ALL: [Self; CLASS_COUNT] = [
        Self::TempoStretch,
        Self::StemInstant,
        Self::StemAudible,
        Self::StemLookAhead,
        Self::InteractiveWaveform,
        Self::NowPlayingAnalysis,
        Self::LibraryAnalysis,
        Self::Maintenance,
    ];

    const fn index(self) -> usize {
        self as usize
    }

    pub const fn priority(self) -> u8 {
        match self {
            Self::TempoStretch => 0,
            Self::StemInstant => 1,
            Self::StemAudible => 2,
            Self::StemLookAhead => 3,
            Self::InteractiveWaveform => 4,
            Self::NowPlayingAnalysis => 5,
            Self::LibraryAnalysis => 6,
            Self::Maintenance => 7,
        }
    }
}

/// One blocking admission request. A deadline bounds queue wait only; native work already running
/// remains non-preemptible and must expose its own cooperative checkpoints.
#[derive(Clone, Copy, Debug)]
pub struct WorkRequest {
    pub class: WorkClass,
    pub deadline: Option<Instant>,
}

impl WorkRequest {
    pub const fn new(class: WorkClass) -> Self {
        Self {
            class,
            deadline: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.deadline = Instant::now().checked_add(timeout);
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkAcquireError {
    Cancelled,
    DeadlineExceeded,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkClassSnapshot {
    pub class: WorkClass,
    pub active: usize,
    pub queued: usize,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoLaneSnapshot {
    pub rate: f32,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSchedulerSnapshot {
    pub heavy_limit: usize,
    pub heavy_in_use: usize,
    pub live_stem_decks: usize,
    pub audio_pressure: AudioPressure,
    pub classes: Vec<WorkClassSnapshot>,
    pub tempo: [TempoLaneSnapshot; 2],
}

/// Latest-value BPM/TEMPO lane. Every active and pending worker for one physical Deck shares the
/// same atomics, so SYNC overwrites obsolete targets instead of creating a command backlog.
#[derive(Clone, Debug)]
pub struct TempoLane {
    rate_bits: Arc<AtomicU32>,
    revision: Arc<AtomicU64>,
}

impl TempoLane {
    pub fn standalone(rate: f32) -> Self {
        let lane = Self {
            rate_bits: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            revision: Arc::new(AtomicU64::new(0)),
        };
        lane.set(rate);
        lane
    }

    pub fn set(&self, rate: f32) {
        let rate = if rate.is_finite() { rate } else { 1.0 };
        self.rate_bits.store(rate.to_bits(), Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
    }

    pub fn rate(&self) -> f32 {
        f32::from_bits(self.rate_bits.load(Ordering::Acquire))
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> TempoLaneSnapshot {
        TempoLaneSnapshot {
            rate: self.rate(),
            revision: self.revision(),
        }
    }
}

struct Pending {
    id: u64,
    class: WorkClass,
    sequence: u64,
    deadline: Option<Instant>,
}

struct SchedulerState {
    next_id: u64,
    heavy_limit: usize,
    heavy_in_use: usize,
    live_stem_decks: usize,
    audio_pressure: AudioPressure,
    active: [usize; CLASS_COUNT],
    queued: [usize; CLASS_COUNT],
    waiting: Vec<Pending>,
}

pub struct WorkScheduler {
    state: Mutex<SchedulerState>,
    wakeup: Condvar,
    tempo: [TempoLane; 2],
    live_stem_decks: AtomicUsize,
    audio_pressure: AtomicU8,
}

impl WorkScheduler {
    fn new(heavy_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SchedulerState {
                next_id: 1,
                heavy_limit: heavy_limit.max(1),
                heavy_in_use: 0,
                live_stem_decks: 0,
                audio_pressure: AudioPressure::Normal,
                active: [0; CLASS_COUNT],
                queued: [0; CLASS_COUNT],
                waiting: Vec::new(),
            }),
            wakeup: Condvar::new(),
            tempo: [TempoLane::standalone(1.0), TempoLane::standalone(1.0)],
            live_stem_decks: AtomicUsize::new(0),
            audio_pressure: AtomicU8::new(AudioPressure::Normal as u8),
        })
    }

    /// Publish the authoritative target for diagnostics/state policy. Worker generations keep
    /// separate Rubber Band controls so a shadow transition can render its future rate without
    /// changing the still-audible outgoing Deck before promotion.
    pub fn publish_deck_tempo(&self, deck: usize, rate: f32) {
        if let Some(lane) = self.tempo.get(deck) {
            lane.set(rate);
        }
    }

    /// Publish the exact number of live STEM Decks. This is pressure state for long background
    /// analysis only; the model dequeue path never treats a lease as queued inference work.
    pub fn set_live_stem_decks(&self, decks: usize) {
        self.live_stem_decks.store(decks, Ordering::Release);
        let mut state = self.state.lock().unwrap();
        state.live_stem_decks = decks;
        drop(state);
        self.wakeup.notify_all();
    }

    pub fn set_audio_pressure(&self, pressure: AudioPressure) {
        if self.audio_pressure.swap(pressure as u8, Ordering::AcqRel) == pressure as u8 {
            return;
        }
        self.state.lock().unwrap().audio_pressure = pressure;
        self.wakeup.notify_all();
    }

    pub fn audio_pressure(&self) -> AudioPressure {
        match self.audio_pressure.load(Ordering::Acquire) {
            2 => AudioPressure::Critical,
            1 => AudioPressure::Low,
            _ => AudioPressure::Normal,
        }
    }

    /// Dedicated owners such as the STEM inference pool do not pass through `acquire`; they use
    /// this non-blocking policy check before dequeuing optional work.
    pub fn allows(&self, class: WorkClass) -> bool {
        pressure_allows(self.audio_pressure(), class)
    }

    pub fn activity(self: &Arc<Self>, class: WorkClass) -> WorkActivityGuard {
        let mut state = self.state.lock().unwrap();
        state.active[class.index()] = state.active[class.index()].saturating_add(1);
        drop(state);
        self.wakeup.notify_all();
        WorkActivityGuard {
            scheduler: Arc::clone(self),
            class,
            heavy: false,
        }
    }

    pub fn queued(self: &Arc<Self>, class: WorkClass) -> QueuedWork {
        let mut state = self.state.lock().unwrap();
        state.queued[class.index()] = state.queued[class.index()].saturating_add(1);
        drop(state);
        self.wakeup.notify_all();
        QueuedWork {
            scheduler: Arc::clone(self),
            class,
            queued: true,
        }
    }

    /// Acquire one heavy-work slot according to class priority and realtime pressure. The caller
    /// owns execution and must poll `cancelled` inside long work if it supports finer checkpoints.
    pub fn acquire<F>(
        self: &Arc<Self>,
        request: WorkRequest,
        cancelled: F,
    ) -> Result<WorkActivityGuard, WorkAcquireError>
    where
        F: Fn() -> bool,
    {
        let mut state = self.state.lock().unwrap();
        let id = state.next_id;
        state.next_id = state.next_id.saturating_add(1);
        state.queued[request.class.index()] = state.queued[request.class.index()].saturating_add(1);
        state.waiting.push(Pending {
            id,
            class: request.class,
            sequence: id,
            deadline: request.deadline,
        });

        loop {
            if cancelled() {
                remove_waiter(&mut state, id, request.class);
                self.wakeup.notify_all();
                return Err(WorkAcquireError::Cancelled);
            }
            if request
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                remove_waiter(&mut state, id, request.class);
                self.wakeup.notify_all();
                return Err(WorkAcquireError::DeadlineExceeded);
            }
            if state.heavy_in_use < state.heavy_limit
                && policy_allows(&state, request.class)
                && is_next_waiter(&state, id)
            {
                remove_waiter(&mut state, id, request.class);
                state.heavy_in_use = state.heavy_in_use.saturating_add(1);
                state.active[request.class.index()] =
                    state.active[request.class.index()].saturating_add(1);
                tracing::debug!(
                    target: "kdj_work_scheduler",
                    class = ?request.class,
                    heavy_in_use = state.heavy_in_use,
                    heavy_limit = state.heavy_limit,
                    "DJ work admitted"
                );
                return Ok(WorkActivityGuard {
                    scheduler: Arc::clone(self),
                    class: request.class,
                    heavy: true,
                });
            }
            let wait = request
                .deadline
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .map(|remaining| remaining.min(WAIT_POLL))
                .unwrap_or(WAIT_POLL);
            (state, _) = self.wakeup.wait_timeout(state, wait).unwrap();
        }
    }

    pub fn snapshot(&self) -> WorkSchedulerSnapshot {
        let state = self.state.lock().unwrap();
        WorkSchedulerSnapshot {
            heavy_limit: state.heavy_limit,
            heavy_in_use: state.heavy_in_use,
            live_stem_decks: self.live_stem_decks.load(Ordering::Acquire),
            audio_pressure: self.audio_pressure(),
            classes: WorkClass::ALL
                .into_iter()
                .map(|class| WorkClassSnapshot {
                    class,
                    active: state.active[class.index()],
                    queued: state.queued[class.index()],
                })
                .collect(),
            tempo: [self.tempo[0].snapshot(), self.tempo[1].snapshot()],
        }
    }
}

fn policy_allows(state: &SchedulerState, class: WorkClass) -> bool {
    let active = |class: WorkClass| state.active[class.index()] > 0;
    let queued = |class: WorkClass| state.queued[class.index()] > 0;
    let immediate_model_pressure = active(WorkClass::StemInstant)
        || active(WorkClass::StemAudible)
        || queued(WorkClass::StemInstant)
        || queued(WorkClass::StemAudible);
    if !pressure_allows(state.audio_pressure, class) {
        return false;
    }
    match class {
        WorkClass::LibraryAnalysis | WorkClass::Maintenance => {
            state.live_stem_decks == 0
                && !active(WorkClass::TempoStretch)
                && !immediate_model_pressure
                && !active(WorkClass::InteractiveWaveform)
                && !active(WorkClass::NowPlayingAnalysis)
        }
        // The user is waiting for an interactive waveform, so it may use one bounded heavy slot
        // while playback continues. Now-playing BPM/key is less immediate and waits for the
        // current tempo transition/model deadline.
        WorkClass::InteractiveWaveform => !immediate_model_pressure,
        WorkClass::NowPlayingAnalysis => {
            !active(WorkClass::TempoStretch) && !immediate_model_pressure
        }
        _ => true,
    }
}

fn pressure_allows(pressure: AudioPressure, class: WorkClass) -> bool {
    match pressure {
        AudioPressure::Normal => true,
        AudioPressure::Low => !matches!(
            class,
            WorkClass::InteractiveWaveform
                | WorkClass::NowPlayingAnalysis
                | WorkClass::LibraryAnalysis
                | WorkClass::Maintenance
        ),
        AudioPressure::Critical => matches!(
            class,
            WorkClass::TempoStretch | WorkClass::StemInstant | WorkClass::StemAudible
        ),
    }
}

fn waiter_cmp(left: &Pending, right: &Pending) -> CmpOrdering {
    left.class
        .priority()
        .cmp(&right.class.priority())
        .then_with(|| match (left.deadline, right.deadline) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => CmpOrdering::Less,
            (None, Some(_)) => CmpOrdering::Greater,
            (None, None) => CmpOrdering::Equal,
        })
        .then_with(|| left.sequence.cmp(&right.sequence))
}

fn is_next_waiter(state: &SchedulerState, id: u64) -> bool {
    state
        .waiting
        .iter()
        .min_by(|left, right| waiter_cmp(left, right))
        .is_some_and(|waiter| waiter.id == id)
}

fn remove_waiter(state: &mut SchedulerState, id: u64, class: WorkClass) {
    if let Some(index) = state.waiting.iter().position(|waiter| waiter.id == id) {
        state.waiting.swap_remove(index);
    }
    state.queued[class.index()] = state.queued[class.index()].saturating_sub(1);
}

pub struct WorkActivityGuard {
    scheduler: Arc<WorkScheduler>,
    class: WorkClass,
    heavy: bool,
}

impl Drop for WorkActivityGuard {
    fn drop(&mut self) {
        let mut state = self.scheduler.state.lock().unwrap();
        state.active[self.class.index()] = state.active[self.class.index()].saturating_sub(1);
        if self.heavy {
            state.heavy_in_use = state.heavy_in_use.saturating_sub(1);
        }
        drop(state);
        self.scheduler.wakeup.notify_all();
    }
}

pub struct QueuedWork {
    scheduler: Arc<WorkScheduler>,
    class: WorkClass,
    queued: bool,
}

impl QueuedWork {
    pub fn start(mut self) -> WorkActivityGuard {
        let mut state = self.scheduler.state.lock().unwrap();
        state.queued[self.class.index()] = state.queued[self.class.index()].saturating_sub(1);
        state.active[self.class.index()] = state.active[self.class.index()].saturating_add(1);
        self.queued = false;
        drop(state);
        self.scheduler.wakeup.notify_all();
        WorkActivityGuard {
            scheduler: Arc::clone(&self.scheduler),
            class: self.class,
            heavy: false,
        }
    }
}

impl Drop for QueuedWork {
    fn drop(&mut self) {
        if !self.queued {
            return;
        }
        let mut state = self.scheduler.state.lock().unwrap();
        state.queued[self.class.index()] = state.queued[self.class.index()].saturating_sub(1);
        drop(state);
        self.scheduler.wakeup.notify_all();
    }
}

fn default_heavy_limit() -> usize {
    if cfg!(target_os = "windows") {
        1
    } else {
        2
    }
}

pub fn work_scheduler() -> &'static Arc<WorkScheduler> {
    static SCHEDULER: OnceLock<Arc<WorkScheduler>> = OnceLock::new();
    SCHEDULER.get_or_init(|| WorkScheduler::new(default_heavy_limit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // CI runners can be descheduled for well over 100 ms while six release jobs compile in
    // parallel. The scheduler itself polls every few milliseconds; keep a generous wall-clock
    // ceiling here so these tests assert bounded cancellation rather than runner availability.
    const BOUNDED_TEST_LATENCY: Duration = Duration::from_millis(500);

    #[test]
    fn queued_work_transitions_to_active_and_releases() {
        let scheduler = WorkScheduler::new(1);
        let queued = scheduler.queued(WorkClass::StemLookAhead);
        assert_eq!(
            scheduler.snapshot().classes[WorkClass::StemLookAhead.index()].queued,
            1
        );
        let active = queued.start();
        let snapshot = scheduler.snapshot();
        assert_eq!(snapshot.classes[WorkClass::StemLookAhead.index()].queued, 0);
        assert_eq!(snapshot.classes[WorkClass::StemLookAhead.index()].active, 1);
        drop(active);
        assert_eq!(
            scheduler.snapshot().classes[WorkClass::StemLookAhead.index()].active,
            0
        );
    }

    #[test]
    fn tempo_activity_blocks_background_but_cancellation_is_bounded() {
        let scheduler = WorkScheduler::new(1);
        let _tempo = scheduler.activity(WorkClass::TempoStretch);
        let started = Instant::now();
        let result = scheduler.acquire(WorkRequest::new(WorkClass::LibraryAnalysis), || {
            started.elapsed() >= Duration::from_millis(15)
        });
        assert!(matches!(result, Err(WorkAcquireError::Cancelled)));
        assert!(started.elapsed() < BOUNDED_TEST_LATENCY);
    }

    #[test]
    fn low_audio_buffer_blocks_optional_work_but_keeps_audible_work_available() {
        let scheduler = WorkScheduler::new(2);
        scheduler.set_audio_pressure(AudioPressure::Low);
        assert!(!scheduler.allows(WorkClass::InteractiveWaveform));
        assert!(scheduler.allows(WorkClass::StemAudible));

        let result = scheduler.acquire(
            WorkRequest::new(WorkClass::InteractiveWaveform).with_timeout(Duration::from_millis(5)),
            || false,
        );
        assert!(matches!(result, Err(WorkAcquireError::DeadlineExceeded)));
        scheduler.set_audio_pressure(AudioPressure::Normal);
        assert!(scheduler
            .acquire(WorkRequest::new(WorkClass::InteractiveWaveform), || false)
            .is_ok());
    }

    #[test]
    fn critical_audio_buffer_defers_lookahead_but_not_current_audio() {
        let scheduler = WorkScheduler::new(1);
        scheduler.set_audio_pressure(AudioPressure::Critical);
        assert!(!scheduler.allows(WorkClass::StemLookAhead));
        assert!(scheduler.allows(WorkClass::TempoStretch));
        assert!(scheduler.allows(WorkClass::StemAudible));
    }

    #[test]
    fn deck_tempo_snapshot_is_latest_value_state() {
        let scheduler = WorkScheduler::new(1);
        scheduler.publish_deck_tempo(0, 1.25);
        scheduler.publish_deck_tempo(0, 0.9);
        let tempo = scheduler.snapshot().tempo[0];
        assert!((tempo.rate - 0.9).abs() < f32::EPSILON);
        assert!(tempo.revision >= 3);
    }

    #[test]
    fn heavy_budget_caps_concurrency_across_independent_callers() {
        let scheduler = WorkScheduler::new(2);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles = (0..6)
            .map(|_| {
                let scheduler = Arc::clone(&scheduler);
                let running = Arc::clone(&running);
                let peak = Arc::clone(&peak);
                std::thread::spawn(move || {
                    let _permit = scheduler
                        .acquire(WorkRequest::new(WorkClass::LibraryAnalysis), || false)
                        .unwrap();
                    let active = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(active, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(5));
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(scheduler.snapshot().heavy_in_use, 0);
    }

    #[test]
    fn deadline_bounds_a_policy_blocked_request() {
        let scheduler = WorkScheduler::new(1);
        scheduler.set_live_stem_decks(1);
        let started = Instant::now();
        let result = scheduler.acquire(
            WorkRequest::new(WorkClass::Maintenance).with_timeout(Duration::from_millis(15)),
            || false,
        );
        assert!(matches!(result, Err(WorkAcquireError::DeadlineExceeded)));
        assert!(started.elapsed() < BOUNDED_TEST_LATENCY);
    }
}
