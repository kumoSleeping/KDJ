use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kdj_core::work_scheduler::{work_scheduler, AudioPressure};
use kdj_core::FilterResonance;
#[cfg(test)]
use kdj_player::DecodedTrack;
use kdj_player::{
    decode_file_streaming_looped, decode_live_stem_streaming, decode_source_streaming_looped,
    run_pitch_preserving_pipeline, DeckId, LoopWindow, PlayerMode, RtCommand, StemFrame,
    StreamMetadata, StreamSeekControl, StreamSource, StreamWriter, TempoControl, TransitionPlan,
    DEFAULT_FILTER_RESONANCE_Q, DEFAULT_STREAM_BUFFER_SECONDS, FILTER_RESONANCE_HIGH_Q,
    FILTER_RESONANCE_LOW_Q, FILTER_RESONANCE_MEDIUM_Q, STEM_GAIN_MAX,
};
#[cfg(test)]
use kdj_stems::record_stem_output_underrun;
use kdj_stems::{
    acquire_stem_pool, stem_output_underruns_by_deck, stem_runtime_diagnostics, StemInferencePool,
    StemPoolGuard,
};

use crate::contract::{
    CommandAck, PlaybackCommand, PlaybackLevels, PlaybackPhase, PlaybackSnapshot, PlaybackSource,
    PlaybackSourceKind, PlaybackTransitionPlan,
};
use crate::platform::{CpalOutputFactory, PlaybackOutput, PlaybackOutputFactory};
use crate::remote_source::{is_loopback_http_url, HttpRangeSource};

const ACTOR_TICK: Duration = Duration::from_millis(10);
/// Seeking 时加密轮询，尽快提权已就绪的 shadow Deck（不降低预缓冲）。
const SEEK_ACTOR_TICK: Duration = Duration::from_millis(1);
const STATE_INTERVAL: Duration = Duration::from_millis(100);
/// 电平表专用的高频轻量事件节奏（全量快照仍保持 STATE_INTERVAL，避免全局重渲染）。
const LEVEL_INTERVAL: Duration = Duration::from_millis(33);
const ACK_TIMEOUT: Duration = Duration::from_secs(2);
// A long raw PCM ring absorbs decode/network jitter. The final post-Rubber-Band ring is
// intentionally short, so a new fader target cannot wait behind seconds of old-tempo PCM.
const TEMPO_OUTPUT_BUFFER_MS: u64 = 160;
const STARTUP_BUFFER_MS: u64 = 120;
const SEEK_BUFFER_MS: u64 = 120;
// ByteDance inference and tile assembly stay outside the callback. Once a fixed tile is ready, this
// short post-tempo ring absorbs scheduler jitter without retaining seconds of stale controls.
const STEM_TEMPO_OUTPUT_BUFFER_MS: u64 = 640;
/// ORG remains audible throughout a cache miss. Replace it only after ByteDance has produced a bounded
/// quarter-second cushion from the context-safe centre of its fixed tile.
const STEM_STARTUP_BUFFER_MS: u64 = 250;
const STEM_SEEK_STARTUP_BUFFER_MS: u64 = 250;
/// 同曲 seek 的互补平滑换手时长：短到无感，长到足以消掉随机采样点之间的阶跃。
const SEEK_HANDOFF_MS: u64 = 5;
/// Below this wall-clock error a decoder replacement costs more than the residual phase offset.
const SYNC_PHASE_TOLERANCE_SEC: f64 = 0.003;
/// A pending replacement even a few milliseconds away must not publish the outgoing decoder.
/// 50ms used to let SYNC phase-align seeks leak the old playhead, which the UI interpolated
/// as the needle and beat grid reversing under a centered playhead.
const LIVE_CLOCK_SAME_ORIGIN_SEC: f64 = 0.008;
const TRANSPORT_FADE_MS: u64 = 120;
/// Edge-jog pitch bend persists just long enough for consecutive rotary packets to feel smooth,
/// then automatically returns to the deck's actual TEMPO without a frontend timer race.
const JOG_NUDGE_HOLD: Duration = Duration::from_millis(90);
const JOG_NUDGE_MAX_RATE_OFFSET: f32 = 0.18;
/// A prepared replacement is aligned to the still-running original Deck. Late cache output is
/// skipped forward; the transport clock is never pulled backwards.
const STEM_HANDOFF_EARLY_SEC: f64 = 0.002;
const STEM_HANDOFF_ALIGN_SEC: f64 = 0.02;
const STEM_HANDOFF_KEEP_MS: u64 = 80;
/// After discarding a late tile down to the keep floor, wait this long for the stretch worker to
/// refill from the same model window. A longer wait used to chase the next Spleeter tile forever.
const STEM_SEEK_CATCHUP_STALL: Duration = Duration::from_millis(40);
const STEM_RECOVERY_BASE_DELAY: Duration = Duration::from_millis(900);
const STEM_RECOVERY_MAX_DELAY: Duration = Duration::from_secs(8);
const AUDIO_CRITICAL_BUFFER_MS: u64 = 30;
const AUDIO_LOW_BUFFER_MS: u64 = 90;
const STEM_AUDIO_LOW_BUFFER_MS: u64 = 300;
const AUDIO_RECOVER_BUFFER_MS: u64 = 130;
const STEM_AUDIO_RECOVER_BUFFER_MS: u64 = 450;

type CommandReply = SyncSender<Result<CommandAck, String>>;
type StateReply = SyncSender<PlaybackSnapshot>;
type StateEmitter = Arc<dyn Fn(PlaybackSnapshot) + Send + Sync>;
type LevelEmitter = Arc<dyn Fn(PlaybackLevels) + Send + Sync>;

pub struct PlaybackCoordinator {
    sender: Sender<Request>,
    next_command_id: AtomicU64,
}

impl PlaybackCoordinator {
    pub fn spawn(emit: impl Fn(PlaybackSnapshot) + Send + Sync + 'static) -> Result<Self, String> {
        Self::spawn_with_factory(emit, Arc::new(CpalOutputFactory))
    }

    pub fn spawn_with_factory(
        emit: impl Fn(PlaybackSnapshot) + Send + Sync + 'static,
        output_factory: Arc<dyn PlaybackOutputFactory>,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let actor_sender = sender.clone();
        let emitter: StateEmitter = Arc::new(emit);
        std::thread::Builder::new()
            .name("kdj-playback-coordinator".into())
            .spawn(move || Actor::new(actor_sender, receiver, emitter, output_factory).run())
            .map_err(|error| format!("启动播放协调器失败：{error}"))?;
        Ok(Self {
            sender,
            next_command_id: AtomicU64::new(1),
        })
    }

    pub fn submit(&self, command: PlaybackCommand) -> Result<CommandAck, String> {
        let command_id = self.next_command_id.fetch_add(1, Ordering::Relaxed);
        self.submit_with_id(command_id, command)
    }

    pub fn submit_with_id(
        &self,
        command_id: u64,
        command: PlaybackCommand,
    ) -> Result<CommandAck, String> {
        self.next_command_id
            .fetch_max(command_id.saturating_add(1), Ordering::Relaxed);
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Command {
                command_id,
                command,
                reply,
            })
            .map_err(|_| "播放协调器已经退出".to_string())?;
        response
            .recv_timeout(ACK_TIMEOUT)
            .map_err(|_| "播放协调器没有及时确认命令".to_string())?
    }

    /// Platform media keys are an independent command source. They must not consume or collide
    /// with frontend command IDs, whose monotonic sequence is used to de-duplicate Tauri invokes.
    pub fn submit_platform(&self, command: PlaybackCommand) -> Result<CommandAck, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Request::PlatformCommand { command, reply })
            .map_err(|_| "播放协调器已经退出".to_string())?;
        response
            .recv_timeout(ACK_TIMEOUT)
            .map_err(|_| "播放协调器没有及时确认系统媒体命令".to_string())?
    }

    /// 订阅高频轻量电平事件（~30Hz），供表桥直接驱动电平表，绕开全量快照的 10Hz 节奏。
    pub fn subscribe_levels(&self, emit: impl Fn(PlaybackLevels) + Send + Sync + 'static) {
        let _ = self.sender.send(Request::SubscribeLevels(Arc::new(emit)));
    }

    pub fn snapshot(&self) -> Result<PlaybackSnapshot, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender
            .send(Request::State { reply })
            .map_err(|_| "播放协调器已经退出".to_string())?;
        response
            .recv_timeout(ACK_TIMEOUT)
            .map_err(|_| "播放协调器没有及时返回状态".to_string())
    }
}

impl Drop for PlaybackCoordinator {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Shutdown);
    }
}

enum Request {
    Command {
        command_id: u64,
        command: PlaybackCommand,
        reply: CommandReply,
    },
    PlatformCommand {
        command: PlaybackCommand,
        reply: CommandReply,
    },
    State {
        reply: StateReply,
    },
    WorkerFinished {
        deck: DeckId,
        revision: u64,
        result: Result<StreamMetadata, String>,
    },
    DeviceError(String),
    SubscribeLevels(LevelEmitter),
    Shutdown,
}

#[derive(Clone)]
enum PlaybackStream {
    Stereo(Arc<StreamSource>),
    Stems(Arc<StreamSource<StemFrame>>),
}

impl PlaybackStream {
    fn buffered_frames(&self) -> u64 {
        match self {
            Self::Stereo(source) => source.buffered_frames(),
            Self::Stems(source) => source.buffered_frames(),
        }
    }

    fn ended(&self) -> bool {
        match self {
            Self::Stereo(source) => source.ended(),
            Self::Stems(source) => source.ended(),
        }
    }

    fn drained(&self) -> bool {
        match self {
            Self::Stereo(source) => source.drained(),
            Self::Stems(source) => source.drained(),
        }
    }

    fn discard_frames(&self, frames: u64) -> u64 {
        match self {
            Self::Stereo(source) => source.discard_frames(frames),
            Self::Stems(source) => source.discard_frames(frames),
        }
    }
}

enum PlaybackStreamWriter {
    Stereo(StreamWriter),
    Stems(StreamWriter<StemFrame>),
}

#[derive(Clone)]
struct DeckRuntime {
    source_id: u64,
    source: PlaybackStream,
    request: PlaybackSource,
    tempo: TempoControl,
    output_sample_rate: u32,
    loop_playback: Option<LoopPlayback>,
    /// Per-worker cancel epoch. Seek/STEM replacements create a new pending worker without
    /// storing 0 here, so the audible decoder keeps filling its ring until promote.
    cancel: Arc<AtomicU64>,
    /// Deck seek. First enablement may bridge through ORG; an active STEM seek uses a shadow stream.
    seek: StreamSeekControl,
}

/// Transport loop on the current source. Times are track seconds, not a replacement slice.
#[derive(Clone, Copy)]
struct LoopPlayback {
    start: f64,
    length: f64,
}

impl DeckRuntime {
    fn frame_for_seconds(&self, seconds: f64) -> u64 {
        (seconds.max(0.0) * f64::from(self.output_sample_rate)).round() as u64
    }

    fn seconds_for_frame(&self, frame: u64) -> f64 {
        frame as f64 / f64::from(self.output_sample_rate)
    }

    fn duration(&self) -> f64 {
        self.request.duration.unwrap_or(0.0).max(0.0)
    }
}

#[derive(Clone, Copy)]
struct PendingTransition {
    position: f64,
    seconds: f64,
    plan: PlaybackTransitionPlan,
}

#[derive(Clone, Copy)]
enum Activation {
    Hard,
    Seek,
    Transition(PendingTransition),
}

#[derive(Debug)]
enum StemHandoff {
    Install,
    Wait,
    RetargetClocked(ClockedDeckSeek),
    RetargetFollowing(f64),
}

/// A playing same-track seek is prepared in shadow, but its destination belongs to the command
/// clock rather than to the outgoing (possibly off-grid) Deck clock. At `promote_at`, `position`
/// is the exact media position that should become audible. A late promotion skips output-time
/// frames from that anchor instead of snapping back to the old Deck's fixed phase error.
#[derive(Clone, Copy, Debug)]
struct ClockedDeckSeek {
    requested_at: Instant,
    requested_position: f64,
    promote_at: Instant,
    position: f64,
    rate: f32,
    advancing: bool,
    skipped_output_frames: u64,
    skipped_media_frames: f64,
    catchup_progress_at: Option<Instant>,
}

struct PendingStream {
    revision: u64,
    source: PlaybackStream,
    request: PlaybackSource,
    tempo: TempoControl,
    output_sample_rate: u32,
    startup_buffer_frames: u64,
    activation: Option<Activation>,
    cancel: Arc<AtomicU64>,
    /// After an instant stereo seek lands, start the live STEM worker without holding the jump.
    followup_stems: bool,
    /// A moved capacitive platter keeps the outgoing source frozen until this replacement has a
    /// decoded cushion. Promotion releases it without changing logical Play/Pause intent.
    release_scratch_hold: bool,
    clocked_seek: Option<ClockedDeckSeek>,
    seek: StreamSeekControl,
}

struct DeferredStream {
    request: PlaybackSource,
    activation: Option<Activation>,
}

#[derive(Clone)]
struct StemRecovery {
    track_id: i64,
    cache_path: String,
    mask: u8,
    gains: [f32; 4],
    attempts: u32,
    next_attempt: Instant,
    in_flight: bool,
}

#[derive(Clone, Copy, Debug)]
struct DeckMixer {
    channel_gain: f32,
    trim_db: f32,
    low_db: f32,
    mid_db: f32,
    high_db: f32,
    filter: f32,
}

impl Default for DeckMixer {
    fn default() -> Self {
        Self {
            channel_gain: 1.0,
            trim_db: 0.0,
            low_db: 0.0,
            mid_db: 0.0,
            high_db: 0.0,
            filter: 0.0,
        }
    }
}

struct Actor {
    sender: Sender<Request>,
    receiver: Receiver<Request>,
    emit: StateEmitter,
    output_factory: Arc<dyn PlaybackOutputFactory>,
    player: Option<Box<dyn PlaybackOutput>>,
    decks: [Option<DeckRuntime>; 2],
    pending: [Option<PendingStream>; 2],
    revisions: [u64; 2],
    revision_fences: [Arc<AtomicU64>; 2],
    loop_windows: [Arc<LoopWindow>; 2],
    next_revision: u64,
    front: DeckId,
    retire_after_transition: Option<DeckId>,
    deferred_stream: Option<DeferredStream>,
    state: PlaybackSnapshot,
    last_emitted: PlaybackSnapshot,
    last_state_tick: Instant,
    level_emit: Option<LevelEmitter>,
    last_level_tick: Instant,
    latest_levels: PlaybackLevels,
    volume: f32,
    eq: (f32, f32),
    filter_resonance: f32,
    manual_mode: bool,
    manual_desired_playing: [bool; 2],
    scratch_held: [bool; 2],
    jog_nudge_until: [Option<Instant>; 2],
    deck_mixers: [DeckMixer; 2],
    stem_pool: Option<(PathBuf, Arc<StemInferencePool>, StemPoolGuard)>,
    observed_stem_underruns: [u64; 2],
    stem_recoveries: [Option<StemRecovery>; 2],
    shutdown: bool,
    queue: Vec<PlaybackSource>,
}

impl Actor {
    fn new(
        sender: Sender<Request>,
        receiver: Receiver<Request>,
        emit: StateEmitter,
        output_factory: Arc<dyn PlaybackOutputFactory>,
    ) -> Self {
        let mut actor = Self {
            sender,
            receiver,
            emit,
            output_factory,
            player: None,
            decks: [None, None],
            pending: [None, None],
            revisions: [0, 0],
            revision_fences: [Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0))],
            loop_windows: [Arc::new(LoopWindow::new()), Arc::new(LoopWindow::new())],
            next_revision: 1,
            front: DeckId::A,
            retire_after_transition: None,
            deferred_stream: None,
            state: PlaybackSnapshot::default(),
            last_emitted: PlaybackSnapshot::default(),
            last_state_tick: Instant::now(),
            level_emit: None,
            last_level_tick: Instant::now(),
            latest_levels: PlaybackLevels::default(),
            volume: 1.0,
            eq: (0.0, 0.0),
            filter_resonance: DEFAULT_FILTER_RESONANCE_Q,
            manual_mode: false,
            manual_desired_playing: [false; 2],
            scratch_held: [false; 2],
            jog_nudge_until: [None, None],
            deck_mixers: [DeckMixer::default(); 2],
            stem_pool: None,
            observed_stem_underruns: stem_output_underruns_by_deck(),
            stem_recoveries: [None, None],
            shutdown: false,
            queue: Vec::new(),
        };
        if let Err(error) = actor.open_output() {
            actor.fail(error);
        }
        actor
    }

    fn run(mut self) {
        self.publish(true);
        while !self.shutdown {
            let tick = if self.awaiting_seek_promotion() {
                SEEK_ACTOR_TICK
            } else {
                ACTOR_TICK
            };
            match self.receiver.recv_timeout(tick) {
                Ok(request) => self.handle(request),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.release_expired_jog_nudges();
            self.promote_ready_streams();
            self.release_stem_pool_if_idle();
            self.refresh_from_audio();
            self.publish_levels();
            self.publish_audio_pressure();
            self.protect_audio_from_stem_underrun();
            self.retry_interrupted_stems();
            self.publish(false);
        }
        self.invalidate(DeckId::A);
        self.invalidate(DeckId::B);
        self.player.take();
        work_scheduler().set_audio_pressure(AudioPressure::Normal);
    }

    fn awaiting_seek_promotion(&self) -> bool {
        self.state.phase == PlaybackPhase::Seeking
            || self.pending.iter().enumerate().any(|(index, pending)| {
                pending.as_ref().is_some_and(|pending| {
                    matches!(pending.activation, Some(Activation::Seek))
                        || self.decks[index].is_some()
                })
            })
    }

    fn handle(&mut self, request: Request) {
        match request {
            Request::Command {
                command_id,
                command,
                reply,
            } => {
                if command_id <= self.state.last_command_id {
                    let _ = reply.send(Ok(CommandAck {
                        command_id,
                        accepted_sequence: self.state.sequence,
                        snapshot: self.state.clone(),
                    }));
                    return;
                }
                // TEMPO is a continuous control, not a transport transition. Its acknowledgement
                // must still be ordered, but force-emitting a full snapshot for every pointer
                // sample makes the WebView re-render every waveform rail at mouse-event rate.
                let immediate_snapshot = !matches!(
                    &command,
                    PlaybackCommand::SetDeckRate { .. }
                        | PlaybackCommand::SetDeckRates { .. }
                        | PlaybackCommand::NudgeDeck { .. }
                        | PlaybackCommand::ScratchDeck { .. }
                        | PlaybackCommand::SetDeckStems { .. }
                        | PlaybackCommand::SetDeckFx { .. }
                );
                let result = self.apply_command(command_id, command).map(|()| {
                    self.bump_sequence();
                    self.publish(immediate_snapshot);
                    CommandAck {
                        command_id,
                        accepted_sequence: self.state.sequence,
                        snapshot: self.state.clone(),
                    }
                });
                let _ = reply.send(result);
            }
            Request::PlatformCommand { command, reply } => {
                let command_id = self.state.last_command_id;
                let immediate_snapshot = !matches!(
                    &command,
                    PlaybackCommand::SetDeckRate { .. }
                        | PlaybackCommand::SetDeckRates { .. }
                        | PlaybackCommand::NudgeDeck { .. }
                        | PlaybackCommand::ScratchDeck { .. }
                        | PlaybackCommand::SetDeckStems { .. }
                        | PlaybackCommand::SetDeckFx { .. }
                );
                let result = self.apply_command(command_id, command).map(|()| {
                    self.bump_sequence();
                    self.publish(immediate_snapshot);
                    CommandAck {
                        command_id,
                        accepted_sequence: self.state.sequence,
                        snapshot: self.state.clone(),
                    }
                });
                let _ = reply.send(result);
            }
            Request::State { reply } => {
                let before = self.state.clone();
                self.refresh_from_audio();
                if self.state != before {
                    self.bump_sequence();
                    self.publish(true);
                }
                let _ = reply.send(self.state.clone());
            }
            Request::WorkerFinished {
                deck,
                revision,
                result,
            } => {
                if self.revisions[deck as usize] != revision {
                    return;
                }
                if let Err(error) = result {
                    let failed = self.pending[deck as usize].take();
                    let activation = failed.as_ref().and_then(|pending| pending.activation);
                    let failed_stem = failed
                        .as_ref()
                        .is_some_and(|pending| pending.request.stem_enabled);
                    let releases_scratch_hold = failed
                        .as_ref()
                        .is_some_and(|pending| pending.release_scratch_hold);
                    if releases_scratch_hold {
                        // A replacement that never reached its cushion must not leave its old
                        // source frozen under the user's hand forever. Keep the original transport
                        // intent and return that still-installed source to audible playback.
                        self.release_scratch_hold(deck);
                    }
                    if activation.is_none() && self.decks[deck as usize].is_some() {
                        self.state.decks[deck as usize].buffering = false;
                        self.state.buffering = false;
                        if failed_stem {
                            // A live STEM worker is an optional replacement while the original
                            // stream stays installed. Never turn a model/cache failure into a
                            // transport command: SYNC and a platter release must leave the Deck
                            // playing its original mix rather than silently pausing it.
                            self.state.decks[deck as usize].desired_playing =
                                self.manual_desired_playing[deck as usize];
                            if self.manual_desired_playing[deck as usize] {
                                self.state.decks[deck as usize].is_playing = true;
                            }
                            self.state.desired_playing = self
                                .manual_desired_playing
                                .into_iter()
                                .any(|playing| playing);
                            self.state.is_playing =
                                self.state.decks.iter().any(|view| view.is_playing);
                            self.state.phase = if self.state.is_playing {
                                PlaybackPhase::Playing
                            } else {
                                PlaybackPhase::Paused
                            };
                            self.state.error = format!("实时 STEM 启动失败，已保留原曲：{error}");
                        } else {
                            // Switching back to explicit ORG is allowed to preserve the old
                            // runtime if its replacement decode fails.
                            self.state.error = format!("音频模式切换失败，已保留当前声音：{error}");
                        }
                    } else if activation.is_some() || deck == self.front {
                        self.fail(error);
                    } else {
                        self.state.prepared_track_id = None;
                        self.state.error = error;
                    }
                    self.bump_sequence();
                    self.publish(true);
                }
            }
            Request::SubscribeLevels(emit) => {
                self.level_emit = Some(emit);
                self.last_level_tick = Instant::now() - LEVEL_INTERVAL;
            }
            Request::DeviceError(error) => {
                self.player.take();
                self.fail(format!("系统音频设备中断：{error}"));
                self.bump_sequence();
                self.publish(true);
            }
            Request::Shutdown => self.shutdown = true,
        }
    }

    fn apply_command(&mut self, command_id: u64, command: PlaybackCommand) -> Result<(), String> {
        self.state.last_command_id = command_id;
        self.state.error.clear();
        match command {
            PlaybackCommand::Load { source } => self.load(source),
            PlaybackCommand::Prepare { source } => self.prepare(source),
            PlaybackCommand::LoadDeck { deck, source } => self.load_deck(deck, source),
            PlaybackCommand::SetQueue { sources } => {
                self.queue = sources;
                self.prewarm_queue()
            }
            PlaybackCommand::Play => self.set_playing(true),
            PlaybackCommand::Pause => self.set_playing(false),
            PlaybackCommand::PlayDeck { deck } => self.set_deck_playing(deck, true),
            PlaybackCommand::PauseDeck { deck } => self.set_deck_playing(deck, false),
            PlaybackCommand::SetDeckScratchHeld { deck, held } => {
                self.set_deck_scratch_held(deck, held)
            }
            PlaybackCommand::ScratchDeck { deck, delta } => self.scratch_deck(deck, delta),
            PlaybackCommand::SeekDeck {
                deck,
                position,
                play_when_ready,
            } => self.seek_deck_when_ready(deck, position, play_when_ready),
            PlaybackCommand::NudgeDeck { deck, amount } => self.nudge_deck(deck, amount),
            PlaybackCommand::SetDeckRate { deck, rate } => self.set_deck_rate(deck, rate),
            PlaybackCommand::SetDeckRates { rates } => self.set_deck_rates(rates),
            PlaybackCommand::SyncDeck {
                follower,
                master,
                rate,
                follower_bpm,
                follower_first_beat,
                master_bpm,
                master_first_beat,
                beats_per_bar,
            } => self.sync_deck(
                follower,
                master,
                rate,
                follower_bpm,
                follower_first_beat,
                master_bpm,
                master_first_beat,
                beats_per_bar,
            ),
            PlaybackCommand::SetDeckMixer {
                deck,
                channel_gain,
                trim_db,
                low_db,
                mid_db,
                high_db,
                filter,
            } => self.set_deck_mixer(
                deck,
                DeckMixer {
                    channel_gain,
                    trim_db,
                    low_db,
                    mid_db,
                    high_db,
                    filter,
                },
            ),
            PlaybackCommand::SetDeckFx {
                deck,
                echo,
                echo_parameter,
                reverb,
                reverb_parameter,
                gater,
                gater_parameter,
                pad,
                beat_seconds,
            } => self.set_deck_fx(
                deck,
                echo,
                echo_parameter,
                reverb,
                reverb_parameter,
                gater,
                gater_parameter,
                pad,
                beat_seconds,
            ),
            PlaybackCommand::SetFilterResonance { resonance } => {
                self.set_filter_resonance(resonance)
            }
            PlaybackCommand::SetDeckStems {
                track_id,
                enabled,
                cache_path,
                mask,
                gains,
            } => self.set_deck_stems(track_id, enabled, cache_path, mask, gains),
            PlaybackCommand::SetDeckLoop {
                track_id,
                start,
                length,
            } => self.set_deck_loop(track_id, start, length),
            PlaybackCommand::ClearDeckLoop { track_id } => self.clear_deck_loop(track_id),
            PlaybackCommand::Seek { position } => self.seek(position),
            PlaybackCommand::Handoff {
                track_id,
                position,
                seconds,
                plan,
            } => self.handoff(
                track_id,
                PendingTransition {
                    position,
                    seconds,
                    plan,
                },
            ),
            PlaybackCommand::SetVolume { volume } => self.set_volume(volume),
            PlaybackCommand::SetTransportFade { enabled } => self.set_transport_fade(enabled),
            PlaybackCommand::SetEq { low_db, high_db } => self.set_eq(low_db, high_db),
            PlaybackCommand::Dispose => {
                self.dispose();
                Ok(())
            }
        }
    }

    fn open_output(&mut self) -> Result<(), String> {
        if self.player.is_some() {
            return Ok(());
        }
        let errors = self.sender.clone();
        let mut player = self
            .output_factory
            .open(Box::new(move |error| {
                let _ = errors.send(Request::DeviceError(error));
            }))
            .map_err(|error| format!("打开系统音频输出失败：{error}"))?;
        player
            .send(RtCommand::SetMasterGain(self.volume))
            .map_err(|error| error.to_string())?;
        player
            .send(RtCommand::SetFilterResonance {
                q: self.filter_resonance,
            })
            .map_err(|error| error.to_string())?;
        self.player = Some(player);
        Ok(())
    }

    fn load(&mut self, mut source: PlaybackSource) -> Result<(), String> {
        self.open_output()?;
        validate_source(&source)?;
        self.manual_mode = false;
        self.manual_desired_playing = [false; 2];
        self.settle_transition()?;
        source.position = source.position.max(0.0);
        // 状态先落账、激活后执行：一旦激活失败必须整体回滚，
        // 否则状态层声称新曲目、硬件却还在旧 Deck 上发声。
        let checkpoint = self.state.clone();
        self.state.desired_playing = source.autoplay;
        self.state.phase = PlaybackPhase::Loading;
        self.state.track_id = Some(source.track_id);
        self.adopt_metadata(&source);
        self.state.prepared_track_id = None;
        self.state.current_time = source.position;
        self.state.duration = source.duration.unwrap_or(0.0).max(0.0);
        self.state.rate = source.rate;
        self.state.buffering = true;
        self.state.transitioning = false;

        let result = if let Some(deck) = self.reusable_deck(&source) {
            self.activate(deck, Activation::Hard, source.position)
        } else {
            let target = self.target_deck();
            if let Some(pending) = self.pending[target as usize]
                .as_mut()
                .filter(|pending| same_source(&pending.request, &source))
            {
                pending.activation = Some(Activation::Hard);
                return Ok(());
            }
            self.start_stream(target, source, Some(Activation::Hard))
        };
        if result.is_err() {
            self.state = checkpoint;
        }
        result
    }

    fn prepare(&mut self, mut source: PlaybackSource) -> Result<(), String> {
        self.open_output()?;
        validate_source(&source)?;
        // LoadDeck 把 coordinator 交给用户直接控制的两台物理 Deck。此后普通播放器
        // 的推荐/队列 prepare 只能被忽略；它没有目标 side 所有权，若继续按
        // front.other() 预热，会 bump 掉用户刚拖入但尚未完成解码的明确装盘。
        if self.manual_mode {
            return Ok(());
        }
        source.position = source.position.max(0.0);
        if self.reusable_deck(&source).is_some()
            || self
                .pending
                .iter()
                .flatten()
                .any(|pending| same_source(&pending.request, &source))
        {
            self.state.prepared_track_id = Some(source.track_id);
            return Ok(());
        }
        if self.retire_after_transition.is_some() {
            // 第一场过渡尚未回收旧 Deck 时，第二场 handoff 可能已经把 deferred
            // 承诺给明确曲目。UI 换曲后会立刻刷新队列/预测并再次 prepare；这里若
            // 无条件覆盖 deferred，第二场激活就永久丢失，表现为底栏到了下一首而
            // 声音仍停在上一首。已带激活的延迟流和 pending 一样，后台预热必须让路。
            if self
                .deferred_stream
                .as_ref()
                .is_some_and(|deferred| deferred.activation.is_some())
            {
                return Ok(());
            }
            self.state.prepared_track_id = Some(source.track_id);
            self.deferred_stream = Some(DeferredStream {
                request: source,
                activation: None,
            });
            return Ok(());
        }
        let target = self.front.other();
        // 目标 Deck 已承诺给换曲/跳转/接歌（带激活的待启用流）时，后台预热必须让路：
        // 顶掉它会连同激活一起丢掉——状态已指向新曲目，却再没有人激活它，
        // 结果就是界面显示新歌、喇叭里还是旧歌。预热放弃本轮即可，
        // 下一次 activate/prewarm 会重新挑歌准备。
        if self.pending[target as usize]
            .as_ref()
            .is_some_and(|pending| pending.activation.is_some())
        {
            return Ok(());
        }
        self.state.prepared_track_id = Some(source.track_id);
        self.start_stream(target, source, None)
    }

    fn load_deck(&mut self, deck: u8, mut source: PlaybackSource) -> Result<(), String> {
        self.open_output()?;
        validate_source(&source)?;
        let deck = deck_id(deck)?;
        self.stem_recoveries[deck as usize] = None;
        self.clear_jog_nudge(deck);
        self.release_scratch_hold(deck);
        self.settle_transition()?;
        self.enter_manual_mode();
        source.position = clamp_position(source.position, source.duration);
        self.manual_desired_playing[deck as usize] = source.autoplay;
        let view = &mut self.state.decks[deck as usize];
        view.track_id = Some(source.track_id);
        view.current_time = source.position;
        view.duration = source.duration.unwrap_or(0.0).max(0.0);
        view.desired_playing = source.autoplay;
        view.is_playing = false;
        view.rate = source.rate;
        view.buffering = true;
        // ByteDance is a background tile model. Even an explicit STEM load starts with ORG and records
        // a follow-up request; only a context-safe prepared cushion may replace it.
        self.start_original_with_optional_stem_followup(deck, source, None, true)
    }

    fn set_deck_playing(&mut self, deck: u8, playing: bool) -> Result<(), String> {
        let deck = deck_id(deck)?;
        if !playing {
            self.clear_jog_nudge(deck);
            self.cancel_clocked_deck_seek(deck);
        }
        let request = self
            .source_for_deck(deck)
            .ok_or_else(|| "目标 Deck 尚未装入曲目".to_string())?;
        self.enter_manual_mode();
        let index = deck as usize;
        if self.scratch_held[index] {
            // An explicit transport button supersedes a momentary platter gesture. Clear the
            // callback hold first; `SetDeckPlaying` then remains the only Play/Pause mutation.
            self.send(RtCommand::SetDeckScratchHeld { deck, held: false })?;
            self.scratch_held[index] = false;
        }
        self.manual_desired_playing[index] = playing;
        self.state.decks[index].desired_playing = playing;
        if self.decks[index].is_some() {
            self.send(RtCommand::SetMode(PlayerMode::RealtimeDj))?;
            self.send(RtCommand::SetDeckPlaying { deck, playing })?;
            self.state.decks[index].is_playing = playing;
        }
        self.front = deck;
        let current_time = self.state.decks[index].current_time;
        let duration = self.decks[index]
            .as_ref()
            .map(DeckRuntime::duration)
            .unwrap_or_else(|| request.duration.unwrap_or(0.0).max(0.0));
        self.state.track_id = Some(request.track_id);
        self.adopt_metadata(&request);
        self.state.current_time = current_time;
        self.state.duration = duration;
        self.state.rate = request.rate;
        self.state.buffering = self.state.decks[index].buffering;
        self.state.desired_playing = self.manual_desired_playing.into_iter().any(|value| value);
        self.state.is_playing = self.state.decks.iter().any(|deck| deck.is_playing);
        self.state.phase = if self.state.is_playing {
            PlaybackPhase::Playing
        } else if self.state.track_id.is_some() {
            PlaybackPhase::Paused
        } else {
            PlaybackPhase::Idle
        };
        Ok(())
    }

    fn set_deck_scratch_held(&mut self, deck: u8, held: bool) -> Result<(), String> {
        let deck = deck_id(deck)?;
        let index = deck as usize;
        if !held {
            self.release_scratch_hold(deck);
            return Ok(());
        }
        if self.decks[index].is_none() {
            return Err("目标 Deck 尚未装入曲目".to_string());
        }
        self.cancel_clocked_deck_seek(deck);
        // A jog touch is a source-cursor hold, not a hidden PauseDeck command.
        self.enter_manual_mode();
        // `enter_manual_mode` is a no-op when already manual, so a stale false intent must not
        // ignore a Deck that is actually playing. Touching that platter used to freeze only the
        // waveform while the callback kept walking, and note-off jumped to "where it would have been".
        let playing = self.manual_desired_playing[index]
            || self.state.decks[index].is_playing
            || self.state.decks[index].desired_playing;
        if !playing {
            return Ok(());
        }
        self.manual_desired_playing[index] = true;
        self.state.decks[index].desired_playing = true;
        self.clear_jog_nudge(deck);
        self.send(RtCommand::SetMode(PlayerMode::RealtimeDj))?;
        self.send(RtCommand::SetDeckScratchHeld { deck, held: true })?;
        self.scratch_held[index] = true;
        Ok(())
    }

    fn release_scratch_hold(&mut self, deck: DeckId) {
        let index = deck as usize;
        if !self.scratch_held[index] {
            return;
        }
        let _ = self.send(RtCommand::SetDeckScratchHeld { deck, held: false });
        self.scratch_held[index] = false;
    }

    fn seek_deck(&mut self, deck: u8, position: f64) -> Result<(), String> {
        self.seek_deck_when_ready(deck, position, false)
    }

    fn seek_deck_when_ready(
        &mut self,
        deck: u8,
        position: f64,
        play_when_ready: bool,
    ) -> Result<(), String> {
        if !position.is_finite() || position < 0.0 {
            return Err("播放位置无效".into());
        }
        let deck = deck_id(deck)?;
        self.clear_jog_nudge(deck);
        // 自动接歌模式下 manual_desired_playing 还没有接管两台 Deck。先从真实
        // snapshot 继承走带状态，再重建流；否则第一次点 Hot Cue / scratch 会把
        // 正在播放的 Deck 当成 false，seek 完就意外停住。
        self.enter_manual_mode();
        let index = deck as usize;
        let release_scratch_hold = self.scratch_held[index];
        if play_when_ready {
            // Do not send SetDeckPlaying here. A paused ordinary Deck may request a resume at
            // promotion time, while a held playing Deck already retains its true transport intent.
            self.manual_desired_playing[index] = true;
            self.state.decks[index].desired_playing = true;
        }
        let Some(mut source) = self.source_for_deck(deck) else {
            if release_scratch_hold {
                self.release_scratch_hold(deck);
            }
            return Err("目标 Deck 没有可重建的音频源".to_string());
        };
        source.position = clamp_position(position, source.duration);
        source.autoplay = self.manual_desired_playing[index];
        let view = &mut self.state.decks[index];
        view.current_time = source.position;
        // Keep the live decoder audible while the new position buffers. Marking buffering here
        // used to freeze the transport UI for the whole time-stretcher startup window.
        view.buffering = self.decks[deck as usize].is_none();
        // Keep an already-separated Deck separated across Hot Cue/SYNC. Its current STEM source
        // remains audible while a shadow ByteDance stream prepares near the future handoff point.
        // Routing this case through ORG made STEM EQ appear reset and doubled SYNC model work.
        let replacing_live_stems = source.stem_enabled
            && self.decks[index].as_ref().is_some_and(|runtime| {
                runtime.request.stem_enabled && runtime.request.track_id == source.track_id
            });
        if replacing_live_stems && self.live_stem_instant_ready(deck) {
            let result = self
                .retarget_live_stems(deck, source.track_id, source.position)
                .and_then(|retargeted| {
                    if retargeted {
                        Ok(())
                    } else {
                        Err("活动 STEM Deck 无法原地跳转".to_string())
                    }
                });
            if release_scratch_hold {
                self.release_scratch_hold(deck);
            }
            return result;
        }
        if replacing_live_stems {
            let clocked_seek = clocked_deck_seek(
                source.position,
                source.rate,
                source.duration,
                self.manual_desired_playing[index],
                true,
            );
            source.position = clocked_seek.position;
            let result = self.start_stream(deck, source, None);
            if result.is_ok() {
                if let Some(pending) = self.pending[index].as_mut() {
                    pending.clocked_seek = Some(clocked_seek);
                }
            }
            if result.is_ok() && release_scratch_hold {
                if let Some(pending) = self.pending[index].as_mut() {
                    pending.release_scratch_hold = true;
                }
            } else if result.is_err() && release_scratch_hold {
                self.release_scratch_hold(deck);
            }
            return result;
        }
        // A first STEM start still uses ORG as its audible bridge. Only a Deck that already owns
        // a live four-lane stream takes the shadow STEM→STEM path above.
        if source.stem_enabled {
            let clocked_seek = clocked_deck_seek(
                source.position,
                source.rate,
                source.duration,
                self.manual_desired_playing[index],
                false,
            );
            source.position = clocked_seek.position;
            let result = self.start_original_with_optional_stem_followup(deck, source, None, true);
            if result.is_ok() {
                if let Some(pending) = self.pending[index].as_mut() {
                    pending.clocked_seek = Some(clocked_seek);
                }
            }
            if result.is_ok() && release_scratch_hold {
                if let Some(pending) = self.pending[index].as_mut() {
                    pending.release_scratch_hold = true;
                }
            } else if result.is_err() && release_scratch_hold {
                self.release_scratch_hold(deck);
            }
            return result;
        }
        if self.retarget_live_stems(deck, source.track_id, source.position)? {
            if release_scratch_hold {
                self.release_scratch_hold(deck);
            }
            return Ok(());
        }
        let clocked_seek = clocked_deck_seek(
            source.position,
            source.rate,
            source.duration,
            self.manual_desired_playing[index],
            false,
        );
        source.position = clocked_seek.position;
        let result = self.start_original_with_optional_stem_followup(deck, source, None, true);
        match result {
            Ok(()) => {
                if let Some(pending) = self.pending[index].as_mut() {
                    pending.clocked_seek = Some(clocked_seek);
                }
                if release_scratch_hold {
                    if let Some(pending) = self.pending[index].as_mut() {
                        pending.release_scratch_hold = true;
                    }
                }
                Ok(())
            }
            Err(error) => {
                if release_scratch_hold {
                    self.release_scratch_hold(deck);
                }
                Err(error)
            }
        }
    }

    fn scratch_deck(&mut self, deck: u8, delta: f64) -> Result<(), String> {
        let deck = deck_id(deck)?;
        if !delta.is_finite() || delta == 0.0 {
            return Ok(());
        }
        let index = deck as usize;
        // A jog packet is never an implicit load. Ignore ticks that arrive before the source
        // exists instead of rebuilding a decoder for every relative CC.
        if self.decks[index].is_none() {
            return Ok(());
        }
        if !self.scratch_held[index] {
            return Ok(());
        }
        let sample_rate = self.decks[index]
            .as_ref()
            .expect("checked installed Deck before converting platter delta")
            .output_sample_rate
            .max(1);
        self.send(RtCommand::ScratchDeck {
            deck,
            delta_frames: delta * f64::from(sample_rate),
        })?;
        let duration = self.state.decks[index].duration;
        let next = (self.state.decks[index].current_time + delta).max(0.0);
        self.state.decks[index].current_time = if duration > 0.0 {
            next.min(duration)
        } else {
            next
        };
        if deck == self.front {
            self.state.current_time = self.state.decks[index].current_time;
        }
        Ok(())
    }

    fn nudge_deck(&mut self, deck: u8, amount: f32) -> Result<(), String> {
        let deck = deck_id(deck)?;
        if !amount.is_finite() {
            return Err("缓动盘偏移量无效".into());
        }
        let index = deck as usize;
        // A jog wheel is a realtime control, not an implicit load request. Ignore its early
        // packets while a track is still being installed instead of restarting that install.
        if self.decks[index].is_none() {
            return Ok(());
        }
        self.enter_manual_mode();
        let runtime = self.decks[index]
            .as_mut()
            .expect("checked installed Deck before entering manual mode");
        let amount = amount.clamp(-1.0, 1.0);
        let rate =
            (runtime.request.rate * (1.0 + amount * JOG_NUDGE_MAX_RATE_OFFSET)).clamp(0.5, 2.0);
        runtime.tempo.set(rate);
        self.send(RtCommand::SetRate { deck, rate })?;
        self.jog_nudge_until[index] = Some(Instant::now() + JOG_NUDGE_HOLD);
        Ok(())
    }

    fn retarget_live_stems(
        &mut self,
        deck: DeckId,
        track_id: i64,
        position: f64,
    ) -> Result<bool, String> {
        let index = deck as usize;
        if let Some(pending) = self.pending[index].as_mut() {
            if pending.request.stem_enabled && pending.request.track_id == track_id {
                let position = clamp_position(position, pending.request.duration);
                pending.request.position = position;
                pending.seek.request(position);
                self.state.decks[index].current_time = position;
                self.state.decks[index].buffering = false;
                if deck == self.front {
                    self.state.current_time = position;
                    self.state.buffering = false;
                }
                return Ok(true);
            }
            return Ok(false);
        }
        let Some(runtime) = self.decks[index].as_mut() else {
            return Ok(false);
        };
        if !runtime.request.stem_enabled || runtime.request.track_id != track_id {
            return Ok(false);
        }
        let position = clamp_position(position, runtime.request.duration);
        runtime.request.position = position;
        runtime.seek.request(position);
        let frame = runtime.frame_for_seconds(position);
        self.send(RtCommand::SeekPrepared { deck, frame })?;
        self.state.decks[index].current_time = position;
        self.state.decks[index].buffering = false;
        if deck == self.front {
            self.state.current_time = position;
            self.state.buffering = false;
        }
        Ok(true)
    }

    fn start_original_with_optional_stem_followup(
        &mut self,
        deck: DeckId,
        mut source: PlaybackSource,
        activation: Option<Activation>,
        keep_original_audible: bool,
    ) -> Result<(), String> {
        let followup_stems = source.stem_enabled && keep_original_audible;
        if followup_stems {
            source.stem_enabled = false;
        }
        self.start_stream(deck, source, activation)?;
        if followup_stems {
            if let Some(pending) = self.pending[deck as usize].as_mut() {
                pending.followup_stems = true;
            }
        }
        Ok(())
    }

    fn set_deck_rate(&mut self, deck: u8, rate: f32) -> Result<(), String> {
        if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
            return Err("播放速度必须在 0.5 到 2.0 之间".into());
        }
        let deck = deck_id(deck)?;
        self.clear_jog_nudge(deck);
        self.cancel_clocked_deck_seek(deck);
        if self.decks[deck as usize].is_none() && self.pending[deck as usize].is_none() {
            return Err("目标曲目尚未装入 Deck".to_string());
        }
        // 同 seek：第一次从自动模式进入手动 Performance 时必须继承实际播放状态，
        // SYNC 只改 rate，不能顺带暂停正在走带的 Deck。
        self.enter_manual_mode();
        let index = deck as usize;
        let live = self.decks[index].as_ref().is_some();
        if let Some(runtime) = self.decks[index].as_mut() {
            runtime.request.rate = rate;
            runtime.tempo.set(rate);
        }
        if let Some(pending) = self.pending[index].as_mut() {
            pending.request.rate = rate;
            pending.tempo.set(rate);
        }
        self.state.decks[deck as usize].rate = rate;
        if self.front == deck {
            self.state.rate = rate;
        }
        // The Rubber Band worker sees the latest atomic target at its next input block; the
        // callback only moves the authoritative media clock. Neither side replaces a decoder or
        // source for a TEMPO/SYNC adjustment.
        if live {
            self.send(RtCommand::SetRate { deck, rate })?;
        }
        Ok(())
    }

    fn set_deck_rates(&mut self, rates: [f32; 2]) -> Result<(), String> {
        if rates
            .iter()
            .any(|rate| !rate.is_finite() || !(0.5..=2.0).contains(rate))
        {
            return Err("播放速度必须在 0.5 到 2.0 之间".into());
        }
        for deck in [DeckId::A, DeckId::B] {
            let index = deck as usize;
            if self.decks[index].is_none() && self.pending[index].is_none() {
                return Err("SYNC 关联的两首曲目必须都已装入 Deck".to_string());
            }
        }
        for deck in [DeckId::A, DeckId::B] {
            self.clear_jog_nudge(deck);
            self.cancel_clocked_deck_seek(deck);
        }
        self.enter_manual_mode();
        for deck in [DeckId::A, DeckId::B] {
            let index = deck as usize;
            let rate = rates[index];
            if let Some(runtime) = self.decks[index].as_mut() {
                runtime.request.rate = rate;
                runtime.tempo.set(rate);
            }
            if let Some(pending) = self.pending[index].as_mut() {
                pending.request.rate = rate;
                pending.tempo.set(rate);
            }
            self.state.decks[index].rate = rate;
            if self.front == deck {
                self.state.rate = rate;
            }
        }
        // One callback command is the important boundary: linked faders never create a transient
        // half-updated pair, and one actor snapshot replaces two independent 10 Hz UI echoes.
        self.send(RtCommand::SetDeckRates { rates })
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_deck(
        &mut self,
        follower: u8,
        master: u8,
        rate: f32,
        follower_bpm: f64,
        follower_first_beat: f64,
        master_bpm: f64,
        master_first_beat: f64,
        beats_per_bar: u8,
    ) -> Result<(), String> {
        let follower = deck_id(follower)?;
        let master = deck_id(master)?;
        if follower == master {
            return Err("SYNC 主从 Deck 不能相同".into());
        }
        if !rate.is_finite()
            || !(0.5..=2.0).contains(&rate)
            || !follower_bpm.is_finite()
            || follower_bpm <= 0.0
            || !master_bpm.is_finite()
            || master_bpm <= 0.0
            || !follower_first_beat.is_finite()
            || !master_first_beat.is_finite()
            || !(1..=16).contains(&beats_per_bar)
        {
            return Err("SYNC 网格参数无效".into());
        }
        let follower_index = follower as usize;
        let master_index = master as usize;
        if self.source_for_deck(follower).is_none() || self.source_for_deck(master).is_none() {
            return Err("SYNC 关联的两首曲目必须都已装入 Deck".into());
        }

        // Cancel an older shadow first, then read both callback cursors from the same transport
        // snapshot. The former WebView algorithm compared a fresh rate with positions that could
        // be almost one 100 ms state tick old, leaving a repeatable phase offset.
        self.clear_jog_nudge(follower);
        self.cancel_clocked_deck_seek(follower);
        self.enter_manual_mode();
        self.refresh_from_audio();
        let follower_position = self.state.decks[follower_index].current_time;
        let master_position = self.state.decks[master_index].current_time;
        let master_rate = self
            .source_for_deck(master)
            .map(|source| f64::from(source.rate))
            .unwrap_or(f64::from(self.state.decks[master_index].rate));
        let duration = self
            .source_for_deck(follower)
            .and_then(|source| source.duration);
        let target = sync_phase_target(SyncPhaseInput {
            follower_position,
            follower_bpm,
            follower_first_beat,
            follower_rate: f64::from(rate),
            master_position,
            master_bpm,
            master_first_beat,
            master_rate,
            beats_per_bar: f64::from(beats_per_bar),
            follower_duration: duration,
        })
        .ok_or_else(|| "SYNC 无法建立有效网格".to_string())?;

        self.set_deck_rate(follower as u8, rate)?;
        let wall_error = (target - follower_position).abs() / f64::from(rate);
        if self.manual_desired_playing[follower_index] && wall_error > SYNC_PHASE_TOLERANCE_SEC {
            self.seek_deck_when_ready(follower as u8, target, false)?;
        }
        Ok(())
    }

    fn set_deck_mixer(&mut self, deck: u8, mut mixer: DeckMixer) -> Result<(), String> {
        let deck = deck_id(deck)?;
        mixer.channel_gain = finite_clamp(mixer.channel_gain, 0.0, 1.0, 1.0);
        mixer.trim_db = finite_clamp(mixer.trim_db, -24.0, 6.0, 0.0);
        mixer.low_db = finite_clamp(mixer.low_db, -48.0, 12.0, 0.0);
        mixer.mid_db = finite_clamp(mixer.mid_db, -48.0, 12.0, 0.0);
        mixer.high_db = finite_clamp(mixer.high_db, -48.0, 12.0, 0.0);
        mixer.filter = finite_clamp(mixer.filter, -1.0, 1.0, 0.0);
        self.deck_mixers[deck as usize] = mixer;
        if self.decks[deck as usize].is_some() {
            self.apply_deck_mixer(deck, mixer)?;
        }
        Ok(())
    }

    fn set_deck_fx(
        &mut self,
        deck: u8,
        echo: f32,
        echo_parameter: f32,
        reverb: f32,
        reverb_parameter: f32,
        gater: f32,
        gater_parameter: f32,
        pad: u8,
        beat_seconds: f32,
    ) -> Result<(), String> {
        let deck = deck_id(deck)?;
        self.send(RtCommand::SetDeckFx {
            deck,
            echo: finite_clamp(echo, 0.0, 1.0, 0.0),
            echo_parameter: finite_clamp(echo_parameter, 0.0, 1.0, 0.5),
            reverb: finite_clamp(reverb, 0.0, 1.0, 0.0),
            reverb_parameter: finite_clamp(reverb_parameter, 0.0, 1.0, 0.5),
            gater: finite_clamp(gater, 0.0, 1.0, 0.0),
            gater_parameter: finite_clamp(gater_parameter, 0.0, 1.0, 0.5),
            pad: pad.min(8),
            beat_seconds: finite_clamp(beat_seconds, 0.1, 4.0, 0.5),
        })
    }

    fn set_deck_stems(
        &mut self,
        track_id: i64,
        enabled: bool,
        cache_path: String,
        mask: u8,
        gains: [f32; 4],
    ) -> Result<(), String> {
        let deck = self
            .deck_for_track(track_id)
            .ok_or_else(|| "目标曲目尚未装入 Deck".to_string())?;
        self.enter_manual_mode();
        let mask = mask & 0b1111;
        let gains = std::array::from_fn(|lane| finite_clamp(gains[lane], 0.0, STEM_GAIN_MAX, 1.0));
        if enabled && cache_path.trim().is_empty() {
            return Err("STEM runtime 路径为空".into());
        }
        let index = deck as usize;
        if !enabled {
            // An explicit ORG command cancels automatic recovery. The underrun protector restores
            // its own recovery intent only after this call has successfully queued the bridge.
            self.stem_recoveries[index] = None;
        }
        // 快速路径：Deck 已在（或正在准备）同一实时 STEM session。掩码/增益只是渲染线程的
        // 实时混音参数，直接进回调 —— 静音/滑杆在下一回调边界生效，不重启解码 worker。
        let live_same = self.decks[index].as_ref().is_some_and(|runtime| {
            runtime.request.stem_enabled && runtime.request.stem_cache_path == cache_path
        });
        let pending_same = self.pending[index].as_ref().is_some_and(|pending| {
            pending.request.stem_enabled && pending.request.stem_cache_path == cache_path
        });
        if enabled && (live_same || pending_same) {
            if let Some(runtime) = self.decks[index].as_mut() {
                runtime.request.stem_mask = mask;
                runtime.request.stem_gains = gains;
            }
            if let Some(pending) = self.pending[index].as_mut() {
                pending.request.stem_mask = mask;
                pending.request.stem_gains = gains;
            }
            if live_same {
                self.send(RtCommand::SetDeckStemGains {
                    deck,
                    gains: effective_stem_gains(mask, gains),
                })?;
            }
            return Ok(());
        }
        // 慢速路径：原曲↔实时 STEM。原曲继续发声，分轨 worker 从当前位置开始推理。
        let mut source = self
            .source_for_deck(deck)
            .ok_or_else(|| "目标 Deck 没有可重建的音频源".to_string())?;
        source.stem_enabled = enabled;
        source.stem_cache_path = cache_path;
        source.stem_mask = mask;
        source.stem_gains = gains;
        source.position = self.state.decks[deck as usize].current_time;
        source.autoplay = self.manual_desired_playing[deck as usize];
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "deck_stem_replacement_requested",
            deck = deck as u8,
            track_id,
            enabled,
            previous_stem = self.decks[index]
                .as_ref()
                .is_some_and(|runtime| runtime.request.stem_enabled),
            pending_stem = self.pending[index]
                .as_ref()
                .is_some_and(|pending| pending.request.stem_enabled),
            cache_path = %source.stem_cache_path,
            position = source.position,
            desired_playing = source.autoplay,
            "Deck STEM source replacement requested"
        );
        if enabled {
            // The worker may take a while to fill its first live STEM buffer. Seed the callback
            // before that wait instead of relying only on the post-install command below: an
            // initial EQ mute must survive the first source installation exactly as a later
            // realtime EQ move does.
            self.send(RtCommand::SetDeckStemGains {
                deck,
                gains: effective_stem_gains(mask, gains),
            })?;
        }
        // Keep the current mix audible. Pausing until the first inference block made a newly
        // loaded playing Deck go silent, so the live waveform looked like it never started.
        self.state.decks[deck as usize].buffering = self.decks[deck as usize].is_none();
        self.start_stream(deck, source, None)?;
        Ok(())
    }

    fn set_deck_loop(&mut self, track_id: i64, start: f64, length: f64) -> Result<(), String> {
        if !start.is_finite() || !length.is_finite() || start < 0.0 || length < 0.05 {
            return Err("循环区间无效".into());
        }
        if length > 180.0 {
            return Err("循环长度超出上限".into());
        }
        let deck = self
            .deck_for_track(track_id)
            .ok_or_else(|| "目标曲目尚未装入 Deck".to_string())?;
        self.cancel_clocked_deck_seek(deck);
        self.enter_manual_mode();
        let duration = self.state.decks[deck as usize].duration;
        if duration > 0.0 && start + length > duration + 0.05 {
            return Err("循环区间超出曲目长度".into());
        }
        let playhead = self.live_deck_seconds(deck);
        // The performance UI can report 0 while the engine is already mid-track (deck state
        // not yet bound). A loop starting at 0 then wrapping the live playhead would decode
        // the intro after draining the current buffer — exactly "unrelated clip, then intro".
        let start = if start < 0.05 && playhead.is_finite() && playhead > length + 0.05 {
            playhead
        } else {
            start
        };
        if duration > 0.0 && start + length > duration + 0.05 {
            return Err("循环区间超出曲目长度".into());
        }
        let stored_playhead = if playhead.is_finite() && playhead > 0.05 {
            playhead
        } else {
            start
        };
        if let Some(runtime) = self.decks[deck as usize].as_mut() {
            runtime.loop_playback = Some(LoopPlayback { start, length });
        }
        self.state.decks[deck as usize].loop_start = Some(start);
        self.state.decks[deck as usize].loop_length = Some(length);
        // Arm the callback loop flag before the decoder notices the window, so an engage
        // underrun freezes the playhead instead of spinning around the window.
        self.apply_engine_loop(deck)?;
        self.loop_windows[deck as usize].set(start, length, stored_playhead);
        Ok(())
    }

    fn clear_deck_loop(&mut self, track_id: i64) -> Result<(), String> {
        let deck = self
            .deck_for_track(track_id)
            .ok_or_else(|| "目标曲目尚未装入 Deck".to_string())?;
        self.cancel_clocked_deck_seek(deck);
        self.enter_manual_mode();
        self.invalidate_loop(deck)
    }

    /// Drop the transport loop without rebuilding the audible source, EQ or STEM session.
    fn invalidate_loop(&mut self, deck: DeckId) -> Result<(), String> {
        self.loop_windows[deck as usize].clear();
        if let Some(runtime) = self.decks[deck as usize].as_mut() {
            runtime.loop_playback = None;
        }
        self.state.decks[deck as usize].loop_start = None;
        self.state.decks[deck as usize].loop_length = None;
        self.send(RtCommand::SetDeckLoop {
            deck,
            looping: false,
            start_frames: 0,
            frames: 0,
        })
    }

    fn apply_engine_loop(&mut self, deck: DeckId) -> Result<(), String> {
        let Some(runtime) = self.decks[deck as usize].as_ref() else {
            return Ok(());
        };
        let Some(looping) = runtime.loop_playback else {
            return self.send(RtCommand::SetDeckLoop {
                deck,
                looping: false,
                start_frames: 0,
                frames: 0,
            });
        };
        let start_frames = runtime.frame_for_seconds(looping.start);
        let frames = runtime.frame_for_seconds(looping.length).max(1);
        self.send(RtCommand::SetDeckLoop {
            deck,
            looping: true,
            start_frames,
            frames,
        })
    }

    fn deck_for_track(&self, track_id: i64) -> Option<DeckId> {
        [DeckId::A, DeckId::B].into_iter().find(|deck| {
            self.decks[*deck as usize]
                .as_ref()
                .is_some_and(|runtime| runtime.request.track_id == track_id)
                || self.pending[*deck as usize]
                    .as_ref()
                    .is_some_and(|pending| pending.request.track_id == track_id)
        })
    }

    fn live_deck_seconds(&mut self, deck: DeckId) -> f64 {
        let state_time = self.state.decks[deck as usize].current_time;
        let Some(runtime) = self.decks[deck as usize].as_ref() else {
            return state_time;
        };
        let source_id = runtime.source_id;
        let output_sample_rate = runtime.output_sample_rate;
        let Some(player) = self.player.as_mut() else {
            return state_time;
        };
        let audio = player.snapshot();
        if audio.deck_source_ids[deck as usize] != source_id {
            return state_time;
        }
        let played = audio.deck_frames[deck as usize] as f64 / f64::from(output_sample_rate);
        if played > 0.05 {
            played
        } else {
            state_time.max(played)
        }
    }

    fn enter_manual_mode(&mut self) {
        if self.manual_mode {
            return;
        }
        self.manual_desired_playing = [
            self.state.decks[0].is_playing,
            self.state.decks[1].is_playing,
        ];
        if self.state.desired_playing {
            self.manual_desired_playing[self.front as usize] = true;
        }
        for index in 0..2 {
            self.state.decks[index].desired_playing = self.manual_desired_playing[index];
        }
        self.manual_mode = true;
    }

    fn clear_jog_nudge(&mut self, deck: DeckId) {
        let index = deck as usize;
        if self.jog_nudge_until[index].take().is_none() {
            return;
        }
        let rate = self.decks[index]
            .as_ref()
            .map(|runtime| runtime.request.rate);
        if let Some(runtime) = self.decks[index].as_mut() {
            runtime.tempo.set(runtime.request.rate);
        }
        if let Some(rate) = rate {
            // The Rubber Band worker and audio callback own separate clocks. Restore both
            // together so a temporary edge bend cannot leave the reported position drifting.
            let _ = self.send(RtCommand::SetRate { deck, rate });
        }
    }

    fn release_expired_jog_nudges(&mut self) {
        let now = Instant::now();
        for deck in [DeckId::A, DeckId::B] {
            if self.jog_nudge_until[deck as usize].is_some_and(|until| until <= now) {
                self.clear_jog_nudge(deck);
            }
        }
    }

    fn source_for_deck(&self, deck: DeckId) -> Option<PlaybackSource> {
        self.pending[deck as usize]
            .as_ref()
            .map(|pending| pending.request.clone())
            .or_else(|| {
                self.decks[deck as usize]
                    .as_ref()
                    .map(|runtime| runtime.request.clone())
            })
    }

    fn cancel_clocked_deck_seek(&mut self, deck: DeckId) {
        let index = deck as usize;
        if !self.pending[index]
            .as_ref()
            .is_some_and(|pending| pending.clocked_seek.is_some())
        {
            return;
        }
        let live_position = self.live_deck_seconds(deck);
        if let Some(pending) = self.pending[index].take() {
            cancel_stream(&pending.cancel);
        }
        // Fence the worker-finished message without cancelling the source that is still audible.
        self.bump_pending_revision(deck);
        self.state.decks[index].current_time = live_position;
        self.state.decks[index].buffering = false;
        if self.front == deck {
            self.state.current_time = live_position;
            self.state.buffering = false;
        }
    }

    fn apply_deck_mixer(&mut self, deck: DeckId, mixer: DeckMixer) -> Result<(), String> {
        self.send(RtCommand::SetDeckGain {
            deck,
            gain: mixer.channel_gain,
        })?;
        self.send(RtCommand::SetEq {
            deck,
            trim_db: mixer.trim_db,
            low_db: mixer.low_db,
            mid_db: mixer.mid_db,
            high_db: mixer.high_db,
            filter: mixer.filter,
        })
    }

    fn prewarm_queue(&mut self) -> Result<(), String> {
        let Some(source) = self
            .queue
            .iter()
            .find(|source| Some(source.track_id) != self.state.track_id)
            .cloned()
        else {
            return Ok(());
        };
        self.prepare(source)
    }

    fn set_playing(&mut self, playing: bool) -> Result<(), String> {
        if self.manual_mode {
            return self.set_deck_playing(self.front as u8, playing);
        }
        if !playing {
            self.release_scratch_hold(DeckId::A);
            self.release_scratch_hold(DeckId::B);
        }
        self.state.desired_playing = playing;
        self.send_playing(playing)?;
        if !matches!(
            self.state.phase,
            PlaybackPhase::Loading | PlaybackPhase::Seeking
        ) {
            self.state.phase = if self.state.track_id.is_none() {
                PlaybackPhase::Idle
            } else if playing {
                PlaybackPhase::Playing
            } else {
                PlaybackPhase::Paused
            };
        }
        Ok(())
    }

    fn seek(&mut self, position: f64) -> Result<(), String> {
        if self.manual_mode {
            return self.seek_deck(self.front as u8, position);
        }
        // 换曲（Hard 激活）还没落地时，front 上仍是旧曲目：跳转旧曲目会顶掉
        // 新曲目的待激活流。但用户点的是新曲目的进度条——把这次跳转折进换曲，
        // 让新曲目改从目标位置起播；连续 scrub 时后到的跳转覆盖先到的装载位置。
        let pending_load = self.pending.iter().position(|pending| {
            pending.as_ref().is_some_and(|pending| {
                matches!(pending.activation, Some(Activation::Hard))
                    && Some(pending.request.track_id) == self.state.track_id
            })
        });
        if let Some(index) = pending_load {
            let checkpoint = self.state.clone();
            let Some(mut request) = self.pending[index]
                .as_ref()
                .map(|pending| pending.request.clone())
            else {
                return Err("换曲进行中，等新歌起播后再跳转".into());
            };
            request.position = clamp_position(position, request.duration);
            request.autoplay = self.state.desired_playing;
            self.state.current_time = request.position;
            self.state.phase = PlaybackPhase::Loading;
            self.state.buffering = true;
            let deck = if index == 0 { DeckId::A } else { DeckId::B };
            let result = self.start_stream(deck, request, Some(Activation::Hard));
            if result.is_err() {
                self.state = checkpoint;
            }
            return result;
        }
        // 接歌承诺已登记、Deck 尚未 activate：与 Hard 一样把跳转折进待激活流。
        // 以前这里直接拒绝，前端却已乐观更新进度条 → 先跳过去再弹回 cue。
        let pending_transition = self.pending.iter().position(|pending| {
            pending.as_ref().is_some_and(|pending| {
                matches!(pending.activation, Some(Activation::Transition(_)))
                    && Some(pending.request.track_id) == self.state.track_id
            })
        });
        if let Some(index) = pending_transition {
            let checkpoint = self.state.clone();
            let (mut request, mut transition) = {
                let Some(pending) = self.pending[index].as_ref() else {
                    return Err("换曲进行中，等新歌起播后再跳转".into());
                };
                let Some(Activation::Transition(transition)) = pending.activation else {
                    return Err("换曲进行中，等新歌起播后再跳转".into());
                };
                (pending.request.clone(), transition)
            };
            let target = clamp_position(position, request.duration);
            request.position = target;
            request.autoplay = true;
            transition.position = target;
            self.state.current_time = target;
            self.state.desired_playing = true;
            self.state.phase = PlaybackPhase::Loading;
            self.state.buffering = true;
            let deck = if index == 0 { DeckId::A } else { DeckId::B };
            let result = self.start_stream(deck, request, Some(Activation::Transition(transition)));
            if result.is_err() {
                self.state = checkpoint;
            }
            return result;
        }
        // 连续接歌：第二场还在 deferred 时状态已指向它。跳转只改承诺位置，
        // 等第一场混音收尾再按新位置起播；绝不能 settle 时把承诺清掉。
        if let Some(deferred) = self.deferred_stream.as_mut().filter(|deferred| {
            matches!(deferred.activation, Some(Activation::Transition(_)))
                && Some(deferred.request.track_id) == self.state.track_id
        }) {
            let target = clamp_position(position, deferred.request.duration);
            deferred.request.position = target;
            deferred.request.autoplay = true;
            if let Some(Activation::Transition(transition)) = deferred.activation.as_mut() {
                transition.position = target;
            }
            self.state.current_time = target;
            self.state.desired_playing = true;
            self.state.phase = PlaybackPhase::Loading;
            self.state.buffering = true;
            return Ok(());
        }
        self.settle_transition()?;
        let current = self.decks[self.front as usize]
            .as_ref()
            .ok_or_else(|| "当前没有可跳转曲目".to_string())?
            .request
            .clone();
        let mut source = current;
        source.position = clamp_position(position, source.duration);
        source.autoplay = self.state.desired_playing;
        if source.stem_enabled && self.live_stem_instant_ready(self.front) {
            let retargeted =
                self.retarget_live_stems(self.front, source.track_id, source.position)?;
            if retargeted {
                self.state.phase = if self.state.desired_playing {
                    PlaybackPhase::Playing
                } else {
                    PlaybackPhase::Paused
                };
                self.state.buffering = false;
                return Ok(());
            }
        }
        // 与 load 同理：登记失败不能把状态留在 Seeking。
        let checkpoint = self.state.clone();
        self.state.phase = PlaybackPhase::Seeking;
        self.state.current_time = source.position;
        self.state.buffering = true;
        self.state.transitioning = false;
        let target = self.front.other();
        let result = self.start_stream(target, source, Some(Activation::Seek));
        if result.is_err() {
            self.state = checkpoint;
        }
        result
    }

    fn handoff(&mut self, expected: i64, transition: PendingTransition) -> Result<(), String> {
        if expected == 0 {
            return Err("接歌目标 id 无效".into());
        }
        let target = self.front.other();
        if self.decks[target as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.track_id == expected)
        {
            return self.activate(
                target,
                Activation::Transition(transition),
                transition.position,
            );
        }
        if let Some(pending) = self.pending[target as usize]
            .as_mut()
            .filter(|pending| pending.request.track_id == expected)
        {
            pending.activation = Some(Activation::Transition(transition));
            let request = pending.request.clone();
            // 先确认能接单再落账；找不到目标时必须保持状态原样。
            self.state.prepared_track_id = Some(expected);
            self.adopt_pending_transition_state(&request, transition);
            return Ok(());
        }
        if let Some(deferred) = self
            .deferred_stream
            .as_mut()
            .filter(|deferred| deferred.request.track_id == expected)
        {
            deferred.activation = Some(Activation::Transition(transition));
            let request = deferred.request.clone();
            self.state.prepared_track_id = Some(expected);
            self.adopt_pending_transition_state(&request, transition);
            return Ok(());
        }
        Err("下一台 Deck 尚未开始准备".into())
    }

    fn adopt_pending_transition_state(
        &mut self,
        request: &PlaybackSource,
        transition: PendingTransition,
    ) {
        self.state.phase = PlaybackPhase::Loading;
        self.state.track_id = Some(request.track_id);
        self.adopt_metadata(request);
        self.state.current_time = transition.position.max(0.0);
        self.state.duration = request.duration.unwrap_or(0.0).max(0.0);
        self.state.desired_playing = true;
        self.state.buffering = true;
    }

    fn settle_transition(&mut self) -> Result<(), String> {
        let Some(old) = self.retire_after_transition.take() else {
            return Ok(());
        };
        let runtime = self.decks[self.front as usize]
            .as_ref()
            .ok_or_else(|| "进场 Deck 已丢失".to_string())?;
        let audio = self
            .player
            .as_mut()
            .ok_or_else(|| "原生音频输出未初始化".to_string())?
            .snapshot();
        let frame = if audio.deck_source_ids[self.front as usize] == runtime.source_id {
            audio.deck_frames[self.front as usize]
        } else {
            runtime.frame_for_seconds(runtime.request.position)
        };
        self.send(RtCommand::HandoffPrepared {
            to: self.front,
            target_frame: frame,
            transition_frames: 0,
            plan: TransitionPlan::default(),
        })?;
        self.retire_deck(old);
        self.state.transitioning = false;
        // 与自然收尾同一条路：旧 Deck 腾出后立刻承接已承诺的第二场接歌。
        // 以前无条件 deferred_stream = None，混音中再切一首会被 seek/load 的
        // settle 悄悄丢掉，表现成「切歌失败」（UI 已是下一首，喇叭还停在上一首）。
        if let Some(deferred) = self.deferred_stream.take() {
            if deferred.activation.is_some() {
                self.start_stream(old, deferred.request, deferred.activation)?;
            }
        }
        Ok(())
    }

    fn set_transport_fade(&mut self, enabled: bool) -> Result<(), String> {
        self.state.transport_fade_enabled = enabled;
        if !enabled && self.player.is_some() {
            self.send_playing(self.state.desired_playing)?;
        }
        Ok(())
    }

    fn adopt_metadata(&mut self, source: &PlaybackSource) {
        self.state.title = source.title.clone();
        self.state.artist = source.artist.clone();
        self.state.album = source.album.clone();
        self.state.artwork_url = source.artwork_url.clone();
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), String> {
        let volume = if volume.is_finite() {
            volume.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.volume = volume;
        self.state.volume = volume;
        self.send(RtCommand::SetMasterGain(volume))
    }

    fn set_filter_resonance(&mut self, resonance: FilterResonance) -> Result<(), String> {
        self.filter_resonance = filter_resonance_q(resonance);
        self.send(RtCommand::SetFilterResonance {
            q: self.filter_resonance,
        })
    }

    fn set_eq(&mut self, low_db: f32, high_db: f32) -> Result<(), String> {
        if !low_db.is_finite() || !high_db.is_finite() {
            return Err("EQ 参数必须是有限数字".into());
        }
        let values = (low_db.clamp(-24.0, 12.0), high_db.clamp(-24.0, 12.0));
        self.eq = values;
        for deck in [DeckId::A, DeckId::B] {
            self.deck_mixers[deck as usize].low_db = values.0;
            self.deck_mixers[deck as usize].high_db = values.1;
            self.send(RtCommand::SetEq {
                deck,
                trim_db: 0.0,
                low_db: values.0,
                mid_db: 0.0,
                high_db: values.1,
                filter: 0.0,
            })?;
        }
        Ok(())
    }

    fn start_stream(
        &mut self,
        deck: DeckId,
        request: PlaybackSource,
        activation: Option<Activation>,
    ) -> Result<(), String> {
        let output_rate = self
            .player
            .as_ref()
            .map(|player| player.spec())
            .ok_or_else(|| "原生音频输出未初始化".to_string())?
            .sample_rate;
        let raw_capacity = output_rate as usize * DEFAULT_STREAM_BUFFER_SECONDS;
        let output_buffer_ms = if request.stem_enabled {
            STEM_TEMPO_OUTPUT_BUFFER_MS
        } else {
            TEMPO_OUTPUT_BUFFER_MS
        };
        let capacity = (u64::from(output_rate) * output_buffer_ms / 1_000).max(2) as usize;
        let startup_ms = if request.stem_enabled {
            let replacing_live_stems = self.decks[deck as usize]
                .as_ref()
                .is_some_and(|runtime| runtime.request.stem_enabled);
            if replacing_live_stems {
                STEM_SEEK_STARTUP_BUFFER_MS
            } else {
                STEM_STARTUP_BUFFER_MS
            }
            .min(output_buffer_ms.saturating_sub(40))
        } else if matches!(activation, Some(Activation::Seek)) {
            SEEK_BUFFER_MS.min(output_buffer_ms / 2)
        } else {
            STARTUP_BUFFER_MS.min(output_buffer_ms / 2)
        };
        let startup_buffer_frames = (u64::from(output_rate) * startup_ms / 1_000)
            .max(1)
            .min(capacity as u64);
        let stem_pool = if request.stem_enabled {
            Some(self.live_stem_pool(PathBuf::from(&request.stem_cache_path))?)
        } else {
            None
        };
        // Do not cancel an outgoing separated producer here. A Hot Cue/SYNC replacement prepares
        // in shadow; promotion retires the old generation only after the new stream has a cushion.
        let (source, writer) = if request.stem_enabled {
            let (source, writer) = StreamSource::<StemFrame>::bounded(capacity);
            (
                PlaybackStream::Stems(source),
                PlaybackStreamWriter::Stems(writer),
            )
        } else {
            let (source, writer) = StreamSource::bounded(capacity);
            (
                PlaybackStream::Stereo(source),
                PlaybackStreamWriter::Stereo(writer),
            )
        };
        let revision = self.bump_pending_revision(deck);
        tracing::info!(
            target: "kdj_stem_lifecycle",
            event = "deck_stream_worker_spawn",
            deck = deck as u8,
            track_id = request.track_id,
            revision,
            stem_enabled = request.stem_enabled,
            activation = match activation {
                Some(Activation::Hard) => "hard",
                Some(Activation::Seek) => "seek",
                Some(Activation::Transition(_)) => "transition",
                None => "shadow",
            },
            "Deck stream worker generation created"
        );
        let same_track = self.state.decks[deck as usize].track_id == Some(request.track_id)
            || self.decks[deck as usize]
                .as_ref()
                .is_some_and(|runtime| runtime.request.track_id == request.track_id);
        if !same_track {
            let _ = self.invalidate_loop(deck);
        }
        let loop_window = Arc::clone(&self.loop_windows[deck as usize]);
        let tempo = TempoControl::for_deck(deck as usize, request.rate);
        let cancel = Arc::new(AtomicU64::new(revision));
        let seek = StreamSeekControl::new();
        self.pending[deck as usize] = Some(PendingStream {
            revision,
            source: source.clone(),
            request: request.clone(),
            tempo: tempo.clone(),
            output_sample_rate: output_rate,
            startup_buffer_frames,
            activation,
            cancel: Arc::clone(&cancel),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: seek.clone(),
        });
        let sender = self.sender.clone();
        std::thread::Builder::new()
            .name(format!("kdj-stream-{}-{revision}", request.track_id))
            .spawn(move || {
                let worker_request = request.clone();
                let cancellation: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new({
                    let cancel = Arc::clone(&cancel);
                    move || cancel.load(Ordering::Acquire) != revision
                });
                let fence = Arc::clone(&cancel);
                let result = match writer {
                    PlaybackStreamWriter::Stems(writer) => {
                        if worker_request.source_kind != PlaybackSourceKind::Local {
                            Err(anyhow::anyhow!("在线曲目不能使用本机实时 STEM"))
                        } else {
                            let path = PathBuf::from(&worker_request.path);
                            let track_id = worker_request.track_id;
                            let position = worker_request.position;
                            let duration = worker_request.duration.unwrap_or(0.0);
                            let pool = stem_pool.expect("live STEM pool");
                            let epoch = Arc::clone(&fence);
                            let worker_loop = Arc::clone(&loop_window);
                            let worker_seek = seek.clone();
                            run_pitch_preserving_pipeline(
                                tempo.clone(),
                                output_rate,
                                raw_capacity,
                                writer,
                                move |raw_writer, cancelled| {
                                    let is_cancelled = || cancelled();
                                    decode_live_stem_streaming(
                                        &path,
                                        track_id,
                                        deck as usize,
                                        position,
                                        duration,
                                        output_rate,
                                        pool,
                                        epoch,
                                        revision,
                                        raw_writer,
                                        &is_cancelled,
                                        Some(worker_loop),
                                        Some(worker_seek),
                                    )
                                },
                                Arc::clone(&cancellation),
                                Some(Arc::clone(&loop_window)),
                                Some(seek),
                            )
                        }
                    }
                    PlaybackStreamWriter::Stereo(writer) => match worker_request.source_kind {
                        PlaybackSourceKind::Local => {
                            let path = PathBuf::from(&worker_request.path);
                            let position = worker_request.position;
                            let worker_loop = Arc::clone(&loop_window);
                            run_pitch_preserving_pipeline(
                                tempo.clone(),
                                output_rate,
                                raw_capacity,
                                writer,
                                move |raw_writer, cancelled| {
                                    let is_cancelled = || cancelled();
                                    decode_file_streaming_looped(
                                        &path,
                                        position,
                                        output_rate,
                                        raw_writer,
                                        &is_cancelled,
                                        Some(worker_loop),
                                    )
                                },
                                Arc::clone(&cancellation),
                                Some(Arc::clone(&loop_window)),
                                None,
                            )
                        }
                        PlaybackSourceKind::Remote => {
                            let path = worker_request.path.clone();
                            let position = worker_request.position;
                            let remote_fence = Arc::clone(&fence);
                            let worker_loop = Arc::clone(&loop_window);
                            run_pitch_preserving_pipeline(
                                tempo.clone(),
                                output_rate,
                                raw_capacity,
                                writer,
                                move |raw_writer, cancelled| {
                                    let opened = HttpRangeSource::open(
                                        &path,
                                        Arc::clone(&remote_fence),
                                        revision,
                                    );
                                    opened.map_err(anyhow::Error::new).and_then(|opened| {
                                        let is_cancelled = || cancelled();
                                        decode_source_streaming_looped(
                                            Box::new(opened.source),
                                            opened.hint_extension.as_deref(),
                                            &path,
                                            position,
                                            output_rate,
                                            raw_writer,
                                            &is_cancelled,
                                            Some(worker_loop),
                                        )
                                    })
                                },
                                Arc::clone(&cancellation),
                                Some(Arc::clone(&loop_window)),
                                None,
                            )
                        }
                    },
                }
                .map_err(|error| {
                    if request.stem_enabled {
                        format!("实时 STEM 无法启动：{error:#}")
                    } else {
                        match request.source_kind {
                            PlaybackSourceKind::Local => format!(
                                "本地音频文件无法播放，可能已被移动或所在设备已断开：{error:#}"
                            ),
                            PlaybackSourceKind::Remote => format!("在线试听无法播放：{error:#}"),
                        }
                    }
                });
                let _ = sender.send(Request::WorkerFinished {
                    deck,
                    revision,
                    result,
                });
            })
            .map_err(|error| format!("启动流式解码线程失败：{error}"))?;
        Ok(())
    }

    fn live_stem_pool(&mut self, model_path: PathBuf) -> Result<Arc<StemInferencePool>, String> {
        if let Some((loaded_path, pool, _)) = &self.stem_pool {
            if *loaded_path == model_path && pool.matches_current_preference() {
                return Ok(Arc::clone(pool));
            }
        }
        let (guard, pool) = acquire_stem_pool(&model_path).map_err(|error| error.to_string())?;
        self.stem_pool = Some((model_path, Arc::clone(&pool), guard));
        Ok(pool)
    }

    fn live_stem_instant_ready(&self, deck: DeckId) -> bool {
        self.stem_pool
            .as_ref()
            .is_some_and(|(_, pool, _)| pool.instant_ready(deck as usize))
    }

    fn release_stem_pool_if_idle(&mut self) {
        let active = self
            .decks
            .iter()
            .flatten()
            .any(|deck| deck.request.stem_enabled)
            || self
                .pending
                .iter()
                .flatten()
                .any(|pending| pending.request.stem_enabled);
        if !active {
            self.stem_pool = None;
        }
    }

    /// STEM stays in the user's requested mode. An empty ring holds the last sample in the
    /// callback until the next hop arrives. Restarting the whole worker would open a hole and
    /// is how seek/underrun became choppy.
    fn protect_audio_from_stem_underrun(&mut self) {
        self.observed_stem_underruns = stem_output_underruns_by_deck();
    }

    fn retry_interrupted_stems(&mut self) {
        let now = Instant::now();
        for deck in [DeckId::A, DeckId::B] {
            let index = deck as usize;
            let Some(mut recovery) = self.stem_recoveries[index].take() else {
                continue;
            };
            let same_track = self.state.decks[index].track_id == Some(recovery.track_id);
            if !same_track {
                continue;
            }
            if self.decks[index]
                .as_ref()
                .is_some_and(|runtime| runtime.request.stem_enabled)
            {
                // The replacement has reached the callback with its startup cushion.
                continue;
            }
            if self.pending[index].is_some() {
                self.stem_recoveries[index] = Some(recovery);
                continue;
            }
            if recovery.in_flight {
                // A failed worker has already left the pending slot. Turn it into a bounded
                // backoff instead of hammering source creation every 10 ms.
                recovery.in_flight = false;
                recovery.attempts = recovery.attempts.saturating_add(1);
                let multiplier = 1u32 << recovery.attempts.min(3);
                recovery.next_attempt =
                    now + (STEM_RECOVERY_BASE_DELAY * multiplier).min(STEM_RECOVERY_MAX_DELAY);
            }
            if now < recovery.next_attempt {
                self.stem_recoveries[index] = Some(recovery);
                continue;
            }
            match self.set_deck_stems(
                recovery.track_id,
                true,
                recovery.cache_path.clone(),
                recovery.mask,
                recovery.gains,
            ) {
                Ok(()) => {
                    recovery.in_flight = true;
                    recovery.next_attempt = now + STEM_RECOVERY_MAX_DELAY;
                }
                Err(error) => {
                    recovery.attempts = recovery.attempts.saturating_add(1);
                    let multiplier = 1u32 << recovery.attempts.min(3);
                    recovery.next_attempt =
                        now + (STEM_RECOVERY_BASE_DELAY * multiplier).min(STEM_RECOVERY_MAX_DELAY);
                    self.state.error = format!(
                        "Deck {} STEM 自动恢复等待重试：{error}",
                        if index == 0 { "A" } else { "B" }
                    );
                }
            }
            self.stem_recoveries[index] = Some(recovery);
        }
    }

    fn stem_handoff_for(&self, deck: DeckId, pending: &PendingStream) -> StemHandoff {
        if let Some(clocked) = pending.clocked_seek {
            if Instant::now() < clocked.promote_at {
                return StemHandoff::Wait;
            }
            // ByteDance tiles often land after `promote_at`. Requiring the full late window
            // before install made every Hot Cue chase a new model window and never replace
            // the audible stream. Once the startup cushion exists, skip what we can and jump.
            if pending.source.buffered_frames() == 0 && pending.source.ended() {
                return StemHandoff::RetargetClocked(retarget_clocked_deck_seek(
                    clocked,
                    pending.request.duration,
                    pending.request.stem_enabled,
                ));
            }
            return StemHandoff::Install;
        }
        if !pending.request.stem_enabled {
            return StemHandoff::Install;
        }
        let Some(runtime) = self.decks[deck as usize].as_ref() else {
            return StemHandoff::Install;
        };
        if !self.manual_desired_playing[deck as usize]
            || runtime.request.track_id != pending.request.track_id
        {
            return StemHandoff::Install;
        }
        let now = self.state.decks[deck as usize].current_time;
        let start = pending.request.position;
        if now + STEM_HANDOFF_EARLY_SEC < start {
            return StemHandoff::Wait;
        }
        let late = now - start;
        if late <= STEM_HANDOFF_ALIGN_SEC {
            return StemHandoff::Install;
        }
        let rate = f64::from(pending.request.rate).clamp(0.5, 2.0);
        let skip = ((late / rate) * f64::from(pending.output_sample_rate))
            .round()
            .max(0.0) as u64;
        // `promote_ready_streams` already proved the startup threshold. After discarding the
        // elapsed prefix, only the short callback cushion must remain; requiring a second full
        // startup buffer turned a viewport-cache hit into another model retarget.
        let keep = u64::from(pending.output_sample_rate) * STEM_HANDOFF_KEEP_MS / 1_000;
        if pending.source.buffered_frames() > skip.saturating_add(keep) {
            return StemHandoff::Install;
        }
        // A live producer may have crossed the small startup threshold while the first full model
        // tile is still moving through Rubber Band. Retargeting at that point cancels useful work
        // every ~tile latency and can create an unbounded chain of replacement stream threads.
        // Keep the original audible and let this one generation finish filling enough catch-up
        // audio. Only an ended producer needs a fresh window.
        if !pending.source.ended() {
            return StemHandoff::Wait;
        }
        StemHandoff::RetargetFollowing(now + stem_followup_lead_seconds())
    }

    fn promote_ready_streams(&mut self) {
        for deck in [DeckId::A, DeckId::B] {
            let ready = self.pending[deck as usize].as_ref().is_some_and(|pending| {
                let buffered = pending.source.buffered_frames();
                buffered >= pending.startup_buffer_frames
                    || pending.source.ended() && buffered > 0
                    // Catch-up discards down to the keep floor, which is below the startup
                    // cushion. Requiring the cushion again left STEM Hot Cue sitting on the
                    // outgoing song forever.
                    || pending
                        .clocked_seek
                        .is_some_and(|clocked| clocked.skipped_output_frames > 0)
                        && buffered > 0
            });
            if !ready {
                continue;
            }
            let Some(mut pending) = self.pending[deck as usize].take() else {
                continue;
            };
            if self.revisions[deck as usize] != pending.revision {
                continue;
            }
            if let Some(mut clocked) = pending.clocked_seek {
                let desired_skip = if clocked.advancing {
                    (Instant::now()
                        .saturating_duration_since(clocked.promote_at)
                        .as_secs_f64()
                        * f64::from(pending.output_sample_rate))
                    .round()
                    .max(0.0) as u64
                } else {
                    0
                };
                let remaining = desired_skip.saturating_sub(clocked.skipped_output_frames);
                if remaining > 0 {
                    let keep = if pending.request.stem_enabled {
                        u64::from(pending.output_sample_rate) * STEM_HANDOFF_KEEP_MS / 1_000
                    } else {
                        1
                    };
                    let available = pending.source.buffered_frames().saturating_sub(keep);
                    let dropped = pending.source.discard_frames(remaining.min(available));
                    clocked.skipped_output_frames =
                        clocked.skipped_output_frames.saturating_add(dropped);
                    let now = Instant::now();
                    if dropped > 0 {
                        clocked.catchup_progress_at = Some(now);
                    }
                    pending.clocked_seek = Some(clocked);
                    if clocked.skipped_output_frames < desired_skip && !pending.source.ended() {
                        let waiting_for_refill = dropped > 0
                            || clocked.catchup_progress_at.is_some_and(|at| {
                                now.saturating_duration_since(at) < STEM_SEEK_CATCHUP_STALL
                            });
                        if waiting_for_refill {
                            // Drain the already-decoded tile in bounded ring-sized steps. The
                            // worker refills the freed space without another model call.
                            self.pending[deck as usize] = Some(pending);
                            continue;
                        }
                        // The current window is exhausted. Install what we have instead of
                        // chasing another Spleeter tile while the outgoing song keeps playing.
                    }
                }
            }
            match self.stem_handoff_for(deck, &pending) {
                StemHandoff::Wait => {
                    self.pending[deck as usize] = Some(pending);
                    continue;
                }
                StemHandoff::RetargetClocked(clocked) => {
                    cancel_stream(&pending.cancel);
                    let mut request = pending.request;
                    request.position = clocked.position;
                    request.autoplay = self.manual_desired_playing[deck as usize];
                    if let Err(error) = self.start_stream(deck, request, None) {
                        self.fail(error);
                    } else if let Some(replacement) = self.pending[deck as usize].as_mut() {
                        replacement.clocked_seek = Some(clocked);
                    }
                    continue;
                }
                StemHandoff::RetargetFollowing(at) => {
                    cancel_stream(&pending.cancel);
                    let mut request = pending.request;
                    request.position = clamp_position(at, request.duration);
                    request.autoplay = self.manual_desired_playing[deck as usize];
                    if let Err(error) = self.start_stream(deck, request, None) {
                        self.fail(error);
                    }
                    continue;
                }
                StemHandoff::Install => {}
            }
            let playing_same_track = self.manual_desired_playing[deck as usize]
                && self.state.decks[deck as usize].is_playing
                && self.decks[deck as usize]
                    .as_ref()
                    .is_some_and(|runtime| runtime.request.track_id == pending.request.track_id);
            let mut start_frame =
                (pending.request.position * f64::from(pending.output_sample_rate)).round() as u64;
            let mut clocked_position = None;
            if let Some(mut clocked) = pending.clocked_seek {
                let desired_skip = if clocked.advancing {
                    (Instant::now()
                        .saturating_duration_since(clocked.promote_at)
                        .as_secs_f64()
                        * f64::from(pending.output_sample_rate))
                    .round()
                    .max(0.0) as u64
                } else {
                    0
                };
                let remaining = desired_skip.saturating_sub(clocked.skipped_output_frames);
                let keep = if pending.request.stem_enabled {
                    u64::from(pending.output_sample_rate) * STEM_HANDOFF_KEEP_MS / 1_000
                } else {
                    1
                };
                let available = pending.source.buffered_frames().saturating_sub(keep);
                let dropped = pending.source.discard_frames(remaining.min(available));
                clocked.skipped_output_frames =
                    clocked.skipped_output_frames.saturating_add(dropped);
                let position = clamp_position(
                    clocked.position
                        + clocked.skipped_output_frames as f64
                            / f64::from(pending.output_sample_rate)
                            * f64::from(clocked.rate).clamp(0.5, 2.0),
                    pending.request.duration,
                );
                start_frame = (position * f64::from(pending.output_sample_rate))
                    .round()
                    .max(0.0) as u64;
                clocked_position = Some(position);
            } else if pending.request.stem_enabled && playing_same_track {
                let now = self.state.decks[deck as usize].current_time;
                let late = now - pending.request.position;
                if late > 0.001 {
                    let rate = f64::from(pending.request.rate).clamp(0.5, 2.0);
                    let skip = ((late / rate) * f64::from(pending.output_sample_rate))
                        .round()
                        .max(0.0) as u64;
                    pending.source.discard_frames(skip);
                    start_frame = (now * f64::from(pending.output_sample_rate))
                        .round()
                        .max(0.0) as u64;
                }
            }
            // STEM 从暂停的原曲切过去时不能把原曲叠进分轨。若原曲仍在发声（seek
            // 先跳原曲、STEM 随后接上），保留 replacement 短换手，避免先静音再等推理。
            let replace_raw_source = pending.request.stem_enabled
                && self.decks[deck as usize]
                    .as_ref()
                    .is_some_and(|previous| !previous.request.stem_enabled)
                && !self.state.decks[deck as usize].is_playing;
            // 安装 source 会把它排进 callback 的实时命令队列。把当前 MASTER 值再放在
            // 它的前面，保证新 Deck 的第一帧也经过全局推子，而不是依赖前端某次异步
            // setVolume 恰好先抵达。特别是 MASTER=0 时，这条顺序是防止装盘瞬间爆音的
            // 最后一层保护。
            if let Err(error) = self.send(RtCommand::SetMasterGain(self.volume)) {
                self.fail(error);
                continue;
            }
            let installed = self
                .player
                .as_mut()
                .ok_or_else(|| "原生音频输出未初始化".to_string())
                .and_then(|player| {
                    if replace_raw_source {
                        player.clear(deck).map_err(|error| error.to_string())?;
                    }
                    match &pending.source {
                        PlaybackStream::Stereo(source) => player
                            .install_stream(deck, Arc::clone(source), start_frame)
                            .map_err(|error| error.to_string()),
                        PlaybackStream::Stems(source) => player
                            .install_stem_stream(deck, Arc::clone(source), start_frame)
                            .map_err(|error| error.to_string()),
                    }
                });
            let source_id = match installed {
                Ok(source_id) => source_id,
                Err(error) => {
                    self.fail(error);
                    continue;
                }
            };
            if let Some(previous) = self.decks[deck as usize].take() {
                // Ordinary replacements may still crossfade from the old ring. Raw→STEM was
                // explicitly cleared above, so it has no such audible fallback; either way wait
                // until the new source is installed before cancelling the old producer.
                cancel_stream(&previous.cancel);
                tracing::info!(
                    target: "kdj_stem_lifecycle",
                    event = "deck_stream_generation_retired",
                    deck = deck as u8,
                    old_track_id = previous.request.track_id,
                    old_stem_enabled = previous.request.stem_enabled,
                    new_track_id = pending.request.track_id,
                    new_stem_enabled = pending.request.stem_enabled,
                    "old Deck producer cancelled after replacement installation"
                );
            }
            self.decks[deck as usize] = Some(DeckRuntime {
                source_id,
                source: pending.source,
                request: pending.request.clone(),
                tempo: pending.tempo,
                output_sample_rate: pending.output_sample_rate,
                loop_playback: self.loop_windows[deck as usize].snapshot().map(|snap| {
                    LoopPlayback {
                        start: snap.start,
                        length: snap.length,
                    }
                }),
                cancel: pending.cancel,
                seek: pending.seek,
            });
            self.state.decks[deck as usize].stem_enabled = pending.request.stem_enabled;
            let _ = self.send(RtCommand::SetRate {
                deck,
                rate: pending.request.rate,
            });
            if pending.request.stem_enabled {
                let _ = self.send(RtCommand::SetDeckStemGains {
                    deck,
                    gains: effective_stem_gains(
                        pending.request.stem_mask,
                        pending.request.stem_gains,
                    ),
                });
            }
            let mixer = self.deck_mixers[deck as usize];
            let _ = self.apply_deck_mixer(deck, mixer);
            let _ = self.apply_engine_loop(deck);
            if let Some(activation) = pending.activation {
                if let Err(error) = self.activate(deck, activation, pending.request.position) {
                    self.fail(error);
                }
            } else if self.manual_mode
                && self.state.decks[deck as usize].track_id == Some(pending.request.track_id)
            {
                let desired = self.manual_desired_playing[deck as usize];
                let _ = self.send(RtCommand::SetMode(PlayerMode::RealtimeDj));
                // A scratch-held Deck never left the engine's playing set. Installing its final
                // source must therefore only release the hold below, not issue a redundant
                // PlayDeck that turns a platter gesture back into a transport toggle.
                if !(pending.release_scratch_hold && desired) {
                    let _ = self.send(RtCommand::SetDeckPlaying {
                        deck,
                        playing: desired,
                    });
                }
                let duration = pending.request.duration.unwrap_or(0.0).max(0.0);
                if let Some(position) = clocked_position {
                    self.state.decks[deck as usize].current_time = position;
                } else if !playing_same_track {
                    self.state.decks[deck as usize].current_time = pending.request.position;
                }
                self.state.decks[deck as usize].duration = duration;
                self.state.decks[deck as usize].rate = pending.request.rate;
                self.state.decks[deck as usize].buffering = false;
                self.state.decks[deck as usize].is_playing = desired;
                self.state.decks[deck as usize].desired_playing = desired;
                if desired {
                    self.front = deck;
                    self.state.track_id = Some(pending.request.track_id);
                    self.adopt_metadata(&pending.request);
                    self.state.current_time = self.state.decks[deck as usize].current_time;
                    self.state.duration = duration;
                    self.state.rate = pending.request.rate;
                }
            } else {
                self.state.prepared_track_id = Some(pending.request.track_id);
            }
            if pending.release_scratch_hold {
                // The new source now owns the final jog position and has its startup cushion.
                // Releasing this callback-only hold intentionally does not send PlayDeck: the
                // logical transport has remained playing for the entire gesture.
                self.release_scratch_hold(deck);
            }
            if pending.followup_stems {
                let mut stem_request = pending.request.clone();
                stem_request.stem_enabled = true;
                if self.manual_desired_playing[deck as usize] {
                    let now = self.state.decks[deck as usize].current_time;
                    stem_request.position =
                        clamp_position(now + stem_followup_lead_seconds(), stem_request.duration);
                }
                if let Err(error) = self.start_stream(deck, stem_request, None) {
                    self.fail(error);
                }
            }
            self.bump_sequence();
            self.publish(true);
        }
    }

    fn activate(
        &mut self,
        deck: DeckId,
        activation: Activation,
        requested_position: f64,
    ) -> Result<(), String> {
        let runtime = self.decks[deck as usize]
            .clone()
            .ok_or_else(|| "目标 Deck 尚未准备".to_string())?;
        // 接歌就是继续播。曲目刚 Ended 时 desired_playing 已被清掉；若已预热的
        // Deck 走 activate 捷径而不拉回 true，交接会以暂停态建立，过渡帧永不推进，
        // 前端只能再硬切——听感就是曲末「咔」一下跳过去。
        if matches!(activation, Activation::Transition(_)) {
            self.state.desired_playing = true;
        }
        let position = match activation {
            Activation::Transition(transition) => transition.position.max(0.0),
            Activation::Hard | Activation::Seek => requested_position.max(0.0),
        };
        let target_frame = runtime.frame_for_seconds(position);
        let old = self.front;
        let (transition_frames, plan) = match activation {
            Activation::Transition(transition) => {
                let frames = (transition.seconds.max(0.0) * f64::from(runtime.output_sample_rate))
                    .round()
                    .min(f64::from(u32::MAX)) as u32;
                (
                    frames,
                    realtime_plan(transition.plan, runtime.output_sample_rate),
                )
            }
            Activation::Seek if self.state.desired_playing => (
                (u64::from(runtime.output_sample_rate) * SEEK_HANDOFF_MS / 1_000) as u32,
                TransitionPlan {
                    flags: TransitionPlan::SEEK_DUCK,
                    beat_frames: 0,
                },
            ),
            Activation::Seek => (0, TransitionPlan::default()),
            Activation::Hard => (0, TransitionPlan::default()),
        };
        self.send(RtCommand::SetMode(if transition_frames > 0 {
            PlayerMode::RealtimeDj
        } else {
            PlayerMode::Continuous
        }))?;
        self.send(RtCommand::HandoffPrepared {
            to: deck,
            target_frame,
            transition_frames,
            plan,
        })?;
        self.send(RtCommand::SetRate {
            deck,
            rate: runtime.request.rate,
        })?;
        self.send_playing(self.state.desired_playing)?;
        self.front = deck;
        self.state.track_id = Some(runtime.request.track_id);
        self.adopt_metadata(&runtime.request);
        self.state.prepared_track_id = None;
        self.state.current_time = position;
        self.state.duration = runtime.duration();
        self.state.rate = runtime.request.rate;
        self.state.buffering = false;
        self.state.is_playing = self.state.desired_playing;
        self.state.transitioning = transition_frames > 0;
        self.state.phase = if transition_frames > 0 {
            PlaybackPhase::Transitioning
        } else if self.state.desired_playing {
            PlaybackPhase::Playing
        } else {
            PlaybackPhase::Paused
        };
        if old != deck {
            if transition_frames > 0 {
                self.retire_after_transition = Some(old);
            } else {
                self.retire_deck(old);
            }
        }
        if transition_frames == 0 {
            self.prewarm_queue()?;
        }
        Ok(())
    }

    fn refresh_from_audio(&mut self) {
        let audio = match self.player.as_mut() {
            Some(player) => player.snapshot(),
            None => return,
        };
        self.latest_levels = PlaybackLevels {
            peaks: audio.deck_peak_levels,
            bands: audio.deck_spectrum_levels,
        };
        let mut rewind_ended = [false, false];
        for deck in [DeckId::A, DeckId::B] {
            let index = deck as usize;
            let Some(runtime) = self.decks[index].as_ref() else {
                continue;
            };
            let stem_clock = runtime.request.stem_enabled.then(|| runtime.seek.clone());
            let view = &mut self.state.decks[index];
            if view.track_id != Some(runtime.request.track_id) {
                view.track_id = Some(runtime.request.track_id);
                view.duration = runtime.duration();
                view.rate = runtime.request.rate;
            }
            if audio.deck_source_ids[index] == runtime.source_id {
                if self.pending[index].as_ref().is_some_and(|pending| {
                    if runtime.source.drained() {
                        // EOF rewind (and any other replacement) already published the target
                        // clock. The drained live decoder is still parked on the last frame.
                        return true;
                    }
                    let same_origin = (pending.request.position - runtime.request.position).abs()
                        <= LIVE_CLOCK_SAME_ORIGIN_SEC;
                    let stem_catchup = pending.request.stem_enabled
                        && !runtime.request.stem_enabled
                        && pending.request.track_id == runtime.request.track_id;
                    !same_origin && !stem_catchup
                }) {
                    // Live is still the pre-seek decoder. Publishing that clock snaps the
                    // playhead back, so a click looks like it did nothing.
                    continue;
                }
                let played = runtime.seconds_for_frame(audio.deck_frames[index]);
                view.current_time = played;
                view.is_playing = audio.deck_playing[index];
                view.buffering = self.manual_desired_playing[index]
                    && runtime.source.buffered_frames() == 0
                    && !runtime.source.ended();
                view.output_buffer_ms =
                    frames_to_ms(runtime.source.buffered_frames(), runtime.output_sample_rate);
                view.minimum_output_buffer_ms = frames_to_ms(
                    audio.deck_min_buffered_frames[index],
                    runtime.output_sample_rate,
                );
                view.output_underruns = audio.deck_output_underruns[index];
                view.peak_level = audio.deck_peak_levels[index];
                if let Some(seek) = stem_clock.as_ref() {
                    if self.pending[index].is_none() {
                        seek.publish_clock(played);
                    }
                }
                if runtime.source.drained() && self.manual_desired_playing[index] {
                    if runtime.loop_playback.is_some() {
                        view.buffering = true;
                    } else {
                        self.manual_desired_playing[index] = false;
                        view.desired_playing = false;
                        view.is_playing = false;
                        rewind_ended[index] = self.manual_mode
                            && self.pending[index].is_none()
                            && !self.scratch_held[index];
                    }
                }
            }
        }
        if self.manual_mode {
            for (index, should_rewind) in rewind_ended.into_iter().enumerate() {
                if should_rewind {
                    // Rebuild at 0 while paused so the waveform can scroll home and Play starts
                    // from the top. Auto-DJ (non-manual) still uses the Ended → next-track path.
                    let _ = self.seek_deck(index as u8, 0.0);
                }
            }
            self.state.desired_playing = self.manual_desired_playing.into_iter().any(|value| value);
            self.state.is_playing = audio.deck_playing.into_iter().any(|value| value);
            self.state.buffering = self.state.decks.iter().any(|deck| deck.buffering);
            let front_view = &self.state.decks[self.front as usize];
            self.state.current_time = front_view.current_time;
            self.state.duration = front_view.duration;
            self.state.rate = front_view.rate;
            self.state.phase = if self.state.buffering && self.state.desired_playing {
                PlaybackPhase::Loading
            } else if self.state.is_playing {
                PlaybackPhase::Playing
            } else if self.state.track_id.is_some() {
                PlaybackPhase::Paused
            } else {
                PlaybackPhase::Idle
            };
            return;
        }
        if self.state.phase == PlaybackPhase::Seeking
            || self.state.phase == PlaybackPhase::Loading && !self.state.transitioning
        {
            self.state.is_playing = audio.playing;
            return;
        }
        let transition_reached_target =
            self.decks[self.front as usize]
                .as_ref()
                .is_some_and(|runtime| {
                    audio.active_deck == self.front
                        && audio.deck_source_ids[self.front as usize] == runtime.source_id
                });
        if audio.transitioning {
            self.state.transitioning = true;
            self.state.phase = PlaybackPhase::Transitioning;
        } else if self.state.transitioning && transition_reached_target {
            self.state.transitioning = false;
            let mut awaiting_deferred_activation = false;
            if let Some(deck) = self.retire_after_transition.take() {
                self.retire_deck(deck);
                if let Some(deferred) = self.deferred_stream.take() {
                    let has_activation = deferred.activation.is_some();
                    if let Err(error) =
                        self.start_stream(deck, deferred.request, deferred.activation)
                    {
                        self.fail(error);
                    } else {
                        awaiting_deferred_activation = has_activation;
                    }
                } else if let Err(error) = self.prewarm_queue() {
                    self.fail(error);
                }
            }
            if awaiting_deferred_activation {
                self.state.phase = PlaybackPhase::Loading;
                self.state.buffering = true;
                self.state.is_playing = audio.playing;
                return;
            }
            self.state.phase = if self.state.desired_playing {
                PlaybackPhase::Playing
            } else {
                PlaybackPhase::Paused
            };
        }
        self.state.is_playing = audio.playing;
        if let Some(runtime) = &self.decks[self.front as usize] {
            // 连续接歌：第二场已承诺（deferred）时 state 已指向新曲目，front 仍是
            // 第一场混音的进场 Deck。它的时钟/时长/Ended 都不属于当前曲目——
            // 拉进来进度条会先跳回第一场的进度，等第二场激活再弹走，
            // 看起来就是「点完进度条又弹回去」。
            let front_is_current = Some(runtime.request.track_id) == self.state.track_id;
            if front_is_current {
                if audio.deck_source_ids[self.front as usize] == runtime.source_id {
                    self.state.current_time =
                        runtime.seconds_for_frame(audio.deck_frames[self.front as usize]);
                }
                self.state.duration = runtime.duration();
                // The callback freezes its media clock when a bounded stream temporarily runs
                // dry. Expose that as buffering (for local disk pressure and online jitter alike)
                // instead of claiming uninterrupted playback while the speaker is in a gap.
                self.state.buffering = self.state.desired_playing
                    && !self.state.transitioning
                    && runtime.source.buffered_frames() == 0
                    && !runtime.source.ended();
            }
            if front_is_current
                && !audio.playing
                && runtime.source.drained()
                && self.state.desired_playing
            {
                self.state.phase = PlaybackPhase::Ended;
                self.state.desired_playing = false;
            } else if !self.state.transitioning && self.state.phase != PlaybackPhase::Ended {
                // Ended 是终态：ACTOR_TICK(10ms) 比 STATE_INTERVAL(100ms) 密，
                // 若下一拍就盖回 Paused，Ended 快照会被发布节流吞掉，
                // 前端永远收不到 ended，自动下一首因此卡死。
                // 新 Load/Play 命令会自行把 phase 推进 Loading/Playing。
                self.state.phase = if self.state.desired_playing {
                    PlaybackPhase::Playing
                } else {
                    PlaybackPhase::Paused
                };
            }
        }
    }

    fn publish_levels(&mut self) {
        let Some(emit) = &self.level_emit else {
            return;
        };
        if self.last_level_tick.elapsed() < LEVEL_INTERVAL {
            return;
        }
        self.last_level_tick = Instant::now();
        emit(self.latest_levels);
    }

    fn publish_audio_pressure(&self) {
        let mut pressure = AudioPressure::Normal;
        let prior = work_scheduler().audio_pressure();
        for index in 0..2 {
            let Some(runtime) = self.decks[index].as_ref() else {
                continue;
            };
            let wants_audio = if self.manual_mode {
                self.manual_desired_playing[index]
            } else {
                self.state.decks[index].is_playing
                    || (index == self.front as usize && self.state.desired_playing)
            };
            if !wants_audio || runtime.source.ended() {
                continue;
            }
            let buffered_ms =
                frames_to_ms(runtime.source.buffered_frames(), runtime.output_sample_rate);
            let low_ms = if runtime.request.stem_enabled {
                STEM_AUDIO_LOW_BUFFER_MS
            } else {
                AUDIO_LOW_BUFFER_MS
            };
            let recover_ms = if runtime.request.stem_enabled {
                STEM_AUDIO_RECOVER_BUFFER_MS
            } else {
                AUDIO_RECOVER_BUFFER_MS
            };
            let deck_pressure = if buffered_ms <= AUDIO_CRITICAL_BUFFER_MS {
                AudioPressure::Critical
            } else if buffered_ms < low_ms
                || (prior != AudioPressure::Normal && buffered_ms < recover_ms)
            {
                AudioPressure::Low
            } else {
                AudioPressure::Normal
            };
            pressure = pressure.max(deck_pressure);
        }
        work_scheduler().set_audio_pressure(pressure);
    }

    fn reusable_deck(&self, request: &PlaybackSource) -> Option<DeckId> {
        [DeckId::A, DeckId::B].into_iter().find(|deck| {
            self.decks[*deck as usize].as_ref().is_some_and(|runtime| {
                runtime.loop_playback.is_none()
                    && same_source(&runtime.request, request)
                    && !runtime.source.drained()
            })
        })
    }

    fn target_deck(&self) -> DeckId {
        if self.decks[self.front as usize].is_none() {
            self.front
        } else {
            self.front.other()
        }
    }

    fn send_playing(&mut self, playing: bool) -> Result<(), String> {
        let fade_frames = if self.state.transport_fade_enabled {
            self.player
                .as_ref()
                .map(|player| {
                    (u64::from(player.spec().sample_rate) * TRANSPORT_FADE_MS / 1_000)
                        .min(u64::from(u32::MAX)) as u32
                })
                .unwrap_or(0)
        } else {
            0
        };
        self.send(RtCommand::SetPlaying {
            playing,
            fade_frames,
        })
    }

    fn send(&mut self, command: RtCommand) -> Result<(), String> {
        self.player
            .as_mut()
            .ok_or_else(|| "原生音频输出未初始化".to_string())?
            .send(command)
            .map_err(|error| error.to_string())
    }

    fn retire_deck(&mut self, deck: DeckId) {
        self.invalidate(deck);
        self.pending[deck as usize] = None;
        if let Some(player) = &mut self.player {
            let _ = player.clear(deck);
        }
        self.decks[deck as usize] = None;
        self.manual_desired_playing[deck as usize] = false;
        self.scratch_held[deck as usize] = false;
        self.state.decks[deck as usize] = crate::contract::PlaybackDeckSnapshot {
            rate: 1.0,
            ..crate::contract::PlaybackDeckSnapshot::default()
        };
    }

    fn bump_revision(&mut self, deck: DeckId) -> u64 {
        self.cancel_deck_workers(deck);
        let revision = self.next_revision;
        self.next_revision = self.next_revision.wrapping_add(1).max(1);
        self.revisions[deck as usize] = revision;
        self.revision_fences[deck as usize].store(revision, Ordering::Release);
        revision
    }

    /// Start a replacement decoder without silencing the installed one. The live worker keeps
    /// its own cancel token until `promote_ready_streams` installs the new ring.
    fn bump_pending_revision(&mut self, deck: DeckId) -> u64 {
        if let Some(pending) = &self.pending[deck as usize] {
            cancel_stream(&pending.cancel);
        }
        let revision = self.next_revision;
        self.next_revision = self.next_revision.wrapping_add(1).max(1);
        self.revisions[deck as usize] = revision;
        revision
    }

    fn cancel_deck_workers(&mut self, deck: DeckId) {
        if let Some(pending) = &self.pending[deck as usize] {
            cancel_stream(&pending.cancel);
        }
        if let Some(runtime) = &self.decks[deck as usize] {
            cancel_stream(&runtime.cancel);
        }
    }

    fn invalidate(&mut self, deck: DeckId) {
        let _ = self.bump_revision(deck);
    }

    fn dispose(&mut self) {
        self.invalidate(DeckId::A);
        self.invalidate(DeckId::B);
        self.pending = [None, None];
        self.deferred_stream = None;
        self.decks = [None, None];
        self.stem_recoveries = [None, None];
        self.manual_mode = false;
        self.manual_desired_playing = [false; 2];
        self.scratch_held = [false; 2];
        self.deck_mixers = [DeckMixer {
            low_db: self.eq.0,
            high_db: self.eq.1,
            ..DeckMixer::default()
        }; 2];
        self.player.take();
        let sequence = self.state.sequence;
        let command = self.state.last_command_id;
        let transport_fade_enabled = self.state.transport_fade_enabled;
        self.state = PlaybackSnapshot {
            sequence,
            last_command_id: command,
            volume: self.volume,
            transport_fade_enabled,
            ..PlaybackSnapshot::default()
        };
    }

    fn fail(&mut self, error: String) {
        self.state.phase = PlaybackPhase::Error;
        self.state.is_playing = false;
        self.state.buffering = false;
        self.state.transitioning = false;
        self.state.error = error;
        // 状态层已经判定不在播，硬件走带必须同步停下：
        // 否则错误挂在那里，旧 Deck 却继续发声。
        if self.player.is_some() {
            let _ = self.send(RtCommand::SetPlaying {
                playing: false,
                fade_frames: 0,
            });
        }
    }

    fn bump_sequence(&mut self) {
        self.state.sequence = self.state.sequence.wrapping_add(1).max(1);
    }

    fn publish(&mut self, force: bool) {
        if !force && self.last_state_tick.elapsed() < STATE_INTERVAL {
            return;
        }
        self.last_state_tick = Instant::now();
        if !force && self.state == self.last_emitted {
            return;
        }
        if !force {
            self.bump_sequence();
        }
        (self.emit)(self.state.clone());
        self.last_emitted = self.state.clone();
    }
}

#[derive(Clone, Copy, Debug)]
struct SyncPhaseInput {
    follower_position: f64,
    follower_bpm: f64,
    follower_first_beat: f64,
    follower_rate: f64,
    master_position: f64,
    master_bpm: f64,
    master_first_beat: f64,
    master_rate: f64,
    beats_per_bar: f64,
    follower_duration: Option<f64>,
}

fn sync_grid_origin(first_beat: f64, cell: f64) -> f64 {
    first_beat.rem_euclid(cell)
}

fn wrap_sync_error(value: f64, period: f64) -> f64 {
    let mut wrapped = value.rem_euclid(period);
    if wrapped > period / 2.0 {
        wrapped -= period;
    }
    wrapped
}

/// Resolve the nearest phase-equivalent follower position that is actually seekable.
///
/// A nearest signed correction can point before 0 when a freshly loaded Deck is synchronized.
/// Clamping that result to 0 destroys the phase relation; advancing by one common grid period
/// preserves exactly the same downbeat while staying inside the track.
fn sync_phase_target(input: SyncPhaseInput) -> Option<f64> {
    if !input.follower_position.is_finite()
        || !input.master_position.is_finite()
        || !input.follower_bpm.is_finite()
        || input.follower_bpm <= 0.0
        || !input.master_bpm.is_finite()
        || input.master_bpm <= 0.0
        || !input.follower_first_beat.is_finite()
        || !input.master_first_beat.is_finite()
        || !input.follower_rate.is_finite()
        || input.follower_rate <= 0.0
        || !input.master_rate.is_finite()
        || input.master_rate <= 0.0
        || !input.beats_per_bar.is_finite()
        || input.beats_per_bar <= 0.0
    {
        return None;
    }
    let follower_cell = 60.0 / input.follower_bpm * input.beats_per_bar;
    let master_cell = 60.0 / input.master_bpm * input.beats_per_bar;
    let follower_period = follower_cell / input.follower_rate;
    let master_period = master_cell / input.master_rate;
    let common_period = follower_period.max(master_period);
    if !common_period.is_finite() || common_period <= 0.0 {
        return None;
    }
    let follower_wall = (input.follower_position
        - sync_grid_origin(input.follower_first_beat, follower_cell))
        / input.follower_rate;
    let master_wall = (input.master_position
        - sync_grid_origin(input.master_first_beat, master_cell))
        / input.master_rate;
    let error = wrap_sync_error(follower_wall - master_wall, common_period);
    let source_period = common_period * input.follower_rate;
    let mut target = input.follower_position - error * input.follower_rate;
    let max_position = input
        .follower_duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| (duration - SEEK_END_MARGIN_SECONDS).max(0.0))
        .unwrap_or(f64::INFINITY);
    if target < 0.0 {
        target += (-target / source_period).ceil() * source_period;
    }
    if target > max_position && max_position.is_finite() {
        target -= ((target - max_position) / source_period).ceil() * source_period;
    }
    if target < 0.0 || target > max_position {
        // Extremely short tracks may contain no full equivalent cell. A bounded target is safer
        // than an invalid seek, though such a track cannot promise a persistent bar lock.
        target = target.clamp(0.0, max_position);
    }
    Some(target)
}

fn validate_source(source: &PlaybackSource) -> Result<(), String> {
    if source.track_id == 0 {
        return Err("曲目 id 无效".into());
    }
    match source.source_kind {
        PlaybackSourceKind::Remote if !is_loopback_http_url(&source.path) => {
            return Err("在线音频必须使用应用内回环代理".into());
        }
        _ => {}
    }
    if !source.position.is_finite() || source.position < 0.0 {
        return Err("播放位置无效".into());
    }
    if !source.rate.is_finite() || !(0.5..=2.0).contains(&source.rate) {
        return Err("播放速度必须在 0.5 到 2.0 之间".into());
    }
    if source.path.trim().is_empty() {
        return Err("音频路径为空".into());
    }
    Ok(())
}

fn cancel_stream(token: &Arc<AtomicU64>) {
    token.store(0, Ordering::Release);
}

fn stem_followup_lead_seconds() -> f64 {
    let diagnostics = stem_runtime_diagnostics();
    let ms = diagnostics
        .p95_block_ms
        .or(diagnostics.first_block_ms)
        .unwrap_or(500);
    (ms as f64 / 1_000.0).clamp(0.08, 1.0)
}

fn clocked_deck_seek(
    requested_position: f64,
    rate: f32,
    duration: Option<f64>,
    playing: bool,
    stems: bool,
) -> ClockedDeckSeek {
    let requested_at = Instant::now();
    let lead = if !playing {
        0.0
    } else if stems {
        stem_followup_lead_seconds()
    } else {
        SEEK_BUFFER_MS as f64 / 1_000.0
    };
    let position = clamp_position(
        requested_position + lead * f64::from(rate).clamp(0.5, 2.0),
        duration,
    );
    ClockedDeckSeek {
        requested_at,
        requested_position,
        promote_at: requested_at + Duration::from_secs_f64(lead),
        position,
        rate,
        advancing: playing,
        skipped_output_frames: 0,
        skipped_media_frames: 0.0,
        catchup_progress_at: None,
    }
}

fn retarget_clocked_deck_seek(
    anchor: ClockedDeckSeek,
    duration: Option<f64>,
    stems: bool,
) -> ClockedDeckSeek {
    let now = Instant::now();
    let lead = if stems {
        stem_followup_lead_seconds()
    } else {
        SEEK_BUFFER_MS as f64 / 1_000.0
    };
    let promote_at = now + Duration::from_secs_f64(lead);
    let elapsed = promote_at
        .saturating_duration_since(anchor.requested_at)
        .as_secs_f64();
    ClockedDeckSeek {
        promote_at,
        position: clamp_position(
            anchor.requested_position + elapsed * f64::from(anchor.rate).clamp(0.5, 2.0),
            duration,
        ),
        skipped_output_frames: 0,
        skipped_media_frames: 0.0,
        catchup_progress_at: None,
        ..anchor
    }
}

fn same_source(left: &PlaybackSource, right: &PlaybackSource) -> bool {
    left.track_id == right.track_id
        && left.source_kind == right.source_kind
        && left.path == right.path
        && left.stem_enabled == right.stem_enabled
        && left.stem_cache_path == right.stem_cache_path
        && left.stem_mask == right.stem_mask
        && (left.rate - right.rate).abs() < 0.000_1
        && (left.position - right.position).abs() < 0.02
}

/// 渲染线程实际施加的每轨增益：掩码关闭的轨直接为 0，其余取 STEM EQ 线性增益。
fn effective_stem_gains(mask: u8, gains: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|lane| {
        if mask & (1 << lane) != 0 {
            finite_clamp(gains[lane], 0.0, STEM_GAIN_MAX, 0.0)
        } else {
            0.0
        }
    })
}

fn deck_id(deck: u8) -> Result<DeckId, String> {
    match deck {
        0 => Ok(DeckId::A),
        1 => Ok(DeckId::B),
        _ => Err("Deck 必须是 0 或 1".into()),
    }
}

fn finite_clamp(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn frames_to_ms(frames: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    frames.saturating_mul(1_000) / u64::from(sample_rate)
}

fn filter_resonance_q(resonance: FilterResonance) -> f32 {
    match resonance {
        // Preserve the former fixed-Q sound as the explicit low setting.
        FilterResonance::Low => FILTER_RESONANCE_LOW_Q,
        FilterResonance::Medium => FILTER_RESONANCE_MEDIUM_Q,
        FilterResonance::High => FILTER_RESONANCE_HIGH_Q,
    }
}

/// 进度条最右端换算出的目标常常正好等于时长；精确 seek 到流的末尾会读出
/// 流外（end of stream），给末尾留一点余量，让“跳到结尾”播完最后一点自然结束。
const SEEK_END_MARGIN_SECONDS: f64 = 0.25;

fn clamp_position(position: f64, duration: Option<f64>) -> f64 {
    let position = if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    };
    duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| position.min((duration - SEEK_END_MARGIN_SECONDS).max(0.0)))
        .unwrap_or(position)
}

fn realtime_plan(plan: PlaybackTransitionPlan, sample_rate: u32) -> TransitionPlan {
    let mut flags = 0;
    if plan.eq {
        flags |= TransitionPlan::EQ;
    }
    if plan.filter {
        flags |= TransitionPlan::FILTER;
    }
    if plan.vocal_cut {
        flags |= TransitionPlan::VOCAL_CUT;
    }
    if plan.echo {
        flags |= TransitionPlan::ECHO;
    }
    if plan.alarm {
        flags |= TransitionPlan::ALARM;
    }
    if plan.hydrant {
        flags |= TransitionPlan::HYDRANT;
    }
    let beat_seconds = if plan.beat_seconds.is_finite() {
        plan.beat_seconds.max(0.01)
    } else {
        0.5
    };
    TransitionPlan {
        flags,
        beat_frames: (beat_seconds * f64::from(sample_rate))
            .round()
            .clamp(1.0, f64::from(u32::MAX)) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::PlaybackOutputSpec;
    use kdj_core::{StemCompute, StemMode};
    use kdj_player::TransportSnapshot;
    use kdj_stems::StemCoordinator;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Mutex, OnceLock};

    /// 不起真实声卡的输出替身：记录发送、按开关注入失败，快照由测试直接摆弄。
    struct FakeKnobs {
        fail_send: AtomicBool,
        sent: Mutex<Vec<RtCommand>>,
        snapshot: Mutex<TransportSnapshot>,
    }

    impl Default for FakeKnobs {
        fn default() -> Self {
            Self {
                fail_send: AtomicBool::new(false),
                sent: Mutex::new(Vec::new()),
                snapshot: Mutex::new(TransportSnapshot::default()),
            }
        }
    }

    struct FakeOutput {
        knobs: Arc<FakeKnobs>,
        next_source_id: u64,
    }

    impl PlaybackOutput for FakeOutput {
        fn spec(&self) -> PlaybackOutputSpec {
            PlaybackOutputSpec {
                sample_rate: 48_000,
                channels: 2,
            }
        }

        fn install_stream(
            &mut self,
            deck: DeckId,
            _source: Arc<StreamSource>,
            start_frame: u64,
        ) -> Result<u64, String> {
            self.next_source_id += 1;
            let source_id = self.next_source_id;
            let mut snapshot = self.knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[deck as usize] = source_id;
            snapshot.deck_frames[deck as usize] = start_frame;
            Ok(source_id)
        }

        fn install_stem_stream(
            &mut self,
            deck: DeckId,
            _source: Arc<StreamSource<StemFrame>>,
            start_frame: u64,
        ) -> Result<u64, String> {
            self.next_source_id += 1;
            let source_id = self.next_source_id;
            let mut snapshot = self.knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[deck as usize] = source_id;
            snapshot.deck_frames[deck as usize] = start_frame;
            Ok(source_id)
        }

        fn install_decoded(
            &mut self,
            deck: DeckId,
            _track: Arc<DecodedTrack>,
            start_frame: u64,
        ) -> Result<u64, String> {
            self.next_source_id += 1;
            let source_id = self.next_source_id;
            let mut snapshot = self.knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[deck as usize] = source_id;
            snapshot.deck_frames[deck as usize] = start_frame;
            Ok(source_id)
        }

        fn clear(&mut self, deck: DeckId) -> Result<(), String> {
            self.knobs.snapshot.lock().unwrap().deck_source_ids[deck as usize] = 0;
            Ok(())
        }

        fn send(&mut self, command: RtCommand) -> Result<(), String> {
            if self.knobs.fail_send.load(Ordering::Relaxed) {
                return Err("注入的实时发送失败".to_string());
            }
            match command {
                RtCommand::HandoffPrepared { to, .. } => {
                    self.knobs.snapshot.lock().unwrap().active_deck = to;
                }
                RtCommand::SetPlaying { playing, .. } => {
                    self.knobs.snapshot.lock().unwrap().playing = playing;
                }
                RtCommand::SeekPrepared { deck, frame } => {
                    self.knobs.snapshot.lock().unwrap().deck_frames[deck as usize] = frame;
                }
                _ => {}
            }
            self.knobs.sent.lock().unwrap().push(command);
            Ok(())
        }

        fn snapshot(&mut self) -> TransportSnapshot {
            *self.knobs.snapshot.lock().unwrap()
        }
    }

    struct FakeFactory {
        knobs: Arc<FakeKnobs>,
        taken: Mutex<bool>,
    }

    impl PlaybackOutputFactory for FakeFactory {
        fn open(
            &self,
            _on_error: Box<dyn FnMut(String) + Send>,
        ) -> Result<Box<dyn PlaybackOutput>, String> {
            let mut taken = self.taken.lock().unwrap();
            if *taken {
                return Err("测试输出只能取走一次".to_string());
            }
            *taken = true;
            Ok(Box::new(FakeOutput {
                knobs: Arc::clone(&self.knobs),
                next_source_id: 0,
            }))
        }
    }

    fn test_actor(knobs: &Arc<FakeKnobs>) -> Actor {
        let (sender, receiver) = mpsc::channel();
        let emit: StateEmitter = Arc::new(|_| {});
        let factory = FakeFactory {
            knobs: Arc::clone(knobs),
            taken: Mutex::new(false),
        };
        Actor::new(sender, receiver, emit, Arc::new(factory))
    }

    fn enable_bytedance_stem_runtime_for_test() {
        static MANAGER: OnceLock<StemCoordinator> = OnceLock::new();
        let manager = MANAGER.get_or_init(|| {
            StemCoordinator::new(&std::env::temp_dir().join("kdj-playback-runtime-tests"))
        });
        manager.activate_runtime(StemMode::MobileNetTwo, StemCompute::Cpu);
    }

    fn source(track_id: i64, position: f64) -> PlaybackSource {
        PlaybackSource {
            track_id,
            path: format!("/nonexistent/{track_id}.flac"),
            source_kind: PlaybackSourceKind::Local,
            title: format!("曲目 {track_id}"),
            artist: String::new(),
            album: String::new(),
            artwork_url: None,
            position,
            duration: Some(180.0),
            rate: 1.0,
            autoplay: false,
            stem_cache_path: String::new(),
            stem_enabled: false,
            stem_mask: 0b1111,
            stem_gains: [1.0; 4],
        }
    }

    #[test]
    fn negative_onelibrary_ids_are_valid_local_playback_sources() {
        let local = source(-1_000_000_042, 0.0);
        assert!(validate_source(&local).is_ok());

        let mut remote = local;
        remote.source_kind = PlaybackSourceKind::Remote;
        assert!(validate_source(&remote).is_err());
    }

    #[test]
    fn sync_phase_target_uses_the_next_equivalent_bar_near_track_start() {
        let target = sync_phase_target(SyncPhaseInput {
            follower_position: 0.1,
            follower_bpm: 120.0,
            follower_first_beat: 0.0,
            follower_rate: 1.0,
            master_position: 1.8,
            master_bpm: 120.0,
            master_first_beat: 0.0,
            master_rate: 1.0,
            beats_per_bar: 4.0,
            follower_duration: Some(180.0),
        })
        .expect("valid grids");
        assert!((target - 1.8).abs() < 1e-9, "target={target}");
    }

    #[test]
    fn linked_rates_reach_the_callback_as_one_atomic_command() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[0] = Some(live_runtime(1, 4.0));
        actor.decks[1] = Some(live_runtime(2, 8.0));
        actor.state.decks[0].track_id = Some(1);
        actor.state.decks[1].track_id = Some(2);
        knobs.sent.lock().unwrap().clear();

        actor.set_deck_rates([1.1, 0.9]).expect("关联 TEMPO");

        assert_eq!(actor.state.decks[0].rate, 1.1);
        assert_eq!(actor.state.decks[1].rate, 0.9);
        let sent = knobs.sent.lock().unwrap();
        assert!(matches!(
            sent.as_slice(),
            [RtCommand::SetDeckRates { rates }]
                if (rates[0] - 1.1).abs() < f32::EPSILON
                    && (rates[1] - 0.9).abs() < f32::EPSILON
        ));
    }

    #[test]
    fn filter_resonance_setting_maps_to_the_expected_realtime_q() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        knobs.sent.lock().unwrap().clear();

        actor
            .set_filter_resonance(FilterResonance::Low)
            .expect("低共振命令");
        actor
            .set_filter_resonance(FilterResonance::High)
            .expect("高共振命令");

        assert_eq!(actor.filter_resonance, FILTER_RESONANCE_HIGH_Q);
        let sent = knobs.sent.lock().unwrap();
        assert!(matches!(
            sent[0],
            RtCommand::SetFilterResonance { q } if (q - FILTER_RESONANCE_LOW_Q).abs() < f32::EPSILON
        ));
        assert!(matches!(
            sent[1],
            RtCommand::SetFilterResonance { q } if (q - FILTER_RESONANCE_HIGH_Q).abs() < f32::EPSILON
        ));
    }

    /// 造假一个“仍在发声”的 Deck：writer 故意泄漏，流永远不会 drained，
    /// reusable_deck 才会承认它。
    fn live_runtime(track_id: i64, position: f64) -> DeckRuntime {
        let (stream, writer) = StreamSource::bounded(48_000);
        std::mem::forget(writer);
        DeckRuntime {
            source_id: 100 + track_id as u64,
            source: PlaybackStream::Stereo(stream),
            request: source(track_id, position),
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            loop_playback: None,
            cancel: Arc::new(AtomicU64::new(1)),
            seek: StreamSeekControl::new(),
        }
    }

    fn drained_runtime(track_id: i64, position: f64) -> DeckRuntime {
        let (stream, writer) = StreamSource::bounded(48_000);
        writer.finish();
        DeckRuntime {
            source_id: 100 + track_id as u64,
            source: PlaybackStream::Stereo(stream),
            request: source(track_id, position),
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            loop_playback: None,
            cancel: Arc::new(AtomicU64::new(1)),
            seek: StreamSeekControl::new(),
        }
    }

    /// 回归主竞态：handoff/load 已承诺的 pending 不得被后台预热顶掉，
    /// 否则激活随之丢失——状态指向新曲目，旧 Deck 却继续发声。
    #[test]
    fn prepare_yields_to_a_committed_pending_stream() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.load(source(2, 0.0)).expect("load 登记");
        assert!(matches!(
            actor.pending[DeckId::B as usize]
                .as_ref()
                .and_then(|pending| pending.activation),
            Some(Activation::Hard)
        ));

        actor.prepare(source(3, 0.0)).expect("prepare 让路但成功");

        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("已承诺的 pending 不能被顶掉");
        assert_eq!(pending.request.track_id, 2);
        assert!(pending.activation.is_some());
        assert_ne!(actor.state.prepared_track_id, Some(3));
    }

    /// 保护不能误伤常规预热：不带激活的 pending 仍然后来居上。
    #[test]
    fn prepare_still_replaces_an_uncommitted_pending_stream() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.prepare(source(2, 0.0)).expect("预热 2");
        actor.prepare(source(3, 0.0)).expect("预热 3");

        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("预热流还在");
        assert_eq!(pending.request.track_id, 3);
        assert!(pending.activation.is_none());
    }

    /// 前端最终接歌前会再次 prepare：即使旧的预热标记已经被队列预热弄陈旧，
    /// 这次确认也必须把 Deck 重新指回最终候选，随后 handoff 才不会退化成硬切。
    #[test]
    fn final_prepare_recovers_a_candidate_replaced_by_queue_prewarm() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.prepare(source(2, 0.0)).expect("预测预热 2");
        actor.prepare(source(3, 0.0)).expect("队列预热改成 3");

        actor.prepare(source(2, 0.0)).expect("最终候选重新确认");
        actor
            .handoff(
                2,
                PendingTransition {
                    position: 0.0,
                    seconds: 8.0,
                    plan: PlaybackTransitionPlan::default(),
                },
            )
            .expect("handoff 应绑定最终候选");

        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("最终候选仍在准备");
        assert_eq!(pending.request.track_id, 2);
        assert!(matches!(
            pending.activation,
            Some(Activation::Transition(transition)) if transition.seconds == 8.0
        ));
    }

    /// 连续接歌时第二场会暂存在 deferred，直到第一场释放旧 Deck。此时 UI 更新会
    /// 触发下一轮队列预热，但不能把已经承诺的第二场激活覆盖掉。
    #[test]
    fn queue_prewarm_yields_to_a_committed_deferred_transition() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::B;
        actor.state.track_id = Some(2);
        actor.retire_after_transition = Some(DeckId::A);
        actor.deferred_stream = Some(DeferredStream {
            request: source(3, 0.0),
            activation: Some(Activation::Transition(PendingTransition {
                position: 0.0,
                seconds: 8.0,
                plan: PlaybackTransitionPlan::default(),
            })),
        });

        actor.prepare(source(4, 0.0)).expect("后台预热应让路");

        let deferred = actor.deferred_stream.as_ref().expect("第二场接歌承诺仍在");
        assert_eq!(deferred.request.track_id, 3);
        assert!(matches!(
            deferred.activation,
            Some(Activation::Transition(transition)) if transition.seconds == 8.0
        ));
        assert_ne!(actor.state.prepared_track_id, Some(4));
    }

    /// 两台 Deck 的容量边界：第一场已混入、第二场占住 deferred 后，第三个候选
    /// 只能被明确拒绝，不能覆盖第二场承诺或把 actor 推进错误状态。前端会把这次
    /// latest intent 留到稳定边沿重试；后端此处仍必须保证三连命令不会 panic。
    #[test]
    fn third_handoff_preserves_the_single_committed_deferred_transition() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.desired_playing = true;

        let transition = PendingTransition {
            position: 0.0,
            seconds: 8.0,
            plan: PlaybackTransitionPlan::default(),
        };
        actor.handoff(2, transition).expect("第一场接歌");
        actor.prepare(source(3, 0.0)).expect("第二场进入 deferred");
        actor.handoff(3, transition).expect("第二场承诺落账");

        actor
            .prepare(source(4, 0.0))
            .expect("第三候选必须给已承诺流让路");
        let before = actor.state.clone();
        let error = actor.handoff(4, transition).unwrap_err();

        assert!(error.contains("尚未开始准备"));
        assert_eq!(actor.state, before, "拒绝第三场不能破坏已发布状态");
        let deferred = actor.deferred_stream.as_ref().expect("第二场承诺必须保留");
        assert_eq!(deferred.request.track_id, 3);
        assert!(matches!(
            deferred.activation,
            Some(Activation::Transition(committed)) if committed.seconds == 8.0
        ));
    }

    #[test]
    fn handoff_without_a_prepared_deck_leaves_state_untouched() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        let before = actor.state.clone();

        let error = actor
            .handoff(
                9,
                PendingTransition {
                    position: 0.0,
                    seconds: 4.0,
                    plan: PlaybackTransitionPlan::default(),
                },
            )
            .unwrap_err();

        assert!(error.contains("尚未开始准备"));
        assert_eq!(actor.state, before);
    }

    /// 曲目 Ended 会清掉 desired_playing。已预热 Deck 的 handoff 必须把它拉回，
    /// 否则过渡以暂停态建立、帧不推进，前端只能再走硬切。
    #[test]
    fn handoff_after_ended_restores_desired_playing() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 170.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Ended;
        actor.state.desired_playing = false;
        actor.state.is_playing = false;

        actor
            .handoff(
                2,
                PendingTransition {
                    position: 0.0,
                    seconds: 4.0,
                    plan: PlaybackTransitionPlan::default(),
                },
            )
            .expect("Ended 后仍应能 handoff");

        assert!(actor.state.desired_playing);
        assert!(actor.state.is_playing);
        assert!(actor.state.transitioning);
        assert_eq!(actor.front, DeckId::B);
        assert_eq!(actor.state.track_id, Some(2));
        assert_eq!(actor.state.phase, PlaybackPhase::Transitioning);
    }

    #[test]
    fn load_failure_rolls_back_published_state() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.state.desired_playing = true;
        actor.state.is_playing = true;
        knobs.fail_send.store(true, Ordering::Relaxed);

        // 同曲目重载走 activate 捷径；发送失败必须整体回滚，
        // 不能留下“状态说已暂停换曲、硬件还在放”的分叉。
        let error = actor.load(source(1, 0.0)).unwrap_err();

        assert!(error.contains("注入"));
        assert_eq!(actor.state.track_id, Some(1));
        assert_eq!(actor.state.phase, PlaybackPhase::Playing);
        assert!(actor.state.desired_playing);
        assert_eq!(actor.front, DeckId::A);
    }

    #[test]
    fn failed_stem_stream_keeps_the_original_mix_and_transport_running() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.state.desired_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.buffering = true;
        actor.state.decks[DeckId::A as usize].buffering = true;
        let (shadow, writer) = StreamSource::bounded(64);
        std::mem::forget(writer);
        let mut request = source(1, 12.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/missing/stem.kdstem".into();
        request.stem_mask = 0b0111;
        actor.revisions[DeckId::A as usize] = 77;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 77,
            source: PlaybackStream::Stereo(shadow),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(77)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });

        actor.handle(Request::WorkerFinished {
            deck: DeckId::A,
            revision: 77,
            result: Err("cache read failed".into()),
        });

        assert!(actor.decks[DeckId::A as usize].is_some());
        assert!(actor.pending[DeckId::A as usize].is_none());
        assert_eq!(actor.state.phase, PlaybackPhase::Playing);
        assert!(!actor.state.buffering);
        assert!(actor.state.error.contains("已保留原曲"));
        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(
            !knobs.sent.lock().unwrap().iter().any(|command| matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::A,
                    playing: false,
                }
            )),
            "a failed optional STEM worker must not pause its Deck"
        );
    }

    #[test]
    fn an_installed_stem_underrun_keeps_the_live_worker() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        let (stems, writer) = StreamSource::<StemFrame>::bounded(48_000);
        std::mem::forget(writer);
        let mut runtime = live_runtime(1, 12.0);
        runtime.source = PlaybackStream::Stems(stems);
        runtime.request.stem_enabled = true;
        runtime.request.stem_cache_path = "/model/hs-tasnet.onnx".into();
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;

        actor.observed_stem_underruns = stem_output_underruns_by_deck();
        record_stem_output_underrun();
        actor.protect_audio_from_stem_underrun();

        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.decks[DeckId::A as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.stem_enabled));
        assert!(actor.stem_recoveries[DeckId::A as usize].is_none());
    }

    #[test]
    fn one_deck_stem_underrun_does_not_tear_down_the_other_deck() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        for (index, deck) in [DeckId::A, DeckId::B].into_iter().enumerate() {
            let (stems, writer) = StreamSource::<StemFrame>::bounded(48_000);
            std::mem::forget(writer);
            let mut runtime = live_runtime(index as i64 + 1, 12.0);
            runtime.source = PlaybackStream::Stems(stems);
            runtime.request.stem_enabled = true;
            runtime.request.stem_cache_path =
                "/model/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
            actor.decks[deck as usize] = Some(runtime);
            actor.state.decks[deck as usize].track_id = Some(index as i64 + 1);
            actor.state.decks[deck as usize].current_time = 12.0;
            actor.manual_desired_playing[deck as usize] = true;
        }
        actor.manual_mode = true;
        actor.observed_stem_underruns = stem_output_underruns_by_deck();

        record_stem_output_underrun();
        actor.protect_audio_from_stem_underrun();

        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.pending[DeckId::B as usize].is_none());
        assert!(actor.decks[DeckId::A as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.stem_enabled));
        assert!(actor.decks[DeckId::B as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.stem_enabled));
    }

    #[test]
    fn stem_seek_prepares_a_shadow_stem_generation_without_falling_back_to_original() {
        enable_bytedance_stem_runtime_for_test();
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let (stems, writer) = StreamSource::<StemFrame>::bounded(48_000);
        std::mem::forget(writer);
        let mut runtime = live_runtime(1, 12.0);
        runtime.source = PlaybackStream::Stems(stems);
        runtime.request.stem_enabled = true;
        runtime.request.stem_cache_path =
            "/model/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        runtime.request.stem_mask = 0b1010;
        runtime.request.stem_gains = [0.25, 0.5, 0.75, 1.25];
        let live_cancel = Arc::clone(&runtime.cancel);
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;

        actor
            .seek_deck(DeckId::A as u8, 4.0)
            .expect("STEM 跳转应建立分轨 shadow");

        assert_eq!(live_cancel.load(Ordering::Acquire), 1);
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("shadow STEM should be pending");
        assert!(pending.request.stem_enabled);
        assert!(!pending.followup_stems);
        assert!(pending.clocked_seek.is_some());
        assert_eq!(pending.request.stem_mask, 0b1010);
        assert_eq!(pending.request.stem_gains, [0.25, 0.5, 0.75, 1.25]);
        assert!(pending.request.position > 4.0);
        assert!((actor.state.decks[DeckId::A as usize].current_time - 4.0).abs() < 0.001);
    }

    #[test]
    fn stem_gain_changes_ride_the_realtime_queue_without_respawning_a_worker() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        let (stream, writer) = StreamSource::<StemFrame>::bounded(48_000);
        std::mem::forget(writer);
        let mut runtime = live_runtime(1, 12.0);
        runtime.source = PlaybackStream::Stems(stream);
        runtime.request.stem_enabled = true;
        runtime.request.stem_cache_path = "/cache/a.kdstem".into();
        runtime.request.stem_mask = 0b1111;
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.manual_mode = true;

        actor
            .set_deck_stems(
                1,
                true,
                "/cache/a.kdstem".into(),
                0b0111,
                [1.0, 0.5, 1.0, 1.0],
            )
            .expect("同缓存的增益调整走快路径");

        assert!(
            actor.pending[DeckId::A as usize].is_none(),
            "增益/静音调整不得重启解码 worker"
        );
        let sent = knobs.sent.lock().unwrap();
        let gains = sent
            .iter()
            .rev()
            .find_map(|command| match command {
                RtCommand::SetDeckStemGains { deck, gains } if *deck == DeckId::A => Some(*gains),
                _ => None,
            })
            .expect("应直接发送实时混音命令");
        // 掩码关掉的 vocals 为 0，bass 半音量，其余全音量。
        assert_eq!(gains, [1.0, 0.5, 1.0, 0.0]);
    }

    #[test]
    fn stem_eq_boost_is_not_clamped_to_unity() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        let (stream, writer) = StreamSource::<StemFrame>::bounded(48_000);
        std::mem::forget(writer);
        let mut runtime = live_runtime(1, 12.0);
        runtime.source = PlaybackStream::Stems(stream);
        runtime.request.stem_enabled = true;
        runtime.request.stem_cache_path = "/cache/a.kdstem".into();
        runtime.request.stem_mask = 0b1111;
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.manual_mode = true;

        actor
            .set_deck_stems(
                1,
                true,
                "/cache/a.kdstem".into(),
                0b1111,
                [1.5, 1.0, 1.0, 2.0],
            )
            .expect("STEM EQ 推升应走快路径");

        let sent = knobs.sent.lock().unwrap();
        let gains = sent
            .iter()
            .rev()
            .find_map(|command| match command {
                RtCommand::SetDeckStemGains { deck, gains } if *deck == DeckId::A => Some(*gains),
                _ => None,
            })
            .expect("应直接发送实时混音命令");
        assert_eq!(gains, [1.5, 1.0, 1.0, 2.0]);
    }

    #[test]
    fn loop_shares_a_live_stem_deck_without_replacing_the_source() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        let mut runtime = live_runtime(1, 12.0);
        runtime.request.stem_enabled = true;
        runtime.request.stem_cache_path =
            "/models/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].duration = 180.0;
        actor.state.decks[DeckId::A as usize].current_time = 12.0;

        actor
            .set_deck_loop(1, 10.0, 1.0)
            .expect("STEM 台上的 LOOP 应只改走带约束");

        assert!(actor.pending[DeckId::A as usize].is_none());
        let runtime = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("循环不得换掉当前 STEM 源");
        assert!(runtime.request.stem_enabled);
        assert!(runtime.loop_playback.is_some());
        assert!(matches!(
            runtime.source,
            PlaybackStream::Stems(_) | PlaybackStream::Stereo(_)
        ));
        assert_eq!(actor.state.decks[DeckId::A as usize].loop_start, Some(10.0));
        let sent = knobs.sent.lock().unwrap();
        assert!(sent.iter().any(|command| matches!(
            command,
            RtCommand::SetDeckLoop {
                deck: DeckId::A,
                looping: true,
                start_frames: 480_000,
                frames: 48_000,
            }
        )));
    }

    #[test]
    fn loop_outside_track_is_rejected_without_touching_playback() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].duration = 180.0;

        actor
            .set_deck_loop(1, 170.0, 20.0)
            .expect_err("循环区间越界必须拒绝");

        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.state.decks[DeckId::A as usize].loop_start.is_none());
        assert!(actor
            .clear_deck_loop(1)
            .is_ok_and(|()| actor.pending[DeckId::A as usize].is_none()));
    }

    #[test]
    fn set_deck_loop_keeps_the_current_source_and_mixer() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.manual_mode = true;
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].duration = 180.0;

        actor
            .set_deck_loop(1, 10.0, 0.1)
            .expect("LOOP 应落在当前源上");
        actor.set_deck_loop(1, 10.0, 0.2).expect("改拍数只更新窗口");

        assert!(actor.pending[DeckId::A as usize].is_none());
        let runtime = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("改循环不得换源");
        assert!(matches!(runtime.source, PlaybackStream::Stereo(_)));
        assert_eq!(
            runtime.loop_playback.map(|looping| looping.length),
            Some(0.2)
        );
        let sent = knobs.sent.lock().unwrap();
        let loops = sent
            .iter()
            .filter(|command| matches!(command, RtCommand::SetDeckLoop { looping: true, .. }))
            .count();
        assert!(loops >= 2, "改拍数应再次发送走带 LOOP 命令");
    }

    #[test]
    fn stale_zero_loop_start_follows_the_live_playhead() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 45.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 45.0;
        actor.state.decks[DeckId::A as usize].duration = 180.0;

        actor
            .set_deck_loop(1, 0.0, 2.0)
            .expect("过期的 0 起点应改用当前播放头");

        assert_eq!(actor.state.decks[DeckId::A as usize].loop_start, Some(45.0));
        assert_eq!(actor.state.decks[DeckId::A as usize].loop_length, Some(2.0));
        let snap = actor.loop_windows[DeckId::A as usize]
            .snapshot()
            .expect("循环窗口应开启");
        assert!((snap.start - 45.0).abs() < 1e-6);
        assert!((snap.playhead - 45.0).abs() < 1e-6);
        assert!((snap.engage_target() - 45.0).abs() < 1e-6);
    }

    #[test]
    fn loop_in_survives_a_zero_playhead_snapshot() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 45.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 0.0;
        actor.state.decks[DeckId::A as usize].duration = 180.0;

        actor
            .set_deck_loop(1, 45.0, 2.0)
            .expect("UI 起点正确时不得被 0 播放头覆盖");

        let snap = actor.loop_windows[DeckId::A as usize]
            .snapshot()
            .expect("循环窗口应开启");
        assert!((snap.start - 45.0).abs() < 1e-6);
        assert_eq!(snap.engage_target(), 45.0);
    }

    #[test]
    fn looping_drained_deck_does_not_rewind_to_start() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut runtime = drained_runtime(1, 45.0);
        runtime.loop_playback = Some(LoopPlayback {
            start: 45.0,
            length: 2.0,
        });
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.state.track_id = Some(1);
        actor.state.desired_playing = true;
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 46.0;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids = [101, 0];
            snapshot.deck_frames = [48_000 * 46, 0];
            snapshot.deck_playing = [true, false];
            snapshot.playing = true;
        }

        actor.refresh_from_audio();

        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - 46.0).abs() < 0.001,
            "LOOP 欠跑不得把播放头拽回曲头"
        );
    }

    /// 换曲激活未落地时点进度条：跳转折进待激活流，新曲目改从目标位置起播，
    /// 而不是被拒绝后让进度条先跳过去再弹回来。
    #[test]
    fn seek_during_a_pending_track_change_retargets_the_load() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.load(source(2, 0.0)).expect("load 登记");

        actor.seek(30.0).expect("跳转折进待激活的换曲");

        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("待激活流不能被这次跳转顶掉");
        assert_eq!(pending.request.track_id, 2);
        assert!(matches!(pending.activation, Some(Activation::Hard)));
        assert!((pending.request.position - 30.0).abs() < 0.001);
        assert!((actor.state.current_time - 30.0).abs() < 0.001);
        assert_eq!(actor.state.phase, PlaybackPhase::Loading);
        assert!(actor.state.buffering);
    }

    /// 接歌承诺未 activate 时点进度条：同样折进 Transition，避免乐观 UI 弹回 cue。
    #[test]
    fn seek_during_a_pending_transition_retargets_the_handoff() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.prepare(source(2, 0.0)).expect("预热下一首");
        actor
            .handoff(
                2,
                PendingTransition {
                    position: 0.0,
                    seconds: 8.0,
                    plan: PlaybackTransitionPlan::default(),
                },
            )
            .expect("登记接歌承诺");

        actor.seek(45.0).expect("跳转折进待激活的接歌");

        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("接歌流仍在");
        assert_eq!(pending.request.track_id, 2);
        assert!((pending.request.position - 45.0).abs() < 0.001);
        assert!(matches!(
            pending.activation,
            Some(Activation::Transition(transition))
                if (transition.position - 45.0).abs() < 0.001 && transition.seconds == 8.0
        ));
        assert!((actor.state.current_time - 45.0).abs() < 0.001);
        assert_eq!(actor.state.track_id, Some(2));
        assert_eq!(actor.state.phase, PlaybackPhase::Loading);
    }

    /// 第二场接歌还在 deferred 时点进度条：只改承诺位置，不能 settle 清掉。
    #[test]
    fn seek_during_a_deferred_transition_retargets_without_dropping_it() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::B;
        actor.state.track_id = Some(3);
        actor.state.phase = PlaybackPhase::Loading;
        actor.retire_after_transition = Some(DeckId::A);
        actor.state.transitioning = true;
        actor.deferred_stream = Some(DeferredStream {
            request: source(3, 0.0),
            activation: Some(Activation::Transition(PendingTransition {
                position: 0.0,
                seconds: 8.0,
                plan: PlaybackTransitionPlan::default(),
            })),
        });

        actor.seek(22.0).expect("跳转折进 deferred 接歌");

        let deferred = actor.deferred_stream.as_ref().expect("第二场承诺仍在");
        assert_eq!(deferred.request.track_id, 3);
        assert!((deferred.request.position - 22.0).abs() < 0.001);
        assert!(matches!(
            deferred.activation,
            Some(Activation::Transition(transition))
                if (transition.position - 22.0).abs() < 0.001 && transition.seconds == 8.0
        ));
        assert!(actor.retire_after_transition.is_some());
        assert!(actor.state.transitioning);
        assert!((actor.state.current_time - 22.0).abs() < 0.001);
    }

    /// 混音被 seek/load 强行收尾时，已承诺的第二场必须升到腾出的 Deck，不能丢。
    #[test]
    fn settle_transition_promotes_a_committed_deferred_handoff() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::B;
        actor.state.track_id = Some(2);
        actor.state.phase = PlaybackPhase::Transitioning;
        actor.state.transitioning = true;
        actor.retire_after_transition = Some(DeckId::A);
        actor.deferred_stream = Some(DeferredStream {
            request: source(3, 1.5),
            activation: Some(Activation::Transition(PendingTransition {
                position: 1.5,
                seconds: 6.0,
                plan: PlaybackTransitionPlan::default(),
            })),
        });

        actor.settle_transition().expect("强行收尾第一场");

        assert!(actor.retire_after_transition.is_none());
        assert!(!actor.state.transitioning);
        assert!(actor.deferred_stream.is_none());
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("第二场应升到腾出的 Deck");
        assert_eq!(pending.request.track_id, 3);
        assert!((pending.request.position - 1.5).abs() < 0.001);
        assert!(matches!(
            pending.activation,
            Some(Activation::Transition(transition))
                if (transition.position - 1.5).abs() < 0.001 && transition.seconds == 6.0
        ));
    }

    /// 连续接歌窗口：deferred 已承诺给新曲目后，state 指向新曲目，front 仍是
    /// 第一场混音的进场 Deck。它的时钟/时长不能进状态，否则进度条先跳回
    /// 第一场的进度，等第二场激活再弹走——看着就是「点完进度条又弹回去」。
    #[test]
    fn deferred_committed_state_ignores_the_front_deck_clock() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 0.0));
        actor.front = DeckId::B;
        actor.state.track_id = Some(3);
        actor.state.phase = PlaybackPhase::Loading;
        actor.state.transitioning = true;
        actor.state.current_time = 45.0;
        actor.state.duration = 240.0;
        actor.retire_after_transition = Some(DeckId::A);
        actor.deferred_stream = Some(DeferredStream {
            request: source(3, 45.0),
            activation: Some(Activation::Transition(PendingTransition {
                position: 45.0,
                seconds: 8.0,
                plan: PlaybackTransitionPlan::default(),
            })),
        });
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.active_deck = DeckId::B;
            snapshot.transitioning = true;
            snapshot.playing = true;
            snapshot.deck_source_ids[DeckId::B as usize] = 102; // live_runtime(2)
            snapshot.deck_frames[DeckId::B as usize] = 48_000; // 第一场才播到 1.0s
        }

        actor.refresh_from_audio();

        assert!(
            (actor.state.current_time - 45.0).abs() < 0.001,
            "front Deck 的时钟不能盖掉已承诺曲目的位置，当前 {}",
            actor.state.current_time
        );
        assert!(
            (actor.state.duration - 240.0).abs() < 0.001,
            "front Deck 的时长不能盖掉已承诺曲目的时长，当前 {}",
            actor.state.duration
        );
    }

    /// 点到进度条最右端：目标被收进末尾余量内，seek 不会读出流外。
    #[test]
    fn clamp_position_keeps_a_margin_from_the_stream_end() {
        assert!((clamp_position(184.464, Some(184.5)) - 184.25).abs() < 0.001);
        assert!((clamp_position(30.0, Some(184.5)) - 30.0).abs() < 0.001);
        assert!((clamp_position(184.464, None) - 184.464).abs() < 0.001);
        assert_eq!(clamp_position(5.0, Some(0.1)), 0.0);
        assert_eq!(clamp_position(f64::NAN, Some(10.0)), 0.0);
    }

    /// 没有激活承诺时跳转照常登记（保护不影响正常 seek）。
    #[test]
    fn seek_still_streams_when_no_activation_is_pending() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.state.desired_playing = true;

        actor.seek(30.0).expect("跳转登记");

        assert_eq!(actor.state.phase, PlaybackPhase::Seeking);
        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("seek 流已登记");
        assert!(matches!(pending.activation, Some(Activation::Seek)));
        assert!((pending.request.position - 30.0).abs() < 0.001);
    }

    #[test]
    fn deck_rate_change_inherits_a_playing_deck_before_manual_mode() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.desired_playing = true;

        actor
            .set_deck_rate(DeckId::A as u8, 0.8)
            .expect("改变 Deck 速率");

        assert!(actor.manual_mode);
        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.state.decks[DeckId::A as usize].is_playing);
        assert!(!actor.state.decks[DeckId::A as usize].buffering);
        assert!(
            (actor.decks[DeckId::A as usize]
                .as_ref()
                .unwrap()
                .request
                .rate
                - 0.8)
                .abs()
                < 0.001
        );
        assert!(knobs.sent.lock().unwrap().iter().any(|command| {
            matches!(command, RtCommand::SetRate { deck: DeckId::A, rate } if (*rate - 0.8).abs() < 0.001)
        }));
    }

    #[test]
    fn edge_jog_nudge_is_temporary_and_never_rebuilds_the_deck() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut runtime = live_runtime(1, 12.0);
        runtime.request.rate = 1.1;
        actor.decks[DeckId::A as usize] = Some(runtime);
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].rate = 1.1;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.desired_playing = true;
        let source_id = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("Deck A 已装入")
            .source_id;
        knobs.sent.lock().unwrap().clear();

        actor
            .nudge_deck(DeckId::A as u8, 1.0)
            .expect("边缘缓动应走实时控制通道");

        let runtime = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("缓动不能替换 Deck");
        assert_eq!(runtime.source_id, source_id);
        assert!(
            (runtime.request.rate - 1.1).abs() < 0.001,
            "TEMPO 不得被缓动写回"
        );
        assert!((runtime.tempo.rate() - 1.1 * (1.0 + JOG_NUDGE_MAX_RATE_OFFSET)).abs() < 0.001);
        assert!(
            actor.pending[DeckId::A as usize].is_none(),
            "缓动不得启动新的解码 worker"
        );
        assert!((actor.state.decks[DeckId::A as usize].rate - 1.1).abs() < 0.001);

        actor.jog_nudge_until[DeckId::A as usize] = Some(Instant::now() - Duration::from_millis(1));
        actor.release_expired_jog_nudges();

        let runtime = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("Deck A 保持原样");
        assert!(
            (runtime.tempo.rate() - 1.1).abs() < 0.001,
            "超时后必须回到原 TEMPO"
        );
        assert!(knobs.sent.lock().unwrap().iter().any(|command| {
            matches!(command, RtCommand::SetRate { deck: DeckId::A, rate } if (*rate - 1.1).abs() < 0.001)
        }));
    }

    #[test]
    fn mixer_controls_target_the_physical_deck_even_when_track_ids_are_ambiguous() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        // A seek/handoff can briefly leave the same track installed on both physical Decks.
        // Mixer controls belong to their channel strip, not to a track ID.
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(1, 18.0));
        knobs.sent.lock().unwrap().clear();

        actor
            .set_deck_mixer(
                DeckId::B as u8,
                DeckMixer {
                    channel_gain: 0.25,
                    trim_db: -6.0,
                    low_db: -12.0,
                    mid_db: -18.0,
                    high_db: 3.0,
                    filter: 0.4,
                },
            )
            .expect("调整 Deck B 混音");

        assert_eq!(actor.deck_mixers[DeckId::A as usize].channel_gain, 1.0);
        assert_eq!(actor.deck_mixers[DeckId::B as usize].channel_gain, 0.25);
        let sent = knobs.sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(matches!(
            sent[0],
            RtCommand::SetDeckGain { deck: DeckId::B, gain } if (gain - 0.25).abs() < 0.001
        ));
        assert!(matches!(
            sent[1],
            RtCommand::SetEq {
                deck: DeckId::B,
                trim_db,
                low_db,
                mid_db,
                high_db,
                filter,
            } if (trim_db + 6.0).abs() < 0.001
                && (low_db + 12.0).abs() < 0.001
                && (mid_db + 18.0).abs() < 0.001
                && (high_db - 3.0).abs() < 0.001
                && (filter - 0.4).abs() < 0.001
        ));
    }

    #[test]
    fn transport_controls_target_the_physical_deck_even_when_track_ids_are_ambiguous() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(1, 18.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::B as usize].track_id = Some(1);
        knobs.sent.lock().unwrap().clear();

        actor
            .set_deck_playing(DeckId::B as u8, true)
            .expect("播放物理 Deck B");

        assert_eq!(actor.front, DeckId::B);
        assert!(!actor.state.decks[DeckId::A as usize].desired_playing);
        assert!(actor.state.decks[DeckId::B as usize].desired_playing);
        assert!(knobs.sent.lock().unwrap().iter().any(|command| {
            matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::B,
                    playing: true
                }
            )
        }));
    }

    #[test]
    fn pausing_one_physical_deck_never_starts_the_other() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 18.0));
        actor.front = DeckId::A;
        actor.state.track_id = Some(1);
        actor.state.desired_playing = true;
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::B as usize].track_id = Some(2);
        actor.state.decks[DeckId::B as usize].is_playing = false;
        knobs.sent.lock().unwrap().clear();

        actor
            .set_deck_playing(DeckId::A as u8, false)
            .expect("只暂停 A");

        assert_eq!(actor.manual_desired_playing, [false, false]);
        assert!(!actor.state.decks[DeckId::A as usize].desired_playing);
        assert!(!actor.state.decks[DeckId::B as usize].desired_playing);
        let sent = knobs.sent.lock().unwrap();
        assert!(sent.iter().any(|command| {
            matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::A,
                    playing: false
                }
            )
        }));
        assert!(!sent.iter().any(|command| {
            matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::B,
                    playing: true
                }
            )
        }));
    }

    #[test]
    fn explicit_paused_deck_load_keeps_the_other_deck_playing() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.desired_playing = true;
        let mut dropped = source(2, 3.25);
        dropped.autoplay = false;

        actor
            .load_deck(DeckId::B as u8, dropped)
            .expect("拖放装入 B");

        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(!actor.manual_desired_playing[DeckId::B as usize]);
        assert_eq!(actor.state.decks[DeckId::B as usize].track_id, Some(2));
        assert!((actor.state.decks[DeckId::B as usize].current_time - 3.25).abs() < 0.001);
        assert!(!actor.state.decks[DeckId::B as usize].desired_playing);
        let pending = actor.pending[DeckId::B as usize]
            .as_ref()
            .expect("B 的暂停流已登记");
        assert!(!pending.request.autoplay);
    }

    #[test]
    fn playing_a_pending_explicit_deck_adopts_that_deck_without_a_cross_deck_load() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.state.track_id = Some(9);
        actor
            .load_deck(DeckId::A as u8, source(11, 3.25))
            .expect("拖放装入 A");

        actor
            .set_deck_playing(DeckId::A as u8, true)
            .expect("播放仍在缓冲的 A");

        assert_eq!(actor.front, DeckId::A);
        assert_eq!(actor.state.track_id, Some(11));
        assert!(actor.state.decks[DeckId::A as usize].desired_playing);
        assert!(actor.state.decks[DeckId::A as usize].buffering);
        assert!(actor.pending[DeckId::B as usize].is_none());
    }

    #[test]
    fn manual_deck_loads_are_isolated_from_recommendation_prepare() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");

        actor
            .load_deck(DeckId::A as u8, source(11, 0.0))
            .expect("显式装入 A");
        actor
            .load_deck(DeckId::B as u8, source(22, 0.0))
            .expect("显式装入 B");
        let revisions = actor.revisions;

        actor
            .prepare(source(33, 0.0))
            .expect("推荐预热在手动模式应为 no-op");
        actor.queue = vec![source(44, 0.0)];
        actor.prewarm_queue().expect("队列预热在手动模式应为 no-op");

        assert_eq!(
            actor.revisions, revisions,
            "后台预热不能取消任一显式解码 worker"
        );
        assert_eq!(
            actor.pending[DeckId::A as usize]
                .as_ref()
                .map(|pending| pending.request.track_id),
            Some(11)
        );
        assert_eq!(
            actor.pending[DeckId::B as usize]
                .as_ref()
                .map(|pending| pending.request.track_id),
            Some(22)
        );
        assert!(actor.manual_mode);
    }

    #[test]
    fn ended_manual_deck_rewinds_to_start_and_stays_paused() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(drained_runtime(1, 0.0));
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 12.0));
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, true];
        actor.state.track_id = Some(1);
        actor.state.desired_playing = true;
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 179.5;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::B as usize].track_id = Some(2);
        actor.state.decks[DeckId::B as usize].current_time = 12.0;
        actor.state.decks[DeckId::B as usize].desired_playing = true;
        actor.state.decks[DeckId::B as usize].is_playing = true;
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids = [101, 102];
            snapshot.deck_frames = [48_000 * 179, 48_000 * 12];
            snapshot.deck_playing = [false, true];
            snapshot.playing = true;
        }

        actor.refresh_from_audio();

        assert!(!actor.manual_desired_playing[DeckId::A as usize]);
        assert!(actor.manual_desired_playing[DeckId::B as usize]);
        assert!(!actor.state.decks[DeckId::A as usize].desired_playing);
        assert!(actor.state.decks[DeckId::B as usize].desired_playing);
        assert!(
            actor.state.decks[DeckId::A as usize].current_time.abs() < 0.001,
            "曲末必须回到 0，波形才能滚回起点"
        );
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("曲末应在起点重建流");
        assert!(pending.request.position.abs() < 0.001);
        assert!(!pending.request.autoplay, "回起点后必须停住，不能自动再放");
        assert!(actor.pending[DeckId::B as usize].is_none());
        actor.refresh_from_audio();
        assert!(
            actor.state.decks[DeckId::A as usize].current_time.abs() < 0.001,
            "未 promote 前 drained 时钟不能把播放头弹回曲尾"
        );
    }

    #[test]
    fn ended_manual_deck_keeps_an_in_flight_seek() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(drained_runtime(1, 0.0));
        actor.front = DeckId::A;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.state.track_id = Some(1);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 4.0;
        let (shadow, writer) = StreamSource::bounded(64);
        std::mem::forget(writer);
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 3,
            source: PlaybackStream::Stereo(shadow),
            request: source(1, 4.0),
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(3)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[0] = 101;
            snapshot.deck_frames[0] = 48_000 * 179;
            snapshot.deck_playing[0] = false;
        }

        actor.refresh_from_audio();

        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("在途 seek 必须保留");
        assert!((pending.request.position - 4.0).abs() < 0.001);
        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - 4.0).abs() < 0.001,
            "drained 旧时钟不能盖掉已经登记的跳转目标"
        );
    }

    #[test]
    fn auto_dj_ended_deck_does_not_rewind_to_start() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(drained_runtime(1, 0.0));
        actor.front = DeckId::A;
        actor.manual_mode = false;
        actor.state.track_id = Some(1);
        actor.state.desired_playing = true;
        actor.state.is_playing = false;
        actor.state.phase = PlaybackPhase::Playing;
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 179.5;
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[0] = 101;
            snapshot.deck_frames[0] = 48_000 * 179;
            snapshot.deck_playing[0] = false;
            snapshot.playing = false;
        }

        actor.refresh_from_audio();

        assert_eq!(actor.state.phase, PlaybackPhase::Ended);
        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(
            actor.state.decks[DeckId::A as usize].current_time > 170.0,
            "自动接歌路径必须停在曲末，才能走 Ended → 下一首"
        );
    }

    #[test]
    fn paused_scratch_seek_stays_paused() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.desired_playing = true;

        actor
            .set_deck_playing(DeckId::A as u8, false)
            .expect("按下波形先暂停");
        actor
            .seek_deck(DeckId::A as u8, 9.5)
            .expect("相对刮擦后跳转");

        assert!(!actor.manual_desired_playing[DeckId::A as usize]);
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("暂停 seek 流已登记");
        assert!(!pending.request.autoplay, "松开刮擦后不能自动恢复播放");
        assert!((pending.request.position - 9.5).abs() < 0.001);
    }

    #[test]
    fn capacitive_scratch_hold_preserves_play_intent_until_the_final_seek_promotes() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.desired_playing = true;

        actor
            .set_deck_scratch_held(DeckId::A as u8, true)
            .expect("按住盘面只接管游标");
        assert!(actor.scratch_held[DeckId::A as usize]);
        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(actor.state.decks[DeckId::A as usize].is_playing);
        assert!(
            !knobs.sent.lock().unwrap().iter().any(|command| matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::A,
                    ..
                }
            )),
            "touch must not be represented by a real PlayDeck/PauseDeck command",
        );
        knobs.sent.lock().unwrap().clear();
        actor
            .seek_deck(DeckId::A as u8, 9.5)
            .expect("松开盘面应预约最终落点");

        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("最终 seek 流已登记");
        assert!(
            pending.request.autoplay,
            "播放意图在整次手势中必须保持 true"
        );
        assert!(pending.release_scratch_hold, "新流有缓冲后才可交还盘面");
        assert_eq!(
            pending.clocked_seek.map(|seek| seek.requested_position),
            Some(9.5),
            "shadow may start ahead, but the platter's requested cursor remains the clock anchor",
        );
        assert!(
            !knobs.sent.lock().unwrap().iter().any(|command| matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::A,
                    ..
                }
            )),
            "jog touch/release must never issue a real PlayDeck/PauseDeck command",
        );
    }

    #[test]
    fn capacitive_scratch_ticks_move_the_held_cursor_without_rebuilding() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].duration = 180.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.desired_playing = true;

        actor
            .set_deck_scratch_held(DeckId::A as u8, true)
            .expect("按住盘面只接管游标");
        knobs.sent.lock().unwrap().clear();
        actor
            .scratch_deck(DeckId::A as u8, -0.01)
            .expect("按住转动应立刻送给引擎");

        assert!(
            actor.pending[DeckId::A as usize].is_none(),
            "刮擦 tick 不得重建 decoder"
        );
        assert!((actor.state.decks[DeckId::A as usize].current_time - 11.99).abs() < 0.001);
        let sent = knobs.sent.lock().unwrap();
        assert!(
            sent.iter().any(|command| matches!(
                command,
                RtCommand::ScratchDeck {
                    deck: DeckId::A,
                    delta_frames,
                } if (*delta_frames + 480.0).abs() < 0.001
            )),
            "held platter motion must become a realtime scratch tick, got {sent:?}",
        );
    }

    #[test]
    fn capacitive_scratch_hold_freezes_a_playing_deck_even_with_stale_manual_intent() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.state.desired_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [false, false];

        actor
            .set_deck_scratch_held(DeckId::A as u8, true)
            .expect("正在播放的 Deck 即使 manual intent 过期也必须冻结游标");
        assert!(actor.scratch_held[DeckId::A as usize]);
        assert!(actor.manual_desired_playing[DeckId::A as usize]);
        assert!(
            knobs.sent.lock().unwrap().iter().any(|command| matches!(
                command,
                RtCommand::SetDeckScratchHeld {
                    deck: DeckId::A,
                    held: true,
                }
            )),
            "stale manual intent must not swallow the callback hold",
        );
    }

    #[test]
    fn scratch_seek_promotion_releases_the_callback_hold_without_play_toggle() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.set_volume(0.0).expect("静音 MASTER");
        knobs.sent.lock().unwrap().clear();
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        actor.scratch_held = [true, false];
        let (stream, mut writer) = StreamSource::bounded(64);
        writer.push([0.0, 0.0], || false).expect("预填 seek ring");
        std::mem::forget(writer);
        actor.revisions[DeckId::A as usize] = 17;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 17,
            source: PlaybackStream::Stereo(stream),
            request: source(1, 9.5),
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(17)),
            followup_stems: false,
            release_scratch_hold: true,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });
        actor.promote_ready_streams();
        assert!(!actor.scratch_held[DeckId::A as usize]);
        let commands = knobs.sent.lock().unwrap();
        assert!(
            matches!(
                commands.first(),
                Some(RtCommand::SetMasterGain(gain)) if *gain == 0.0
            ),
            "安装 replacement 前必须重申已静音的 MASTER"
        );
        assert!(commands.iter().any(|command| matches!(
            command,
            RtCommand::SetDeckScratchHeld {
                deck: DeckId::A,
                held: false
            }
        )));
        assert!(
            !commands.iter().any(|command| matches!(
                command,
                RtCommand::SetDeckPlaying {
                    deck: DeckId::A,
                    ..
                }
            )),
            "promotion hands the cursor back; it must not synthesize a PlayDeck toggle",
        );
    }

    #[test]
    fn seek_does_not_cancel_the_live_decoder_before_promote() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        let live_cancel = Arc::clone(&actor.decks[DeckId::A as usize].as_ref().unwrap().cancel);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.desired_playing = true;

        actor
            .seek_deck(DeckId::A as u8, 4.0)
            .expect("跳转应登记替换流");

        assert_eq!(
            live_cancel.load(Ordering::Acquire),
            1,
            "正在发声的解码线程必须继续填 ring，直到新流 promote"
        );
        assert!(actor.pending[DeckId::A as usize].is_some());
        assert!(actor.decks[DeckId::A as usize].is_some());
        assert!(
            !actor.state.decks[DeckId::A as usize].buffering,
            "有可听的 live Deck 时 seek 不能把 UI 打成 buffering"
        );
        assert!((actor.state.decks[DeckId::A as usize].current_time - 4.0).abs() < 0.001);

        knobs.snapshot.lock().unwrap().deck_source_ids[0] = 101;
        knobs.snapshot.lock().unwrap().deck_frames[0] = 48_000 * 12;
        actor.refresh_from_audio();
        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - 4.0).abs() < 0.001,
            "promote 前不能把播放头弹回旧解码时钟"
        );
    }

    #[test]
    fn pause_cancels_a_clocked_sync_seek_and_keeps_the_audible_deck_clock() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 12.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.state.decks[DeckId::A as usize].desired_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        {
            let mut snapshot = knobs.snapshot.lock().unwrap();
            snapshot.deck_source_ids[DeckId::A as usize] = 101;
            snapshot.deck_frames[DeckId::A as usize] = 48_000 * 12;
            snapshot.deck_playing[DeckId::A as usize] = true;
        }

        actor
            .seek_deck(DeckId::A as u8, 4.0)
            .expect("SYNC seek should prepare in shadow");
        assert!(actor.pending[DeckId::A as usize]
            .as_ref()
            .is_some_and(|pending| pending.clocked_seek.is_some()));

        actor
            .set_deck_playing(DeckId::A as u8, false)
            .expect("pause should cancel the correction safely");

        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.decks[DeckId::A as usize].is_some());
        assert!((actor.state.decks[DeckId::A as usize].current_time - 12.0).abs() < 0.001);
        assert!(!actor.state.decks[DeckId::A as usize].is_playing);
    }

    #[test]
    fn stem_followup_does_not_freeze_or_rewind_the_seeked_clock() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 4.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 4.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        let (shadow, writer) = StreamSource::<StemFrame>::bounded(64);
        std::mem::forget(writer);
        let mut request = source(1, 7.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor.revisions[DeckId::A as usize] = 3;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 3,
            source: PlaybackStream::Stems(shadow),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(3)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });

        knobs.snapshot.lock().unwrap().deck_source_ids[0] = 101;
        knobs.snapshot.lock().unwrap().deck_frames[0] = 48_000 * 6;
        knobs.snapshot.lock().unwrap().deck_playing[0] = true;
        actor.refresh_from_audio();
        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - 6.0).abs() < 0.001,
            "分轨还在预热时必须跟着已经跳过去的原曲时钟走，不能把波形钉死"
        );

        match actor.stem_handoff_for(
            DeckId::A,
            actor.pending[DeckId::A as usize].as_ref().unwrap(),
        ) {
            StemHandoff::Wait => {}
            other => panic!("分轨起在未来位置时应等待，不能立刻装上，got {other:?}"),
        }
    }

    #[test]
    fn stem_handoff_waits_out_a_thirty_millisecond_early_window() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 6.97));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 6.97;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        let (shadow, writer) = StreamSource::<StemFrame>::bounded(64);
        std::mem::forget(writer);
        let mut request = source(1, 7.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 1,
            source: PlaybackStream::Stems(shadow),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(1)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });

        match actor.stem_handoff_for(
            DeckId::A,
            actor.pending[DeckId::A as usize].as_ref().unwrap(),
        ) {
            StemHandoff::Wait => {}
            other => panic!("提前 30ms 装上会把播放头向前跳一截，got {other:?}"),
        }
    }

    #[test]
    fn ready_viewport_stem_tile_skips_elapsed_prefix_without_a_second_retarget() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 6.15));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 6.15;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_000);
        for _ in 0..12_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        let mut request = source(1, 6.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        let pending = PendingStream {
            revision: 1,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 12_000,
            activation: None,
            cancel: Arc::new(AtomicU64::new(1)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        };

        assert!(matches!(
            actor.stem_handoff_for(DeckId::A, &pending),
            StemHandoff::Install
        ));
        drop(writer);
    }

    #[test]
    fn live_stem_handoff_waits_for_catchup_instead_of_spawning_replacement_generations() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 7.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 7.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_000);
        for _ in 0..3_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        let mut request = source(1, 6.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        let pending = PendingStream {
            revision: 1,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 2_000,
            activation: None,
            cancel: Arc::new(AtomicU64::new(1)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        };

        assert!(matches!(
            actor.stem_handoff_for(DeckId::A, &pending),
            StemHandoff::Wait
        ));
        drop(writer);
    }

    #[test]
    fn playing_stem_sync_promotes_from_the_command_clock_not_the_old_fixed_phase() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut live = live_runtime(1, 12.4);
        live.request.stem_enabled = true;
        actor.decks[DeckId::A as usize] = Some(live);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.4;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];

        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_000);
        for _ in 0..12_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        let promote_at = Instant::now() - Duration::from_millis(50);
        let mut request = source(1, 20.0);
        request.rate = 1.25;
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        actor.revisions[DeckId::A as usize] = 9;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 9,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.25),
            output_sample_rate: 48_000,
            startup_buffer_frames: 12_000,
            activation: None,
            cancel: Arc::new(AtomicU64::new(9)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: Some(ClockedDeckSeek {
                requested_at: promote_at - Duration::from_secs(1),
                requested_position: 18.75,
                promote_at,
                position: 20.0,
                rate: 1.25,
                advancing: true,
                skipped_output_frames: 0,
                skipped_media_frames: 0.0,
                catchup_progress_at: None,
            }),
            seek: StreamSeekControl::new(),
        });

        let before = Instant::now();
        actor.promote_ready_streams();
        let after = Instant::now();
        let installed =
            knobs.snapshot.lock().unwrap().deck_frames[DeckId::A as usize] as f64 / 48_000.0;
        let earliest = 20.0 + before.duration_since(promote_at).as_secs_f64() * 1.25;
        let latest = 20.0 + after.duration_since(promote_at).as_secs_f64() * 1.25;
        assert!(
            installed >= earliest - 0.001 && installed <= latest + 0.001,
            "clocked seek should install {earliest:.6}..{latest:.6}, got {installed:.6}",
        );
        assert!(
            (installed - 12.4).abs() > 1.0,
            "the outgoing Deck clock must not erase the requested SYNC correction",
        );
        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - installed).abs() < 0.001,
            "published Deck clock must match the frame installed into the callback",
        );
        drop(writer);
    }

    #[test]
    fn clocked_stem_seek_installs_a_late_tile_instead_of_chasing_another_model_window() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut live = live_runtime(1, 12.0);
        live.request.stem_enabled = true;
        actor.decks[DeckId::A as usize] = Some(live);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 12.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];

        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_000);
        for _ in 0..8_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        let promote_at = Instant::now() - Duration::from_millis(200);
        let mut request = source(1, 4.5);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        actor.revisions[DeckId::A as usize] = 11;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 11,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 8_000,
            activation: None,
            cancel: Arc::new(AtomicU64::new(11)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: Some(ClockedDeckSeek {
                requested_at: promote_at - Duration::from_millis(250),
                requested_position: 4.0,
                promote_at,
                position: 4.5,
                rate: 1.0,
                advancing: true,
                skipped_output_frames: 0,
                skipped_media_frames: 0.0,
                catchup_progress_at: None,
            }),
            seek: StreamSeekControl::new(),
        });

        actor.promote_ready_streams();
        assert!(
            actor.pending[DeckId::A as usize].is_some(),
            "the same pending worker should remain while its freed ring refills"
        );
        assert_eq!(actor.revisions[DeckId::A as usize], 11);
        for _ in 0..8_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        actor.promote_ready_streams();
        assert!(actor.pending[DeckId::A as usize].is_none());
        assert!(actor.decks[DeckId::A as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.stem_enabled));
        let installed =
            knobs.snapshot.lock().unwrap().deck_frames[DeckId::A as usize] as f64 / 48_000.0;
        assert!(
            (installed - 4.7).abs() < 0.02,
            "late ring catch-up must land on the command clock, got {installed:.6}"
        );
        drop(writer);
    }

    #[test]
    fn clocked_stem_seek_installs_once_the_keep_floor_stops_refilling() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut live = live_runtime(1, 50.0);
        live.request.stem_enabled = true;
        actor.decks[DeckId::A as usize] = Some(live);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 50.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];

        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_000);
        for _ in 0..12_000 {
            writer.push(StemFrame::default(), || false).unwrap();
        }
        let promote_at = Instant::now() - Duration::from_secs(2);
        let mut request = source(1, 30.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/bytedance-mobilenet-subbandtime-2-fp32-onnx".into();
        actor.revisions[DeckId::A as usize] = 12;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 12,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 12_000,
            activation: None,
            cancel: Arc::new(AtomicU64::new(12)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: Some(ClockedDeckSeek {
                requested_at: promote_at - Duration::from_millis(250),
                requested_position: 29.75,
                promote_at,
                position: 30.0,
                rate: 1.0,
                advancing: true,
                skipped_output_frames: 0,
                skipped_media_frames: 0.0,
                catchup_progress_at: None,
            }),
            seek: StreamSeekControl::new(),
        });

        actor.promote_ready_streams();
        assert!(
            actor.pending[DeckId::A as usize].is_some(),
            "first drain leaves the keep floor below the startup cushion"
        );
        std::thread::sleep(STEM_SEEK_CATCHUP_STALL + Duration::from_millis(10));
        actor.promote_ready_streams();
        assert!(
            actor.pending[DeckId::A as usize].is_none(),
            "a stalled keep floor must install instead of waiting for another model window"
        );
        let installed =
            knobs.snapshot.lock().unwrap().deck_frames[DeckId::A as usize] as f64 / 48_000.0;
        assert!(
            (installed - 50.0).abs() > 1.0,
            "installed clock must leave the pre-seek playhead, got {installed:.6}"
        );
        drop(writer);
    }

    #[test]
    fn playing_original_sync_uses_the_same_command_clock_contract() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 42.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 42.0;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];

        let (stream, mut writer) = StreamSource::bounded(4_000);
        for _ in 0..3_000 {
            writer.push([0.0, 0.0], || false).unwrap();
        }
        let promote_at = Instant::now() - Duration::from_millis(10);
        actor.revisions[DeckId::A as usize] = 10;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 10,
            source: PlaybackStream::Stereo(stream),
            request: source(1, 20.0),
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(10)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: Some(ClockedDeckSeek {
                requested_at: promote_at - Duration::from_millis(SEEK_BUFFER_MS),
                requested_position: 19.88,
                promote_at,
                position: 20.0,
                rate: 1.0,
                advancing: true,
                skipped_output_frames: 0,
                skipped_media_frames: 0.0,
                catchup_progress_at: None,
            }),
            seek: StreamSeekControl::new(),
        });

        actor.promote_ready_streams();

        let installed =
            knobs.snapshot.lock().unwrap().deck_frames[DeckId::A as usize] as f64 / 48_000.0;
        assert!((installed - 20.01).abs() < 0.005, "got {installed:.6}");
        assert!((installed - 42.0).abs() > 1.0);
        drop(writer);
    }

    #[test]
    fn stem_promote_over_playing_original_keeps_the_playhead() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 6.12));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::A as usize].current_time = 6.12;
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, false];
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(48_000);
        for _ in 0..20_000 {
            writer
                .push(StemFrame::default(), || false)
                .expect("预填分轨 ring");
        }
        std::mem::forget(writer);
        let mut request = source(1, 6.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor.revisions[DeckId::A as usize] = 3;
        actor.pending[DeckId::A as usize] = Some(PendingStream {
            revision: 3,
            source: PlaybackStream::Stems(stream),
            request,
            tempo: TempoControl::new(1.0),
            output_sample_rate: 48_000,
            startup_buffer_frames: 1,
            activation: None,
            cancel: Arc::new(AtomicU64::new(3)),
            followup_stems: false,
            release_scratch_hold: false,
            clocked_seek: None,
            seek: StreamSeekControl::new(),
        });
        assert!(
            !actor.state.decks[DeckId::A as usize].stem_enabled,
            "a pending STEM worker must not claim callback ownership before promotion"
        );

        actor.promote_ready_streams();
        assert!(
            actor.state.decks[DeckId::A as usize].stem_enabled,
            "the snapshot must expose installed STEM ownership for safe runtime retirement"
        );

        assert!(
            (actor.state.decks[DeckId::A as usize].current_time - 6.12).abs() < 0.001,
            "原曲还在走时不能把播放头拽回分轨起点"
        );
        assert_eq!(
            knobs.snapshot.lock().unwrap().deck_frames[0],
            (6.12_f64 * 48_000.0).round() as u64,
            "装上分轨时必须对齐当前播放头，而不是分轨 worker 的起点"
        );
    }

    #[test]
    fn deck_seek_keeps_the_other_deck_and_prepares_stems_without_an_original_bridge() {
        enable_bytedance_stem_runtime_for_test();
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut live = live_runtime(1, 12.0);
        live.request.stem_enabled = true;
        live.request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor.decks[DeckId::A as usize] = Some(live);
        let live_cancel = Arc::clone(&actor.decks[DeckId::A as usize].as_ref().unwrap().cancel);
        actor.decks[DeckId::B as usize] = Some(live_runtime(2, 8.0));
        actor.state.decks[DeckId::A as usize].track_id = Some(1);
        actor.state.decks[DeckId::B as usize].track_id = Some(2);
        actor.state.decks[DeckId::A as usize].is_playing = true;
        actor.manual_mode = true;
        actor.manual_desired_playing = [true, true];

        actor
            .seek_deck(DeckId::A as u8, 4.0)
            .expect("DJ 同台跳转应建立分轨 shadow");

        assert!(
            actor.pending[DeckId::B as usize].is_none(),
            "不能占用对面正在播放的 Deck 做 shadow seek"
        );
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("ByteDance shadow stream must be pending");
        assert!(pending.request.stem_enabled);
        assert!(!pending.followup_stems);
        assert!(pending.request.position > 4.0);
        let runtime = actor.decks[DeckId::A as usize]
            .as_ref()
            .expect("shadow promotion前旧分轨仍负责发声");
        assert!(runtime.request.stem_enabled);
        assert_eq!(
            live_cancel.load(Ordering::Acquire),
            1,
            "replacement 安装前不能提前切断当前音频"
        );
        assert!(
            actor.awaiting_seek_promotion(),
            "shadow STEM must promote only after its startup cushion is ready"
        );
        assert!(actor.decks[DeckId::B as usize].is_some());
        assert!(!actor.state.error.contains("原曲"));
    }

    #[test]
    fn loading_a_playing_deck_keeps_original_until_bytedance_is_ready() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut request = source(9, 0.0);
        request.autoplay = true;
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor
            .load_deck(DeckId::A as u8, request)
            .expect("装入 Deck");
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("播放中装入应先登记原曲流");
        assert!(
            !pending.request.stem_enabled,
            "ByteDance cache miss must keep ORG audible"
        );
        assert!(pending.followup_stems);
        assert_eq!(pending.request.stem_cache_path, "/tmp/kdj-stem-cache");
    }

    #[test]
    fn loading_a_paused_deck_queues_stem_analysis_at_the_drop_position() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        let mut request = source(9, 3.0);
        request.stem_enabled = true;
        request.stem_cache_path = "/tmp/kdj-stem-cache".into();
        actor
            .load_deck(DeckId::A as u8, request)
            .expect("装入 Deck");
        let pending = actor.pending[DeckId::A as usize]
            .as_ref()
            .expect("暂停装入也应先登记原曲流");
        assert!(!pending.request.stem_enabled);
        assert!(pending.followup_stems);
        assert!((pending.request.position - 3.0).abs() < 0.001);
        assert_eq!(pending.request.stem_cache_path, "/tmp/kdj-stem-cache");
    }

    #[test]
    fn tempo_does_not_rebuild_the_decoder() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.open_output().expect("打开测试输出");
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 8.0));
        let live_cancel = Arc::clone(&actor.decks[DeckId::A as usize].as_ref().unwrap().cancel);
        actor.state.decks[DeckId::A as usize].track_id = Some(1);

        actor
            .set_deck_rate(DeckId::A as u8, 1.25)
            .expect("TEMPO 只改原子量和时钟");

        assert_eq!(live_cancel.load(Ordering::Acquire), 1);
        assert!(actor.pending[DeckId::A as usize].is_none());
        let sent = knobs.sent.lock().unwrap();
        assert!(
            sent.iter()
                .any(|command| matches!(command, RtCommand::SetRate { rate, .. } if (*rate - 1.25).abs() < f32::EPSILON)),
            "回调只收到 SetRate，不换源"
        );
    }

    #[test]
    fn fail_stops_the_hardware_transport() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        knobs.snapshot.lock().unwrap().playing = true;

        actor.fail("测试错误".to_string());

        assert!(!actor.state.is_playing);
        assert!(knobs
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|command| matches!(command, RtCommand::SetPlaying { playing: false, .. })));
    }

    #[test]
    fn platform_commands_do_not_consume_frontend_command_ids() {
        let knobs = Arc::new(FakeKnobs::default());
        let factory = Arc::new(FakeFactory {
            knobs,
            taken: Mutex::new(false),
        });
        let coordinator =
            PlaybackCoordinator::spawn_with_factory(|_| {}, factory).expect("启动测试协调器");

        coordinator
            .submit_with_id(7, PlaybackCommand::SetVolume { volume: 0.4 })
            .expect("前端命令");
        let platform = coordinator
            .submit_platform(PlaybackCommand::SetVolume { volume: 0.7 })
            .expect("系统媒体命令");
        assert_eq!(platform.snapshot.last_command_id, 7);
        assert!((platform.snapshot.volume - 0.7).abs() < 0.001);

        let frontend = coordinator
            .submit_with_id(8, PlaybackCommand::SetVolume { volume: 0.9 })
            .expect("后续前端命令");
        assert_eq!(frontend.snapshot.last_command_id, 8);
        assert!((frontend.snapshot.volume - 0.9).abs() < 0.001);
    }
}
