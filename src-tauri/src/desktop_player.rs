use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kdj_player::{
    decode_file_with_limit_and_cancel, open_dynamic_default, stretch_preserving_pitch_with_cancel,
    DeckId, DecodedTrack, DynamicPlayer, PlayerMode, RtCommand, TransitionPlan,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub const STATE_EVENT: &str = "desktop-player-state";
const COMMAND_CAPACITY: usize = 256;
const MAX_TRACK_PCM_BYTES: usize = 128 * 1024 * 1024;
const STATE_INTERVAL: Duration = Duration::from_millis(20);

type Reply = oneshot::Sender<Result<DesktopPlayerState, String>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLoadRequest {
    pub track_id: i64,
    pub path: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default = "default_rate")]
    pub rate: f32,
    #[serde(default)]
    pub autoplay: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrepareRequest {
    pub track_id: i64,
    pub path: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default = "default_rate")]
    pub rate: f32,
}

fn default_rate() -> f32 {
    1.0
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTransitionPlan {
    #[serde(default)]
    pub eq: bool,
    #[serde(default)]
    pub filter: bool,
    #[serde(default)]
    pub vocal_cut: bool,
    #[serde(default)]
    pub echo: bool,
    #[serde(default)]
    pub alarm: bool,
    #[serde(default)]
    pub hydrant: bool,
    #[serde(default)]
    pub beat_seconds: f64,
}

impl DesktopTransitionPlan {
    fn realtime(self, sample_rate: u32) -> TransitionPlan {
        let mut flags = 0;
        if self.eq {
            flags |= TransitionPlan::EQ;
        }
        if self.filter {
            flags |= TransitionPlan::FILTER;
        }
        if self.vocal_cut {
            flags |= TransitionPlan::VOCAL_CUT;
        }
        if self.echo {
            flags |= TransitionPlan::ECHO;
        }
        if self.alarm {
            flags |= TransitionPlan::ALARM;
        }
        if self.hydrant {
            flags |= TransitionPlan::HYDRANT;
        }
        TransitionPlan {
            flags,
            beat_frames: (self.beat_seconds.max(0.01) * f64::from(sample_rate))
                .round()
                .min(f64::from(u32::MAX)) as u32,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlayerState {
    pub status: &'static str,
    pub track_id: Option<i64>,
    pub prepared_track_id: Option<i64>,
    pub current_time: f64,
    pub duration: f64,
    pub is_playing: bool,
    pub buffering: bool,
    pub rate: f32,
    pub volume: f32,
    pub active_deck: &'static str,
    pub transitioning: bool,
    pub source_revision: u64,
    pub seek_revision: u64,
    pub output_sample_rate: u32,
    pub output_channels: usize,
    pub error: String,
}

impl Default for DesktopPlayerState {
    fn default() -> Self {
        Self {
            status: "idle",
            track_id: None,
            prepared_track_id: None,
            current_time: 0.0,
            duration: 0.0,
            is_playing: false,
            buffering: false,
            rate: 1.0,
            volume: 1.0,
            active_deck: "a",
            transitioning: false,
            source_revision: 0,
            seek_revision: 0,
            output_sample_rate: 0,
            output_channels: 0,
            error: String::new(),
        }
    }
}

pub struct DesktopPlayerHandle {
    sender: Sender<Request>,
}

impl Drop for DesktopPlayerHandle {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Shutdown);
    }
}

impl DesktopPlayerHandle {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let actor_sender = sender.clone();
        std::thread::Builder::new()
            .name("kdj-player-control".into())
            .spawn(move || PlayerActor::new(app, actor_sender, receiver).run())
            .map_err(|error| format!("启动原生播放器控制线程失败：{error}"))?;
        Ok(Self { sender })
    }

    async fn request(
        &self,
        build: impl FnOnce(Reply) -> Request,
    ) -> Result<DesktopPlayerState, String> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(build(reply))
            .map_err(|_| "原生播放器控制线程已退出".to_string())?;
        response
            .await
            .map_err(|_| "原生播放器没有返回命令结果".to_string())?
    }
}

enum Request {
    Initialize {
        reply: Reply,
    },
    Load {
        request: DesktopLoadRequest,
        reply: Reply,
    },
    Prepare {
        request: DesktopPrepareRequest,
        reply: Reply,
    },
    DecodeFinished(DecodeFinished),
    DeviceError(String),
    Play {
        reply: Reply,
    },
    Pause {
        reply: Reply,
    },
    Seek {
        position: f64,
        reply: Reply,
    },
    Handoff {
        position: f64,
        seconds: f64,
        plan: DesktopTransitionPlan,
        reply: Reply,
    },
    SetVolume {
        volume: f32,
        reply: Reply,
    },
    SetEq {
        low_db: f32,
        high_db: f32,
        reply: Reply,
    },
    State {
        reply: Reply,
    },
    Dispose {
        reply: Reply,
    },
    Shutdown,
}

#[derive(Clone, Copy)]
enum DecodePurpose {
    Load,
    Prepare,
}

struct DecodeFinished {
    deck: DeckId,
    revision: u64,
    purpose: DecodePurpose,
    request: DesktopPrepareRequest,
    result: Result<PreparedAudio, String>,
    elapsed: Duration,
    reply: Reply,
}

struct PreparedAudio {
    pcm: Arc<DecodedTrack>,
    logical_duration: f64,
}

#[derive(Clone, Debug)]
struct DeckState {
    source_id: u64,
    track_id: i64,
    duration: f64,
    sample_rate: u32,
    tempo_rate: f32,
}

impl DeckState {
    fn frame_for_seconds(&self, seconds: f64) -> u64 {
        let seconds = seconds.clamp(0.0, self.duration);
        (seconds * f64::from(self.sample_rate) / f64::from(self.tempo_rate)).round() as u64
    }

    fn seconds_for_frame(&self, frame: u64) -> f64 {
        (frame as f64 * f64::from(self.tempo_rate) / f64::from(self.sample_rate))
            .clamp(0.0, self.duration)
    }
}

struct PlayerActor {
    app: AppHandle,
    sender: Sender<Request>,
    receiver: Receiver<Request>,
    player: Option<DynamicPlayer>,
    decks: [Option<DeckState>; 2],
    deck_revisions: [u64; 2],
    revision_fences: [Arc<AtomicU64>; 2],
    next_revision: u64,
    front: DeckId,
    desired_playing: bool,
    /// Target plus whether the callback has reported at least one mixing block.
    pending_handoff: Option<(DeckId, bool)>,
    state: DesktopPlayerState,
    last_emitted: DesktopPlayerState,
    last_publish: Instant,
    shutdown: bool,
}

impl PlayerActor {
    fn new(app: AppHandle, sender: Sender<Request>, receiver: Receiver<Request>) -> Self {
        let mut actor = Self {
            app,
            sender,
            receiver,
            player: None,
            decks: [None, None],
            deck_revisions: [0, 0],
            revision_fences: [Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0))],
            next_revision: 1,
            front: DeckId::A,
            desired_playing: false,
            pending_handoff: None,
            state: DesktopPlayerState::default(),
            last_emitted: DesktopPlayerState::default(),
            last_publish: Instant::now(),
            shutdown: false,
        };
        if let Err(error) = actor.open_output() {
            actor.state.status = "error";
            actor.state.error = error;
        }
        actor
    }

    fn run(mut self) {
        self.publish(true);
        while !self.shutdown {
            match self.receiver.recv_timeout(STATE_INTERVAL) {
                Ok(request) => self.handle(request),
                Err(RecvTimeoutError::Timeout) => self.publish(false),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        self.player.take();
    }

    fn open_output(&mut self) -> Result<(), String> {
        if self.player.is_some() {
            return Ok(());
        }
        let errors = self.sender.clone();
        let player = open_dynamic_default(COMMAND_CAPACITY, move |error| {
            tracing::error!("原生音频设备错误：{error}");
            let _ = errors.send(Request::DeviceError(error.to_string()));
        })
        .map_err(|error| format!("打开系统音频输出失败：{error}"))?;
        let spec = player.spec();
        self.state.output_sample_rate = spec.sample_rate;
        self.state.output_channels = spec.channels;
        self.state.error.clear();
        self.player = Some(player);
        Ok(())
    }

    fn handle(&mut self, request: Request) {
        match request {
            Request::Initialize { reply } => {
                let result = self.open_output().map(|()| self.current_state());
                let _ = reply.send(result);
            }
            Request::Load { request, reply } => self.start_load(request, reply),
            Request::Prepare { request, reply } => self.start_prepare(request, reply),
            Request::DecodeFinished(done) => self.finish_decode(done),
            Request::DeviceError(error) => {
                self.desired_playing = false;
                self.player.take();
                self.state.status = "error";
                self.state.is_playing = false;
                self.state.error = format!("系统音频设备中断：{error}");
            }
            Request::Play { reply } => {
                self.desired_playing = true;
                let result = self.send(RtCommand::SetPlaying(true)).map(|()| {
                    self.state.is_playing = true;
                    self.state.status = "playing";
                    self.current_state()
                });
                let _ = reply.send(result);
            }
            Request::Pause { reply } => {
                self.desired_playing = false;
                let result = self.send(RtCommand::SetPlaying(false)).map(|()| {
                    self.state.is_playing = false;
                    self.state.status = if self.state.track_id.is_some() {
                        "paused"
                    } else {
                        "idle"
                    };
                    self.current_state()
                });
                let _ = reply.send(result);
            }
            Request::Seek { position, reply } => {
                let result = self.seek(position).map(|()| self.current_state());
                let _ = reply.send(result);
            }
            Request::Handoff {
                position,
                seconds,
                plan,
                reply,
            } => {
                let result = self
                    .handoff(position, seconds, plan)
                    .map(|()| self.current_state());
                let _ = reply.send(result);
            }
            Request::SetVolume { volume, reply } => {
                let volume = volume.clamp(0.0, 1.0);
                let result = self.send(RtCommand::SetMasterGain(volume)).map(|()| {
                    self.state.volume = volume;
                    self.current_state()
                });
                let _ = reply.send(result);
            }
            Request::SetEq {
                low_db,
                high_db,
                reply,
            } => {
                let result = self.set_eq(low_db, high_db).map(|()| self.current_state());
                let _ = reply.send(result);
            }
            Request::State { reply } => {
                let _ = reply.send(Ok(self.current_state()));
            }
            Request::Dispose { reply } => {
                self.invalidate_all_decks();
                self.player.take();
                self.decks = [None, None];
                self.desired_playing = false;
                self.pending_handoff = None;
                self.state = DesktopPlayerState::default();
                let _ = reply.send(Ok(self.state.clone()));
            }
            Request::Shutdown => {
                self.invalidate_all_decks();
                self.player.take();
                self.shutdown = true;
            }
        }
        self.publish(true);
    }

    fn start_load(&mut self, request: DesktopLoadRequest, reply: Reply) {
        if let Err(error) = self.open_output() {
            let _ = reply.send(Err(error));
            return;
        }
        if let Err(error) = validate_rate(request.rate) {
            let _ = reply.send(Err(error));
            return;
        }
        if let Some(player) = &mut self.player {
            let snapshot = player.snapshot();
            self.front = snapshot.active_deck;
            let _ = player.send(RtCommand::SetPlaying(false));
        }
        self.invalidate_all_decks();
        self.pending_handoff = None;
        let revision = self.bump_deck_revision(self.front);
        self.desired_playing = request.autoplay;
        self.state.status = "loading";
        self.state.buffering = true;
        self.state.is_playing = false;
        self.state.track_id = Some(request.track_id);
        self.state.current_time = request.position.max(0.0);
        self.state.rate = request.rate;
        self.state.error.clear();
        let prepare = DesktopPrepareRequest {
            track_id: request.track_id,
            path: request.path,
            position: request.position,
            rate: request.rate,
        };
        self.spawn_decode(self.front, revision, DecodePurpose::Load, prepare, reply);
    }

    fn start_prepare(&mut self, request: DesktopPrepareRequest, reply: Reply) {
        if let Err(error) = self.open_output() {
            let _ = reply.send(Err(error));
            return;
        }
        if let Err(error) = validate_rate(request.rate) {
            let _ = reply.send(Err(error));
            return;
        }
        let deck = self.front.other();
        let revision = self.bump_deck_revision(deck);
        self.spawn_decode(deck, revision, DecodePurpose::Prepare, request, reply);
    }

    fn spawn_decode(
        &self,
        deck: DeckId,
        revision: u64,
        purpose: DecodePurpose,
        request: DesktopPrepareRequest,
        reply: Reply,
    ) {
        let sender = self.sender.clone();
        let revision_fence = Arc::clone(&self.revision_fences[deck as usize]);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("kdj-decode-{revision}"))
            .spawn(move || {
                let started = Instant::now();
                let result = prepare_audio(&request, || {
                    revision_fence.load(Ordering::Acquire) != revision
                });
                let _ = sender.send(Request::DecodeFinished(DecodeFinished {
                    deck,
                    revision,
                    purpose,
                    request,
                    result,
                    elapsed: started.elapsed(),
                    reply,
                }));
            })
        {
            tracing::error!("启动音频解码线程失败：{error}");
        }
    }

    fn finish_decode(&mut self, done: DecodeFinished) {
        tracing::debug!(
            track_id = done.request.track_id,
            deck = deck_name(done.deck),
            revision = done.revision,
            elapsed_ms = done.elapsed.as_millis(),
            accepted = self.deck_revisions[done.deck as usize] == done.revision,
            "原生 Deck 准备完成"
        );
        if self.deck_revisions[done.deck as usize] != done.revision {
            let _ = done.reply.send(Err("音频准备已被更新的操作替代".into()));
            return;
        }
        let prepared = match done.result {
            Ok(prepared) => prepared,
            Err(error) => {
                if matches!(done.purpose, DecodePurpose::Load) {
                    self.state.status = "error";
                    self.state.buffering = false;
                    self.state.error = error.clone();
                }
                let _ = done.reply.send(Err(error));
                return;
            }
        };
        let mut deck_state = DeckState {
            source_id: 0,
            track_id: done.request.track_id,
            duration: prepared.logical_duration,
            sample_rate: prepared.pcm.sample_rate(),
            tempo_rate: done.request.rate,
        };
        let start_frame = deck_state.frame_for_seconds(done.request.position);
        let result = (|| {
            let player = self
                .player
                .as_mut()
                .ok_or_else(|| "原生音频输出未初始化".to_string())?;
            deck_state.source_id = player
                .install(done.deck, prepared.pcm, start_frame)
                .map_err(|error| error.to_string())?;
            player
                .send(RtCommand::SetRate {
                    deck: done.deck,
                    rate: 1.0,
                })
                .map_err(|error| error.to_string())?;
            self.decks[done.deck as usize] = Some(deck_state.clone());
            match done.purpose {
                DecodePurpose::Load => {
                    player
                        .send(RtCommand::HandoffPrepared {
                            to: done.deck,
                            target_frame: start_frame,
                            transition_frames: 0,
                            plan: kdj_player::TransitionPlan::default(),
                        })
                        .map_err(|error| error.to_string())?;
                    let other = done.deck.other();
                    let _ = player.clear(other);
                    self.decks[other as usize] = None;
                    self.front = done.deck;
                    let autoplay = self.desired_playing;
                    player
                        .send(RtCommand::SetPlaying(autoplay))
                        .map_err(|error| error.to_string())?;
                    self.state.status = if autoplay { "playing" } else { "paused" };
                    self.state.track_id = Some(done.request.track_id);
                    self.state.prepared_track_id = None;
                    self.state.current_time = done.request.position.max(0.0);
                    self.state.duration = deck_state.duration;
                    self.state.is_playing = autoplay;
                    self.state.buffering = false;
                    self.state.rate = done.request.rate;
                }
                DecodePurpose::Prepare => {
                    self.state.prepared_track_id = Some(done.request.track_id);
                }
            }
            Ok(self.current_state())
        })();
        let _ = done.reply.send(result);
    }

    fn seek(&mut self, position: f64) -> Result<(), String> {
        let deck = self.front;
        let meta = self.decks[deck as usize]
            .clone()
            .ok_or_else(|| "当前 Deck 没有已准备曲目".to_string())?;
        let frame = meta.frame_for_seconds(position);
        self.state.seek_revision = self.state.seek_revision.wrapping_add(1);
        tracing::debug!(
            deck = deck_name(deck),
            seek_revision = self.state.seek_revision,
            target_seconds = position,
            target_frame = frame,
            "提交原生 seek"
        );
        self.send(RtCommand::SeekPrepared { deck, frame })?;
        if self
            .player
            .as_mut()
            .map(|player| player.snapshot().active_deck != deck)
            .unwrap_or(false)
        {
            self.send(RtCommand::HandoffPrepared {
                to: deck,
                target_frame: frame,
                transition_frames: 0,
                plan: kdj_player::TransitionPlan::default(),
            })?;
        }
        self.state.current_time = position.clamp(0.0, meta.duration);
        self.pending_handoff = None;
        self.state.transitioning = false;
        Ok(())
    }

    fn handoff(
        &mut self,
        position: f64,
        seconds: f64,
        plan: DesktopTransitionPlan,
    ) -> Result<(), String> {
        let target = self.front.other();
        let meta = self.decks[target as usize]
            .clone()
            .ok_or_else(|| "下一台 Deck 尚未准备完成".to_string())?;
        let target_frame = meta.frame_for_seconds(position);
        let sample_rate = self
            .player
            .as_ref()
            .map(DynamicPlayer::spec)
            .ok_or_else(|| "原生音频输出未初始化".to_string())?
            .sample_rate;
        let transition_frames = (seconds.max(0.0) * f64::from(sample_rate))
            .round()
            .min(f64::from(u32::MAX)) as u32;
        tracing::debug!(
            from = deck_name(self.front),
            to = deck_name(target),
            target_seconds = position,
            transition_frames,
            "提交 sample-clock handoff"
        );
        self.send(RtCommand::SetMode(PlayerMode::RealtimeDj))?;
        self.send(RtCommand::HandoffPrepared {
            to: target,
            target_frame,
            transition_frames,
            plan: plan.realtime(sample_rate),
        })?;
        self.front = target;
        self.pending_handoff = (transition_frames > 0).then_some((target, false));
        self.state.track_id = Some(meta.track_id);
        self.state.prepared_track_id = None;
        self.state.current_time = position.clamp(0.0, meta.duration);
        self.state.duration = meta.duration;
        self.state.rate = meta.tempo_rate;
        self.state.transitioning = transition_frames > 0;
        Ok(())
    }

    fn set_eq(&mut self, low_db: f32, high_db: f32) -> Result<(), String> {
        if !low_db.is_finite() || !high_db.is_finite() {
            return Err("EQ 参数必须是有限数字".into());
        }
        for deck in [DeckId::A, DeckId::B] {
            self.send(RtCommand::SetEq {
                deck,
                low_db: low_db.clamp(-24.0, 12.0),
                high_db: high_db.clamp(-24.0, 12.0),
            })?;
        }
        Ok(())
    }

    fn send(&mut self, command: RtCommand) -> Result<(), String> {
        self.player
            .as_mut()
            .ok_or_else(|| "原生音频输出未初始化".to_string())?
            .send(command)
            .map_err(|error| error.to_string())
    }

    fn current_state(&mut self) -> DesktopPlayerState {
        self.refresh_from_callback();
        self.state.clone()
    }

    fn refresh_from_callback(&mut self) {
        let Some(player) = &mut self.player else {
            return;
        };
        let snapshot = player.snapshot();
        if self.state.buffering {
            // Hard load pauses the old Deck before worker decode. Until the new revision installs,
            // that old callback snapshot must not overwrite the requested track/time in the UI.
            self.state.is_playing = false;
            self.state.transitioning = false;
            return;
        }
        let display_deck = if snapshot.transitioning {
            let target = snapshot.transition_to;
            self.pending_handoff = Some((target, true));
            target
        } else if let Some((target, observed)) = self.pending_handoff {
            if observed {
                self.pending_handoff = None;
                snapshot.active_deck
            } else {
                target
            }
        } else {
            snapshot.active_deck
        };
        self.front = display_deck;
        self.state.active_deck = deck_name(display_deck);
        self.state.transitioning = snapshot.transitioning || self.pending_handoff.is_some();
        self.state.is_playing = snapshot.playing;
        if let Some(meta) = &self.decks[display_deck as usize] {
            self.state.track_id = Some(meta.track_id);
            if snapshot.deck_source_ids[display_deck as usize] == meta.source_id {
                self.state.current_time =
                    meta.seconds_for_frame(snapshot.deck_frames[display_deck as usize]);
            }
            self.state.duration = meta.duration;
            self.state.rate = meta.tempo_rate;
            if !self.state.buffering {
                self.state.status = if snapshot.playing {
                    "playing"
                } else if self.state.current_time + 0.02 >= meta.duration {
                    "ended"
                } else {
                    "paused"
                };
            }
        }
    }

    fn publish(&mut self, force: bool) {
        if !force && self.last_publish.elapsed() < STATE_INTERVAL {
            return;
        }
        self.refresh_from_callback();
        self.last_publish = Instant::now();
        if force || self.state != self.last_emitted {
            if let Err(error) = self.app.emit(STATE_EVENT, &self.state) {
                tracing::warn!("发送原生播放器状态失败：{error}");
            }
            self.last_emitted = self.state.clone();
        }
    }

    fn bump_deck_revision(&mut self, deck: DeckId) -> u64 {
        let revision = self.next_revision;
        self.next_revision = self.next_revision.wrapping_add(1).max(1);
        self.deck_revisions[deck as usize] = revision;
        self.revision_fences[deck as usize].store(revision, Ordering::Release);
        self.state.source_revision = revision;
        revision
    }

    fn invalidate_all_decks(&mut self) {
        for deck in [DeckId::A, DeckId::B] {
            let _ = self.bump_deck_revision(deck);
        }
    }
}

fn prepare_audio<F>(request: &DesktopPrepareRequest, cancelled: F) -> Result<PreparedAudio, String>
where
    F: Fn() -> bool + Copy,
{
    validate_rate(request.rate)?;
    let path = PathBuf::from(&request.path);
    if !path.is_file() {
        return Err(format!("音频文件不存在：{}", path.display()));
    }
    let decode_limit =
        ((MAX_TRACK_PCM_BYTES as f64 * f64::from(request.rate)) as usize).min(MAX_TRACK_PCM_BYTES);
    let decoded = decode_file_with_limit_and_cancel(&path, decode_limit, cancelled)
        .map_err(|error| format!("解码失败：{error:#}"))?;
    let logical_duration = decoded.duration_seconds();
    let pcm = if (request.rate - 1.0).abs() < 0.000_1 {
        Arc::new(decoded)
    } else {
        Arc::new(
            stretch_preserving_pitch_with_cancel(&decoded, request.rate, cancelled)
                .map_err(|error| format!("变速不变调准备失败：{error:#}"))?,
        )
    };
    if pcm.byte_len() > MAX_TRACK_PCM_BYTES {
        return Err(format!(
            "准备后的 PCM 超过 {} MiB 上限",
            MAX_TRACK_PCM_BYTES / (1024 * 1024)
        ));
    }
    Ok(PreparedAudio {
        pcm,
        logical_duration,
    })
}

fn validate_rate(rate: f32) -> Result<(), String> {
    if rate.is_finite() && (0.5..=2.0).contains(&rate) {
        Ok(())
    } else {
        Err("播放速度必须在 0.5 到 2.0 之间".into())
    }
}

fn deck_name(deck: DeckId) -> &'static str {
    match deck {
        DeckId::A => "a",
        DeckId::B => "b",
    }
}

#[tauri::command]
pub async fn desktop_player_initialize(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<DesktopPlayerState, String> {
    player.request(|reply| Request::Initialize { reply }).await
}

#[tauri::command]
pub async fn desktop_player_load(
    player: tauri::State<'_, DesktopPlayerHandle>,
    request: DesktopLoadRequest,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::Load { request, reply })
        .await
}

#[tauri::command]
pub async fn desktop_player_prepare(
    player: tauri::State<'_, DesktopPlayerHandle>,
    request: DesktopPrepareRequest,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::Prepare { request, reply })
        .await
}

#[tauri::command]
pub async fn desktop_player_play(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<DesktopPlayerState, String> {
    player.request(|reply| Request::Play { reply }).await
}

#[tauri::command]
pub async fn desktop_player_pause(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<DesktopPlayerState, String> {
    player.request(|reply| Request::Pause { reply }).await
}

#[tauri::command]
pub async fn desktop_player_seek(
    player: tauri::State<'_, DesktopPlayerHandle>,
    position: f64,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::Seek { position, reply })
        .await
}

#[tauri::command]
pub async fn desktop_player_handoff(
    player: tauri::State<'_, DesktopPlayerHandle>,
    position: f64,
    seconds: f64,
    plan: DesktopTransitionPlan,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::Handoff {
            position,
            seconds,
            plan,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn desktop_player_set_volume(
    player: tauri::State<'_, DesktopPlayerHandle>,
    volume: f32,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::SetVolume { volume, reply })
        .await
}

#[tauri::command]
pub async fn desktop_player_set_eq(
    player: tauri::State<'_, DesktopPlayerHandle>,
    low_db: f32,
    high_db: f32,
) -> Result<DesktopPlayerState, String> {
    player
        .request(|reply| Request::SetEq {
            low_db,
            high_db,
            reply,
        })
        .await
}

#[tauri::command]
pub async fn desktop_player_state(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<DesktopPlayerState, String> {
    player.request(|reply| Request::State { reply }).await
}

#[tauri::command]
pub async fn desktop_player_dispose(
    player: tauri::State<'_, DesktopPlayerHandle>,
) -> Result<DesktopPlayerState, String> {
    player.request(|reply| Request::Dispose { reply }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_seconds_map_through_offline_tempo_pcm() {
        let deck = DeckState {
            source_id: 1,
            track_id: 7,
            duration: 240.0,
            sample_rate: 48_000,
            tempo_rate: 1.25,
        };
        let frame = deck.frame_for_seconds(100.0);
        assert_eq!(frame, 3_840_000);
        assert!((deck.seconds_for_frame(frame) - 100.0).abs() < 0.000_1);
    }

    #[test]
    fn transition_contract_maps_every_effect_to_fixed_flags() {
        let plan = DesktopTransitionPlan {
            eq: true,
            filter: true,
            vocal_cut: true,
            echo: true,
            alarm: true,
            hydrant: true,
            beat_seconds: 0.5,
        }
        .realtime(48_000);
        assert_eq!(plan.beat_frames, 24_000);
        for flag in [
            TransitionPlan::EQ,
            TransitionPlan::FILTER,
            TransitionPlan::VOCAL_CUT,
            TransitionPlan::ECHO,
            TransitionPlan::ALARM,
            TransitionPlan::HYDRANT,
        ] {
            assert!(plan.contains(flag));
        }
    }

    #[test]
    fn emitted_state_uses_the_frontend_contract_names() {
        let state = DesktopPlayerState {
            track_id: Some(42),
            is_playing: true,
            source_revision: 9,
            seek_revision: 3,
            ..DesktopPlayerState::default()
        };
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["trackId"], 42);
        assert_eq!(value["isPlaying"], true);
        assert_eq!(value["sourceRevision"], 9);
        assert_eq!(value["seekRevision"], 3);
        assert!(value.get("track_id").is_none());
    }
}
