use std::fmt;
use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::command::{EngineCommand, SourceKind};
use crate::dsp::{DeckEq, TransitionFx};
use crate::state::{SharedState, SharedTransportState};
use crate::{
    DeckId, DecodedTrack, PlayerMode, RtCommand, StreamSource, TransitionPlan, TransportSnapshot,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandError {
    Full,
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("realtime command queue is full")
    }
}

impl std::error::Error for CommandError {}

/// Single-producer control handle. It is intentionally not `Clone`: a second producer would
/// violate the realtime queue's ownership contract.
pub struct PlayerController {
    producer: Producer<EngineCommand>,
    shared: SharedTransportState,
}

impl PlayerController {
    pub fn send(&mut self, command: RtCommand) -> Result<(), CommandError> {
        self.producer
            .push(EngineCommand::Transport(command))
            .map_err(|_| CommandError::Full)
    }

    pub(crate) fn install_prepared(
        &mut self,
        deck: DeckId,
        source_id: u64,
        source_kind: SourceKind,
        address: usize,
        start_frame: u64,
    ) -> Result<(), CommandError> {
        self.producer
            .push(EngineCommand::InstallPrepared {
                deck,
                source_id,
                source_kind,
                address,
                start_frame,
            })
            .map_err(|_| CommandError::Full)
    }

    pub(crate) fn clear_prepared(&mut self, deck: DeckId) -> Result<(), CommandError> {
        self.producer
            .push(EngineCommand::ClearPrepared { deck })
            .map_err(|_| CommandError::Full)
    }

    pub fn snapshot(&self) -> TransportSnapshot {
        self.shared.snapshot()
    }
}

#[derive(Clone, Copy, Debug)]
struct Transition {
    from: DeckId,
    to: DeckId,
    total_frames: u32,
    elapsed_frames: u32,
    plan: TransitionPlan,
}

#[derive(Clone, Copy, Debug, Default)]
struct InstalledSource {
    id: u64,
    kind: SourceKind,
    address: usize,
}

#[derive(Clone, Copy, Debug)]
struct TransportRamp {
    target: f32,
    step: f32,
    remaining_frames: u32,
    stop_after_ramp: bool,
}

/// State owned exclusively by the platform audio callback.
pub struct AudioRenderer {
    consumer: Consumer<EngineCommand>,
    retired: Option<Producer<u64>>,
    deck_sources: [InstalledSource; 2],
    shared: SharedTransportState,
    mode: PlayerMode,
    playing: bool,
    transport_gain: f32,
    transport_ramp: Option<TransportRamp>,
    active_deck: DeckId,
    output_frames: u64,
    deck_positions: [f64; 2],
    deck_gains: [f32; 2],
    deck_rates: [f64; 2],
    source_rate_ratios: [f64; 2],
    /// Encoded network streams may briefly starve. Hold the last sample and ramp its edge instead
    /// of hard-switching between an arbitrary sample and zero, which is perceived as crackle.
    stream_edge_gains: [f32; 2],
    stream_last_frames: [[f32; 2]; 2],
    output_sample_rate: u32,
    deck_eq: [DeckEq; 2],
    transition_fx: TransitionFx,
    master_gain: f32,
    transition: Option<Transition>,
}

/// Creates the bounded control/audio halves. Capacity is fixed for the lifetime of the player.
pub fn command_channel(capacity: usize) -> (PlayerController, AudioRenderer) {
    make_channels(capacity, None)
}

pub(crate) fn dynamic_command_channel(
    capacity: usize,
    retire_capacity: usize,
) -> (PlayerController, AudioRenderer, Consumer<u64>) {
    assert!(
        retire_capacity > 0,
        "retire queue capacity must be non-zero"
    );
    let (retired_producer, retired_consumer) = RingBuffer::new(retire_capacity);
    let (controller, renderer) = make_channels(capacity, Some(retired_producer));
    (controller, renderer, retired_consumer)
}

fn make_channels(
    capacity: usize,
    retired: Option<Producer<u64>>,
) -> (PlayerController, AudioRenderer) {
    assert!(capacity > 0, "command queue capacity must be non-zero");
    let (producer, consumer) = RingBuffer::new(capacity);
    let shared = Arc::new(SharedState::default());
    (
        PlayerController {
            producer,
            shared: Arc::clone(&shared),
        },
        AudioRenderer {
            consumer,
            retired,
            deck_sources: [InstalledSource::default(); 2],
            shared,
            mode: PlayerMode::Continuous,
            playing: false,
            transport_gain: 0.0,
            transport_ramp: None,
            active_deck: DeckId::A,
            output_frames: 0,
            deck_positions: [0.0; 2],
            deck_gains: [1.0; 2],
            deck_rates: [1.0; 2],
            source_rate_ratios: [1.0; 2],
            stream_edge_gains: [0.0; 2],
            stream_last_frames: [[0.0; 2]; 2],
            output_sample_rate: 48_000,
            deck_eq: [DeckEq::default(); 2],
            transition_fx: TransitionFx::new(),
            master_gain: 1.0,
            transition: None,
        },
    )
}

impl AudioRenderer {
    /// Mixes one interleaved output block without allocating or taking a lock.
    ///
    /// Inputs must already be decoded, resampled and aligned to each deck's prepared cursor.
    /// Missing samples are treated as silence. Commands are applied before the first frame.
    pub fn render(&mut self, deck_a: &[f32], deck_b: &[f32], output: &mut [f32], channels: usize) {
        if channels == 0 {
            output.fill(0.0);
            return;
        }
        self.ensure_eq_sample_rate();
        self.drain_commands();

        let complete_len = output.len() - output.len() % channels;
        let frame_count = complete_len / channels;
        for frame in 0..frame_count {
            let (transition_a, transition_b) = self.transition_gains();
            let index = frame * channels;
            let input_a = [
                deck_a.get(index).copied().unwrap_or(0.0),
                deck_a
                    .get(index + usize::from(channels > 1))
                    .copied()
                    .unwrap_or(0.0),
            ];
            let input_b = [
                deck_b.get(index).copied().unwrap_or(0.0),
                deck_b
                    .get(index + usize::from(channels > 1))
                    .copied()
                    .unwrap_or(0.0),
            ];
            let (a, b) = if self.playing {
                (
                    self.deck_eq[0].process_stereo(input_a),
                    self.deck_eq[1].process_stereo(input_b),
                )
            } else {
                ([0.0; 2], [0.0; 2])
            };
            for channel in 0..channels {
                output[index + channel] = if self.playing {
                    let side = channel.min(1);
                    (a[side] * self.deck_gains[0] * transition_a
                        + b[side] * self.deck_gains[1] * transition_b)
                        * self.master_gain
                        * self.transport_gain
                } else {
                    0.0
                };
            }
            self.advance_frame([true, true], true);
            self.advance_transport_ramp();
        }
        output[complete_len..].fill(0.0);
        self.publish();
    }

    /// Renders directly from two immutable predecoded tracks. Random seeks only change a frame
    /// index, so the callback never asks a compressed decoder to rebuild buffers.
    pub fn render_tracks(
        &mut self,
        deck_a: &DecodedTrack,
        deck_b: &DecodedTrack,
        output: &mut [f32],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        if output_sample_rate == 0 || output_channels == 0 {
            output.fill(0.0);
            return;
        }
        self.output_sample_rate = output_sample_rate;
        self.source_rate_ratios = [
            f64::from(deck_a.sample_rate()) / f64::from(output_sample_rate),
            f64::from(deck_b.sample_rate()) / f64::from(output_sample_rate),
        ];
        self.ensure_eq_sample_rate();
        self.drain_commands();

        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let (transition_a, transition_b) = self.transition_gains();
            let (a, b) = if self.playing {
                (
                    self.deck_eq[0].process_stereo([
                        track_sample(deck_a, self.deck_positions[0], 0),
                        track_sample(deck_a, self.deck_positions[0], 1),
                    ]),
                    self.deck_eq[1].process_stereo([
                        track_sample(deck_b, self.deck_positions[1], 0),
                        track_sample(deck_b, self.deck_positions[1], 1),
                    ]),
                )
            } else {
                ([0.0; 2], [0.0; 2])
            };
            for (channel, sample) in frame.iter_mut().enumerate() {
                *sample = if self.playing {
                    let side = channel.min(1);
                    (a[side] * self.deck_gains[0] * transition_a
                        + b[side] * self.deck_gains[1] * transition_b)
                        * self.master_gain
                        * self.transport_gain
                } else {
                    0.0
                };
            }
            self.advance_frame([true, true], true);
            self.advance_transport_ramp();
        }
        output[complete_len..].fill(0.0);
        self.publish();
    }

    /// Renders from sources installed by the control thread. The callback only follows stable
    /// addresses and never clones or drops their owning `Arc`; retirement is acknowledged through
    /// the reverse SPSC queue after a Deck switches away from an address.
    pub(crate) fn render_prepared(
        &mut self,
        output: &mut [f32],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        self.render_prepared_as(output, output_sample_rate, output_channels, |sample| sample);
    }

    pub(crate) fn render_prepared_i16(
        &mut self,
        output: &mut [i16],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        self.render_prepared_as(output, output_sample_rate, output_channels, |sample| {
            (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
        });
    }

    pub(crate) fn render_prepared_u16(
        &mut self,
        output: &mut [u16],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        self.render_prepared_as(output, output_sample_rate, output_channels, |sample| {
            ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * f32::from(u16::MAX)).round() as u16
        });
    }

    fn render_prepared_as<T, F>(
        &mut self,
        output: &mut [T],
        output_sample_rate: u32,
        output_channels: usize,
        convert: F,
    ) where
        F: Fn(f32) -> T,
    {
        if output_sample_rate == 0 || output_channels == 0 {
            for sample in output.iter_mut() {
                *sample = convert(0.0);
            }
            return;
        }
        self.output_sample_rate = output_sample_rate;
        self.drain_commands();

        let installed = self.deck_sources;
        // SAFETY: DynamicPlayer retains the matching Arc until this renderer acknowledges the old
        // source ID. Stream consumers are touched only by this callback.
        let sources = unsafe {
            [
                installed_callback_source(installed[0]),
                installed_callback_source(installed[1]),
            ]
        };
        self.source_rate_ratios = [
            callback_source_ratio(sources[0], output_sample_rate),
            callback_source_ratio(sources[1], output_sample_rate),
        ];
        self.ensure_eq_sample_rate();

        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let required = self.required_decks();
            let (raw_a, advance_a) = if self.playing && required[0] {
                callback_source_frame(sources[0], self.deck_positions[0])
            } else {
                ([0.0; 2], false)
            };
            let raw_a = self.smooth_stream_edge(0, sources[0], raw_a, advance_a);
            let (raw_b, advance_b) = if self.playing && required[1] {
                callback_source_frame(sources[1], self.deck_positions[1])
            } else {
                ([0.0; 2], false)
            };
            let raw_b = self.smooth_stream_edge(1, sources[1], raw_b, advance_b);
            let transition_can_advance = self.transition.is_none()
                || (!required[0] || advance_a) && (!required[1] || advance_b);
            let (transition_a, transition_b) = self.transition_gains();
            let (a, b) = if self.playing {
                (
                    self.deck_eq[0].process_stereo(raw_a),
                    self.deck_eq[1].process_stereo(raw_b),
                )
            } else {
                ([0.0; 2], [0.0; 2])
            };
            let (processed, wet) = if let Some(transition) = self.transition {
                self.transition_fx.process(
                    [a, b],
                    transition.from as usize,
                    transition.to as usize,
                    transition_progress(transition),
                    self.output_sample_rate,
                    transition.plan,
                )
            } else {
                ([a, b], [0.0; 2])
            };
            let [a, b] = processed;
            for (channel, sample) in frame.iter_mut().enumerate() {
                let value = if self.playing {
                    let side = channel.min(1);
                    ((a[side] * self.deck_gains[0] * transition_a
                        + b[side] * self.deck_gains[1] * transition_b)
                        + wet[side])
                        * self.master_gain
                        * self.transport_gain
                } else {
                    0.0
                };
                *sample = convert(value.clamp(-1.0, 1.0));
            }
            self.advance_frame([advance_a, advance_b], transition_can_advance);
            self.advance_transport_ramp();
        }
        for sample in &mut output[complete_len..] {
            *sample = convert(0.0);
        }
        if self.transition.is_none() {
            if callback_source_ended(
                sources[self.active_deck as usize],
                self.deck_positions[self.active_deck as usize],
            ) {
                self.stop_transport();
            }
        }
        self.publish();
    }

    fn smooth_stream_edge(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
        frame: [f32; 2],
        advanced: bool,
    ) -> [f32; 2] {
        if !matches!(source, Some(CallbackSource::Stream(_))) {
            self.stream_edge_gains[index] = 1.0;
            self.stream_last_frames[index] = frame;
            return frame;
        }
        // Five milliseconds spans many callback samples but remains far below transport latency.
        // It removes the discontinuity at both sides of a starvation gap without advancing the
        // source clock or allocating/locking on the realtime thread.
        let ramp_frames = (self.output_sample_rate / 200).max(1) as f32;
        let step = 1.0 / ramp_frames;
        if advanced {
            self.stream_last_frames[index] = frame;
            self.stream_edge_gains[index] = (self.stream_edge_gains[index] + step).min(1.0);
        } else {
            self.stream_edge_gains[index] = (self.stream_edge_gains[index] - step).max(0.0);
        }
        let held = if advanced {
            frame
        } else {
            self.stream_last_frames[index]
        };
        [
            held[0] * self.stream_edge_gains[index],
            held[1] * self.stream_edge_gains[index],
        ]
    }

    fn drain_commands(&mut self) {
        while let Ok(command) = self.consumer.pop() {
            match command {
                EngineCommand::Transport(command) => self.apply(command),
                EngineCommand::InstallPrepared {
                    deck,
                    source_id,
                    source_kind,
                    address,
                    start_frame,
                } => self.install_prepared(deck, source_id, source_kind, address, start_frame),
                EngineCommand::ClearPrepared { deck } => self.clear_prepared(deck),
            }
        }
    }

    fn retire(&mut self, source: InstalledSource) {
        if source.id == 0 {
            return;
        }
        if let Some(retired) = &mut self.retired {
            // A full acknowledgement queue delays reclamation until shutdown but never permits
            // the callback to drop PCM or block. Runtime capacities make this exceptional.
            let _ = retired.push(source.id);
        }
    }

    fn install_prepared(
        &mut self,
        deck: DeckId,
        source_id: u64,
        source_kind: SourceKind,
        address: usize,
        start_frame: u64,
    ) {
        let index = deck as usize;
        let previous = std::mem::replace(
            &mut self.deck_sources[index],
            InstalledSource {
                id: source_id,
                kind: source_kind,
                address,
            },
        );
        self.deck_positions[index] = start_frame as f64;
        self.deck_rates[index] = 1.0;
        self.stream_edge_gains[index] = if source_kind == SourceKind::Stream {
            0.0
        } else {
            1.0
        };
        self.stream_last_frames[index] = [0.0; 2];
        self.deck_eq[index].reset();
        self.retire(previous);
    }

    fn clear_prepared(&mut self, deck: DeckId) {
        let index = deck as usize;
        let previous = std::mem::take(&mut self.deck_sources[index]);
        self.deck_positions[index] = 0.0;
        self.stream_edge_gains[index] = 0.0;
        self.stream_last_frames[index] = [0.0; 2];
        if deck == self.active_deck {
            self.stop_transport();
            self.transition = None;
        }
        self.retire(previous);
    }

    fn apply(&mut self, command: RtCommand) {
        match command {
            RtCommand::SetMode(mode) => self.mode = mode,
            RtCommand::SetPlaying {
                playing,
                fade_frames,
            } => self.set_transport_playing(playing, fade_frames),
            RtCommand::SetMasterGain(gain) => self.master_gain = normalized_gain(gain),
            RtCommand::SetDeckGain { deck, gain } => {
                self.deck_gains[deck as usize] = normalized_gain(gain);
            }
            RtCommand::SetRate { deck, rate } => {
                if rate.is_finite() && rate > 0.0 {
                    self.deck_rates[deck as usize] = f64::from(rate);
                }
            }
            RtCommand::SetEq {
                deck,
                low_db,
                high_db,
            } => self.deck_eq[deck as usize].configure(self.output_sample_rate, low_db, high_db),
            RtCommand::SeekPrepared { deck, frame } => {
                self.deck_positions[deck as usize] = frame as f64;
                self.deck_eq[deck as usize].reset();
                if deck == self.active_deck {
                    self.transition = None;
                }
            }
            RtCommand::HandoffPrepared {
                to,
                target_frame,
                transition_frames,
                plan,
            } => {
                self.deck_positions[to as usize] = target_frame as f64;
                self.deck_eq[to as usize].reset();
                if to == self.active_deck || transition_frames == 0 {
                    self.active_deck = to;
                    self.transition = None;
                } else {
                    self.transition_fx.reset();
                    self.transition = Some(Transition {
                        from: self.active_deck,
                        to,
                        total_frames: transition_frames,
                        elapsed_frames: 0,
                        plan,
                    });
                }
            }
        }
    }

    fn set_transport_playing(&mut self, playing: bool, fade_frames: u32) {
        if fade_frames == 0 {
            self.transport_ramp = None;
            self.playing = playing;
            self.transport_gain = if playing { 1.0 } else { 0.0 };
            return;
        }

        if playing {
            self.playing = true;
        } else if !self.playing {
            self.stop_transport();
            return;
        }

        let target = if playing { 1.0 } else { 0.0 };
        let distance = (target - self.transport_gain).abs();
        if distance <= f32::EPSILON {
            self.transport_gain = target;
            self.transport_ramp = None;
            if !playing {
                self.playing = false;
            }
            return;
        }

        // A reversal starts at the current gain. Scaling by the remaining distance preserves the
        // configured slope, so rapid play/pause clicks cannot create a jump or a sluggish restart.
        let remaining_frames = ((fade_frames as f32 * distance).ceil() as u32).max(1);
        self.transport_ramp = Some(TransportRamp {
            target,
            step: (target - self.transport_gain) / remaining_frames as f32,
            remaining_frames,
            stop_after_ramp: !playing,
        });
    }

    fn advance_transport_ramp(&mut self) {
        let Some(mut ramp) = self.transport_ramp else {
            return;
        };
        if ramp.remaining_frames <= 1 {
            self.transport_gain = ramp.target;
            self.transport_ramp = None;
            if ramp.stop_after_ramp {
                self.playing = false;
            }
            return;
        }
        self.transport_gain = (self.transport_gain + ramp.step).clamp(0.0, 1.0);
        ramp.remaining_frames -= 1;
        self.transport_ramp = Some(ramp);
    }

    fn stop_transport(&mut self) {
        self.playing = false;
        self.transport_gain = 0.0;
        self.transport_ramp = None;
    }

    fn ensure_eq_sample_rate(&mut self) {
        for eq in &mut self.deck_eq {
            eq.ensure_sample_rate(self.output_sample_rate);
        }
    }

    fn required_decks(&self) -> [bool; 2] {
        if !self.playing {
            return [false, false];
        }
        if let Some(transition) = self.transition {
            let mut required = [false, false];
            required[transition.from as usize] = true;
            required[transition.to as usize] = true;
            required
        } else {
            match self.active_deck {
                DeckId::A => [true, false],
                DeckId::B => [false, true],
            }
        }
    }

    fn transition_gains(&self) -> (f32, f32) {
        let Some(transition) = self.transition else {
            return match self.active_deck {
                DeckId::A => (1.0, 0.0),
                DeckId::B => (0.0, 1.0),
            };
        };
        let progress =
            (transition.elapsed_frames + 1) as f32 / transition.total_frames.max(1) as f32;
        let (outgoing, incoming) = if transition.plan.contains(TransitionPlan::SEEK_DUCK) {
            // seek 两端通常是毫不相关的采样点。新位置若从第一帧就满幅叠上来，
            // 会制造一次幅度阶跃/削波，听起来正是“点了以后顿一下”。用零斜率的
            // 互补 smootherstep 换手：总增益始终为 1，既不叠成两下也不硬切爆点。
            let incoming = progress * progress * (3.0 - 2.0 * progress);
            (1.0 - incoming, incoming)
        } else {
            // Equal-power crossfade keeps perceived loudness stable around the midpoint; a linear
            // 0.5 + 0.5 handoff audibly dips when the decks are not phase-correlated.
            (
                (progress * std::f32::consts::FRAC_PI_2).cos(),
                (progress * std::f32::consts::FRAC_PI_2).sin(),
            )
        };
        match (transition.from, transition.to) {
            (DeckId::A, DeckId::B) => (outgoing, incoming),
            (DeckId::B, DeckId::A) => (incoming, outgoing),
            // A malformed realtime command must silence/continue rather than panic on the
            // platform audio callback. The coordinator normally only sends opposite decks.
            _ => match self.active_deck {
                DeckId::A => (1.0, 0.0),
                DeckId::B => (0.0, 1.0),
            },
        }
    }

    fn advance_frame(&mut self, advanced: [bool; 2], transition_can_advance: bool) {
        self.output_frames = self.output_frames.saturating_add(1);
        if self.playing {
            let required = self.required_decks();
            for index in 0..2 {
                if required[index] && advanced[index] {
                    self.deck_positions[index] +=
                        self.deck_rates[index] * self.source_rate_ratios[index];
                }
            }
        }

        if self.playing && transition_can_advance {
            if let Some(mut transition) = self.transition {
                transition.elapsed_frames += 1;
                if transition.elapsed_frames >= transition.total_frames {
                    self.active_deck = transition.to;
                    self.transition = None;
                } else {
                    self.transition = Some(transition);
                }
            }
        }
    }

    fn publish(&self) {
        self.shared.publish(
            self.mode,
            self.playing,
            self.active_deck,
            self.transition.map(|transition| transition.to),
            self.output_frames,
            [self.deck_positions[0] as u64, self.deck_positions[1] as u64],
            [self.deck_sources[0].id, self.deck_sources[1].id],
        );
    }
}

#[derive(Clone, Copy)]
enum CallbackSource {
    Decoded(&'static DecodedTrack),
    Stream(&'static StreamSource),
}

/// # Safety
///
/// `source.address` must match `source.kind` and point to an owner retained by DynamicPlayer.
/// The renderer never stores the resulting reference beyond one callback invocation.
unsafe fn installed_callback_source(source: InstalledSource) -> Option<CallbackSource> {
    if source.id == 0 || source.address == 0 {
        return None;
    }
    match source.kind {
        SourceKind::Decoded => {
            // SAFETY: upheld by DynamicPlayer's source registry and retirement protocol.
            Some(CallbackSource::Decoded(unsafe {
                &*(source.address as *const DecodedTrack)
            }))
        }
        SourceKind::Stream => {
            // SAFETY: upheld by DynamicPlayer's source registry and retirement protocol.
            Some(CallbackSource::Stream(unsafe {
                &*(source.address as *const StreamSource)
            }))
        }
    }
}

fn callback_source_ratio(source: Option<CallbackSource>, output_sample_rate: u32) -> f64 {
    match source {
        Some(CallbackSource::Decoded(track)) => {
            f64::from(track.sample_rate()) / f64::from(output_sample_rate)
        }
        Some(CallbackSource::Stream(_)) | None => 1.0,
    }
}

fn callback_source_frame(source: Option<CallbackSource>, position: f64) -> ([f32; 2], bool) {
    match source {
        Some(CallbackSource::Decoded(track)) if position < track.frames() as f64 => (
            [
                track_sample(track, position, 0),
                track_sample(track, position, 1),
            ],
            true,
        ),
        Some(CallbackSource::Stream(stream)) => stream
            .pop_callback()
            .map(|frame| (frame, true))
            .unwrap_or(([0.0; 2], false)),
        _ => ([0.0; 2], false),
    }
}

fn callback_source_ended(source: Option<CallbackSource>, position: f64) -> bool {
    match source {
        Some(CallbackSource::Decoded(track)) => position >= track.frames() as f64,
        Some(CallbackSource::Stream(stream)) => stream.drained(),
        None => true,
    }
}

fn transition_progress(transition: Transition) -> f32 {
    (transition.elapsed_frames + 1) as f32 / transition.total_frames.max(1) as f32
}

fn track_sample(track: &DecodedTrack, position: f64, channel: usize) -> f32 {
    if !position.is_finite() || position < 0.0 {
        return 0.0;
    }
    let base = position.floor() as usize;
    let fraction = (position - base as f64) as f32;
    let samples = track.interleaved();
    let index = base.saturating_mul(2).saturating_add(channel);
    let current = samples.get(index).copied().unwrap_or(0.0);
    let next = samples.get(index + 2).copied().unwrap_or(current);
    current + (next - current) * fraction
}

fn normalized_gain(gain: f32) -> f32 {
    if gain.is_finite() {
        gain.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_is_silent_and_does_not_advance_deck_clock() {
        let (controller, mut renderer) = command_channel(4);
        let mut output = [9.0; 4];
        renderer.render(&[1.0; 4], &[1.0; 4], &mut output, 2);
        assert_eq!(output, [0.0; 4]);
        assert_eq!(controller.snapshot().output_frames, 2);
        assert_eq!(controller.snapshot().deck_frames, [0, 0]);
    }

    #[test]
    fn malformed_output_shape_is_silenced_instead_of_panicking() {
        let (_controller, mut renderer) = command_channel(4);
        let mut partial = [9.0; 3];
        renderer.render(&[1.0; 4], &[1.0; 4], &mut partial, 2);
        assert_eq!(partial, [0.0; 3]);

        let mut no_channels = [9.0; 2];
        renderer.render(&[1.0; 2], &[1.0; 2], &mut no_channels, 0);
        assert_eq!(no_channels, [0.0; 2]);
    }

    #[test]
    fn transport_fade_reverses_from_the_current_gain_without_a_jump() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: false,
                fade_frames: 4,
            })
            .unwrap();
        let mut fade_out = [0.0; 2];
        renderer.render(&[1.0; 2], &[], &mut fade_out, 1);
        assert_eq!(fade_out, [1.0, 0.75]);

        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 4,
            })
            .unwrap();
        let mut reversed = [0.0; 3];
        renderer.render(&[1.0; 3], &[], &mut reversed, 1);
        assert_eq!(reversed, [0.5, 0.75, 1.0]);
        assert!(controller.snapshot().playing);
    }

    #[test]
    fn prepared_handoff_is_sample_clocked_without_a_silent_frame() {
        let (mut controller, mut renderer) = command_channel(4);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        controller
            .send(RtCommand::HandoffPrepared {
                to: DeckId::B,
                target_frame: 8_000,
                transition_frames: 4,
                plan: TransitionPlan::default(),
            })
            .unwrap();

        let mut output = [0.0; 4];
        renderer.render(&[1.0; 4], &[-1.0; 4], &mut output, 1);
        let expected = [0.541_196, 0.0, -0.541_196, -1.0];
        for (actual, expected) in output.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 0.000_01);
        }
        let snapshot = controller.snapshot();
        assert_eq!(snapshot.active_deck, DeckId::B);
        assert_eq!(snapshot.deck_frames, [4, 8_004]);
    }

    #[test]
    fn seek_handoff_is_smooth_and_never_stacks_both_decks() {
        let (mut controller, mut renderer) = command_channel(4);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        controller
            .send(RtCommand::HandoffPrepared {
                to: DeckId::B,
                target_frame: 0,
                transition_frames: 4,
                plan: TransitionPlan {
                    flags: TransitionPlan::SEEK_DUCK,
                    beat_frames: 0,
                },
            })
            .unwrap();

        // A=+1、B=-1：互补 smootherstep 从旧位置单调、连续地走到新位置。
        let mut output = [0.0; 4];
        renderer.render(&[1.0; 4], &[-1.0; 4], &mut output, 1);
        let expected = [0.6875, 0.0, -0.6875, -1.0];
        for (actual, expected) in output.into_iter().zip(expected) {
            assert!(
                (actual - expected).abs() < 0.000_01,
                "actual={actual} expected={expected}"
            );
        }

        // 同相的最坏峰值也始终为 1；旧实现第一帧会把两台叠到 1.56，造成削波顿挫。
        let (mut controller, mut renderer) = command_channel(4);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        controller
            .send(RtCommand::HandoffPrepared {
                to: DeckId::B,
                target_frame: 0,
                transition_frames: 4,
                plan: TransitionPlan {
                    flags: TransitionPlan::SEEK_DUCK,
                    beat_frames: 0,
                },
            })
            .unwrap();
        let mut output = [0.0; 4];
        renderer.render(&[1.0; 4], &[1.0; 4], &mut output, 1);
        assert_eq!(output, [1.0; 4]);
    }

    #[test]
    fn repeated_scrub_updates_coalesce_before_the_next_audio_frame() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        for frame in [1_000, 5_000, 9_000] {
            controller
                .send(RtCommand::SeekPrepared {
                    deck: DeckId::A,
                    frame,
                })
                .unwrap();
        }
        let mut output = [0.0; 1];
        renderer.render(&[1.0], &[], &mut output, 1);
        assert_eq!(controller.snapshot().deck_frames[0], 9_001);
    }

    #[test]
    fn seek_and_gain_apply_before_first_output_frame() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        controller
            .send(RtCommand::SeekPrepared {
                deck: DeckId::A,
                frame: 48_000,
            })
            .unwrap();
        controller.send(RtCommand::SetMasterGain(0.25)).unwrap();
        let mut output = [0.0; 2];
        renderer.render(&[1.0; 2], &[], &mut output, 1);
        assert_eq!(output, [0.25, 0.25]);
        assert_eq!(controller.snapshot().deck_frames[0], 48_002);
    }

    #[test]
    fn realtime_commands_are_fixed_size_and_need_no_drop() {
        assert!(!std::mem::needs_drop::<RtCommand>());
        assert!(std::mem::size_of::<RtCommand>() <= 24);
    }

    #[test]
    fn bounded_queue_reports_backpressure() {
        let (mut controller, _renderer) = command_channel(1);
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        assert_eq!(
            controller.send(RtCommand::SetPlaying {
                playing: false,
                fade_frames: 0,
            }),
            Err(CommandError::Full)
        );
    }

    #[test]
    fn a_starved_stream_fades_its_last_sample_instead_of_hard_clicking_to_zero() {
        let (stream, mut writer) = StreamSource::bounded(512);
        for _ in 0..240 {
            writer.push([1.0, 1.0], || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                10,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                0,
            )
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();

        let mut primed = [0.0; 240];
        renderer.render_prepared(&mut primed, 48_000, 1);
        assert!(
            primed[239] > 0.99,
            "startup edge should reach unity within 5ms"
        );

        let mut starved = [0.0; 3];
        renderer.render_prepared(&mut starved, 48_000, 1);
        assert!(
            starved[0] > 0.99,
            "first missing frame must not hard-cut to zero"
        );
        assert!(starved[0] > starved[1] && starved[1] > starved[2]);
        assert_eq!(
            controller.snapshot().deck_frames[0],
            240,
            "starvation freezes media time"
        );
        drop(writer);
    }

    #[test]
    fn dynamic_deck_install_is_ordered_and_retires_old_source() {
        let first = Arc::new(
            DecodedTrack::from_interleaved_stereo(
                vec![0.25, -0.25, 0.25, -0.25, 0.25, -0.25, 0.25, -0.25],
                48_000,
            )
            .unwrap(),
        );
        let second = Arc::new(
            DecodedTrack::from_interleaved_stereo(
                vec![0.75, -0.75, 0.75, -0.75, 0.75, -0.75, 0.75, -0.75],
                48_000,
            )
            .unwrap(),
        );
        let (mut controller, mut renderer, mut retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                10,
                SourceKind::Decoded,
                Arc::as_ptr(&first) as usize,
                0,
            )
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        let mut output = [0.0; 2];
        renderer.render_prepared(&mut output, 48_000, 2);
        assert_eq!(output, [0.25, -0.25]);

        controller
            .install_prepared(
                DeckId::A,
                11,
                SourceKind::Decoded,
                Arc::as_ptr(&second) as usize,
                1,
            )
            .unwrap();
        renderer.render_prepared(&mut output, 48_000, 2);
        assert_eq!(output, [0.75, -0.75]);
        assert_eq!(retired.pop(), Ok(10));
    }
}
