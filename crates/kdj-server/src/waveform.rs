//! 交互波形：缓存读写 + 单飞计算 + 给分析让路。
//!
//! 波形是用户盯着看的交互路径；后台分析不能把它堵在 `spawn_blocking`
//! 队列里几十秒。这里：
//! - 同 `(track_id, buckets, mtime)` 只解一次，PlayerBar / 详情栏共享结果；
//! - 开算之前先占住分析闸门，逼正在跑的分析在歌与歌之间让开。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use kdj_analysis::waveform::{
    analyze_waveform_evidence, analyze_waveform_evidence_cancellable,
    analyze_waveform_evidence_preview_burst_cancellable, band_waveform_and_texture_with_evidence,
    detail_waveform_buckets, release_overview_waveform_with_detail_texture,
    release_overview_waveform_with_evidence, release_overview_waveform_with_evidence_cancellable,
    WaveformColourTexture, WaveformEvidence, WAVEFORM_EVIDENCE_SR,
};
use kdj_core::models::Waveform;
use kdj_core::work_scheduler::{AudioPressure, WorkAcquireError, WorkClass};

pub const MAX_WAVEFORM_BUCKETS: usize = kdj_analysis::waveform::MAX_WAVEFORM_BUCKETS;
use kdj_library::LibraryService;
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::jobs;

/// 当前详细波形的快速首帧档位；整曲 release overview 单独使用更细的原生资产。
pub const DEFAULT_WAVEFORM_BUCKETS: usize = 640;
pub const RELEASE_OVERVIEW_BUCKETS: usize = 4_096;
pub const CURRENT_WAVEFORM_PROFILE: &str = "kdwave-current-detail";
pub const CURRENT_WAVEFORM_REVISION: i64 = 9;
pub const CANONICAL_WAVEFORM_PROFILE: &str = "kdwave-v0241-overview-640";
pub const CANONICAL_WAVEFORM_REVISION: i64 = 9;
pub const WAVEFORM_BINARY_MIME: &str = "application/vnd.kdj.waveform";
const CACHE_MAGIC: &[u8; 8] = b"KDJWAVE\0";
const CACHE_VERSION: u16 = 2;
const CACHE_HEADER_LEN: usize = 8 + 2 + 8 + 8 + 4;
const WIRE_MAGIC: &[u8; 8] = b"KDJWVFM\0";
const WIRE_VERSION: u16 = 2;
const WIRE_HEADER_LEN: usize = 8 + 2 + 1 + 1 + 4 + 8 + 8 + 4;
const MAX_CACHE_COLUMNS: usize = 100_000;

/// HTTP 二进制波形自描述其算法 profile 与 revision；前端不再只能从 URL 猜数据语义。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaveformWireProfile {
    CurrentDetail,
    ReleaseOverview,
}

impl WaveformWireProfile {
    pub const fn code(self) -> u8 {
        match self {
            Self::CurrentDetail => 1,
            Self::ReleaseOverview => 2,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::CurrentDetail => CURRENT_WAVEFORM_PROFILE,
            Self::ReleaseOverview => CANONICAL_WAVEFORM_PROFILE,
        }
    }

    pub const fn revision(self) -> u32 {
        match self {
            Self::CurrentDetail => CURRENT_WAVEFORM_REVISION as u32,
            Self::ReleaseOverview => CANONICAL_WAVEFORM_REVISION as u32,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct WaveKey {
    track_id: i64,
    buckets: usize,
    mtime: u64,
}

/// Why a cold release overview was requested. Only the PlayerBar and predicted-next lanes are
/// latest-wins; independent library/detail previews are allowed to coexist.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReleaseOverviewIntent {
    #[default]
    Visible,
    Player,
    Prefetch,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum DecodeLane {
    Standard,
    Visible,
    Player(u64),
    Prefetch(u64),
}

/// One full-file decode is shared by every column count for the same audio identity.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct DecodeKey {
    track_id: i64,
    mtime: u64,
    profile: WaveformProfile,
    lane: DecodeLane,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct EvidenceKey {
    track_id: i64,
    mtime: u64,
}

const PREPARED_EVIDENCE_CAPACITY: usize = 4;

/// A visible release preview has already paid for the exact full-song semantic FFT needed by the
/// detail asset. Keep only those compact feature arrays for the next few songs; retaining decoded
/// PCM would cost tens of megabytes per track, while throwing the evidence away makes the
/// one-second-later detail warmup repeat the dominant CPU stage.
#[derive(Default)]
struct PreparedEvidenceCache {
    entries: VecDeque<(EvidenceKey, Arc<WaveformEvidence>)>,
}

impl PreparedEvidenceCache {
    fn get(&mut self, key: EvidenceKey) -> Option<Arc<WaveformEvidence>> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| *candidate == key)?;
        let entry = self.entries.remove(index)?;
        let evidence = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(evidence)
    }

    fn insert(&mut self, key: EvidenceKey, evidence: Arc<WaveformEvidence>) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|(candidate, _)| *candidate == key)
        {
            self.entries.remove(index);
        }
        self.entries.push_back((key, evidence));
        while self.entries.len() > PREPARED_EVIDENCE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

impl WaveKey {
    fn decode_key(self, profile: WaveformProfile, lane: DecodeLane) -> DecodeKey {
        DecodeKey {
            track_id: self.track_id,
            mtime: self.mtime,
            profile,
            lane,
        }
    }
}

/// 整曲预览和 DJ 滚动主波形必须是两份独立资产：前者精确恢复 v0.2.41，
/// 后者保留当前 native-rate 高密度算法。
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum WaveformProfile {
    CurrentDetail,
    ReleaseOverview,
}

/// Every cold request in this coordinator decodes and inspects the complete song, regardless of
/// whether its response has 640, 4,096 or 100,000 columns. Column count is not a useful cost
/// proxy: the shared spectral evidence pass is the expensive part. The exact PlayerBar preview
/// owns a distinct visible-work class so it can preempt an explicitly requested current-track
/// detail warmup. Ordinary full-track requests remain idle-only. Only the playback coordinator
/// may use `InteractiveWaveform`, because that path owns a bounded PCM window.
fn waveform_work_class(
    interactive: bool,
    profile: WaveformProfile,
    warm_detail_while_playing: bool,
    release_intent: ReleaseOverviewIntent,
) -> WorkClass {
    if interactive && profile == WaveformProfile::ReleaseOverview {
        if release_intent == ReleaseOverviewIntent::Player {
            WorkClass::VisibleWaveform
        } else {
            // Selected-track previews and predicted-next work remain visible eventually, but the
            // global current-song rail may cancel/preempt them through scheduler policy.
            WorkClass::LibraryAnalysisLight
        }
    } else if interactive && warm_detail_while_playing {
        // Speculative detail waits behind queued Manager/visible-preview/now-playing/tempo work.
        // Its decoder and FFT checkpoints abandon the optional asset as soon as one arrives.
        WorkClass::LibraryAnalysisLight
    } else {
        WorkClass::Maintenance
    }
}

const FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING: &str = "播放已开始，整曲波形生成已延后";
const FULL_TRACK_WAVEFORM_SUPERSEDED: &str = "波形请求已被更新的曲目取代";

fn waveform_should_yield_to_audio(live_audio_decks: usize) -> bool {
    live_audio_decks > 0
}

fn ensure_waveform_may_continue() -> Result<()> {
    if waveform_should_yield_to_audio(kdj_core::work_scheduler::work_scheduler().live_audio_decks())
    {
        anyhow::bail!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING);
    }
    Ok(())
}

fn realtime_waveform_should_cancel(pressure: AudioPressure, own_lane_allowed: bool) -> bool {
    pressure != AudioPressure::Normal || !own_lane_allowed
}

#[derive(Clone)]
struct ReleaseIntentToken {
    id: u64,
    cancellation: CancellationToken,
}

#[derive(Clone)]
struct ReleaseIntentSlot {
    request_id: u64,
    track_id: i64,
    token: ReleaseIntentToken,
}

#[derive(Default)]
struct ReleaseIntentState {
    next_token_id: u64,
    player: Option<ReleaseIntentSlot>,
    prefetch: Option<ReleaseIntentSlot>,
}

impl ReleaseIntentState {
    fn register(
        &mut self,
        track_id: i64,
        intent: ReleaseOverviewIntent,
        request_id: u64,
    ) -> ReleaseIntentToken {
        match intent {
            ReleaseOverviewIntent::Visible => ReleaseIntentToken {
                id: 0,
                cancellation: CancellationToken::new(),
            },
            ReleaseOverviewIntent::Player => register_latest_release_intent(
                &mut self.next_token_id,
                &mut self.player,
                track_id,
                request_id,
            ),
            ReleaseOverviewIntent::Prefetch => register_latest_release_intent(
                &mut self.next_token_id,
                &mut self.prefetch,
                track_id,
                request_id,
            ),
        }
    }
}

fn register_latest_release_intent(
    next_token_id: &mut u64,
    slot: &mut Option<ReleaseIntentSlot>,
    track_id: i64,
    request_id: u64,
) -> ReleaseIntentToken {
    if let Some(current) = slot.as_mut() {
        let ordered = request_id > 0 && current.request_id > 0;
        if ordered && request_id < current.request_id {
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            return ReleaseIntentToken {
                id: 0,
                cancellation,
            };
        }
        if current.track_id == track_id && !current.token.cancellation.is_cancelled() {
            current.request_id = current.request_id.max(request_id);
            return current.token.clone();
        }
        current.token.cancellation.cancel();
    }

    *next_token_id = next_token_id.saturating_add(1).max(1);
    let token = ReleaseIntentToken {
        id: *next_token_id,
        cancellation: CancellationToken::new(),
    };
    *slot = Some(ReleaseIntentSlot {
        request_id,
        track_id,
        token: token.clone(),
    });
    token
}

#[derive(Clone)]
enum WaveOutcome {
    Ok(Waveform),
    Err(String),
}

#[derive(Clone)]
struct WarmRequest {
    key: WaveKey,
    path: PathBuf,
    cache_dir: PathBuf,
}

#[derive(Default)]
struct WarmQueue {
    requests: VecDeque<WarmRequest>,
    /// 排队和正在计算的都留在这里，避免分析线程每首完成时重复塞同一个任务。
    active: HashSet<WaveKey>,
}

#[cfg(test)]
struct DecodeGateWaitGuard<'a>(&'a std::sync::atomic::AtomicUsize);

#[cfg(test)]
impl<'a> DecodeGateWaitGuard<'a> {
    fn new(waiters: &'a std::sync::atomic::AtomicUsize) -> Self {
        waiters.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(waiters)
    }
}

#[cfg(test)]
impl Drop for DecodeGateWaitGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 单飞 + 一条不会丢任务的波形预热队列。
///
/// 旧实现用全局 `BUSY`：上一首没算完，后续所有歌曲直接跳过，批量分析结束后
/// 大量歌曲仍要在播放时现场计算。这里固定一个 worker，忙时排队而不是丢弃。
pub struct WaveformCoordinator {
    inflight: Mutex<HashMap<DecodeKey, broadcast::Sender<WaveOutcome>>>,
    release_intents: Mutex<ReleaseIntentState>,
    prepared_evidence: Mutex<PreparedEvidenceCache>,
    /// A full-file decode scans the entire song. One is enough; parallel interactive
    /// requests starve the Tauri WebView and live Decks.
    interactive_detail_gate: Arc<Semaphore>,
    #[cfg(test)]
    decode_gate_waiters: std::sync::atomic::AtomicUsize,
    warm: Mutex<WarmQueue>,
    warm_ready: Condvar,
    library: Arc<LibraryService>,
}

impl WaveformCoordinator {
    pub fn new(library: Arc<LibraryService>) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            inflight: Default::default(),
            release_intents: Default::default(),
            prepared_evidence: Default::default(),
            interactive_detail_gate: Arc::new(Semaphore::new(1)),
            #[cfg(test)]
            decode_gate_waiters: std::sync::atomic::AtomicUsize::new(0),
            warm: Default::default(),
            warm_ready: Condvar::new(),
            library,
        });
        let worker = Arc::clone(&coordinator);
        let _ = std::thread::Builder::new()
            .name("waveform-worker".into())
            .spawn(move || {
                kdj_core::thread_qos::prefer_background();
                worker.warm_loop();
            });
        coordinator
    }

    fn register_release_overview_intent(
        &self,
        track_id: i64,
        intent: ReleaseOverviewIntent,
        request_id: u64,
    ) -> ReleaseIntentToken {
        self.release_intents
            .lock()
            .expect("release overview intent")
            .register(track_id, intent, request_id)
    }

    /// Advance a latest-wins lane even when WebView memory already has the requested waveform.
    pub fn note_release_overview_intent(
        &self,
        track_id: i64,
        intent: ReleaseOverviewIntent,
        request_id: u64,
    ) {
        if intent != ReleaseOverviewIntent::Visible {
            let _ = self.register_release_overview_intent(track_id, intent, request_id);
        }
    }

    /// 把固定高密度的旧版整曲预览放进单 worker 队列。`priority` 给已装入 Deck 的歌曲用；
    /// 普通批量分析走队尾。缓存已存在、已排队或正在算都不会重复提交。
    pub fn enqueue_default(
        &self,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
        priority: bool,
    ) {
        let mtime = file_mtime(&path);
        let key = WaveKey {
            track_id,
            buckets: RELEASE_OVERVIEW_BUCKETS,
            mtime,
        };
        if let Some((_, canonical)) = read_release_overview_cached(&cache_dir, key) {
            if canonical {
                self.record_status(key, None);
            }
            return;
        }
        let mut queue = self.warm.lock().expect("waveform warm queue");
        if !queue.active.insert(key) {
            return;
        }
        let request = WarmRequest {
            key,
            path,
            cache_dir,
        };
        if priority {
            queue.requests.push_front(request);
        } else {
            queue.requests.push_back(request);
        }
        self.warm_ready.notify_one();
    }

    fn warm_loop(&self) {
        loop {
            let request = {
                let mut queue = self.warm.lock().expect("waveform warm queue");
                while queue.requests.is_empty() {
                    queue = self.warm_ready.wait(queue).expect("waveform warm wait");
                }
                queue.requests.pop_front().expect("队列刚确认非空")
            };
            self.run_warm_request(&request);
            self.warm
                .lock()
                .expect("waveform warm queue")
                .active
                .remove(&request.key);
        }
    }

    fn run_warm_request(&self, request: &WarmRequest) {
        if let Some((_, canonical)) = read_release_overview_cached(&request.cache_dir, request.key)
        {
            if canonical {
                self.record_status(request.key, None);
            }
            return;
        }

        // 等后台额度时先不要占 inflight：播放器若在这时要同一首，可以直接成为
        // 交互 leader；拿到额度后再查一次缓存，就不会重复解码。
        let _permit = jobs::acquire_scheduled_work(WorkClass::Maintenance);
        if let Some((_, canonical)) = read_release_overview_cached(&request.cache_dir, request.key)
        {
            if canonical {
                self.record_status(request.key, None);
            }
            return;
        }

        // 真正开始后和交互请求共用 inflight 表，同一首歌只解一次。
        let decode_key = request
            .key
            .decode_key(WaveformProfile::ReleaseOverview, DecodeLane::Standard);
        let leader = {
            let mut map = self.inflight.lock().expect("waveform inflight");
            if map.contains_key(&decode_key) {
                false
            } else {
                let (tx, _rx) = broadcast::channel(1);
                map.insert(decode_key, tx);
                true
            }
        };
        if !leader {
            return;
        }

        let computed = compute_release_overview(&request.path, request.key.track_id);
        let outcome = match computed {
            Ok(overview) => {
                match write_release_overview(&request.cache_dir, request.key, &overview) {
                    Ok(()) => WaveOutcome::Ok(overview),
                    Err(err) => WaveOutcome::Err(format!("{err:#}")),
                }
            }
            Err(err) => WaveOutcome::Err(format!("{err:#}")),
        };
        if let WaveOutcome::Err(message) = &outcome {
            tracing::debug!("波形预热跳过 {}：{}", request.key.track_id, message);
            if message.contains(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING) {
                // Playback won the small admission-to-decode race. This is a normal deferral,
                // not a corrupt asset; a later idle/warm request may try again.
                publish(self, decode_key, outcome);
                return;
            }
        }
        self.record_outcome(request.key, &outcome);
        publish(self, decode_key, outcome);
    }

    /// 交互读取：缓存未命中时暂停后台分析接下一首，把 CPU 先让给播放器。
    pub async fn get_or_compute(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(
            track_id,
            path,
            buckets,
            cache_dir,
            true,
            false,
            WaveformProfile::CurrentDetail,
            false,
            ReleaseOverviewIntent::Visible,
            0,
        )
        .await
    }

    /// Opportunistically prepare the current local song's full 400 Hz detail asset.
    ///
    /// Unlike the ordinary interactive endpoint, this mode may run beside healthy playback in
    /// the single light-analysis lane. It remains background QoS and aborts before publishing if
    /// the output ring reports pressure; the frontend can quietly retry later.
    pub async fn warm_detail_while_playing(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(
            track_id,
            path,
            buckets,
            cache_dir,
            true,
            false,
            WaveformProfile::CurrentDetail,
            true,
            ReleaseOverviewIntent::Visible,
            0,
        )
        .await
    }

    /// 普通播放条与 DJ A/B overview 使用的 v0.2.41 整曲预览。
    pub async fn get_release_overview(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_release_overview_with_intent(
            track_id,
            path,
            cache_dir,
            ReleaseOverviewIntent::Player,
            0,
        )
        .await
    }

    pub async fn get_release_overview_with_intent(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
        intent: ReleaseOverviewIntent,
        request_id: u64,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(
            track_id,
            path,
            RELEASE_OVERVIEW_BUCKETS,
            cache_dir,
            true,
            true,
            WaveformProfile::ReleaseOverview,
            false,
            intent,
            request_id,
        )
        .await
    }

    /// 旧曲库补齐固定演奏波形。它仍然单飞，但不抢交互优先权、不暂停主分析。
    pub async fn prepare_default(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(
            track_id,
            path,
            RELEASE_OVERVIEW_BUCKETS,
            cache_dir,
            false,
            true,
            WaveformProfile::ReleaseOverview,
            false,
            ReleaseOverviewIntent::Visible,
            0,
        )
        .await
    }

    async fn get_or_compute_mode(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
        interactive: bool,
        record_status: bool,
        profile: WaveformProfile,
        warm_detail_while_playing: bool,
        release_intent: ReleaseOverviewIntent,
        request_id: u64,
    ) -> Result<Waveform> {
        let buckets = if profile == WaveformProfile::ReleaseOverview {
            RELEASE_OVERVIEW_BUCKETS
        } else {
            buckets.clamp(64, MAX_WAVEFORM_BUCKETS)
        };
        let mtime = file_mtime(&path);
        let key = WaveKey {
            track_id,
            buckets,
            mtime,
        };
        let request_token = if interactive && profile == WaveformProfile::ReleaseOverview {
            self.register_release_overview_intent(track_id, release_intent, request_id)
        } else {
            ReleaseIntentToken {
                id: 0,
                cancellation: CancellationToken::new(),
            }
        };
        if request_token.cancellation.is_cancelled() {
            anyhow::bail!(FULL_TRACK_WAVEFORM_SUPERSEDED);
        }
        if let Some(cached) = resolve_profile_from_cache(&cache_dir, key, profile) {
            if record_status {
                self.record_status(key, None);
            }
            return Ok(cached);
        }
        // An audible Deck may always read either existing asset above. A cold current-detail
        // request remains idle-only. The exact PlayerBar overview instead enters the cancellable
        // visible-waveform lane below, so continuous playback can eventually fill a blank rail
        // without ever substituting an approximate/detail asset.
        if interactive
            && profile != WaveformProfile::ReleaseOverview
            && !warm_detail_while_playing
            && waveform_should_yield_to_audio(
                kdj_core::work_scheduler::work_scheduler().live_audio_decks(),
            )
        {
            anyhow::bail!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING);
        }

        let work_class = waveform_work_class(
            interactive,
            profile,
            warm_detail_while_playing,
            release_intent,
        );
        let decode_lane = if profile != WaveformProfile::ReleaseOverview || !interactive {
            DecodeLane::Standard
        } else {
            match release_intent {
                ReleaseOverviewIntent::Visible => DecodeLane::Visible,
                ReleaseOverviewIntent::Player => DecodeLane::Player(request_token.id),
                ReleaseOverviewIntent::Prefetch => DecodeLane::Prefetch(request_token.id),
            }
        };
        let decode_key = key.decode_key(profile, decode_lane);
        let follower = {
            let mut map = self.inflight.lock().expect("waveform inflight");
            if let Some(tx) = map.get(&decode_key) {
                Some(tx.subscribe())
            } else {
                let (tx, _rx) = broadcast::channel(1);
                map.insert(decode_key, tx);
                None
            }
        };

        if let Some(mut rx) = follower {
            return match rx.recv().await.context("等待波形结果失败")? {
                WaveOutcome::Ok(wave) => Ok(fit_profile_waveform(wave, buckets, profile)),
                WaveOutcome::Err(msg) => Err(anyhow::anyhow!(msg)),
            };
        }

        // Admission comes before the decode gate. Maintenance may wait for every audible Deck to
        // become idle; it must not occupy the one-decode gate while waiting. The exact PlayerBar
        // overview may enter its visible lane only between higher-priority work items.
        let (work_permit, decode_permit) = loop {
            let admission_cancellation = request_token.cancellation.clone();
            let admission = tokio::task::spawn_blocking(move || {
                jobs::acquire_scheduled_work_cancellable(work_class, || {
                    admission_cancellation.is_cancelled()
                })
            })
            .await
            .context("波形准入任务被取消")?;
            let work_permit = match admission {
                Ok(permit) => permit,
                Err(WorkAcquireError::Cancelled) => {
                    let outcome = WaveOutcome::Err(FULL_TRACK_WAVEFORM_SUPERSEDED.into());
                    publish(self, decode_key, outcome);
                    anyhow::bail!(FULL_TRACK_WAVEFORM_SUPERSEDED);
                }
                Err(WorkAcquireError::DeadlineExceeded) => {
                    let outcome = WaveOutcome::Err("波形准入等待超时".into());
                    publish(self, decode_key, outcome);
                    anyhow::bail!("波形准入等待超时");
                }
            };
            let decode_permit = if interactive {
                #[cfg(test)]
                let _gate_wait = DecodeGateWaitGuard::new(&self.decode_gate_waiters);
                let gate_cancellation = request_token.cancellation.clone();
                loop {
                    let gate = Arc::clone(&self.interactive_detail_gate);
                    let cancellation_wait = gate_cancellation.clone();
                    tokio::select! {
                        permit = gate.acquire_owned() => {
                            break Some(permit.context("等待波形解码任务失败")?);
                        }
                        _ = cancellation_wait.cancelled() => {
                            drop(work_permit);
                            let outcome = WaveOutcome::Err(FULL_TRACK_WAVEFORM_SUPERSEDED.into());
                            publish(self, decode_key, outcome);
                            anyhow::bail!(FULL_TRACK_WAVEFORM_SUPERSEDED);
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(20)),
                            if matches!(work_class, WorkClass::VisibleWaveform | WorkClass::LibraryAnalysisLight) =>
                        {
                            let scheduler = kdj_core::work_scheduler::work_scheduler();
                            if realtime_waveform_should_cancel(
                                scheduler.audio_pressure(),
                                scheduler.allows(work_class),
                            ) {
                                drop(work_permit);
                                let outcome = WaveOutcome::Err(
                                    FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING.into(),
                                );
                                publish(self, decode_key, outcome);
                                anyhow::bail!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING);
                            }
                        }
                    }
                }
            } else {
                None
            };
            if work_class != WorkClass::Maintenance
                || kdj_core::work_scheduler::work_scheduler().live_audio_decks() == 0
            {
                break (work_permit, decode_permit);
            }
            drop(decode_permit);
            drop(work_permit);
        };
        let coord = Arc::clone(self);
        let compute_cancellation = request_token.cancellation.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            kdj_core::thread_qos::prefer_background();
            let _decode_permit = decode_permit;
            let _work = work_permit;
            if compute_cancellation.is_cancelled() {
                let outcome = WaveOutcome::Err(FULL_TRACK_WAVEFORM_SUPERSEDED.into());
                publish(&coord, decode_key, outcome.clone());
                return outcome;
            }
            if let Some(cached) = resolve_profile_from_cache(&cache_dir, key, profile) {
                let published = if profile == WaveformProfile::CurrentDetail {
                    detail_from_cache(&cache_dir, key.track_id, key.mtime).unwrap_or(cached)
                } else {
                    cached
                };
                let outcome = WaveOutcome::Ok(published);
                if record_status {
                    coord.record_outcome(
                        WaveKey {
                            track_id,
                            buckets,
                            mtime,
                        },
                        &outcome,
                    );
                }
                publish(&coord, decode_key, outcome.clone());
                return outcome;
            }
            let started = Instant::now();
            let prepared_evidence = (profile == WaveformProfile::CurrentDetail)
                .then(|| {
                    coord
                        .prepared_evidence
                        .lock()
                        .expect("prepared waveform evidence")
                        .get(EvidenceKey { track_id, mtime })
                })
                .flatten();
            let outcome = match compute_profile_waveforms(
                &path,
                track_id,
                mtime,
                &cache_dir,
                profile,
                interactive
                    && profile == WaveformProfile::CurrentDetail
                    && kdj_core::work_scheduler::work_scheduler().live_audio_decks() == 0,
                matches!(
                    work_class,
                    WorkClass::VisibleWaveform | WorkClass::LibraryAnalysisLight
                ),
                prepared_evidence,
                work_class,
                &compute_cancellation,
            ) {
                Ok((waveform, reusable_evidence)) => {
                    if interactive
                        && profile == WaveformProfile::ReleaseOverview
                        && !compute_cancellation.is_cancelled()
                    {
                        if let Some(evidence) = reusable_evidence {
                            coord
                                .prepared_evidence
                                .lock()
                                .expect("prepared waveform evidence")
                                .insert(EvidenceKey { track_id, mtime }, evidence);
                        }
                    }
                    WaveOutcome::Ok(waveform)
                }
                Err(_err) if compute_cancellation.is_cancelled() => {
                    WaveOutcome::Err(FULL_TRACK_WAVEFORM_SUPERSEDED.into())
                }
                Err(err) => WaveOutcome::Err(format!("{err:#}")),
            };
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            if matches!(&outcome, WaveOutcome::Ok(_)) {
                tracing::debug!(
                    track_id,
                    profile = match profile {
                        WaveformProfile::CurrentDetail => "current_detail",
                        WaveformProfile::ReleaseOverview => "release_overview",
                    },
                    elapsed_ms,
                    "整曲波形冷计算完成"
                );
            }
            if let WaveOutcome::Err(message) = &outcome {
                if message.contains(FULL_TRACK_WAVEFORM_SUPERSEDED) {
                    tracing::debug!(track_id, elapsed_ms, "过期整曲波形已取消");
                } else if message.contains(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING) {
                    tracing::debug!(track_id, elapsed_ms, "整曲波形让位于播放");
                } else {
                    tracing::warn!("波形生成失败 {track_id}：{message}");
                }
            }
            if record_status
                && !matches!(
                    &outcome,
                    WaveOutcome::Err(message)
                        if message.contains(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING)
                            || message.contains(FULL_TRACK_WAVEFORM_SUPERSEDED)
                )
            {
                coord.record_outcome(
                    WaveKey {
                        track_id,
                        buckets,
                        mtime,
                    },
                    &outcome,
                );
            }
            publish(&coord, decode_key, outcome.clone());
            outcome
        })
        .await
        .context("波形任务被取消")?;

        match outcome {
            WaveOutcome::Ok(wave) => Ok(fit_profile_waveform(wave, buckets, profile)),
            WaveOutcome::Err(msg) => Err(anyhow::anyhow!(msg)),
        }
    }

    fn record_outcome(&self, key: WaveKey, outcome: &WaveOutcome) {
        match outcome {
            WaveOutcome::Ok(_) => self.record_status(key, None),
            WaveOutcome::Err(message) => self.record_status(key, Some(message)),
        }
    }

    fn record_status(&self, key: WaveKey, error: Option<&str>) {
        if key.buckets != RELEASE_OVERVIEW_BUCKETS {
            return;
        }
        if let Err(err) = self.library.record_waveform_asset(
            key.track_id,
            CANONICAL_WAVEFORM_PROFILE,
            CANONICAL_WAVEFORM_REVISION,
            key.mtime,
            error,
        ) {
            tracing::warn!("记录波形就绪状态失败 {}：{err:#}", key.track_id);
        }
    }
}

fn publish(coord: &WaveformCoordinator, key: DecodeKey, outcome: WaveOutcome) {
    if let Some(tx) = coord
        .inflight
        .lock()
        .expect("waveform inflight")
        .remove(&key)
    {
        let _ = tx.send(outcome);
    }
}

fn validated_waveform_columns(wave: &Waveform) -> Result<usize> {
    let count = wave.amp.len();
    anyhow::ensure!(
        count > 0 && count <= MAX_CACHE_COLUMNS,
        "波形列数非法：{count}"
    );
    anyhow::ensure!(
        wave.r.len() == count && wave.g.len() == count && wave.b.len() == count,
        "波形通道长度不一致"
    );
    anyhow::ensure!(
        wave.duration.is_finite() && wave.duration >= 0.0,
        "波形时长非法"
    );
    anyhow::ensure!(
        wave.amp.iter().all(|value| value.is_finite()),
        "波形振幅含非法值"
    );
    let contour_empty =
        wave.minimum.is_empty() && wave.maximum.is_empty() && wave.transient.is_empty();
    anyhow::ensure!(
        contour_empty
            || (wave.minimum.len() == count
                && wave.maximum.len() == count
                && wave.transient.len() == count),
        "波形轮廓通道长度不一致"
    );
    anyhow::ensure!(
        wave.minimum
            .iter()
            .chain(&wave.maximum)
            .all(|value| value.is_finite()),
        "波形轮廓含非法值"
    );
    Ok(count)
}

fn quantize_contour(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

/// HTTP wire v2：36-byte 小端自描述头，随后是 SoA 排列的 i16 min/max 与
/// u8 RGB/transient。每列 8 bytes；没有 v2 轮廓的旧调用方会编码为对称 amp 轮廓。
pub fn encode_waveform_binary(wave: &Waveform, profile: WaveformWireProfile) -> Result<Vec<u8>> {
    let count = validated_waveform_columns(wave)?;
    let has_contour = wave.minimum.len() == count;
    let mut body = Vec::with_capacity(WIRE_HEADER_LEN + count * 8);
    body.extend_from_slice(WIRE_MAGIC);
    body.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    body.push(profile.code());
    body.push(0); // flags/reserved
    body.extend_from_slice(&profile.revision().to_le_bytes());
    body.extend_from_slice(&wave.track_id.to_le_bytes());
    body.extend_from_slice(&wave.duration.to_le_bytes());
    body.extend_from_slice(&(count as u32).to_le_bytes());
    for index in 0..count {
        let value = if has_contour {
            wave.minimum[index]
        } else {
            -wave.amp[index]
        };
        body.extend_from_slice(&quantize_contour(value).to_le_bytes());
    }
    for index in 0..count {
        let value = if has_contour {
            wave.maximum[index]
        } else {
            wave.amp[index]
        };
        body.extend_from_slice(&quantize_contour(value).to_le_bytes());
    }
    body.extend_from_slice(&wave.r);
    body.extend_from_slice(&wave.g);
    body.extend_from_slice(&wave.b);
    if has_contour {
        body.extend_from_slice(&wave.transient);
    } else {
        body.resize(body.len() + count, 0);
    }
    Ok(body)
}

/// `.kdwave` 与 HTTP v2 使用相同的 8 bytes/column SoA payload。旧 v1 缓存仍可读，
/// 但新 revision 的文件名会确保它不会冒充已生成的轮廓资产。
fn encode_cache(wave: &Waveform) -> Result<Vec<u8>> {
    let count = validated_waveform_columns(wave)?;
    let has_contour = wave.minimum.len() == count;
    let mut body = Vec::with_capacity(CACHE_HEADER_LEN + count * 8);
    body.extend_from_slice(CACHE_MAGIC);
    body.extend_from_slice(&CACHE_VERSION.to_le_bytes());
    body.extend_from_slice(&wave.track_id.to_le_bytes());
    body.extend_from_slice(&wave.duration.to_le_bytes());
    body.extend_from_slice(&(count as u32).to_le_bytes());
    for index in 0..count {
        let value = if has_contour {
            wave.minimum[index]
        } else {
            -wave.amp[index]
        };
        body.extend_from_slice(&quantize_contour(value).to_le_bytes());
    }
    for index in 0..count {
        let value = if has_contour {
            wave.maximum[index]
        } else {
            wave.amp[index]
        };
        body.extend_from_slice(&quantize_contour(value).to_le_bytes());
    }
    body.extend_from_slice(&wave.r);
    body.extend_from_slice(&wave.g);
    body.extend_from_slice(&wave.b);
    if has_contour {
        body.extend_from_slice(&wave.transient);
    } else {
        body.resize(body.len() + count, 0);
    }
    Ok(body)
}

/// 缓存也走“临时文件 → 原子提交”。进程被 kill 时最多留下 `.partial`，
/// 已有完整资产不会被截断。
fn write_cache(path: &Path, wave: &Waveform) -> Result<()> {
    let parent = path.parent().context("波形缓存没有上级目录")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("创建波形缓存目录失败：{}", parent.display()))?;
    let body = encode_cache(wave)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".wave-{nonce}.partial"));
    std::fs::write(&tmp, body).with_context(|| format!("写波形临时文件失败：{}", tmp.display()))?;
    if let Err(first) = std::fs::rename(&tmp, path) {
        if path.is_file() {
            let rollback = parent.join(format!(".wave-{nonce}.rollback"));
            std::fs::rename(path, &rollback)
                .with_context(|| format!("暂存旧波形失败：{}", path.display()))?;
            if let Err(second) = std::fs::rename(&tmp, path) {
                let _ = std::fs::rename(&rollback, path);
                let _ = std::fs::remove_file(&tmp);
                return Err(second).with_context(|| {
                    format!("提交波形失败：{}（首次错误：{first}）", path.display())
                });
            }
            let _ = std::fs::remove_file(rollback);
        } else {
            let _ = std::fs::remove_file(&tmp);
            return Err(first).with_context(|| format!("提交波形失败：{}", path.display()));
        }
    }
    Ok(())
}

fn decode_waveform_audio(path: &Path) -> Result<kdj_analysis::decode::DecodedAudio> {
    kdj_analysis::decode::decode_audio_native(path, None)
        .with_context(|| format!("解码整轨波形失败：{}", path.display()))
}

fn release_overview_from_decoded(
    decoded: &kdj_analysis::decode::DecodedAudio,
    track_id: i64,
    evidence: &WaveformEvidence,
    detail_texture: Option<&WaveformColourTexture>,
) -> Result<Waveform> {
    let resampled =
        (decoded.sample_rate != kdj_analysis::waveform::RELEASE_OVERVIEW_SR).then(|| {
            kdj_analysis::decode::resample_mono(
                &decoded.samples,
                decoded.sample_rate,
                kdj_analysis::waveform::RELEASE_OVERVIEW_SR,
            )
        });
    let samples = resampled.as_deref().unwrap_or(&decoded.samples);
    let mut overview = if let Some(detail_texture) = detail_texture {
        release_overview_waveform_with_detail_texture(
            samples,
            f64::from(kdj_analysis::waveform::RELEASE_OVERVIEW_SR),
            RELEASE_OVERVIEW_BUCKETS,
            evidence,
            detail_texture,
        )
    } else {
        release_overview_waveform_with_evidence(
            samples,
            f64::from(kdj_analysis::waveform::RELEASE_OVERVIEW_SR),
            RELEASE_OVERVIEW_BUCKETS,
            evidence,
        )
    };
    if overview.amp.is_empty() {
        anyhow::bail!("文件没有可解码的整曲预览");
    }
    overview.track_id = track_id;
    Ok(fit_release_overview_columns(
        overview,
        RELEASE_OVERVIEW_BUCKETS,
    ))
}

fn release_overview_from_decoded_cancellable(
    decoded: &kdj_analysis::decode::DecodedAudio,
    track_id: i64,
    evidence: &WaveformEvidence,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<Option<Waveform>> {
    if cancelled() {
        return Ok(None);
    }
    let resample_started = Instant::now();
    let resampled = if decoded.sample_rate == kdj_analysis::waveform::RELEASE_OVERVIEW_SR {
        None
    } else {
        match kdj_analysis::decode::resample_mono_cancellable(
            &decoded.samples,
            decoded.sample_rate,
            kdj_analysis::waveform::RELEASE_OVERVIEW_SR,
            cancelled,
        ) {
            Some(samples) => Some(samples),
            None => return Ok(None),
        }
    };
    let release_resample_ms = resample_started.elapsed().as_secs_f64() * 1_000.0;
    let samples = resampled.as_deref().unwrap_or(&decoded.samples);
    let render_started = Instant::now();
    let Some(mut overview) = release_overview_waveform_with_evidence_cancellable(
        samples,
        f64::from(kdj_analysis::waveform::RELEASE_OVERVIEW_SR),
        RELEASE_OVERVIEW_BUCKETS,
        evidence,
        cancelled,
    ) else {
        return Ok(None);
    };
    tracing::debug!(
        target: "kdj_waveform_profile",
        track_id,
        release_resample_ms,
        release_render_ms = render_started.elapsed().as_secs_f64() * 1_000.0,
        "整曲预览成图计时"
    );
    if overview.amp.is_empty() {
        anyhow::bail!("文件没有可解码的整曲预览");
    }
    if cancelled() {
        return Ok(None);
    }
    overview.track_id = track_id;
    Ok(Some(fit_release_overview_columns(
        overview,
        RELEASE_OVERVIEW_BUCKETS,
    )))
}

fn current_waveforms_from_decoded(
    decoded: &kdj_analysis::decode::DecodedAudio,
    track_id: i64,
    evidence_samples: &[f32],
    evidence: &WaveformEvidence,
) -> Result<(Waveform, Waveform, WaveformColourTexture)> {
    let duration = decoded
        .duration
        .unwrap_or(decoded.samples.len() as f64 / f64::from(decoded.sample_rate).max(1.0));
    let (mut detail, texture) = band_waveform_and_texture_with_evidence(
        evidence_samples,
        f64::from(WAVEFORM_EVIDENCE_SR),
        detail_waveform_buckets(duration),
        evidence,
    );
    if detail.amp.is_empty() {
        anyhow::bail!("文件没有可解码的详细波形");
    }
    detail.track_id = track_id;
    let mut overview = fit_waveform_columns(detail.clone(), DEFAULT_WAVEFORM_BUCKETS);
    overview.track_id = track_id;
    Ok((overview, detail, texture))
}

/// A cold interactive request materialises its requested visual profile from one native PCM
/// decode. Current-detail may prime the small release sibling after its mandatory work. A visible
/// release request also retains its compact evidence for the later detail warmup instead of
/// repeating the dominant semantic pass.
fn compute_profile_waveforms(
    path: &Path,
    track_id: i64,
    mtime: u64,
    cache_dir: &Path,
    profile: WaveformProfile,
    prime_other_profile: bool,
    realtime_yielding: bool,
    prepared_evidence: Option<Arc<WaveformEvidence>>,
    work_class: WorkClass,
    request_cancellation: &CancellationToken,
) -> Result<(Waveform, Option<Arc<WaveformEvidence>>)> {
    let profile_name = match profile {
        WaveformProfile::CurrentDetail => "current_detail",
        WaveformProfile::ReleaseOverview => "release_overview",
    };
    let cancelled = || {
        if request_cancellation.is_cancelled() {
            return true;
        }
        let scheduler = kdj_core::work_scheduler::work_scheduler();
        realtime_yielding
            && realtime_waveform_should_cancel(
                scheduler.audio_pressure(),
                scheduler.allows(work_class),
            )
    };
    if !realtime_yielding {
        ensure_waveform_may_continue()?;
    }
    let decode_started = Instant::now();
    let decoded = if realtime_yielding {
        kdj_analysis::decode::decode_audio_native_cancellable(path, None, &cancelled)?
            .ok_or_else(|| anyhow::anyhow!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING))?
    } else {
        decode_waveform_audio(path)?
    };
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1_000.0;
    if !realtime_yielding {
        ensure_waveform_may_continue()?;
    }
    let evidence_resample_started = Instant::now();
    let evidence_resampled = if decoded.sample_rate == WAVEFORM_EVIDENCE_SR {
        None
    } else if realtime_yielding {
        Some(
            kdj_analysis::decode::resample_mono_cancellable(
                &decoded.samples,
                decoded.sample_rate,
                WAVEFORM_EVIDENCE_SR,
                &cancelled,
            )
            .ok_or_else(|| anyhow::anyhow!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING))?,
        )
    } else {
        Some(kdj_analysis::decode::resample_mono(
            &decoded.samples,
            decoded.sample_rate,
            WAVEFORM_EVIDENCE_SR,
        ))
    };
    let evidence_resample_ms = evidence_resample_started.elapsed().as_secs_f64() * 1_000.0;
    let evidence_samples = evidence_resampled.as_deref().unwrap_or(&decoded.samples);
    let evidence_started = Instant::now();
    let reused_evidence = prepared_evidence.is_some();
    let evidence = if let Some(evidence) = prepared_evidence {
        evidence
    } else {
        Arc::new(if realtime_yielding {
            let evidence = match profile {
                // The blank PlayerBar is user-visible, so its one-off pass may use the measured
                // burst budget. A later detail warmup reuses this exact completed result.
                WaveformProfile::ReleaseOverview => {
                    analyze_waveform_evidence_preview_burst_cancellable(
                        evidence_samples,
                        f64::from(WAVEFORM_EVIDENCE_SR),
                        &cancelled,
                    )
                }
                WaveformProfile::CurrentDetail => analyze_waveform_evidence_cancellable(
                    evidence_samples,
                    f64::from(WAVEFORM_EVIDENCE_SR),
                    &cancelled,
                ),
            };
            evidence.ok_or_else(|| anyhow::anyhow!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING))?
        } else {
            analyze_waveform_evidence(evidence_samples, f64::from(WAVEFORM_EVIDENCE_SR))
        })
    };
    let evidence_ms = evidence_started.elapsed().as_secs_f64() * 1_000.0;
    tracing::debug!(
        target: "kdj_waveform_profile",
        track_id,
        profile = profile_name,
        source_sample_rate = decoded.sample_rate,
        source_samples = decoded.samples.len(),
        decode_ms,
        evidence_resample_ms,
        evidence_ms,
        reused_evidence,
        "整曲波形分段计时"
    );
    if !realtime_yielding {
        ensure_waveform_may_continue()?;
    }
    match profile {
        WaveformProfile::ReleaseOverview => {
            // When a cold load needs both assets, build detail first and lend its pre-texture
            // colour pass to release overview. The previous order regenerated those 100k colour
            // columns after the same evidence FFT.
            let mut generated_current = None;
            if prime_other_profile
                && !waveform_should_yield_to_audio(
                    kdj_core::work_scheduler::work_scheduler().live_audio_decks(),
                )
                && detail_from_cache(cache_dir, track_id, mtime).is_none()
            {
                match current_waveforms_from_decoded(
                    &decoded,
                    track_id,
                    evidence_samples,
                    evidence.as_ref(),
                ) {
                    Ok(value) => generated_current = Some(value),
                    Err(error) => tracing::warn!(
                        "顺带生成详细波形失败 {track_id}（整曲预览仍可用）：{error:#}"
                    ),
                }
            }
            let release = if realtime_yielding {
                release_overview_from_decoded_cancellable(
                    &decoded,
                    track_id,
                    evidence.as_ref(),
                    &cancelled,
                )?
                .ok_or_else(|| anyhow::anyhow!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING))?
            } else {
                release_overview_from_decoded(
                    &decoded,
                    track_id,
                    evidence.as_ref(),
                    generated_current.as_ref().map(|(_, _, texture)| texture),
                )?
            };
            let release_key = WaveKey {
                track_id,
                buckets: RELEASE_OVERVIEW_BUCKETS,
                mtime,
            };
            write_release_overview(cache_dir, release_key, &release)?;

            if let Some((overview, detail, _texture)) = generated_current {
                if let Err(error) =
                    store_shared_waveforms(cache_dir, track_id, mtime, &overview, &detail)
                {
                    tracing::warn!("顺带缓存详细波形失败 {track_id}（整曲预览仍可用）：{error:#}");
                } else {
                    remove_obsolete_track_caches(cache_dir, track_id);
                }
            }
            Ok((release, Some(evidence)))
        }
        WaveformProfile::CurrentDetail => {
            if realtime_yielding {
                if cancelled() {
                    anyhow::bail!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING);
                }
            } else {
                ensure_waveform_may_continue()?;
            }
            let (overview, detail, texture) = current_waveforms_from_decoded(
                &decoded,
                track_id,
                evidence_samples,
                evidence.as_ref(),
            )?;
            if realtime_yielding && cancelled() {
                anyhow::bail!(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING);
            }
            store_shared_waveforms(cache_dir, track_id, mtime, &overview, &detail)?;
            remove_obsolete_track_caches(cache_dir, track_id);

            if prime_other_profile {
                let release_key = WaveKey {
                    track_id,
                    buckets: RELEASE_OVERVIEW_BUCKETS,
                    mtime,
                };
                if read_release_overview_cached(cache_dir, release_key).is_none() {
                    match release_overview_from_decoded(
                        &decoded,
                        track_id,
                        evidence.as_ref(),
                        Some(&texture),
                    )
                    .and_then(|release| write_release_overview(cache_dir, release_key, &release))
                    {
                        Ok(()) => {}
                        Err(error) => tracing::warn!(
                            "顺带生成整曲预览失败 {track_id}（详细波形仍可用）：{error:#}"
                        ),
                    }
                }
            }
            Ok((detail, None))
        }
    }
}

fn compute_release_overview(path: &Path, track_id: i64) -> Result<Waveform> {
    ensure_waveform_may_continue()?;
    let decoded = decode_waveform_audio(path)
        .with_context(|| format!("解码 v0.2.41 整曲预览失败：{}", path.display()))?;
    ensure_waveform_may_continue()?;
    let evidence_resampled = (decoded.sample_rate != WAVEFORM_EVIDENCE_SR).then(|| {
        kdj_analysis::decode::resample_mono(
            &decoded.samples,
            decoded.sample_rate,
            WAVEFORM_EVIDENCE_SR,
        )
    });
    let evidence_samples = evidence_resampled.as_deref().unwrap_or(&decoded.samples);
    let evidence = analyze_waveform_evidence(evidence_samples, f64::from(WAVEFORM_EVIDENCE_SR));
    ensure_waveform_may_continue()?;
    release_overview_from_decoded(&decoded, track_id, &evidence, None)
}

fn write_release_overview(cache_dir: &Path, key: WaveKey, overview: &Waveform) -> Result<()> {
    write_cache(&release_overview_cache_path(cache_dir, key), overview)
}

fn store_shared_waveforms(
    cache_dir: &Path,
    track_id: i64,
    mtime: u64,
    overview: &Waveform,
    detail: &Waveform,
) -> Result<()> {
    write_cache(
        &cache_path(cache_dir, track_id, DEFAULT_WAVEFORM_BUCKETS, mtime),
        overview,
    )?;
    if detail.amp.len() != overview.amp.len() {
        write_cache(
            &cache_path(cache_dir, track_id, detail.amp.len(), mtime),
            detail,
        )?;
    }
    Ok(())
}

fn resolve_from_cache(cache_dir: &Path, key: WaveKey) -> Option<Waveform> {
    if let Some((cached, _)) = read_cached(cache_dir, key) {
        return Some(cached);
    }
    let overview_key = WaveKey {
        track_id: key.track_id,
        buckets: DEFAULT_WAVEFORM_BUCKETS,
        mtime: key.mtime,
    };
    let overview = read_cached(cache_dir, overview_key)?.0;
    if key.buckets == DEFAULT_WAVEFORM_BUCKETS {
        return Some(overview);
    }
    let detail = detail_from_cache(cache_dir, key.track_id, key.mtime)?;
    Some(fit_waveform_columns(detail, key.buckets))
}

fn resolve_profile_from_cache(
    cache_dir: &Path,
    key: WaveKey,
    profile: WaveformProfile,
) -> Option<Waveform> {
    match profile {
        WaveformProfile::CurrentDetail => resolve_from_cache(cache_dir, key),
        WaveformProfile::ReleaseOverview => {
            read_release_overview_cached(cache_dir, key).map(|(wave, _)| wave)
        }
    }
}

fn fit_profile_waveform(wave: Waveform, columns: usize, profile: WaveformProfile) -> Waveform {
    match profile {
        WaveformProfile::CurrentDetail => fit_waveform_columns(wave, columns),
        WaveformProfile::ReleaseOverview => fit_release_overview_columns(wave, columns),
    }
}

fn detail_from_cache(cache_dir: &Path, track_id: i64, mtime: u64) -> Option<Waveform> {
    let overview = read_cached(
        cache_dir,
        WaveKey {
            track_id,
            buckets: DEFAULT_WAVEFORM_BUCKETS,
            mtime,
        },
    )?
    .0;
    let detail_n = detail_waveform_buckets(overview.duration);
    read_cached(
        cache_dir,
        WaveKey {
            track_id,
            buckets: detail_n,
            mtime,
        },
    )
    .map(|(wave, _)| wave)
}

/// 完整播放条使用固定列数。这里以时间面积重采样到请求宽度；高度以 80% RMS +
/// 20% peak 汇聚，避免一个 click 把整段 overview 顶满，同时保留可见瞬态；颜色仍按
/// 响度加权，短曲也不会退化成双空线。
pub fn fit_waveform_columns(wave: Waveform, columns: usize) -> Waveform {
    let columns = columns.clamp(64, MAX_WAVEFORM_BUCKETS);
    let source_len = wave.amp.len();
    if source_len == columns
        || source_len == 0
        || wave.r.len() != source_len
        || wave.g.len() != source_len
        || wave.b.len() != source_len
    {
        return wave;
    }
    let mut amp = Vec::with_capacity(columns);
    let mut red = Vec::with_capacity(columns);
    let mut green = Vec::with_capacity(columns);
    let mut blue = Vec::with_capacity(columns);
    let has_contour = wave.minimum.len() == source_len
        && wave.maximum.len() == source_len
        && wave.transient.len() == source_len;
    let mut minimum = has_contour.then(|| Vec::with_capacity(columns));
    let mut maximum = has_contour.then(|| Vec::with_capacity(columns));
    let mut transient = has_contour.then(|| Vec::with_capacity(columns));
    for target in 0..columns {
        let start = target as f64 * source_len as f64 / columns as f64;
        let end = (target + 1) as f64 * source_len as f64 / columns as f64;
        let first = start.floor() as usize;
        let last = (end.ceil() as usize).min(source_len);
        let mut peak = 0.0f32;
        let mut square_sum = 0.0f64;
        let mut amplitude_weight = 0.0f64;
        let mut r = 0.0f64;
        let mut g = 0.0f64;
        let mut b = 0.0f64;
        let mut total_weight = 0.0f64;
        let mut lower = 0.0f32;
        let mut upper = 0.0f32;
        let mut onset = 0u8;
        for source in first..last {
            let overlap = (end.min((source + 1) as f64) - start.max(source as f64)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            let value = wave.amp[source].clamp(0.0, 1.0);
            peak = peak.max(value);
            square_sum += f64::from(value * value) * overlap;
            amplitude_weight += overlap;
            let weight = overlap * (f64::from(value) + 0.001);
            r += f64::from(wave.r[source]) * weight;
            g += f64::from(wave.g[source]) * weight;
            b += f64::from(wave.b[source]) * weight;
            total_weight += weight;
            if has_contour {
                lower = lower.min(wave.minimum[source]);
                upper = upper.max(wave.maximum[source]);
                onset = onset.max(wave.transient[source]);
            }
        }
        let fallback = first.min(source_len - 1);
        let rms = if amplitude_weight > 0.0 {
            (square_sum / amplitude_weight).sqrt() as f32
        } else {
            peak
        };
        amp.push((rms * 0.8 + peak * 0.2).clamp(0.0, 1.0));
        red.push(if total_weight > 0.0 {
            (r / total_weight).round() as u8
        } else {
            wave.r[fallback]
        });
        green.push(if total_weight > 0.0 {
            (g / total_weight).round() as u8
        } else {
            wave.g[fallback]
        });
        blue.push(if total_weight > 0.0 {
            (b / total_weight).round() as u8
        } else {
            wave.b[fallback]
        });
        if let Some(values) = minimum.as_mut() {
            values.push(lower);
        }
        if let Some(values) = maximum.as_mut() {
            values.push(upper);
        }
        if let Some(values) = transient.as_mut() {
            values.push(onset);
        }
    }
    Waveform {
        track_id: wave.track_id,
        duration: wave.duration,
        amp,
        minimum: minimum.unwrap_or_default(),
        maximum: maximum.unwrap_or_default(),
        r: red,
        g: green,
        b: blue,
        transient: transient.unwrap_or_default(),
    }
}

/// v0.2.41 的屏幕列汇聚：高度保留窗口 peak，而不是当前详细波形的 RMS/peak 混合。
fn fit_release_overview_columns(wave: Waveform, columns: usize) -> Waveform {
    let columns = columns.clamp(64, RELEASE_OVERVIEW_BUCKETS);
    let source_len = wave.amp.len();
    if source_len == columns
        || source_len == 0
        || wave.r.len() != source_len
        || wave.g.len() != source_len
        || wave.b.len() != source_len
    {
        return wave;
    }
    let mut amp = Vec::with_capacity(columns);
    let mut red = Vec::with_capacity(columns);
    let mut green = Vec::with_capacity(columns);
    let mut blue = Vec::with_capacity(columns);
    let has_contour = wave.minimum.len() == source_len
        && wave.maximum.len() == source_len
        && wave.transient.len() == source_len;
    let mut minimum = has_contour.then(|| Vec::with_capacity(columns));
    let mut maximum = has_contour.then(|| Vec::with_capacity(columns));
    let mut transient = has_contour.then(|| Vec::with_capacity(columns));
    for target in 0..columns {
        let start = target as f64 * source_len as f64 / columns as f64;
        let end = (target + 1) as f64 * source_len as f64 / columns as f64;
        let first = start.floor() as usize;
        let last = (end.ceil() as usize).min(source_len);
        let mut peak = 0.0f32;
        let mut r = 0.0f64;
        let mut g = 0.0f64;
        let mut b = 0.0f64;
        let mut total_weight = 0.0f64;
        let mut lower = 0.0f32;
        let mut upper = 0.0f32;
        let mut onset = 0u8;
        for source in first..last {
            let overlap = (end.min((source + 1) as f64) - start.max(source as f64)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            let value = wave.amp[source].clamp(0.0, 1.0);
            peak = peak.max(value);
            let weight = overlap * (f64::from(value) + 0.001);
            r += f64::from(wave.r[source]) * weight;
            g += f64::from(wave.g[source]) * weight;
            b += f64::from(wave.b[source]) * weight;
            total_weight += weight;
            if has_contour {
                lower = lower.min(wave.minimum[source]);
                upper = upper.max(wave.maximum[source]);
                onset = onset.max(wave.transient[source]);
            }
        }
        let fallback = first.min(source_len - 1);
        amp.push(peak);
        red.push(if total_weight > 0.0 {
            (r / total_weight).round() as u8
        } else {
            wave.r[fallback]
        });
        green.push(if total_weight > 0.0 {
            (g / total_weight).round() as u8
        } else {
            wave.g[fallback]
        });
        blue.push(if total_weight > 0.0 {
            (b / total_weight).round() as u8
        } else {
            wave.b[fallback]
        });
        if let Some(values) = minimum.as_mut() {
            values.push(lower);
        }
        if let Some(values) = maximum.as_mut() {
            values.push(upper);
        }
        if let Some(values) = transient.as_mut() {
            values.push(onset);
        }
    }
    Waveform {
        track_id: wave.track_id,
        duration: wave.duration,
        amp,
        minimum: minimum.unwrap_or_default(),
        maximum: maximum.unwrap_or_default(),
        r: red,
        g: green,
        b: blue,
        transient: transient.unwrap_or_default(),
    }
}

pub fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

fn cache_path(cache_dir: &Path, track_id: i64, buckets: usize, mtime: u64) -> PathBuf {
    cache_dir.join(format!(
        "{track_id}-v{CURRENT_WAVEFORM_REVISION}-{buckets}-{mtime}.kdwave"
    ))
}

fn release_overview_cache_path(cache_dir: &Path, key: WaveKey) -> PathBuf {
    cache_dir.join(format!(
        "{}-release-v{}-overview-{}-{}.kdwave",
        key.track_id, CANONICAL_WAVEFORM_REVISION, key.buckets, key.mtime
    ))
}

fn remove_obsolete_track_caches(cache_dir: &Path, track_id: i64) -> usize {
    let old_json_prefix = format!("{track_id}-v2-");
    let old_binary_prefix = format!("{track_id}-v3-");
    let old_native_prefix = format!("{track_id}-v4-");
    let old_peak_prefix = format!("{track_id}-v5-");
    let old_current_prefix = format!("{track_id}-v6-");
    let old_contour_prefix = format!("{track_id}-v7-");
    let old_semantic_prefix = format!("{track_id}-v8-");
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.starts_with(&old_json_prefix) && name.ends_with(".json"))
                || (name.starts_with(&old_binary_prefix) && name.ends_with(".kdwave"))
                || (name.starts_with(&old_native_prefix) && name.ends_with(".kdwave"))
                || (name.starts_with(&old_peak_prefix) && name.ends_with(".kdwave"))
                || (name.starts_with(&old_current_prefix) && name.ends_with(".kdwave"))
                || (name.starts_with(&old_contour_prefix) && name.ends_with(".kdwave"))
                || (name.starts_with(&old_semantic_prefix) && name.ends_with(".kdwave"))
        })
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

fn read_cache(path: &Path) -> Option<Waveform> {
    let body = std::fs::read(path).ok()?;
    if body.len() < CACHE_HEADER_LEN || &body[..8] != CACHE_MAGIC {
        return None;
    }
    let version = u16::from_le_bytes(body[8..10].try_into().ok()?);
    if version != 1 && version != CACHE_VERSION {
        return None;
    }
    let track_id = i64::from_le_bytes(body[10..18].try_into().ok()?);
    let duration = f64::from_le_bytes(body[18..26].try_into().ok()?);
    let count = u32::from_le_bytes(body[26..30].try_into().ok()?) as usize;
    let bytes_per_column = if version == 1 { 7 } else { 8 };
    if count == 0
        || count > MAX_CACHE_COLUMNS
        || body.len() != CACHE_HEADER_LEN + count * bytes_per_column
    {
        return None;
    }
    if !duration.is_finite() || duration < 0.0 {
        return None;
    }
    if version == 1 {
        let mut amp = Vec::with_capacity(count);
        let amp_end = CACHE_HEADER_LEN + count * 4;
        for chunk in body[CACHE_HEADER_LEN..amp_end].chunks_exact(4) {
            let value = f32::from_le_bytes(chunk.try_into().ok()?);
            if !value.is_finite() {
                return None;
            }
            amp.push(value);
        }
        let r_end = amp_end + count;
        let g_end = r_end + count;
        return Some(Waveform {
            track_id,
            duration,
            amp,
            minimum: Vec::new(),
            maximum: Vec::new(),
            r: body[amp_end..r_end].to_vec(),
            g: body[r_end..g_end].to_vec(),
            b: body[g_end..].to_vec(),
            transient: Vec::new(),
        });
    }

    let minimum_end = CACHE_HEADER_LEN + count * 2;
    let maximum_end = minimum_end + count * 2;
    let decode_contour = |bytes: &[u8]| -> Option<Vec<f32>> {
        bytes
            .chunks_exact(2)
            .map(|chunk| {
                Some(f32::from(i16::from_le_bytes(chunk.try_into().ok()?)) / f32::from(i16::MAX))
            })
            .collect()
    };
    let minimum = decode_contour(&body[CACHE_HEADER_LEN..minimum_end])?;
    let maximum = decode_contour(&body[minimum_end..maximum_end])?;
    let amp = minimum
        .iter()
        .zip(&maximum)
        .map(|(minimum, maximum)| (*maximum).max(-*minimum).clamp(0.0, 1.0))
        .collect();
    let r_end = maximum_end + count;
    let g_end = r_end + count;
    let b_end = g_end + count;
    Some(Waveform {
        track_id,
        duration,
        amp,
        minimum,
        maximum,
        r: body[maximum_end..r_end].to_vec(),
        g: body[r_end..g_end].to_vec(),
        b: body[g_end..b_end].to_vec(),
        transient: body[b_end..].to_vec(),
    })
}

/// 路径版本同时是波形算法版本。v5 的纯 peak / 高饱和数据不能迁移到 v6，否则
/// 新 palette 下仍然看不出段落动态。
fn read_cached(cache_dir: &Path, key: WaveKey) -> Option<(Waveform, bool)> {
    let current = cache_path(cache_dir, key.track_id, key.buckets, key.mtime);
    read_cache(&current)
        .filter(|wave| wave.track_id == key.track_id)
        .map(|wave| (wave, true))
}

fn read_release_overview_cached(cache_dir: &Path, key: WaveKey) -> Option<(Waveform, bool)> {
    let current = release_overview_cache_path(cache_dir, key);
    read_cache(&current)
        .filter(|wave| wave.track_id == key.track_id && wave.amp.len() == key.buckets)
        .map(|wave| (wave, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_overview_owns_the_visible_lane_and_secondary_work_is_preemptible() {
        assert_eq!(
            waveform_work_class(
                true,
                WaveformProfile::ReleaseOverview,
                false,
                ReleaseOverviewIntent::Player,
            ),
            WorkClass::VisibleWaveform
        );
        assert_eq!(
            waveform_work_class(
                true,
                WaveformProfile::ReleaseOverview,
                false,
                ReleaseOverviewIntent::Visible,
            ),
            WorkClass::LibraryAnalysisLight
        );
        assert_eq!(
            waveform_work_class(
                true,
                WaveformProfile::ReleaseOverview,
                false,
                ReleaseOverviewIntent::Prefetch,
            ),
            WorkClass::LibraryAnalysisLight
        );
        assert_eq!(
            waveform_work_class(
                true,
                WaveformProfile::CurrentDetail,
                false,
                ReleaseOverviewIntent::Visible,
            ),
            WorkClass::Maintenance
        );
        assert_eq!(
            waveform_work_class(
                true,
                WaveformProfile::CurrentDetail,
                true,
                ReleaseOverviewIntent::Visible,
            ),
            WorkClass::LibraryAnalysisLight
        );
        assert_eq!(
            waveform_work_class(
                false,
                WaveformProfile::ReleaseOverview,
                false,
                ReleaseOverviewIntent::Visible,
            ),
            WorkClass::Maintenance
        );
        assert!(waveform_should_yield_to_audio(1));
        assert!(!waveform_should_yield_to_audio(0));
    }

    #[test]
    fn latest_player_and_prefetch_intents_cancel_only_their_own_stale_track() {
        let mut state = ReleaseIntentState::default();
        let player_a = state.register(10, ReleaseOverviewIntent::Player, 100);
        let player_a_again = state.register(10, ReleaseOverviewIntent::Player, 101);
        assert_eq!(player_a.id, player_a_again.id);
        assert!(!player_a.cancellation.is_cancelled());

        let stale_arrival = state.register(9, ReleaseOverviewIntent::Player, 99);
        assert!(stale_arrival.cancellation.is_cancelled());
        assert!(!player_a.cancellation.is_cancelled());

        let prefetch_a = state.register(20, ReleaseOverviewIntent::Prefetch, 200);
        let player_b = state.register(11, ReleaseOverviewIntent::Player, 102);
        assert!(player_a.cancellation.is_cancelled());
        assert!(!player_b.cancellation.is_cancelled());
        assert!(!prefetch_a.cancellation.is_cancelled());

        let prefetch_b = state.register(21, ReleaseOverviewIntent::Prefetch, 201);
        assert!(prefetch_a.cancellation.is_cancelled());
        assert!(!prefetch_b.cancellation.is_cancelled());
        assert!(!player_b.cancellation.is_cancelled());
    }

    #[test]
    fn admitted_visible_preview_yields_to_manager_or_output_pressure() {
        assert!(!realtime_waveform_should_cancel(
            AudioPressure::Normal,
            true,
        ));
        assert!(realtime_waveform_should_cancel(
            AudioPressure::Normal,
            false,
        ));
        assert!(realtime_waveform_should_cancel(AudioPressure::Low, true));
        assert!(realtime_waveform_should_cancel(
            AudioPressure::Critical,
            true,
        ));
    }

    #[test]
    fn speculative_full_detail_yields_to_bounded_manager_work() {
        assert!(!realtime_waveform_should_cancel(
            AudioPressure::Normal,
            true,
        ));
        assert!(realtime_waveform_should_cancel(
            AudioPressure::Normal,
            false,
        ));
        assert!(realtime_waveform_should_cancel(AudioPressure::Low, true,));
    }

    #[test]
    fn prepared_evidence_cache_reuses_recent_tracks_and_stays_bounded() {
        let mut cache = PreparedEvidenceCache::default();
        let mut inserted = Vec::new();
        for track_id in 0..=PREPARED_EVIDENCE_CAPACITY as i64 {
            let evidence = Arc::new(WaveformEvidence::default());
            cache.insert(EvidenceKey { track_id, mtime: 7 }, Arc::clone(&evidence));
            inserted.push(evidence);
        }

        assert_eq!(cache.entries.len(), PREPARED_EVIDENCE_CAPACITY);
        assert!(cache
            .get(EvidenceKey {
                track_id: 0,
                mtime: 7,
            })
            .is_none());
        let latest = cache
            .get(EvidenceKey {
                track_id: PREPARED_EVIDENCE_CAPACITY as i64,
                mtime: 7,
            })
            .expect("latest evidence remains reusable");
        assert!(Arc::ptr_eq(
            &latest,
            inserted.last().expect("inserted evidence")
        ));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kdj-wave-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_wav(path: &Path) {
        write_test_wav_seconds(path, 30);
    }

    fn write_test_wav_seconds(path: &Path, seconds: u32) {
        const RATE: u32 = 44_100;
        let data_len = RATE * seconds;
        let mut data = Vec::with_capacity(44 + data_len as usize);
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + data_len).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&RATE.to_le_bytes());
        data.extend_from_slice(&RATE.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&8u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&data_len.to_le_bytes());
        data.resize(44 + data_len as usize, 128);
        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn http_binary_waveform_is_compact_and_self_describes_its_profile() {
        let wave = Waveform {
            track_id: -42,
            duration: 3.5,
            amp: vec![0.25, 0.75],
            minimum: vec![-0.2, -0.7],
            maximum: vec![0.25, 0.75],
            r: vec![255, 32],
            g: vec![64, 128],
            b: vec![32, 255],
            transient: vec![0, 255],
        };
        for profile in [
            WaveformWireProfile::CurrentDetail,
            WaveformWireProfile::ReleaseOverview,
        ] {
            let body = encode_waveform_binary(&wave, profile).unwrap();
            assert_eq!(&body[..8], WIRE_MAGIC);
            assert_eq!(u16::from_le_bytes(body[8..10].try_into().unwrap()), 2);
            assert_eq!(body[10], profile.code());
            assert_eq!(body[11], 0);
            assert_eq!(
                u32::from_le_bytes(body[12..16].try_into().unwrap()),
                profile.revision()
            );
            assert_eq!(
                i64::from_le_bytes(body[16..24].try_into().unwrap()),
                wave.track_id
            );
            assert_eq!(
                f64::from_le_bytes(body[24..32].try_into().unwrap()),
                wave.duration
            );
            assert_eq!(u32::from_le_bytes(body[32..36].try_into().unwrap()), 2);
            assert_eq!(body.len(), WIRE_HEADER_LEN + wave.amp.len() * 8);
            assert_eq!(
                i16::from_le_bytes(body[36..38].try_into().unwrap()),
                quantize_contour(-0.2)
            );
            assert_eq!(&body[44..], &[255, 32, 64, 128, 32, 255, 0, 255]);
        }
    }

    #[test]
    fn cache_writes_atomically_and_roundtrips() {
        let dir = scratch("roundtrip");
        let path = dir.join("1-v9-640-1.kdwave");
        let wave = Waveform {
            track_id: 1,
            duration: 3.5,
            amp: vec![0.25, 0.75],
            minimum: vec![-0.2, -0.7],
            maximum: vec![0.25, 0.75],
            r: vec![255, 32],
            g: vec![64, 128],
            b: vec![32, 255],
            transient: vec![0, 255],
        };
        write_cache(&path, &wave).unwrap();
        let loaded = read_cache(&path).unwrap();
        assert_eq!(loaded.track_id, 1);
        assert_eq!(loaded.transient, wave.transient);
        assert_eq!(loaded.r, wave.r);
        assert!((loaded.minimum[0] - wave.minimum[0]).abs() < 1e-4);
        assert!((loaded.maximum[1] - wave.maximum[1]).abs() < 1e-4);
        assert!(
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".partial")),
            "成功提交后不能留下半成品"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn overview_energy_pooling_does_not_turn_one_transient_into_a_full_height_section() {
        let mut amp = vec![0.2; 640];
        amp[5] = 1.0;
        let sparse = fit_waveform_columns(
            Waveform {
                track_id: 1,
                duration: 10.0,
                amp,
                r: vec![80; 640],
                g: vec![120; 640],
                b: vec![180; 640],
                ..Default::default()
            },
            64,
        );
        assert!(
            sparse.amp[0] < 0.6,
            "单个 peak 不应把整个 overview 时间窗画满：{}",
            sparse.amp[0]
        );

        let dense = fit_waveform_columns(
            Waveform {
                track_id: 2,
                duration: 10.0,
                amp: vec![1.0; 640],
                r: vec![80; 640],
                g: vec![120; 640],
                b: vec![180; 640],
                ..Default::default()
            },
            64,
        );
        assert!(dense.amp.iter().all(|value| (*value - 1.0).abs() < 1e-6));
    }

    #[test]
    fn overview_pooling_matches_the_frontend_rms_peak_contract() {
        let mut source = Vec::with_capacity(128);
        for target in 0..64 {
            if target % 2 == 0 {
                source.extend([1.0, 0.0]);
            } else {
                source.extend([0.8, 0.2]);
            }
        }
        let pooled = fit_waveform_columns(
            Waveform {
                track_id: 3,
                duration: 4.0,
                amp: source,
                r: vec![255; 128],
                g: vec![64; 128],
                b: vec![32; 128],
                ..Default::default()
            },
            64,
        );
        assert!((pooled.amp[0] - 0.76568544).abs() < 1e-6);
        assert!((pooled.amp[1] - 0.62647617).abs() < 1e-6);
    }

    #[test]
    fn completed_v9_waveform_removes_only_that_tracks_obsolete_caches() {
        let dir = scratch("obsolete-cleanup");
        let old_json = dir.join("7-v2-640-1.json");
        let old_binary = dir.join("7-v3-4096-1.kdwave");
        let old_resampled = dir.join("7-v4-24000-1.kdwave");
        let other_track = dir.join("70-v3-640-1.kdwave");
        let old_peak = dir.join("7-v5-640-1.kdwave");
        let old_current = dir.join("7-v6-640-1.kdwave");
        let old_contour = dir.join("7-v7-640-1.kdwave");
        let old_semantic = dir.join("7-v8-640-1.kdwave");
        let current = dir.join("7-v9-640-1.kdwave");
        for path in [
            &old_json,
            &old_binary,
            &old_resampled,
            &old_peak,
            &old_current,
            &old_contour,
            &old_semantic,
            &other_track,
            &current,
        ] {
            std::fs::write(path, b"fixture").unwrap();
        }

        assert_eq!(remove_obsolete_track_caches(&dir, 7), 7);
        assert!(!old_json.exists());
        assert!(!old_binary.exists());
        assert!(!old_resampled.exists());
        assert!(!old_peak.exists());
        assert!(!old_current.exists());
        assert!(!old_contour.exists());
        assert!(!old_semantic.exists());
        assert!(other_track.exists(), "不能误删 id 前缀相似的其它曲目");
        assert!(current.exists(), "不能删刚写成功的 v9 波形");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn one_decode_writes_overview_and_detail_caches() {
        let dir = scratch("shared-decode");
        let audio = dir.join("track.wav");
        let cache_dir = dir.join("cache");
        write_test_wav(&audio);
        let library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let coordinator = WaveformCoordinator::new(library);
        let overview = coordinator
            .get_or_compute(1, audio.clone(), 640, cache_dir.clone())
            .await
            .unwrap();
        assert_eq!(overview.amp.len(), 640);
        let mtime = file_mtime(&audio);
        let detail_n = detail_waveform_buckets(overview.duration);
        assert!(
            cache_path(&cache_dir, 1, 640, mtime).is_file(),
            "640 overview must be written from the first decode"
        );
        assert!(
            cache_path(&cache_dir, 1, detail_n, mtime).is_file(),
            "detail master must be written from the same decode"
        );
        assert!(
            release_overview_cache_path(
                &cache_dir,
                WaveKey {
                    track_id: 1,
                    buckets: RELEASE_OVERVIEW_BUCKETS,
                    mtime,
                },
            )
            .is_file(),
            "current detail cold miss must prime release overview from the same decode"
        );
        let detailed = coordinator
            .get_or_compute(1, audio, detail_n, cache_dir)
            .await
            .unwrap();
        assert_eq!(detailed.amp.len(), detail_n);
        assert_eq!(detailed.duration, overview.duration);
    }

    #[tokio::test]
    async fn release_overview_cache_is_independent_from_current_detail_cache() {
        let dir = scratch("release-overview-profile");
        let audio = dir.join("track.wav");
        let cache_dir = dir.join("cache");
        write_test_wav(&audio);
        let library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let coordinator = WaveformCoordinator::new(library);

        let release = coordinator
            .get_release_overview(41, audio.clone(), cache_dir.clone())
            .await
            .unwrap();
        let key = WaveKey {
            track_id: 41,
            buckets: RELEASE_OVERVIEW_BUCKETS,
            mtime: file_mtime(&audio),
        };
        let detail_n = detail_waveform_buckets(release.duration);
        assert!(
            !cache_path(&cache_dir, 41, 640, key.mtime).is_file(),
            "blank release preview must not wait for the current overview"
        );
        assert!(
            !cache_path(&cache_dir, 41, detail_n, key.mtime).is_file(),
            "blank release preview must not wait for the 100k-column detail asset"
        );
        assert!(release_overview_cache_path(&cache_dir, key).is_file());
        assert_eq!(release.amp.len(), RELEASE_OVERVIEW_BUCKETS);

        let current = coordinator
            .get_or_compute(41, audio.clone(), 640, cache_dir.clone())
            .await
            .unwrap();
        assert_eq!(current.amp.len(), DEFAULT_WAVEFORM_BUCKETS);
        assert_ne!(
            current.amp.len(),
            release.amp.len(),
            "release preview must retain its independent fixed-column asset"
        );

        let detail = coordinator
            .get_or_compute(41, audio, detail_n, cache_dir.clone())
            .await
            .unwrap();
        assert_eq!(detail.amp.len(), detail_n);
        assert!(cache_path(&cache_dir, 41, detail_n, key.mtime).is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn newer_player_request_cancels_the_old_leader_before_the_decode_gate() {
        let dir = scratch("latest-player-request");
        let audio = dir.join("track.wav");
        let cache_dir = dir.join("cache");
        write_test_wav_seconds(&audio, 2);
        let library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let coordinator = WaveformCoordinator::new(library);
        let gate = Arc::clone(&coordinator.interactive_detail_gate)
            .acquire_owned()
            .await
            .unwrap();

        let old_coord = Arc::clone(&coordinator);
        let old_audio = audio.clone();
        let old_cache = cache_dir.clone();
        let old = tokio::spawn(async move {
            old_coord
                .get_release_overview_with_intent(
                    51,
                    old_audio,
                    old_cache,
                    ReleaseOverviewIntent::Player,
                    1_000,
                )
                .await
        });
        for _ in 0..100 {
            if coordinator
                .inflight
                .lock()
                .expect("waveform inflight")
                .keys()
                .any(|key| key.track_id == 51)
            {
                break;
            }
            tokio::task::yield_now().await;
        }

        let new_coord = Arc::clone(&coordinator);
        let new_audio = audio.clone();
        let new_cache = cache_dir.clone();
        let new = tokio::spawn(async move {
            new_coord
                .get_release_overview_with_intent(
                    52,
                    new_audio,
                    new_cache,
                    ReleaseOverviewIntent::Player,
                    1_001,
                )
                .await
        });

        let old_error = tokio::time::timeout(std::time::Duration::from_secs(2), old)
            .await
            .expect("stale player request should leave admission/gate promptly")
            .unwrap()
            .unwrap_err();
        assert!(format!("{old_error:#}").contains(FULL_TRACK_WAVEFORM_SUPERSEDED));
        drop(gate);

        let latest = tokio::time::timeout(std::time::Duration::from_secs(10), new)
            .await
            .expect("latest player request should acquire the released decode gate")
            .unwrap()
            .unwrap();
        assert_eq!(latest.track_id, 52);
        assert!(!release_overview_cache_path(
            &cache_dir,
            WaveKey {
                track_id: 51,
                buckets: RELEASE_OVERVIEW_BUCKETS,
                mtime: file_mtime(&audio),
            }
        )
        .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn player_request_preempts_a_secondary_overview_waiting_for_the_decode_gate() {
        let dir = scratch("player-preempts-secondary");
        let audio = dir.join("track.wav");
        let cache_dir = dir.join("cache");
        write_test_wav_seconds(&audio, 2);
        let library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let coordinator = WaveformCoordinator::new(library);
        let gate = Arc::clone(&coordinator.interactive_detail_gate)
            .acquire_owned()
            .await
            .unwrap();

        let secondary_coord = Arc::clone(&coordinator);
        let secondary_audio = audio.clone();
        let secondary_cache = cache_dir.clone();
        let secondary = tokio::spawn(async move {
            secondary_coord
                .get_release_overview_with_intent(
                    61,
                    secondary_audio,
                    secondary_cache,
                    ReleaseOverviewIntent::Visible,
                    0,
                )
                .await
        });
        let mut secondary_admitted = false;
        for _ in 0..400 {
            secondary_admitted = coordinator
                .decode_gate_waiters
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0;
            if secondary_admitted {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            secondary_admitted,
            "secondary overview should reach the decode gate"
        );

        let player_coord = Arc::clone(&coordinator);
        let player_audio = audio.clone();
        let player_cache = cache_dir.clone();
        let player = tokio::spawn(async move {
            player_coord
                .get_release_overview_with_intent(
                    62,
                    player_audio,
                    player_cache,
                    ReleaseOverviewIntent::Player,
                    2_000,
                )
                .await
        });

        let secondary_error = tokio::time::timeout(std::time::Duration::from_secs(2), secondary)
            .await
            .expect("secondary overview should yield while still waiting for the decode gate")
            .unwrap()
            .unwrap_err();
        assert!(format!("{secondary_error:#}").contains(FULL_TRACK_WAVEFORM_DEFERRED_WHILE_PLAYING));
        drop(gate);

        let latest = tokio::time::timeout(std::time::Duration::from_secs(10), player)
            .await
            .expect("PlayerBar overview should acquire the released decode gate")
            .unwrap()
            .unwrap();
        assert_eq!(latest.track_id, 62);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_or_misaligned_cache_is_rejected() {
        let dir = scratch("invalid");
        let path = dir.join("bad.kdwave");
        std::fs::write(&path, CACHE_MAGIC).unwrap();
        assert!(read_cache(&path).is_none(), "只有魔数的半截文件不能通过");

        let bad = Waveform {
            track_id: 1,
            duration: 3.0,
            amp: vec![0.5],
            r: vec![],
            g: vec![1],
            b: vec![2],
            ..Default::default()
        };
        assert!(encode_cache(&bad).is_err(), "通道错位不能写进缓存");

        let key = WaveKey {
            track_id: 1,
            buckets: RELEASE_OVERVIEW_BUCKETS,
            mtime: 7,
        };
        let wrong_density = Waveform {
            track_id: 1,
            duration: 3.0,
            amp: vec![0.25; 2_000],
            r: vec![255; 2_000],
            g: vec![64; 2_000],
            b: vec![32; 2_000],
            ..Default::default()
        };
        write_cache(&release_overview_cache_path(&dir, key), &wrong_density).unwrap();
        assert!(
            read_release_overview_cached(&dir, key).is_none(),
            "文件名升级后不能继续读取内部仍为旧密度的缓存"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
