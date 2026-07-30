use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kdj_player::{
    decode_file_streaming, DeckId, PlayerMode, RtCommand, StreamMetadata, StreamSource,
    TransitionPlan, DEFAULT_STREAM_BUFFER_SECONDS,
};

use crate::contract::{
    CommandAck, PlaybackCommand, PlaybackPhase, PlaybackSnapshot, PlaybackSource,
    PlaybackTransitionPlan,
};
use crate::platform::{CpalOutputFactory, PlaybackOutput, PlaybackOutputFactory};

const ACTOR_TICK: Duration = Duration::from_millis(10);
const STATE_INTERVAL: Duration = Duration::from_millis(100);
const ACK_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_BUFFER_MS: u64 = 120;
const SEEK_BUFFER_MS: u64 = 40;
const SEEK_CROSSFADE_MS: u64 = 5;
const TRANSPORT_FADE_MS: u64 = 120;

type CommandReply = SyncSender<Result<CommandAck, String>>;
type StateReply = SyncSender<PlaybackSnapshot>;
type StateEmitter = Arc<dyn Fn(PlaybackSnapshot) + Send + Sync>;

pub struct PlaybackCoordinator {
    sender: Sender<Request>,
    next_command_id: AtomicU64,
}

impl PlaybackCoordinator {
    pub fn spawn(
        emit: impl Fn(PlaybackSnapshot) + Send + Sync + 'static,
    ) -> Result<Self, String> {
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
    State {
        reply: StateReply,
    },
    WorkerFinished {
        deck: DeckId,
        revision: u64,
        result: Result<StreamMetadata, String>,
    },
    DeviceError(String),
    Shutdown,
}

#[derive(Clone)]
struct DeckRuntime {
    source_id: u64,
    source: Arc<StreamSource>,
    request: PlaybackSource,
    output_sample_rate: u32,
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

struct PendingStream {
    revision: u64,
    source: Arc<StreamSource>,
    request: PlaybackSource,
    output_sample_rate: u32,
    activation: Option<Activation>,
}

struct DeferredStream {
    request: PlaybackSource,
    activation: Option<Activation>,
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
    next_revision: u64,
    front: DeckId,
    retire_after_transition: Option<DeckId>,
    deferred_stream: Option<DeferredStream>,
    state: PlaybackSnapshot,
    last_emitted: PlaybackSnapshot,
    last_state_tick: Instant,
    volume: f32,
    eq: (f32, f32),
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
            next_revision: 1,
            front: DeckId::A,
            retire_after_transition: None,
            deferred_stream: None,
            state: PlaybackSnapshot::default(),
            last_emitted: PlaybackSnapshot::default(),
            last_state_tick: Instant::now(),
            volume: 1.0,
            eq: (0.0, 0.0),
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
            match self.receiver.recv_timeout(ACTOR_TICK) {
                Ok(request) => self.handle(request),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.promote_ready_streams();
            self.refresh_from_audio();
            self.publish(false);
        }
        self.invalidate(DeckId::A);
        self.invalidate(DeckId::B);
        self.player.take();
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
                let result = self.apply_command(command_id, command).map(|()| {
                    self.bump_sequence();
                    self.publish(true);
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
                    let activation = self.pending[deck as usize]
                        .as_ref()
                        .and_then(|pending| pending.activation);
                    self.pending[deck as usize] = None;
                    if activation.is_some() || deck == self.front {
                        self.fail(error);
                    } else {
                        self.state.prepared_track_id = None;
                        self.state.error = error;
                    }
                    self.bump_sequence();
                    self.publish(true);
                }
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

    fn apply_command(
        &mut self,
        command_id: u64,
        command: PlaybackCommand,
    ) -> Result<(), String> {
        self.state.last_command_id = command_id;
        self.state.error.clear();
        match command {
            PlaybackCommand::Load { source } => self.load(source),
            PlaybackCommand::Prepare { source } => self.prepare(source),
            PlaybackCommand::SetQueue { sources } => {
                self.queue = sources;
                self.prewarm_queue()
            }
            PlaybackCommand::Play => self.set_playing(true),
            PlaybackCommand::Pause => self.set_playing(false),
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
        self.player = Some(player);
        Ok(())
    }

    fn load(&mut self, mut source: PlaybackSource) -> Result<(), String> {
        self.open_output()?;
        validate_source(&source)?;
        self.settle_transition()?;
        source.position = source.position.max(0.0);
        // 状态先落账、激活后执行：一旦激活失败必须整体回滚，
        // 否则状态层声称新曲目、硬件却还在旧 Deck 上发声。
        let checkpoint = self.state.clone();
        self.state.desired_playing = source.autoplay;
        self.state.phase = PlaybackPhase::Loading;
        self.state.track_id = Some(source.track_id);
        self.state.prepared_track_id = None;
        self.state.current_time = source.position;
        self.state.duration = source.duration.unwrap_or(0.0).max(0.0);
        self.state.rate = 1.0;
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
        self.state.desired_playing = playing;
        self.send_playing(playing)?;
        if !matches!(self.state.phase, PlaybackPhase::Loading | PlaybackPhase::Seeking) {
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
        // 换曲/接歌的激活还没落地时，front 上仍是旧曲目：这时跳转旧曲目会顶掉
        // 新曲目的待激活流——状态已指向新曲目、声音却退回旧曲目。拒绝这次跳转，
        // 装载通常在几百毫秒内完成，调用方看到新状态后再跳。连续 scrub
        // （Activation::Seek 的 pending）不在此列，仍允许后到的跳转覆盖先到的。
        if self.pending.iter().flatten().any(|pending| {
            matches!(
                pending.activation,
                Some(Activation::Hard) | Some(Activation::Transition(_))
            )
        }) {
            return Err("换曲进行中，等新歌起播后再跳转".into());
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

    fn handoff(
        &mut self,
        expected: i64,
        transition: PendingTransition,
    ) -> Result<(), String> {
        if expected <= 0 {
            return Err("接歌目标 id 无效".into());
        }
        let target = self.front.other();
        if self.decks[target as usize]
            .as_ref()
            .is_some_and(|runtime| runtime.request.track_id == expected)
        {
            return self.activate(target, Activation::Transition(transition), transition.position);
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
        self.deferred_stream = None;
        Ok(())
    }

    fn set_transport_fade(&mut self, enabled: bool) -> Result<(), String> {
        self.state.transport_fade_enabled = enabled;
        if !enabled && self.player.is_some() {
            self.send_playing(self.state.desired_playing)?;
        }
        Ok(())
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

    fn set_eq(&mut self, low_db: f32, high_db: f32) -> Result<(), String> {
        if !low_db.is_finite() || !high_db.is_finite() {
            return Err("EQ 参数必须是有限数字".into());
        }
        let values = (low_db.clamp(-24.0, 12.0), high_db.clamp(-24.0, 12.0));
        self.eq = values;
        for deck in [DeckId::A, DeckId::B] {
            self.send(RtCommand::SetEq {
                deck,
                low_db: values.0,
                high_db: values.1,
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
        let capacity = output_rate as usize * DEFAULT_STREAM_BUFFER_SECONDS;
        let (source, writer) = StreamSource::bounded(capacity);
        let revision = self.bump_revision(deck);
        self.pending[deck as usize] = Some(PendingStream {
            revision,
            source: Arc::clone(&source),
            request: request.clone(),
            output_sample_rate: output_rate,
            activation,
        });
        let sender = self.sender.clone();
        let fence = Arc::clone(&self.revision_fences[deck as usize]);
        let path = PathBuf::from(&request.path);
        std::thread::Builder::new()
            .name(format!("kdj-stream-{}-{revision}", request.track_id))
            .spawn(move || {
                let result = decode_file_streaming(
                    &path,
                    request.position,
                    output_rate,
                    writer,
                    || fence.load(Ordering::Acquire) != revision,
                )
                .map_err(|error| format!("流式解码失败：{error:#}"));
                let _ = sender.send(Request::WorkerFinished {
                    deck,
                    revision,
                    result,
                });
            })
            .map_err(|error| format!("启动流式解码线程失败：{error}"))?;
        Ok(())
    }

    fn promote_ready_streams(&mut self) {
        for deck in [DeckId::A, DeckId::B] {
            let ready = self.pending[deck as usize].as_ref().is_some_and(|pending| {
                let ready_ms = if matches!(pending.activation, Some(Activation::Seek)) {
                    SEEK_BUFFER_MS
                } else {
                    STARTUP_BUFFER_MS
                };
                let threshold = u64::from(pending.output_sample_rate) * ready_ms / 1_000;
                pending.source.buffered_frames() >= threshold
                    || pending.source.ended() && pending.source.buffered_frames() > 0
            });
            if !ready {
                continue;
            }
            let Some(pending) = self.pending[deck as usize].take() else {
                continue;
            };
            if self.revisions[deck as usize] != pending.revision {
                continue;
            }
            let start_frame = (pending.request.position
                * f64::from(pending.output_sample_rate))
            .round() as u64;
            let installed = self
                .player
                .as_mut()
                .ok_or_else(|| "原生音频输出未初始化".to_string())
                .and_then(|player| {
                    player
                        .install_stream(deck, Arc::clone(&pending.source), start_frame)
                        .map_err(|error| error.to_string())
                });
            let source_id = match installed {
                Ok(source_id) => source_id,
                Err(error) => {
                    self.fail(error);
                    continue;
                }
            };
            self.decks[deck as usize] = Some(DeckRuntime {
                source_id,
                source: pending.source,
                request: pending.request.clone(),
                output_sample_rate: pending.output_sample_rate,
            });
            let _ = self.send(RtCommand::SetEq {
                deck,
                low_db: self.eq.0,
                high_db: self.eq.1,
            });
            if let Some(activation) = pending.activation {
                if let Err(error) = self.activate(deck, activation, pending.request.position) {
                    self.fail(error);
                }
            } else {
                self.state.prepared_track_id = Some(pending.request.track_id);
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
        let position = match activation {
            Activation::Transition(transition) => transition.position.max(0.0),
            Activation::Hard | Activation::Seek => requested_position.max(0.0),
        };
        let target_frame = runtime.frame_for_seconds(position);
        let old = self.front;
        let (transition_frames, plan) = match activation {
            Activation::Transition(transition) => {
                let frames = (transition.seconds.max(0.0)
                    * f64::from(runtime.output_sample_rate))
                .round()
                .min(f64::from(u32::MAX)) as u32;
                (frames, realtime_plan(transition.plan, runtime.output_sample_rate))
            }
            Activation::Seek if self.state.desired_playing => (
                (u64::from(runtime.output_sample_rate) * SEEK_CROSSFADE_MS / 1_000) as u32,
                TransitionPlan::default(),
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
        self.send_playing(self.state.desired_playing)?;
        self.front = deck;
        self.state.track_id = Some(runtime.request.track_id);
        self.state.prepared_track_id = None;
        self.state.current_time = position;
        self.state.duration = runtime.duration();
        self.state.rate = 1.0;
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
        if self.state.phase == PlaybackPhase::Seeking
            || self.state.phase == PlaybackPhase::Loading && !self.state.transitioning
        {
            self.state.is_playing = audio.playing;
            return;
        }
        let transition_reached_target = self.decks[self.front as usize]
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
                    if let Err(error) = self.start_stream(
                        deck,
                        deferred.request,
                        deferred.activation,
                    ) {
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
            if audio.deck_source_ids[self.front as usize] == runtime.source_id {
                self.state.current_time = runtime
                    .seconds_for_frame(audio.deck_frames[self.front as usize]);
            }
            self.state.duration = runtime.duration();
            if !audio.playing && runtime.source.drained() && self.state.desired_playing {
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

    fn reusable_deck(&self, request: &PlaybackSource) -> Option<DeckId> {
        [DeckId::A, DeckId::B].into_iter().find(|deck| {
            self.decks[*deck as usize].as_ref().is_some_and(|runtime| {
                same_source(&runtime.request, request) && !runtime.source.drained()
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
    }

    fn bump_revision(&mut self, deck: DeckId) -> u64 {
        let revision = self.next_revision;
        self.next_revision = self.next_revision.wrapping_add(1).max(1);
        self.revisions[deck as usize] = revision;
        self.revision_fences[deck as usize].store(revision, Ordering::Release);
        revision
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

fn validate_source(source: &PlaybackSource) -> Result<(), String> {
    if source.track_id <= 0 {
        return Err("曲目 id 无效".into());
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

fn same_source(left: &PlaybackSource, right: &PlaybackSource) -> bool {
    left.track_id == right.track_id
        && left.path == right.path
        && (left.position - right.position).abs() < 0.02
}

fn clamp_position(position: f64, duration: Option<f64>) -> f64 {
    let position = if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    };
    duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| position.min(duration))
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
    TransitionPlan {
        flags,
        beat_frames: (plan.beat_seconds.max(0.01) * f64::from(sample_rate))
            .round()
            .min(f64::from(u32::MAX)) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::PlaybackOutputSpec;
    use kdj_player::TransportSnapshot;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

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

    fn source(track_id: i64, position: f64) -> PlaybackSource {
        PlaybackSource {
            track_id,
            path: format!("/nonexistent/{track_id}.flac"),
            position,
            duration: Some(180.0),
            rate: 1.0,
            autoplay: false,
        }
    }

    /// 造假一个“仍在发声”的 Deck：writer 故意泄漏，流永远不会 drained，
    /// reusable_deck 才会承认它。
    fn live_runtime(track_id: i64, position: f64) -> DeckRuntime {
        let (stream, writer) = StreamSource::bounded(48_000);
        std::mem::forget(writer);
        DeckRuntime {
            source_id: 100 + track_id as u64,
            source: stream,
            request: source(track_id, position),
            output_sample_rate: 48_000,
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
    fn seek_is_rejected_while_a_track_change_is_pending() {
        let knobs = Arc::new(FakeKnobs::default());
        let mut actor = test_actor(&knobs);
        actor.decks[DeckId::A as usize] = Some(live_runtime(1, 0.0));
        actor.state.track_id = Some(1);
        actor.state.phase = PlaybackPhase::Playing;
        actor.load(source(2, 0.0)).expect("load 登记");

        let error = actor.seek(30.0).unwrap_err();

        assert!(error.contains("换曲进行中"));
        assert_eq!(
            actor.pending[DeckId::B as usize]
                .as_ref()
                .map(|pending| pending.request.track_id),
            Some(2),
            "待激活的新曲目不能被这次跳转顶掉"
        );
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
            .any(|command| matches!(
                command,
                RtCommand::SetPlaying {
                    playing: false,
                    ..
                }
            )));
    }
}
