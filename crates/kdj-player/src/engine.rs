use std::fmt;
use std::sync::Arc;

use kdj_stems::record_stem_output_underrun_for_deck;
use rtrb::{Consumer, Producer, RingBuffer};

use crate::command::{EngineCommand, SourceKind};
use crate::dsp::{DeckEq, TransitionFx};
use crate::state::{SharedState, SharedTransportState};
use crate::stream::{FrameLerp, StemFrame, STEM_GAIN_MAX, STEM_LANES};
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

/// Callback-local recovery state for one streaming Deck. The decoder's long raw read-ahead and
/// worker-owned Rubber Band R3 stage have already produced hardware-rate, pitch-preserved PCM; the
/// callback pops exactly one output frame and never performs tempo interpolation itself.
#[derive(Clone, Copy, Debug, Default)]
struct StreamPlaybackState {
    rebuffering: bool,
    /// Output frames whose clock already advanced while this ring was empty.
    /// Recovered PCM that arrives late is discarded so the playhead and audio
    /// stay on the same wall clock instead of freezing the waveform.
    missed_frames: u64,
    /// Source frames represented by the most recently consumed post-stretch PCM frame. This is
    /// carried with the rendered packet so queued old-rate audio cannot move the clock at a new
    /// target rate before it is actually heard.
    media_advance: f64,
}

const SCRATCH_TAPE_FRAMES: usize = 96_000;
const SCRATCH_IDLE_SECONDS: f64 = 0.04;
const SCRATCH_VELOCITY_DEADZONE: f64 = 0.02;
const SCRATCH_VELOCITY_MAX: f64 = 8.0;

/// Recent stereo PCM for vinyl-style reverse/forward while a platter is held.
/// Indexed by absolute output-rate media frames so a reverse tick can replay history
/// without rebuilding the streaming decoder.
struct ScratchTape {
    samples: Box<[[f32; 2]]>,
    /// Next absolute media frame that will be written.
    end: u64,
    filled: u64,
}

impl ScratchTape {
    fn new() -> Self {
        Self {
            samples: vec![[0.0; 2]; SCRATCH_TAPE_FRAMES].into_boxed_slice(),
            end: 0,
            filled: 0,
        }
    }

    fn reset(&mut self) {
        self.end = 0;
        self.filled = 0;
    }

    fn start(&self) -> u64 {
        self.end.saturating_sub(self.filled)
    }

    fn push_at(&mut self, frame: u64, sample: [f32; 2]) {
        let len = self.samples.len() as u64;
        if self.filled == 0 {
            self.samples[(frame % len) as usize] = sample;
            self.end = frame.saturating_add(1);
            self.filled = 1;
            return;
        }
        if frame > self.end.saturating_add(32) || frame < self.start() {
            self.reset();
            self.samples[(frame % len) as usize] = sample;
            self.end = frame.saturating_add(1);
            self.filled = 1;
            return;
        }
        self.samples[(frame % len) as usize] = sample;
        if frame >= self.end {
            self.filled = self.filled.saturating_add(frame - self.end + 1).min(len);
            self.end = frame.saturating_add(1);
        }
    }

    fn get(&self, position: f64) -> [f32; 2] {
        if !position.is_finite() || self.filled == 0 {
            return [0.0; 2];
        }
        let start = self.start() as f64;
        let end = self.end as f64;
        if position < start || position >= end {
            return [0.0; 2];
        }
        let len = self.samples.len() as u64;
        let index = position.floor() as u64;
        let fraction = (position - index as f64) as f32;
        let current = self.samples[(index % len) as usize];
        let next_index = index.saturating_add(1);
        if next_index >= self.end {
            return current;
        }
        let next = self.samples[(next_index % len) as usize];
        [
            current[0] + (next[0] - current[0]) * fraction,
            current[1] + (next[1] - current[1]) * fraction,
        ]
    }
}

/// Per-lane STEM gains with a short ramp toward the target, killing zipper noise on slider
/// drags while staying effectively instant (~5 ms) for mutes.
#[derive(Clone, Copy, Debug)]
struct StemGains {
    current: [f32; STEM_LANES],
    target: [f32; STEM_LANES],
}

impl Default for StemGains {
    fn default() -> Self {
        Self {
            current: [1.0; STEM_LANES],
            target: [1.0; STEM_LANES],
        }
    }
}

impl StemGains {
    /// Mixes one raw STEM frame to stereo, then advances the gain ramp by one output frame.
    fn mix(&mut self, raw: StemFrame, ramp_step: f32) -> [f32; 2] {
        let mut separated = [0.0f32; 2];
        for lane in 0..STEM_LANES {
            let gain = self.current[lane];
            separated[0] += raw.lanes[lane * 2] * gain;
            separated[1] += raw.lanes[lane * 2 + 1] * gain;
            let target = self.target[lane];
            self.current[lane] = if gain < target {
                (gain + ramp_step).min(target)
            } else {
                (gain - ramp_step).max(target)
            };
        }
        let reconstruction_gain = if raw.reconstruction_gain.is_finite() {
            raw.reconstruction_gain.clamp(0.5, 2.0)
        } else {
            1.0
        };
        separated[0] *= reconstruction_gain;
        separated[1] *= reconstruction_gain;
        let blend = raw.blend.clamp(0.0, 1.0);
        [
            raw.original[0] * (1.0 - blend) + separated[0] * blend,
            raw.original[1] * (1.0 - blend) + separated[1] * blend,
        ]
    }
}

/// State owned exclusively by the platform audio callback.
pub struct AudioRenderer {
    consumer: Consumer<EngineCommand>,
    retired: Option<Producer<u64>>,
    deck_sources: [InstalledSource; 2],
    replacement_sources: [InstalledSource; 2],
    replacement_positions: [f64; 2],
    replacement_stream_playback: [StreamPlaybackState; 2],
    replacement_remaining: [u32; 2],
    replacement_total: [u32; 2],
    shared: SharedTransportState,
    mode: PlayerMode,
    playing: bool,
    deck_playing: [bool; 2],
    /// A held capacitive platter owns this Deck's media cursor. Logical Play/Pause is unchanged;
    /// audio follows platter velocity instead of the persisted TEMPO.
    deck_scratch_held: [bool; 2],
    deck_scratch_velocity: [f64; 2],
    deck_scratch_tick_frames: [f64; 2],
    deck_scratch_tick_at: [u64; 2],
    scratch_tapes: [ScratchTape; 2],
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
    stream_playback: [StreamPlaybackState; 2],
    stem_stream_playback: [StreamPlaybackState; 2],
    replacement_stem_playback: [StreamPlaybackState; 2],
    stem_gains: [StemGains; 2],
    /// Transport loop on the installed source. Cursor wraps into `[start, start + length)`.
    deck_looping: [bool; 2],
    deck_loop_start_frames: [u64; 2],
    deck_loop_frames: [u64; 2],
    output_sample_rate: u32,
    filter_resonance: f32,
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
            replacement_sources: [InstalledSource::default(); 2],
            replacement_positions: [0.0; 2],
            replacement_stream_playback: [StreamPlaybackState::default(); 2],
            replacement_remaining: [0; 2],
            replacement_total: [0; 2],
            shared,
            mode: PlayerMode::Continuous,
            playing: false,
            deck_playing: [false; 2],
            deck_scratch_held: [false; 2],
            deck_scratch_velocity: [0.0; 2],
            deck_scratch_tick_frames: [0.0; 2],
            deck_scratch_tick_at: [0; 2],
            scratch_tapes: [ScratchTape::new(), ScratchTape::new()],
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
            stream_playback: [StreamPlaybackState::default(); 2],
            stem_stream_playback: [StreamPlaybackState::default(); 2],
            replacement_stem_playback: [StreamPlaybackState::default(); 2],
            stem_gains: [StemGains::default(); 2],
            deck_looping: [false; 2],
            deck_loop_start_frames: [0; 2],
            deck_loop_frames: [0; 2],
            output_sample_rate: 48_000,
            filter_resonance: crate::DEFAULT_FILTER_RESONANCE_Q,
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
            let required = self.required_decks();
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
            let a = if required[0] && !self.deck_scratch_held[0] {
                self.deck_eq[0].process_stereo(input_a)
            } else {
                [0.0; 2]
            };
            let b = if required[1] && !self.deck_scratch_held[1] {
                self.deck_eq[1].process_stereo(input_b)
            } else {
                [0.0; 2]
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
            self.advance_frame(
                [
                    required[0] && !self.deck_scratch_held[0],
                    required[1] && !self.deck_scratch_held[1],
                ],
                true,
            );
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
        self.arm_scratch_velocity();

        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let required = self.required_decks();
            let (transition_a, transition_b) = self.transition_gains();
            let a = if required[0] {
                let raw = if self.deck_scratch_held[0] {
                    self.decoded_scratch_frame(0, deck_a)
                } else {
                    [
                        track_sample(deck_a, self.deck_positions[0], 0),
                        track_sample(deck_a, self.deck_positions[0], 1),
                    ]
                };
                self.deck_eq[0].process_stereo(raw)
            } else {
                [0.0; 2]
            };
            let b = if required[1] {
                let raw = if self.deck_scratch_held[1] {
                    self.decoded_scratch_frame(1, deck_b)
                } else {
                    [
                        track_sample(deck_b, self.deck_positions[1], 0),
                        track_sample(deck_b, self.deck_positions[1], 1),
                    ]
                };
                self.deck_eq[1].process_stereo(raw)
            } else {
                [0.0; 2]
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
            self.advance_frame(
                [
                    required[0] && !self.deck_scratch_held[0],
                    required[1] && !self.deck_scratch_held[1],
                ],
                true,
            );
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
        let replacements = self.replacement_sources;
        // SAFETY: DynamicPlayer retains the matching Arc until this renderer acknowledges the old
        // source ID. Stream consumers are touched only by this callback.
        let sources = unsafe {
            [
                installed_callback_source(installed[0]),
                installed_callback_source(installed[1]),
            ]
        };
        let replacement_sources = unsafe {
            [
                installed_callback_source(replacements[0]),
                installed_callback_source(replacements[1]),
            ]
        };
        self.source_rate_ratios = [
            callback_source_ratio(sources[0], output_sample_rate),
            callback_source_ratio(sources[1], output_sample_rate),
        ];
        self.ensure_eq_sample_rate();
        self.arm_scratch_velocity();

        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let required = self.required_decks();
            // Loop sources may be decoded slices or worker-streamed pitch-preserved rings. In
            // both cases this is the authoritative *logical* media cursor used for snapshots.
            for index in 0..2 {
                self.wrap_deck_loop(index);
            }
            let (raw_a, advance_a) = self.play_or_scratch(0, sources[0], required[0]);
            let raw_a = if self.deck_scratch_held[0] {
                raw_a
            } else {
                let raw = self.smooth_stream_edge(0, sources[0], raw_a, advance_a);
                self.mix_replacement(0, raw, advance_a, replacement_sources[0])
            };
            let (raw_b, advance_b) = self.play_or_scratch(1, sources[1], required[1]);
            let raw_b = if self.deck_scratch_held[1] {
                raw_b
            } else {
                let raw = self.smooth_stream_edge(1, sources[1], raw_b, advance_b);
                self.mix_replacement(1, raw, advance_b, replacement_sources[1])
            };
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
            self.advance_frame(
                [
                    stream_clock_should_advance(
                        self.playing && required[0],
                        self.deck_scratch_held[0],
                        advance_a,
                        stream_rebuffering(&self.stream_playback[0], &self.stem_stream_playback[0]),
                        stream_source_ended(sources[0]),
                        self.deck_looping[0],
                    ),
                    stream_clock_should_advance(
                        self.playing && required[1],
                        self.deck_scratch_held[1],
                        advance_b,
                        stream_rebuffering(&self.stream_playback[1], &self.stem_stream_playback[1]),
                        stream_source_ended(sources[1]),
                        self.deck_looping[1],
                    ),
                ],
                transition_can_advance,
            );
            self.advance_transport_ramp();
        }
        for sample in &mut output[complete_len..] {
            *sample = convert(0.0);
        }
        if self.transition.is_none() {
            if self.mode == PlayerMode::RealtimeDj {
                for index in 0..2 {
                    if self.deck_playing[index]
                        && !self.deck_scratch_held[index]
                        && callback_source_ended(
                            sources[index],
                            self.deck_positions[index],
                            self.deck_looping[index],
                        )
                    {
                        self.deck_playing[index] = false;
                    }
                }
                self.playing = self.deck_playing.into_iter().any(|playing| playing);
                if !self.playing {
                    self.transport_gain = 0.0;
                }
            } else if callback_source_ended(
                sources[self.active_deck as usize],
                self.deck_positions[self.active_deck as usize],
                self.deck_looping[self.active_deck as usize],
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
        if !matches!(
            source,
            Some(CallbackSource::Stream(_)) | Some(CallbackSource::StemStream(_))
        ) {
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

    fn mix_replacement(
        &mut self,
        index: usize,
        incoming: [f32; 2],
        incoming_advanced: bool,
        outgoing_source: Option<CallbackSource>,
    ) -> [f32; 2] {
        if self.replacement_remaining[index] == 0 {
            return incoming;
        }
        let (outgoing, outgoing_advanced) = match outgoing_source {
            Some(CallbackSource::Decoded(track))
                if self.replacement_positions[index] < track.frames() as f64 =>
            {
                (
                    [
                        track_sample(track, self.replacement_positions[index], 0),
                        track_sample(track, self.replacement_positions[index], 1),
                    ],
                    true,
                )
            }
            Some(CallbackSource::Stream(stream)) => stream_output_frame(
                &mut self.replacement_stream_playback[index],
                stream,
                self.output_sample_rate,
                self.deck_looping[index],
                StreamRecoverPolicy::PacketCushion,
            ),
            Some(CallbackSource::StemStream(stream)) => {
                let (raw, advanced) = stream_output_frame(
                    &mut self.replacement_stem_playback[index],
                    stream,
                    self.output_sample_rate,
                    self.deck_looping[index],
                    StreamRecoverPolicy::Immediate,
                );
                if advanced {
                    (self.mix_stem_gains(index, raw), true)
                } else {
                    ([0.0; 2], false)
                }
            }
            _ => ([0.0; 2], false),
        };
        if outgoing_advanced {
            let advance = match outgoing_source {
                Some(CallbackSource::Stream(_))
                    if self.replacement_stream_playback[index].media_advance > 0.0 =>
                {
                    self.replacement_stream_playback[index].media_advance
                }
                Some(CallbackSource::StemStream(_))
                    if self.replacement_stem_playback[index].media_advance > 0.0 =>
                {
                    self.replacement_stem_playback[index].media_advance
                }
                _ => {
                    self.deck_rates[index]
                        * callback_source_ratio(outgoing_source, self.output_sample_rate)
                }
            };
            self.replacement_positions[index] += advance;
        }
        // The incoming worker normally has a 500ms cushion. If it nevertheless starves, keep the
        // outgoing source at full level and postpone the handoff rather than fading into a gap.
        if !incoming_advanced && outgoing_advanced {
            return outgoing;
        }
        let total = self.replacement_total[index].max(1);
        let elapsed = total
            .saturating_sub(self.replacement_remaining[index])
            .saturating_add(1);
        let progress = elapsed as f32 / total as f32;
        let mixed = if outgoing_advanced {
            [
                outgoing[0] * (1.0 - progress) + incoming[0] * progress,
                outgoing[1] * (1.0 - progress) + incoming[1] * progress,
            ]
        } else {
            incoming
        };
        self.replacement_remaining[index] -= 1;
        if self.replacement_remaining[index] == 0 {
            let retired = std::mem::take(&mut self.replacement_sources[index]);
            self.replacement_stream_playback[index] = StreamPlaybackState::default();
            self.retire(retired);
        }
        mixed
    }

    fn arm_scratch_velocity(&mut self) {
        let sample_rate = f64::from(self.output_sample_rate.max(1));
        let min_elapsed = sample_rate * 0.005;
        let max_elapsed = sample_rate * 0.08;
        for index in 0..2 {
            if !self.deck_scratch_held[index] {
                self.deck_scratch_tick_frames[index] = 0.0;
                self.deck_scratch_velocity[index] = 0.0;
                continue;
            }
            let pending = self.deck_scratch_tick_frames[index];
            if pending.abs() > 0.0 {
                let elapsed = (self
                    .output_frames
                    .saturating_sub(self.deck_scratch_tick_at[index])
                    as f64)
                    .clamp(min_elapsed, max_elapsed);
                self.deck_scratch_velocity[index] =
                    (pending / elapsed).clamp(-SCRATCH_VELOCITY_MAX, SCRATCH_VELOCITY_MAX);
                self.deck_scratch_tick_frames[index] = 0.0;
                self.deck_scratch_tick_at[index] = self.output_frames;
            } else {
                let idle = self
                    .output_frames
                    .saturating_sub(self.deck_scratch_tick_at[index])
                    as f64
                    / sample_rate;
                if idle > SCRATCH_IDLE_SECONDS {
                    self.deck_scratch_velocity[index] = 0.0;
                }
            }
        }
    }

    fn play_or_scratch(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
        required: bool,
    ) -> ([f32; 2], bool) {
        if !self.playing || !required {
            return ([0.0; 2], false);
        }
        if self.deck_scratch_held[index] {
            return self.scratch_output_frame(index, source);
        }
        let (raw, advanced) = self.callback_source_frame(index, source);
        if advanced {
            let frame = self.deck_positions[index].floor().max(0.0) as u64;
            self.scratch_tapes[index].push_at(frame, raw);
        }
        (raw, advanced)
    }

    fn scratch_output_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> ([f32; 2], bool) {
        let velocity = self.deck_scratch_velocity[index];
        if velocity.abs() < SCRATCH_VELOCITY_DEADZONE {
            return ([0.0; 2], false);
        }
        let next =
            (self.deck_positions[index] + velocity * self.source_rate_ratios[index]).max(0.0);
        let sample = self.scratch_sample(index, source, next);
        self.deck_positions[index] = next;
        self.wrap_deck_loop(index);
        (sample, false)
    }

    fn scratch_sample(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
        position: f64,
    ) -> [f32; 2] {
        match source {
            Some(CallbackSource::Decoded(track)) => [
                track_sample(track, position, 0),
                track_sample(track, position, 1),
            ],
            Some(CallbackSource::Stream(_) | CallbackSource::StemStream(_)) => {
                self.fill_scratch_tape(index, source, position);
                self.scratch_tapes[index].get(position)
            }
            None => [0.0; 2],
        }
    }

    fn fill_scratch_tape(&mut self, index: usize, source: Option<CallbackSource>, position: f64) {
        if !position.is_finite() || position < 0.0 {
            return;
        }
        let needed = position.floor() as u64;
        for _ in 0..16 {
            if self.scratch_tapes[index].end > needed && self.scratch_tapes[index].filled > 0 {
                return;
            }
            let write_at = if self.scratch_tapes[index].filled == 0 {
                self.deck_positions[index].floor().max(0.0) as u64
            } else {
                self.scratch_tapes[index].end
            };
            if write_at > needed {
                return;
            }
            let (raw, advanced) = self.callback_source_frame(index, source);
            if !advanced {
                return;
            }
            self.scratch_tapes[index].push_at(write_at, raw);
        }
    }

    fn decoded_scratch_frame(&mut self, index: usize, track: &DecodedTrack) -> [f32; 2] {
        let velocity = self.deck_scratch_velocity[index];
        if velocity.abs() < SCRATCH_VELOCITY_DEADZONE {
            return [0.0; 2];
        }
        let next =
            (self.deck_positions[index] + velocity * self.source_rate_ratios[index]).max(0.0);
        let sample = [track_sample(track, next, 0), track_sample(track, next, 1)];
        self.deck_positions[index] = next;
        self.wrap_deck_loop(index);
        sample
    }

    fn callback_source_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> ([f32; 2], bool) {
        match source {
            Some(CallbackSource::Decoded(track))
                if self.deck_positions[index] < track.frames() as f64 =>
            {
                (
                    [
                        track_sample(track, self.deck_positions[index], 0),
                        track_sample(track, self.deck_positions[index], 1),
                    ],
                    true,
                )
            }
            Some(CallbackSource::Stream(stream)) => stream_output_frame(
                &mut self.stream_playback[index],
                stream,
                self.output_sample_rate,
                self.deck_looping[index],
                StreamRecoverPolicy::PacketCushion,
            ),
            Some(CallbackSource::StemStream(stream)) => {
                let was_rebuffering = self.stem_stream_playback[index].rebuffering;
                let (raw, advanced) = stream_output_frame(
                    &mut self.stem_stream_playback[index],
                    stream,
                    self.output_sample_rate,
                    self.deck_looping[index],
                    StreamRecoverPolicy::PacketCushion,
                );
                if !advanced {
                    if !was_rebuffering && !stream.ended() {
                        record_stem_output_underrun_for_deck(index);
                    }
                    return ([0.0; 2], false);
                }
                (self.mix_stem_gains(index, raw), true)
            }
            _ => ([0.0; 2], false),
        }
    }

    /// Applies per-lane STEM gains with a ~5 ms ramp: mutes land at the next callback frame and
    /// slider drags stay zipper-free, all without touching a decode worker.
    fn mix_stem_gains(&mut self, index: usize, raw: StemFrame) -> [f32; 2] {
        let ramp_frames = (f64::from(self.output_sample_rate) * 0.005).max(1.0) as f32;
        self.stem_gains[index].mix(raw, 1.0 / ramp_frames)
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
        let was_playing = self.deck_playing[index]
            || self.mode == PlayerMode::Continuous && self.active_deck == deck && self.playing;
        let superseded_replacement = std::mem::take(&mut self.replacement_sources[index]);
        self.retire(superseded_replacement);
        let previous = std::mem::replace(
            &mut self.deck_sources[index],
            InstalledSource {
                id: source_id,
                kind: source_kind,
                address,
            },
        );
        if previous.id != 0 && was_playing {
            self.replacement_sources[index] = previous;
            self.replacement_positions[index] = self.deck_positions[index];
            self.replacement_stream_playback[index] = self.stream_playback[index];
            self.replacement_stem_playback[index] = self.stem_stream_playback[index];
            let fade_frames = if matches!(previous.kind, SourceKind::Stream)
                && matches!(source_kind, SourceKind::StemStream)
            {
                // Raw→STEM is a timbre change, not a same-source seek. 20ms is still below
                // transport latency and avoids the 5ms tick that read as a stutter.
                (self.output_sample_rate / 50).max(1)
            } else {
                (self.output_sample_rate / 200).max(1)
            };
            self.replacement_remaining[index] = fade_frames;
            self.replacement_total[index] = fade_frames;
        } else {
            self.replacement_remaining[index] = 0;
            self.replacement_total[index] = 0;
            self.retire(previous);
        }
        self.deck_positions[index] = start_frame as f64;
        self.deck_scratch_velocity[index] = 0.0;
        self.deck_scratch_tick_frames[index] = 0.0;
        self.scratch_tapes[index].reset();
        self.deck_looping[index] = false;
        self.deck_loop_start_frames[index] = 0;
        self.deck_loop_frames[index] = 0;
        // STEM EQ can be set while the live inference worker is filling its first buffer. That
        // target is already resident in the callback; do not reset it when this first STEM
        // source is installed, or a one-shot vocal mute is lost until the user moves the knob
        // again. Non-STEM sources retain the historical reset boundary.
        if !matches!(source_kind, SourceKind::StemStream) {
            self.stem_gains[index] = StemGains::default();
        }
        if !was_playing {
            self.deck_rates[index] = 1.0;
            self.deck_eq[index].reset();
        }
        self.deck_playing[index] = was_playing;
        self.stream_edge_gains[index] = if self.replacement_remaining[index] > 0 {
            1.0
        } else if matches!(source_kind, SourceKind::Stream | SourceKind::StemStream) {
            0.0
        } else {
            1.0
        };
        self.stream_last_frames[index] = [0.0; 2];
        self.stream_playback[index] = StreamPlaybackState::default();
        self.stem_stream_playback[index] = StreamPlaybackState::default();
    }

    fn clear_prepared(&mut self, deck: DeckId) {
        let index = deck as usize;
        let previous = std::mem::take(&mut self.deck_sources[index]);
        let replacement = std::mem::take(&mut self.replacement_sources[index]);
        self.deck_positions[index] = 0.0;
        self.deck_playing[index] = false;
        self.deck_scratch_held[index] = false;
        self.deck_scratch_velocity[index] = 0.0;
        self.deck_scratch_tick_frames[index] = 0.0;
        self.scratch_tapes[index].reset();
        self.deck_looping[index] = false;
        self.deck_loop_start_frames[index] = 0;
        self.deck_loop_frames[index] = 0;
        self.stream_edge_gains[index] = 0.0;
        self.stream_last_frames[index] = [0.0; 2];
        self.stream_playback[index] = StreamPlaybackState::default();
        self.stem_stream_playback[index] = StreamPlaybackState::default();
        self.replacement_stream_playback[index] = StreamPlaybackState::default();
        self.replacement_stem_playback[index] = StreamPlaybackState::default();
        self.replacement_remaining[index] = 0;
        self.replacement_total[index] = 0;
        if deck == self.active_deck && self.mode == PlayerMode::Continuous {
            self.stop_transport();
            self.transition = None;
        }
        self.playing = self.deck_playing.into_iter().any(|playing| playing);
        self.retire(previous);
        self.retire(replacement);
    }

    fn apply(&mut self, command: RtCommand) {
        match command {
            RtCommand::SetMode(mode) => {
                self.mode = mode;
                if mode == PlayerMode::Continuous {
                    self.deck_playing = [false; 2];
                    self.deck_playing[self.active_deck as usize] = self.playing;
                }
            }
            RtCommand::SetPlaying {
                playing,
                fade_frames,
            } => self.set_transport_playing(playing, fade_frames),
            RtCommand::SetMasterGain(gain) => self.master_gain = normalized_gain(gain),
            RtCommand::SetDeckGain { deck, gain } => {
                self.deck_gains[deck as usize] = normalized_gain(gain);
            }
            RtCommand::SetDeckPlaying { deck, playing } => {
                self.mode = PlayerMode::RealtimeDj;
                self.deck_playing[deck as usize] = playing;
                if !playing {
                    self.deck_scratch_held[deck as usize] = false;
                }
                if playing {
                    self.active_deck = deck;
                    self.transport_gain = 1.0;
                    self.transport_ramp = None;
                }
                self.playing = self.deck_playing.into_iter().any(|value| value);
                if !self.playing {
                    self.transport_gain = 0.0;
                }
            }
            RtCommand::SetDeckScratchHeld { deck, held } => {
                let index = deck as usize;
                self.mode = PlayerMode::RealtimeDj;
                self.deck_scratch_held[index] = held;
                self.deck_scratch_velocity[index] = 0.0;
                self.deck_scratch_tick_frames[index] = 0.0;
                self.deck_scratch_tick_at[index] = self.output_frames;
                // Re-ramp stream audio after release rather than jumping from the held sample to
                // a later buffered frame.
                if held {
                    self.stream_edge_gains[index] = 0.0;
                }
            }
            RtCommand::ScratchDeck { deck, delta_frames } => {
                let index = deck as usize;
                if self.deck_scratch_held[index] && delta_frames.is_finite() && delta_frames != 0.0
                {
                    self.mode = PlayerMode::RealtimeDj;
                    self.deck_scratch_tick_frames[index] += delta_frames;
                }
            }
            RtCommand::SetRate { deck, rate } => {
                if rate.is_finite() && rate > 0.0 {
                    self.deck_rates[deck as usize] = f64::from(rate);
                }
            }
            RtCommand::SetDeckStemGains { deck, gains } => {
                let state = &mut self.stem_gains[deck as usize];
                for lane in 0..STEM_LANES {
                    state.target[lane] = if gains[lane].is_finite() {
                        gains[lane].clamp(0.0, STEM_GAIN_MAX)
                    } else {
                        0.0
                    };
                }
            }
            RtCommand::SetDeckLoop {
                deck,
                looping,
                start_frames,
                frames,
            } => {
                let index = deck as usize;
                self.deck_looping[index] = looping && frames > 0;
                self.deck_loop_start_frames[index] = if looping { start_frames } else { 0 };
                self.deck_loop_frames[index] = if looping { frames } else { 0 };
                self.wrap_deck_loop(index);
            }
            RtCommand::SetFilterResonance { q } => {
                self.filter_resonance = normalize_filter_resonance(q);
                for deck in &mut self.deck_eq {
                    deck.set_filter_resonance(self.filter_resonance);
                }
            }
            RtCommand::SetEq {
                deck,
                trim_db,
                low_db,
                mid_db,
                high_db,
                filter,
            } => self.deck_eq[deck as usize].configure(
                self.output_sample_rate,
                trim_db,
                low_db,
                mid_db,
                high_db,
                filter,
                self.filter_resonance,
            ),
            RtCommand::SeekPrepared { deck, frame } => {
                let index = deck as usize;
                self.deck_positions[index] = frame as f64;
                self.deck_eq[index].reset();
                self.scratch_tapes[index].reset();
                self.stream_playback[index] = StreamPlaybackState::default();
                self.stem_stream_playback[index] = StreamPlaybackState::default();
                self.stream_edge_gains[index] = 0.0;
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
                    self.deck_playing = [false; 2];
                    self.deck_playing[to as usize] = self.playing;
                } else {
                    self.deck_playing[self.active_deck as usize] = true;
                    self.deck_playing[to as usize] = true;
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
            self.deck_playing = [false; 2];
            self.deck_playing[self.active_deck as usize] = playing;
            return;
        }

        if playing {
            self.playing = true;
            self.deck_playing[self.active_deck as usize] = true;
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
                self.deck_playing = [false; 2];
            }
            return;
        }
        self.transport_gain = (self.transport_gain + ramp.step).clamp(0.0, 1.0);
        ramp.remaining_frames -= 1;
        self.transport_ramp = Some(ramp);
    }

    fn stop_transport(&mut self) {
        self.playing = false;
        self.deck_playing = [false; 2];
        self.transport_gain = 0.0;
        self.transport_ramp = None;
    }

    fn wrap_deck_loop(&mut self, index: usize) {
        if !self.deck_looping[index] || self.deck_loop_frames[index] == 0 {
            return;
        }
        let start = self.deck_loop_start_frames[index] as f64;
        let length = self.deck_loop_frames[index] as f64;
        let position = self.deck_positions[index];
        if position >= start + length {
            self.deck_positions[index] = start + (position - start) % length;
        }
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
        } else if self.mode == PlayerMode::RealtimeDj {
            self.deck_playing
        } else {
            match self.active_deck {
                DeckId::A => [true, false],
                DeckId::B => [false, true],
            }
        }
    }

    fn transition_gains(&self) -> (f32, f32) {
        let Some(transition) = self.transition else {
            if self.mode == PlayerMode::RealtimeDj {
                return (1.0, 1.0);
            }
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
                    self.deck_positions[index] += self.deck_media_advance(index);
                    self.wrap_deck_loop(index);
                }
            }
        }

        if self.playing && transition_can_advance {
            if let Some(mut transition) = self.transition {
                transition.elapsed_frames += 1;
                if transition.elapsed_frames >= transition.total_frames {
                    self.active_deck = transition.to;
                    self.deck_playing[transition.from as usize] = false;
                    self.deck_playing[transition.to as usize] = true;
                    self.transition = None;
                } else {
                    self.transition = Some(transition);
                }
            }
        }
    }

    fn deck_media_advance(&self, index: usize) -> f64 {
        match self.deck_sources[index].kind {
            SourceKind::Stream if self.stream_playback[index].media_advance > 0.0 => {
                self.stream_playback[index].media_advance
            }
            SourceKind::StemStream if self.stem_stream_playback[index].media_advance > 0.0 => {
                self.stem_stream_playback[index].media_advance
            }
            _ => self.deck_rates[index] * self.source_rate_ratios[index],
        }
    }

    fn publish(&self) {
        self.shared.publish(
            self.mode,
            self.playing,
            self.deck_playing,
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
    StemStream(&'static StreamSource<StemFrame>),
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
        SourceKind::StemStream => {
            // SAFETY: upheld by DynamicPlayer's source registry and retirement protocol.
            Some(CallbackSource::StemStream(unsafe {
                &*(source.address as *const StreamSource<StemFrame>)
            }))
        }
    }
}

fn callback_source_ratio(source: Option<CallbackSource>, output_sample_rate: u32) -> f64 {
    match source {
        Some(CallbackSource::Decoded(track)) => {
            f64::from(track.sample_rate()) / f64::from(output_sample_rate)
        }
        Some(CallbackSource::Stream(_)) | Some(CallbackSource::StemStream(_)) | None => 1.0,
    }
}

fn stream_clock_should_advance(
    deck_playing: bool,
    scratch_held: bool,
    pcm_advanced: bool,
    rebuffering: bool,
    stream_ended: bool,
    looping: bool,
) -> bool {
    if !deck_playing || scratch_held {
        return false;
    }
    // Loop engage can empty the post-Rubber-Band ring for a moment. Keep the playhead frozen so the
    // waveform does not spin around the window, then resume from the same beat when audio returns.
    if looping && rebuffering && !pcm_advanced {
        return false;
    }
    pcm_advanced || (rebuffering && !stream_ended)
}

fn stream_rebuffering(stereo: &StreamPlaybackState, stems: &StreamPlaybackState) -> bool {
    stereo.rebuffering || stems.rebuffering
}

fn stream_source_ended(source: Option<CallbackSource>) -> bool {
    match source {
        Some(CallbackSource::Stream(stream)) => stream.ended(),
        Some(CallbackSource::StemStream(stream)) => stream.ended(),
        _ => true,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StreamRecoverPolicy {
    PacketCushion,
    Immediate,
}

fn stream_output_frame<F: FrameLerp>(
    state: &mut StreamPlaybackState,
    stream: &StreamSource<F>,
    output_sample_rate: u32,
    looping: bool,
    policy: StreamRecoverPolicy,
) -> (F, bool) {
    state.media_advance = 0.0;
    if policy == StreamRecoverPolicy::Immediate {
        let Some((frame, media_advance)) = stream.pop_callback_timed() else {
            state.rebuffering = !stream.ended();
            if state.rebuffering {
                state.missed_frames = state.missed_frames.saturating_add(1);
            }
            return (F::silence(), false);
        };
        state.rebuffering = false;
        state.missed_frames = 0;
        state.media_advance = f64::from(media_advance);
        return (frame, true);
    }
    // Once a worker misses the realtime reader, wait for a useful cushion instead of repeatedly
    // accepting one or two new frames. The latter produces a fade-in/fade-out pulse train heard as
    // a low buzz. Thirty milliseconds is inaudible as added recovery latency but spans multiple
    // decoder packets and CoreAudio callbacks.
    let rebuffer_frames = u64::from(output_sample_rate.max(1)) * 30 / 1_000;
    if state.rebuffering {
        if stream.buffered_frames() < rebuffer_frames && !stream.ended() {
            state.missed_frames = state.missed_frames.saturating_add(1);
            return (F::silence(), false);
        }
        // Catch-up discards keep a jitter gap aligned with wall-clock time. A loop refill is
        // already at loop-in; dropping those frames would skip the first cycle or jump to 0.
        if !looping && state.missed_frames > 0 && !stream.ended() {
            let spare = stream.buffered_frames().saturating_sub(rebuffer_frames);
            let dropped = stream.discard_frames(state.missed_frames.min(spare));
            state.missed_frames = state.missed_frames.saturating_sub(dropped);
        }
        state.rebuffering = false;
        state.missed_frames = 0;
    }

    // Preserve one queued frame while a live decoder is still open. If we consume that last
    // sample and then starve, the edge envelope jumps back up between fade samples and makes a
    // low buzz. A finite source still drains its real final frame normally.
    if stream.buffered_frames() <= 1 && !stream.ended() {
        state.rebuffering = true;
        state.missed_frames = state.missed_frames.saturating_add(1);
        return (F::silence(), false);
    }

    let Some((frame, media_advance)) = stream.pop_callback_timed() else {
        state.rebuffering = !stream.ended();
        if state.rebuffering {
            state.missed_frames = state.missed_frames.saturating_add(1);
        }
        return (F::silence(), false);
    };
    state.media_advance = f64::from(media_advance);
    (frame, true)
}

fn callback_source_ended(source: Option<CallbackSource>, position: f64, looping: bool) -> bool {
    match source {
        Some(CallbackSource::Decoded(track)) => !looping && position >= track.frames() as f64,
        Some(CallbackSource::Stream(stream)) => !looping && stream.drained(),
        Some(CallbackSource::StemStream(stream)) => !looping && stream.drained(),
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

fn normalize_filter_resonance(q: f32) -> f32 {
    if q.is_finite() {
        q.clamp(
            crate::FILTER_RESONANCE_LOW_Q,
            crate::FILTER_RESONANCE_HIGH_Q,
        )
    } else {
        crate::DEFAULT_FILTER_RESONANCE_Q
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
    fn stream_underrun_keeps_the_playhead_moving_until_the_source_ends() {
        assert!(stream_clock_should_advance(
            true, false, false, true, false, false
        ));
        assert!(
            !stream_clock_should_advance(true, true, false, true, false, false),
            "a held platter still owns the frozen cursor"
        );
        assert!(
            !stream_clock_should_advance(false, false, false, true, false, false),
            "a paused Deck must not walk its clock through silence"
        );
        assert!(
            !stream_clock_should_advance(true, false, false, true, true, false),
            "ended streams drain instead of inventing time past EOF"
        );
        assert!(
            !stream_clock_should_advance(true, false, false, true, false, true),
            "a looping Deck must freeze through a loop-engage underrun"
        );
        assert!(stream_clock_should_advance(
            true, false, true, false, false, false
        ));
    }

    #[test]
    fn capacitive_scratch_holds_audio_without_changing_play_intent() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        let mut running = [0.0; 4];
        renderer.render(&[1.0; 4], &[], &mut running, 1);
        assert_eq!(running, [1.0; 4]);
        assert_eq!(controller.snapshot().deck_frames, [4, 0]);

        controller
            .send(RtCommand::SetDeckScratchHeld {
                deck: DeckId::A,
                held: true,
            })
            .unwrap();
        let mut held = [9.0; 4];
        renderer.render(&[1.0; 4], &[], &mut held, 1);
        assert_eq!(held, [0.0; 4]);
        let snapshot = controller.snapshot();
        assert!(snapshot.playing);
        assert!(snapshot.deck_playing[DeckId::A as usize]);
        assert_eq!(
            snapshot.deck_frames,
            [4, 0],
            "the platter owns the frozen cursor"
        );

        controller
            .send(RtCommand::SetDeckScratchHeld {
                deck: DeckId::A,
                held: false,
            })
            .unwrap();
        let mut released = [0.0; 4];
        renderer.render(&[1.0; 4], &[], &mut released, 1);
        assert_eq!(released, [1.0; 4]);
        assert_eq!(controller.snapshot().deck_frames, [8, 0]);
        assert!(controller.snapshot().deck_playing[DeckId::A as usize]);
    }

    #[test]
    fn capacitive_scratch_ticks_are_audible_and_move_the_needle() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        let mut running = [0.0; 4];
        renderer.render_tracks(&track, &silent, &mut running, 48_000, 2);
        assert!(running.iter().any(|sample| sample.abs() > 0.0));
        let frozen = controller.snapshot().deck_frames[0];

        controller
            .send(RtCommand::SetDeckScratchHeld {
                deck: DeckId::A,
                held: true,
            })
            .unwrap();
        let mut held = [9.0; 4];
        renderer.render_tracks(&track, &silent, &mut held, 48_000, 2);
        assert_eq!(held, [0.0; 4]);
        assert_eq!(controller.snapshot().deck_frames[0], frozen);

        controller
            .send(RtCommand::ScratchDeck {
                deck: DeckId::A,
                delta_frames: 240.0,
            })
            .unwrap();
        let mut scratched = [0.0; 96];
        renderer.render_tracks(&track, &silent, &mut scratched, 48_000, 2);
        assert!(
            scratched.iter().any(|sample| sample.abs() > 0.0),
            "a held platter must speak as soon as it moves"
        );
        assert_ne!(
            controller.snapshot().deck_frames[0],
            frozen,
            "the needle must follow platter motion instead of waiting for note-off"
        );
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
    fn realtime_mode_runs_and_mixes_two_decks_independently() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::B,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::A,
                gain: 0.5,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::B,
                gain: 0.25,
            })
            .unwrap();

        let mut output = [0.0; 4];
        renderer.render(&[1.0; 4], &[1.0; 4], &mut output, 1);
        assert_eq!(output, [0.75; 4]);
        let running = controller.snapshot();
        assert_eq!(running.deck_playing, [true, true]);
        assert_eq!(running.deck_frames, [4, 4]);

        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: false,
            })
            .unwrap();
        renderer.render(&[1.0; 2], &[1.0; 2], &mut output[..2], 1);
        assert_eq!(&output[..2], &[0.25; 2]);
        let one_running = controller.snapshot();
        assert_eq!(one_running.deck_playing, [false, true]);
        assert_eq!(one_running.deck_frames, [4, 6]);
    }

    #[test]
    fn deck_eq_command_changes_realtime_output_before_the_next_frame() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetEq {
                deck: DeckId::A,
                trim_db: -24.0,
                low_db: 0.0,
                mid_db: 0.0,
                high_db: 0.0,
                filter: 0.0,
            })
            .unwrap();

        let mut output = [0.0; 32];
        renderer.render(&[0.5; 32], &[], &mut output, 1);
        let expected = 0.5 * 10.0f32.powf(-24.0 / 20.0);
        assert!(output
            .iter()
            .all(|sample| (*sample - expected).abs() < 0.000_01));
    }

    #[test]
    fn crossfader_endpoint_gains_isolate_the_requested_deck() {
        let (mut controller, mut renderer) = command_channel(16);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::B,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::A,
                gain: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::B,
                gain: 1.0,
            })
            .unwrap();

        let mut output = [0.0; 2];
        renderer.render(&[0.25; 2], &[0.75; 2], &mut output, 1);
        assert_eq!(output, [0.75; 2], "B 端必须完全隔离 Deck A");

        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::A,
                gain: 1.0,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckGain {
                deck: DeckId::B,
                gain: 0.0,
            })
            .unwrap();
        renderer.render(&[0.25; 2], &[0.75; 2], &mut output, 1);
        assert_eq!(output, [0.25; 2], "A 端必须完全隔离 Deck B");
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
    fn muted_master_silences_a_newly_playing_second_deck() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller.send(RtCommand::SetMasterGain(0.0)).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::B,
                playing: true,
            })
            .unwrap();

        let mut output = [1.0; 4];
        renderer.render(&[0.8; 4], &[1.0; 4], &mut output, 1);

        assert_eq!(output, [0.0; 4], "MASTER=0 必须静音两台 Deck 的首帧");
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
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(4_096);
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

        let mut primed = [0.0; 238];
        renderer.render_prepared(&mut primed, 48_000, 1);
        assert!(
            primed[237] > 0.99,
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
            241,
            "starvation keeps the wall clock moving so the waveform does not freeze"
        );

        // A decoder that trickles back one frame must not repeatedly wake the Deck and create a
        // fade pulse on every callback. Recovery waits for the 30ms cushion.
        writer.push([1.0, 1.0], || false).unwrap();
        let mut trickle = [0.0; 300];
        renderer.render_prepared(&mut trickle, 48_000, 1);
        assert!(trickle[260..].iter().all(|sample| sample.abs() < 0.000_1));
        assert_eq!(
            controller.snapshot().deck_frames[0],
            541,
            "waiting for the recovery cushion must not freeze the published playhead"
        );
        drop(writer);
    }

    #[test]
    fn streaming_target_rate_does_not_relabel_already_rendered_pcm() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        for _ in 0..12_000 {
            writer.push([0.5, 0.5], || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                77,
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

        let mut normal = [0.0; 512];
        renderer.render_prepared(&mut normal, 48_000, 1);
        assert!(normal[300..].iter().all(|sample| *sample > 0.49));
        let consumed_before = stream.consumed_frames();

        controller
            .send(RtCommand::SetRate {
                deck: DeckId::A,
                rate: 1.5,
            })
            .unwrap();
        let mut faster = [0.0; 512];
        renderer.render_prepared(&mut faster, 48_000, 1);

        assert!(faster
            .iter()
            .all(|sample| sample.is_finite() && *sample > 0.49));
        assert_eq!(controller.snapshot().deck_source_ids[0], 77);
        assert!(
            (stream.consumed_frames() - consumed_before).abs_diff(512) <= 1,
            "post-stretch PCM must be read one hardware frame at a time; consuming 1.5x here would shift pitch"
        );
        assert!((controller.snapshot().deck_frames[0] as i64 - 1_024).abs() <= 2);
        drop(writer);
    }

    #[test]
    fn streaming_clock_uses_the_rate_carried_by_post_stretch_pcm() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        for _ in 0..12_000 {
            writer
                .push_with_media_advance([0.5, 0.5], 1.5, || false)
                .unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                78,
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

        let mut output = [0.0; 512];
        renderer.render_prepared(&mut output, 48_000, 1);

        assert!(output[300..].iter().all(|sample| *sample > 0.49));
        assert!((controller.snapshot().deck_frames[0] as i64 - 768).abs() <= 2);
        drop(writer);
    }

    #[test]
    fn dynamic_deck_install_is_ordered_and_retires_old_source() {
        let first = Arc::new(
            DecodedTrack::from_interleaved_stereo([0.25, -0.25].repeat(400), 48_000).unwrap(),
        );
        let second = Arc::new(
            DecodedTrack::from_interleaved_stereo([0.75, -0.75].repeat(400), 48_000).unwrap(),
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
        let mut crossfade = vec![0.0; 240 * 2];
        renderer.render_prepared(&mut crossfade, 48_000, 2);
        assert!(crossfade[0] > 0.25 && crossfade[0] < 0.26);
        assert!((crossfade[crossfade.len() - 2] - 0.75).abs() < 0.000_01);
        assert!((crossfade[crossfade.len() - 1] + 0.75).abs() < 0.000_01);
        assert_eq!(retired.pop(), Ok(10));
    }

    #[test]
    fn stem_gains_mix_lanes_in_the_callback_without_a_worker_swap() {
        // 四轨常量帧：drums=0.1, bass=0.2, other=0.3, vocals=0.4。
        let frame = StemFrame::separated([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_384);
        for _ in 0..12_000 {
            writer.push(frame, || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                55,
                SourceKind::StemStream,
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
        let mut output = [0.0; 512];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!(output[300..].iter().all(|sample| *sample > 0.99));

        // 只留 vocals：下一回调边界即生效，5ms 斜坡后收敛到 0.4。
        controller
            .send(RtCommand::SetDeckStemGains {
                deck: DeckId::A,
                gains: [0.0, 0.0, 0.0, 1.0],
            })
            .unwrap();
        let mut muted = [0.0; 960];
        renderer.render_prepared(&mut muted, 48_000, 1);
        assert!(
            muted[32] < 0.99,
            "mute ramps in within the first millisecond"
        );
        assert!(muted[480..]
            .iter()
            .all(|sample| (*sample - 0.4).abs() < 0.01));
        drop(writer);
    }

    #[test]
    fn stem_install_keeps_a_gain_target_set_while_the_worker_was_buffering() {
        // A first EQ gesture reaches the callback before the asynchronous STEM worker has
        // enough audio to install. Installing that stream must not put vocals back to unity.
        let frame = StemFrame::separated([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_384);
        for _ in 0..12_000 {
            writer.push(frame, || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .send(RtCommand::SetDeckStemGains {
                deck: DeckId::A,
                gains: [1.0, 1.0, 1.0, 0.0],
            })
            .unwrap();
        controller
            .install_prepared(
                DeckId::A,
                57,
                SourceKind::StemStream,
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

        let mut output = [0.0; 512];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!(output[300..]
            .iter()
            .all(|sample| (*sample - 0.6).abs() < 0.01));
        drop(writer);
    }

    #[test]
    fn full_stem_mix_uses_the_source_level_calibration() {
        // Four lanes add to 0.20. The model-side calibration represents a source mix at 0.22.
        let frame = StemFrame::separated_with_gain([0.05; 8], 1.1);
        let (stream, mut writer) = StreamSource::<StemFrame>::bounded(16_384);
        for _ in 0..12_000 {
            writer.push(frame, || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                56,
                SourceKind::StemStream,
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

        let mut output = [0.0; 512];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!(output[300..]
            .iter()
            .all(|sample| (*sample - 0.22).abs() < 0.001));
        drop(writer);
    }

    #[test]
    fn decoded_loop_wraps_its_cursor_instead_of_ending_the_deck() {
        let region =
            Arc::new(DecodedTrack::from_interleaved_stereo([0.5, 0.5].repeat(96), 48_000).unwrap());
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                66,
                SourceKind::Decoded,
                Arc::as_ptr(&region) as usize,
                0,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                looping: true,
                start_frames: 0,
                frames: 96,
            })
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        // 渲出远超 96 帧的一个块：游标必须回绕而不是报 Ended。
        let mut output = [0.0; 512];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!(output.iter().all(|sample| (*sample - 0.5).abs() < 1e-6));
        let position = controller.snapshot().deck_frames[0];
        assert!(position < 96, "loop cursor wrapped, got {position}");
        assert!(controller.snapshot().playing);
    }

    #[test]
    fn transport_loop_wraps_inside_an_absolute_window() {
        let region = Arc::new(
            DecodedTrack::from_interleaved_stereo([0.5, 0.5].repeat(480), 48_000).unwrap(),
        );
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                67,
                SourceKind::Decoded,
                Arc::as_ptr(&region) as usize,
                200,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                looping: true,
                start_frames: 96,
                frames: 48,
            })
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();
        let mut output = [0.0; 256];
        renderer.render_prepared(&mut output, 48_000, 1);
        let position = controller.snapshot().deck_frames[0];
        assert!(
            (96..144).contains(&position),
            "absolute loop window should wrap into [96, 144), got {position}"
        );
        assert!(controller.snapshot().playing);
    }
}
