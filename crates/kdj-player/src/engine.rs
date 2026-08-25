use std::fmt;
use std::sync::Arc;

use kdj_stems::record_stem_output_underrun_for_deck;
use rtrb::{Consumer, Producer, RingBuffer};

use crate::command::{EngineCommand, SourceKind};
use crate::dsp::{DeckEq, DeckSpectrum, TransitionFx};
use crate::manual_fx::DeckManualFx;
use crate::state::{OutputCallbackTiming, SharedState, SharedTransportState};
use crate::stream::{FrameLerp, StemFrame, STEM_GAIN_MAX, STEM_LANES};
use crate::{
    DeckId, DecodedTrack, PlatterPhase, PlayerMode, RtCommand, StreamSource, TransitionPlan,
    TransportSnapshot,
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
#[derive(Clone, Copy, Debug)]
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
    tempo_revision: u64,
    /// Absolute media time of the packet currently leaving the callback, in seconds.
    media_time: f64,
    loop_generation: u64,
    loop_active: bool,
    loop_wrapped: bool,
}

impl Default for StreamPlaybackState {
    fn default() -> Self {
        Self {
            rebuffering: false,
            missed_frames: 0,
            media_advance: 0.0,
            tempo_revision: 0,
            media_time: f64::NAN,
            loop_generation: 0,
            loop_active: false,
            loop_wrapped: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct TimedStereoFrame {
    frame: [f32; 2],
    media_advance: f64,
    tempo_revision: u64,
    media_time: f64,
}

/// Fractional reader over already pitch-preserved PCM. SYNC phase correction is deliberately
/// applied here: sending dozens of tiny ratio changes back through Rubber Band R3 repeatedly
/// invalidates its look-ahead and is heard as severe stutter, especially for eight-lane STEM.
#[derive(Clone, Copy, Debug, Default)]
struct DeckPhaseResampler {
    current: Option<TimedStereoFrame>,
    next: Option<TimedStereoFrame>,
    fraction: f64,
}

/// Twelve seconds covers the complete Performance detail viewport at ordinary zoom while keeping
/// the callback cache bounded (~9 MiB for two stereo Decks).
const SCRATCH_TAPE_FRAMES: usize = 576_000;
/// Input is already normalized to velocity from source timestamps. Keep the maximum at half the
/// sequential fill budget: a fast throw must accelerate, not outrun prepared PCM into zero.
const SCRATCH_VELOCITY_MAX: f64 = 8.0;
const SCRATCH_TAPE_FILL_FRAMES: usize = 16;
/// A short acceleration constant keeps the platter physical without lagging behind the hand.
const SCRATCH_RESPONSE_SECONDS: f64 = 0.010;
/// Release duration is a true settle time, not a one-pole time constant. The old 0.9 second
/// constant could take more than three seconds to reach the handoff threshold while paused.
const SCRATCH_COAST_MIN_SECONDS: f64 = 0.06;
const SCRATCH_COAST_MAX_SECONDS: f64 = 0.9;
const SCRATCH_COAST_REFERENCE_DIFFERENCE: f64 = 4.0;
/// One or two quantized controller ticks at note-off are contact jitter, not platter inertia.
const SCRATCH_CONTACT_JITTER_VELOCITY: f64 = 0.15;
const SCRATCH_HANDOFF_RATE_EPSILON: f64 = 0.08;
/// Published platter rate one-pole (~4 ms at 48 kHz) so the waveform compositor does not
/// reverse on encoder Δt jitter between packets.
const SCRATCH_AUDIBLE_RATE_SMOOTH_SECONDS: f64 = 0.004;
const SCRATCH_STATIONARY_VELOCITY: f64 = 1.0e-4;
const SCRATCH_MIN_VALID_SECONDS: f64 = 0.024;
const SCRATCH_MAX_VALID_SECONDS: f64 = 0.250;
const SCRATCH_DEFAULT_VALID_SECONDS: f64 = 0.100;
const SCRATCH_STILL_FRICTION_SECONDS: f64 = 0.04;
const SCRATCH_NO_TICK: u64 = u64::MAX;
/// Silent lead-in before source frame 0. Must match the coordinator's Performance pre-roll.
pub const PERFORMANCE_PREROLL_SECONDS: f64 = 30.0;
const SCRATCH_GAP_FRAMES: i64 = 64;

/// Bidirectional PCM cache around the needle, Mixxx CachingReader-style.
/// Indexed by integer output-rate media frames so reverse/coast can replay history and
/// append look-ahead without wiping on a non-monotonic read.
struct ScratchTape {
    samples: Box<[[f32; 2]]>,
    /// Inclusive start of the valid media-frame range.
    first_frame: i64,
    /// Exclusive end of the valid media-frame range.
    last_frame: i64,
}

impl ScratchTape {
    fn new() -> Self {
        Self {
            samples: vec![[0.0; 2]; SCRATCH_TAPE_FRAMES].into_boxed_slice(),
            first_frame: 0,
            last_frame: 0,
        }
    }

    fn reset(&mut self) {
        self.first_frame = 0;
        self.last_frame = 0;
    }

    fn is_empty(&self) -> bool {
        self.last_frame <= self.first_frame
    }

    fn slot(frame: i64) -> usize {
        let len = SCRATCH_TAPE_FRAMES as i64;
        (((frame % len) + len) % len) as usize
    }

    fn contains_frame(&self, frame: i64) -> bool {
        !self.is_empty() && frame >= self.first_frame && frame < self.last_frame
    }

    fn contains_position(&self, position: f64) -> bool {
        position.is_finite()
            && !self.is_empty()
            && position >= self.first_frame as f64
            && position <= self.last_frame as f64
    }

    fn first_position(&self) -> Option<f64> {
        (!self.is_empty()).then_some(self.first_frame as f64)
    }

    fn end_position(&self) -> Option<f64> {
        (!self.is_empty()).then_some(self.last_frame as f64)
    }

    fn write_frame(&mut self, frame: i64, sample: [f32; 2]) {
        if frame < 0 {
            return;
        }
        let capacity = SCRATCH_TAPE_FRAMES as i64;
        if self.is_empty() {
            self.samples[Self::slot(frame)] = sample;
            self.first_frame = frame;
            self.last_frame = frame + 1;
            return;
        }
        if self.contains_frame(frame) {
            self.samples[Self::slot(frame)] = sample;
            return;
        }
        if frame == self.last_frame {
            if self.last_frame - self.first_frame >= capacity {
                self.first_frame += 1;
            }
            self.samples[Self::slot(frame)] = sample;
            self.last_frame = frame + 1;
            return;
        }
        if frame + 1 == self.first_frame {
            if self.last_frame - self.first_frame >= capacity {
                self.last_frame -= 1;
            }
            self.samples[Self::slot(frame)] = sample;
            self.first_frame = frame;
            return;
        }
        if frame > self.last_frame && frame <= self.last_frame + SCRATCH_GAP_FRAMES {
            let fill = self.samples[Self::slot(self.last_frame - 1)];
            while self.last_frame < frame {
                if self.last_frame - self.first_frame >= capacity {
                    self.first_frame += 1;
                }
                self.samples[Self::slot(self.last_frame)] = fill;
                self.last_frame += 1;
            }
            self.write_frame(frame, sample);
            return;
        }
        if frame < self.first_frame && frame + SCRATCH_GAP_FRAMES >= self.first_frame {
            let fill = self.samples[Self::slot(self.first_frame)];
            while self.first_frame > frame + 1 {
                if self.last_frame - self.first_frame >= capacity {
                    self.last_frame -= 1;
                }
                self.first_frame -= 1;
                self.samples[Self::slot(self.first_frame)] = fill;
            }
            self.write_frame(frame, sample);
            return;
        }
        self.samples[Self::slot(frame)] = sample;
        self.first_frame = frame;
        self.last_frame = frame + 1;
    }

    fn push_at(&mut self, position: f64, sample: [f32; 2], _media_advance: f64) {
        if !position.is_finite() || position < 0.0 {
            return;
        }
        let frame = position.floor() as i64;
        if !self.is_empty() && frame >= self.last_frame {
            let anchor_frame = self.last_frame - 1;
            let gap = frame - anchor_frame;
            if gap > 1 && gap <= SCRATCH_GAP_FRAMES {
                let anchor = self.samples[Self::slot(anchor_frame)];
                for offset in 1..=gap {
                    let fraction = offset as f32 / gap as f32;
                    self.write_frame(
                        anchor_frame + offset,
                        [
                            anchor[0] + (sample[0] - anchor[0]) * fraction,
                            anchor[1] + (sample[1] - anchor[1]) * fraction,
                        ],
                    );
                }
                return;
            }
        }
        self.write_frame(frame, sample);
    }

    fn get(&self, position: f64) -> [f32; 2] {
        if !position.is_finite() || self.is_empty() {
            return [0.0; 2];
        }
        if position < self.first_frame as f64 || position > self.last_frame as f64 {
            return [0.0; 2];
        }
        let floor = position.floor() as i64;
        let frac = (position - floor as f64) as f32;
        let a = if self.contains_frame(floor) {
            self.samples[Self::slot(floor)]
        } else if floor == self.last_frame && self.last_frame > self.first_frame {
            self.samples[Self::slot(self.last_frame - 1)]
        } else {
            return [0.0; 2];
        };
        let next = floor + 1;
        let b = if self.contains_frame(next) {
            self.samples[Self::slot(next)]
        } else {
            a
        };
        [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
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
    deck_pfl: [bool; 2],
    /// A held capacitive platter owns this Deck's media cursor. Logical Play/Pause is unchanged;
    /// audio follows platter velocity instead of the persisted TEMPO.
    deck_scratch_held: [bool; 2],
    deck_scratch_velocity: [f64; 2],
    /// Latest normalized input observation converted to media frames per output frame.
    deck_scratch_target_velocity: [f64; 2],
    deck_scratch_releasing: [bool; 2],
    deck_scratch_release_decay: [f64; 2],
    /// A settled streaming scratch replays cached history only until it catches the source head.
    deck_scratch_playthrough: [bool; 2],
    deck_scratch_input_at: [u64; 2],
    deck_scratch_valid_frames: [u64; 2],
    /// One-pole of published platter rate so the UI needle does not reverse on tick jitter.
    deck_audible_rate_smooth: [f32; 2],
    scratch_tapes: [ScratchTape; 2],
    /// First media frame decoded by the installed stream. A freshly prepared cue has no PCM
    /// before this point; the platter may still traverse that lead-in as silence down to t < 0.
    deck_source_origin_frames: [f64; 2],
    transport_gain: f32,
    transport_ramp: Option<TransportRamp>,
    active_deck: DeckId,
    output_frames: u64,
    callback_timing: OutputCallbackTiming,
    presentation_time_ns: u64,
    deck_output_underruns: [u64; 2],
    deck_min_buffered_frames: [u64; 2],
    deck_peak_levels: [f32; 2],
    deck_spectrum: [DeckSpectrum; 2],
    deck_levels_active: [bool; 2],
    deck_positions: [f64; 2],
    deck_gains: [f32; 2],
    deck_rates: [f64; 2],
    deck_phase_corrections: [f64; 2],
    deck_phase_correction_targets: [f64; 2],
    deck_phase_correction_steps: [f64; 2],
    deck_phase_correction_remaining: [u32; 2],
    deck_phase_resamplers: [DeckPhaseResampler; 2],
    deck_rate_revisions: [u64; 2],
    deck_discontinuity_revisions: [u64; 2],
    source_rate_ratios: [f64; 2],
    /// Encoded network streams may briefly starve. Hold the last sample and ramp its edge instead
    /// of hard-switching between an arbitrary sample and zero, which is perceived as crackle.
    stream_edge_gains: [f32; 2],
    stream_last_frames: [[f32; 2]; 2],
    stream_playback: [StreamPlaybackState; 2],
    stem_stream_playback: [StreamPlaybackState; 2],
    replacement_stem_playback: [StreamPlaybackState; 2],
    stem_gains: [StemGains; 2],
    /// Desired transport loop on the installed source.
    deck_looping: [bool; 2],
    deck_loop_generations: [u64; 2],
    deck_loop_start_frames: [u64; 2],
    deck_loop_frames: [u64; 2],
    /// Streaming loops become effective only when matching PCM reaches the callback.
    deck_effective_looping: [bool; 2],
    deck_effective_loop_generations: [u64; 2],
    deck_effective_loop_start_frames: [u64; 2],
    deck_effective_loop_frames: [u64; 2],
    deck_loop_wrap_counts: [u64; 2],
    deck_loop_stall_frames: [u64; 2],
    output_sample_rate: u32,
    filter_resonance: f32,
    deck_eq: [DeckEq; 2],
    deck_manual_fx: [DeckManualFx; 2],
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
            deck_pfl: [false; 2],
            deck_scratch_held: [false; 2],
            deck_scratch_velocity: [0.0; 2],
            deck_scratch_target_velocity: [0.0; 2],
            deck_scratch_releasing: [false; 2],
            deck_scratch_release_decay: [0.0; 2],
            deck_scratch_playthrough: [false; 2],
            deck_scratch_input_at: [SCRATCH_NO_TICK; 2],
            deck_scratch_valid_frames: [0; 2],
            deck_audible_rate_smooth: [0.0; 2],
            scratch_tapes: [ScratchTape::new(), ScratchTape::new()],
            deck_source_origin_frames: [0.0; 2],
            transport_gain: 0.0,
            transport_ramp: None,
            active_deck: DeckId::A,
            output_frames: 0,
            callback_timing: OutputCallbackTiming::default(),
            presentation_time_ns: 0,
            deck_output_underruns: [0; 2],
            deck_min_buffered_frames: [u64::MAX; 2],
            deck_peak_levels: [0.0; 2],
            deck_spectrum: [DeckSpectrum::default(); 2],
            deck_levels_active: [false; 2],
            deck_positions: [0.0; 2],
            deck_gains: [1.0; 2],
            deck_rates: [1.0; 2],
            deck_phase_corrections: [1.0; 2],
            deck_phase_correction_targets: [1.0; 2],
            deck_phase_correction_steps: [0.0; 2],
            deck_phase_correction_remaining: [0; 2],
            deck_phase_resamplers: [DeckPhaseResampler::default(); 2],
            deck_rate_revisions: [0; 2],
            deck_discontinuity_revisions: [0; 2],
            source_rate_ratios: [1.0; 2],
            stream_edge_gains: [0.0; 2],
            stream_last_frames: [[0.0; 2]; 2],
            stream_playback: [StreamPlaybackState::default(); 2],
            stem_stream_playback: [StreamPlaybackState::default(); 2],
            replacement_stem_playback: [StreamPlaybackState::default(); 2],
            stem_gains: [StemGains::default(); 2],
            deck_looping: [false; 2],
            deck_loop_generations: [0; 2],
            deck_loop_start_frames: [0; 2],
            deck_loop_frames: [0; 2],
            deck_effective_looping: [false; 2],
            deck_effective_loop_generations: [0; 2],
            deck_effective_loop_start_frames: [0; 2],
            deck_effective_loop_frames: [0; 2],
            deck_loop_wrap_counts: [0; 2],
            deck_loop_stall_frames: [0; 2],
            output_sample_rate: 48_000,
            filter_resonance: crate::DEFAULT_FILTER_RESONANCE_Q,
            deck_eq: [DeckEq::default(); 2],
            deck_manual_fx: std::array::from_fn(|_| DeckManualFx::new()),
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
            self.advance_deck_phase_correction(0);
            self.advance_deck_phase_correction(1);
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
            let a = if required[0] && !self.deck_scratch_held[0] && self.deck_positions[0] >= 0.0 {
                self.deck_eq[0].process_stereo(input_a)
            } else {
                [0.0; 2]
            };
            let b = if required[1] && !self.deck_scratch_held[1] && self.deck_positions[1] >= 0.0 {
                self.deck_eq[1].process_stereo(input_b)
            } else {
                [0.0; 2]
            };
            let a = self.deck_manual_fx[0].process(a, self.output_sample_rate);
            let b = self.deck_manual_fx[1].process(b, self.output_sample_rate);
            self.observe_deck_levels(a, b);
            for channel in 0..channels {
                output[index + channel] =
                    self.render_output_channel(a, b, [0.0; 2], channel, transition_a, transition_b);
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
        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let required = self.required_decks();
            self.advance_deck_phase_correction(0);
            self.advance_deck_phase_correction(1);
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
            let a = self.deck_manual_fx[0].process(a, self.output_sample_rate);
            let b = self.deck_manual_fx[1].process(b, self.output_sample_rate);
            self.observe_deck_levels(a, b);
            for (channel, sample) in frame.iter_mut().enumerate() {
                *sample =
                    self.render_output_channel(a, b, [0.0; 2], channel, transition_a, transition_b);
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
        self.render_prepared_timed(
            output,
            output_sample_rate,
            output_channels,
            OutputCallbackTiming::default(),
        );
    }

    pub(crate) fn render_prepared_timed(
        &mut self,
        output: &mut [f32],
        output_sample_rate: u32,
        output_channels: usize,
        timing: OutputCallbackTiming,
    ) {
        self.render_prepared_as(
            output,
            output_sample_rate,
            output_channels,
            timing,
            |sample| sample,
        );
    }

    pub(crate) fn render_prepared_i16(
        &mut self,
        output: &mut [i16],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        self.render_prepared_i16_timed(
            output,
            output_sample_rate,
            output_channels,
            OutputCallbackTiming::default(),
        );
    }

    pub(crate) fn render_prepared_i16_timed(
        &mut self,
        output: &mut [i16],
        output_sample_rate: u32,
        output_channels: usize,
        timing: OutputCallbackTiming,
    ) {
        self.render_prepared_as(
            output,
            output_sample_rate,
            output_channels,
            timing,
            |sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16,
        );
    }

    pub(crate) fn render_prepared_u16(
        &mut self,
        output: &mut [u16],
        output_sample_rate: u32,
        output_channels: usize,
    ) {
        self.render_prepared_u16_timed(
            output,
            output_sample_rate,
            output_channels,
            OutputCallbackTiming::default(),
        );
    }

    pub(crate) fn render_prepared_u16_timed(
        &mut self,
        output: &mut [u16],
        output_sample_rate: u32,
        output_channels: usize,
        timing: OutputCallbackTiming,
    ) {
        self.render_prepared_as(
            output,
            output_sample_rate,
            output_channels,
            timing,
            |sample| ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * f32::from(u16::MAX)).round() as u16,
        );
    }

    fn render_prepared_as<T, F>(
        &mut self,
        output: &mut [T],
        output_sample_rate: u32,
        output_channels: usize,
        timing: OutputCallbackTiming,
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
        self.callback_timing = timing;
        let callback_frames = output.len() / output_channels;
        let buffer_ns = (callback_frames as u128).saturating_mul(1_000_000_000)
            / u128::from(output_sample_rate);
        self.presentation_time_ns = timing
            .playback_time_ns
            .saturating_add(buffer_ns.min(u128::from(u64::MAX)) as u64);
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
        let required_at_boundary = self.required_decks();
        if self.playing {
            for index in 0..2 {
                if required_at_boundary[index] {
                    if let Some(buffered) = callback_source_buffered_frames(sources[index]) {
                        self.deck_min_buffered_frames[index] =
                            self.deck_min_buffered_frames[index].min(buffered);
                    }
                }
            }
        }

        let complete_len = output.len() - output.len() % output_channels;
        for frame in output[..complete_len].chunks_mut(output_channels) {
            let required = self.required_decks();
            // Decoded slices wrap the random-access cursor. Stream/STEM playheads follow the
            // packet that just left the FIFO, so they must not be modulo'd independently.
            for index in 0..2 {
                if self.deck_scratch_held[index]
                    || matches!(self.deck_sources[index].kind, SourceKind::Decoded)
                {
                    self.wrap_deck_loop(index);
                }
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
            let (a, b) = if self.rendering_active() {
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
            let a = self.deck_manual_fx[0].process(a, self.output_sample_rate);
            let b = self.deck_manual_fx[1].process(b, self.output_sample_rate);
            self.observe_deck_levels(a, b);
            for (channel, sample) in frame.iter_mut().enumerate() {
                let value =
                    self.render_output_channel(a, b, wet, channel, transition_a, transition_b);
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
                        self.loop_transport_active(0),
                    ),
                    stream_clock_should_advance(
                        self.playing && required[1],
                        self.deck_scratch_held[1],
                        advance_b,
                        stream_rebuffering(&self.stream_playback[1], &self.stem_stream_playback[1]),
                        stream_source_ended(sources[1]),
                        self.loop_transport_active(1),
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
                            self.loop_transport_active(index),
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
                self.loop_transport_active(self.active_deck as usize),
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

    #[inline]
    fn observe_deck_levels(&mut self, a: [f32; 2], b: [f32; 2]) {
        // Fast attack with a ~0.35s visual release at 48 kHz so meters feel responsive. The callback
        // remains allocation/lock free; levels may exceed 1.0 so the UI can report clipping.
        const RELEASE_PER_FRAME: f32 = 0.999_94;
        for (index, input) in [a, b].into_iter().enumerate() {
            let active = self.playing && self.deck_playing[index] || self.platter_active(index);
            if !active {
                if self.deck_levels_active[index] {
                    self.deck_peak_levels[index] = 0.0;
                    self.deck_spectrum[index].reset();
                    self.deck_levels_active[index] = false;
                }
                continue;
            }
            if !self.deck_levels_active[index] {
                self.deck_peak_levels[index] = 0.0;
                self.deck_spectrum[index].reset();
                self.deck_levels_active[index] = true;
            }
            let peak = input[0].abs().max(input[1].abs());
            self.deck_peak_levels[index] =
                (self.deck_peak_levels[index] * RELEASE_PER_FRAME).max(peak);
            self.deck_spectrum[index].observe(input);
        }
    }

    fn deck_loop_out_seconds(&self, index: usize) -> Option<f64> {
        let (looping, start, frames) = if self.deck_looping[index] {
            (
                true,
                self.deck_loop_start_frames[index],
                self.deck_loop_frames[index],
            )
        } else {
            (
                self.deck_effective_looping[index],
                self.deck_effective_loop_start_frames[index],
                self.deck_effective_loop_frames[index],
            )
        };
        if !looping || frames == 0 {
            return None;
        }
        let sample_rate = f64::from(self.output_sample_rate.max(1));
        Some((start + frames) as f64 / sample_rate)
    }

    fn loop_transport_active(&self, index: usize) -> bool {
        self.deck_looping[index] || self.deck_effective_looping[index]
    }

    fn adopt_stream_loop_timing(&mut self, index: usize, timing: StreamPlaybackState) {
        if timing.loop_generation == self.deck_loop_generations[index] {
            self.deck_effective_loop_generations[index] = timing.loop_generation;
            self.deck_effective_looping[index] = timing.loop_active;
            if timing.loop_active {
                self.deck_effective_loop_start_frames[index] = self.deck_loop_start_frames[index];
                self.deck_effective_loop_frames[index] = self.deck_loop_frames[index];
            } else {
                self.deck_effective_loop_start_frames[index] = 0;
                self.deck_effective_loop_frames[index] = 0;
            }
        }
        if timing.loop_active && timing.loop_wrapped {
            self.deck_loop_wrap_counts[index] = self.deck_loop_wrap_counts[index].saturating_add(1);
        }
    }

    fn reset_deck_loop_state(&mut self, index: usize) {
        self.deck_looping[index] = false;
        self.deck_loop_generations[index] = 0;
        self.deck_loop_start_frames[index] = 0;
        self.deck_loop_frames[index] = 0;
        self.deck_effective_looping[index] = false;
        self.deck_effective_loop_generations[index] = 0;
        self.deck_effective_loop_start_frames[index] = 0;
        self.deck_effective_loop_frames[index] = 0;
        self.deck_loop_wrap_counts[index] = 0;
        self.deck_loop_stall_frames[index] = 0;
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
            Some(CallbackSource::Stream(stream)) => {
                let loop_out = self.deck_loop_out_seconds(index);
                let looping = self.loop_transport_active(index);
                stream_output_frame(
                    &mut self.replacement_stream_playback[index],
                    stream,
                    self.output_sample_rate,
                    looping,
                    loop_out,
                    self.deck_loop_generations[index],
                    StreamRecoverPolicy::PacketCushion,
                )
            }
            Some(CallbackSource::StemStream(stream)) => {
                let loop_out = self.deck_loop_out_seconds(index);
                let looping = self.loop_transport_active(index);
                let (raw, advanced) = stream_output_frame(
                    &mut self.replacement_stem_playback[index],
                    stream,
                    self.output_sample_rate,
                    looping,
                    loop_out,
                    self.deck_loop_generations[index],
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

    fn set_platter_velocity(&mut self, index: usize, velocity: f64, valid_for_seconds: f32) {
        if !velocity.is_finite() {
            return;
        }
        let normalized = velocity.clamp(-SCRATCH_VELOCITY_MAX, SCRATCH_VELOCITY_MAX);
        self.deck_scratch_target_velocity[index] = normalized * self.source_rate_ratios[index];
        self.deck_scratch_input_at[index] = self.output_frames;
        let valid = if valid_for_seconds.is_finite() {
            f64::from(valid_for_seconds).clamp(SCRATCH_MIN_VALID_SECONDS, SCRATCH_MAX_VALID_SECONDS)
        } else {
            SCRATCH_DEFAULT_VALID_SECONDS
        };
        self.deck_scratch_valid_frames[index] =
            (valid * f64::from(self.output_sample_rate.max(1))).ceil() as u64;
    }

    fn play_or_scratch(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
        required: bool,
    ) -> ([f32; 2], bool) {
        if !required {
            return ([0.0; 2], false);
        }
        self.advance_deck_phase_correction(index);
        if self.scratch_playthrough_ready(index) {
            self.end_scratch_voice(index);
        }
        if self.deck_scratch_held[index] {
            return self.scratch_output_frame(index, source);
        }
        if !self.playing {
            return ([0.0; 2], false);
        }
        let (raw, advanced) = if self.deck_positions[index] >= 0.0
            && matches!(
                source,
                Some(CallbackSource::Stream(_) | CallbackSource::StemStream(_))
            )
            && ((self.deck_phase_corrections[index] - 1.0).abs() > f64::EPSILON
                || self.deck_phase_resamplers[index].current.is_some())
        {
            self.phase_corrected_stream_frame(index, source)
        } else {
            self.callback_source_frame(index, source)
        };
        if advanced {
            self.apply_stream_media_playhead(index, source);
            let position = self.deck_positions[index].max(0.0);
            let media_advance = self.deck_media_advance(index);
            self.scratch_tapes[index].push_at(position, raw, media_advance);
        }
        (raw, advanced)
    }

    fn scratch_output_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> ([f32; 2], bool) {
        let mut next = self.next_scratch_position(index);
        if let Some(CallbackSource::Decoded(track)) = source {
            next = self.clamp_decoded_scratch_end(index, next, track.frames());
        }
        if matches!(
            source,
            Some(CallbackSource::Stream(_) | CallbackSource::StemStream(_))
        ) {
            let fill_at =
                if self.scratch_tapes[index].is_empty() && next < self.deck_positions[index] {
                    self.deck_positions[index]
                } else {
                    next
                };
            self.fill_scratch_tape(index, source, fill_at);
            let before_decode_origin =
                self.scratch_tapes[index]
                    .first_position()
                    .is_some_and(|first| {
                        first <= self.deck_source_origin_frames[index] + SCRATCH_GAP_FRAMES as f64
                            && next < first
                            && (self.deck_positions[index] < first
                                || self.deck_scratch_velocity[index] < 0.0)
                    });
            if next >= 0.0
                && !self.scratch_tapes[index].contains_position(next)
                && !before_decode_origin
            {
                // The bounded post-tempo ring has not produced this future frame yet (or reverse
                // reached the history edge). Hold the last real grain and cursor; never advance
                // through digital zero and later jump when data arrives.
                self.deck_scratch_velocity[index] = 0.0;
                if self.scratch_tapes[index]
                    .first_position()
                    .is_some_and(|first| next < first)
                {
                    self.deck_scratch_target_velocity[index] = 0.0;
                }
                let parked = self.deck_positions[index];
                return (self.scratch_tapes[index].get(parked), false);
            }
        }
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
                self.scratch_tapes[index].get(position)
            }
            None => [0.0; 2],
        }
    }

    fn fill_scratch_tape(&mut self, index: usize, source: Option<CallbackSource>, position: f64) {
        if !position.is_finite() || position < 0.0 {
            return;
        }
        let needed = position;
        for _ in 0..SCRATCH_TAPE_FILL_FRAMES {
            // Mixxx's CachingReader only fetches *ahead* of already-cached frames. A reverse
            // lookup that is still inside the tape must not consume the forward stream.
            if self.scratch_tapes[index].contains_position(needed) {
                return;
            }
            if self.scratch_tapes[index]
                .first_position()
                .is_some_and(|first| needed < first)
            {
                return;
            }
            let write_at = self.scratch_tapes[index]
                .end_position()
                .unwrap_or_else(|| self.deck_positions[index].max(0.0));
            if write_at > needed {
                return;
            }
            let (raw, advanced) = self.callback_source_frame(index, source);
            if !advanced {
                return;
            }
            let media_advance = self.deck_media_advance(index);
            self.scratch_tapes[index].push_at(write_at, raw, media_advance);
        }
    }

    fn decoded_scratch_frame(&mut self, index: usize, track: &DecodedTrack) -> [f32; 2] {
        let next = self.next_scratch_position(index);
        let next = self.clamp_decoded_scratch_end(index, next, track.frames());
        let sample = [track_sample(track, next, 0), track_sample(track, next, 1)];
        self.deck_positions[index] = next;
        self.wrap_deck_loop(index);
        sample
    }

    fn clamp_decoded_scratch_end(&mut self, index: usize, next: f64, frames: usize) -> f64 {
        if self.deck_looping[index] || frames == 0 {
            return next;
        }
        let end = frames.saturating_sub(1) as f64;
        if next <= end {
            return next;
        }
        if self.deck_scratch_velocity[index] > 0.0 {
            self.deck_scratch_velocity[index] = 0.0;
            self.deck_scratch_target_velocity[index] = 0.0;
        }
        end
    }

    fn callback_source_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> ([f32; 2], bool) {
        if self.deck_positions[index] < 0.0 {
            // Advance the signed Deck clock through silence without consuming source frame 0.
            return ([0.0; 2], true);
        }
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
            Some(CallbackSource::Stream(stream)) => {
                let was_rebuffering = self.stream_playback[index].rebuffering;
                let loop_out = self.deck_loop_out_seconds(index);
                let looping = self.loop_transport_active(index);
                let result = stream_output_frame(
                    &mut self.stream_playback[index],
                    stream,
                    self.output_sample_rate,
                    looping,
                    loop_out,
                    self.deck_loop_generations[index],
                    StreamRecoverPolicy::PacketCushion,
                );
                if result.1 {
                    self.adopt_stream_loop_timing(index, self.stream_playback[index]);
                } else if self.loop_transport_active(index) {
                    self.deck_loop_stall_frames[index] =
                        self.deck_loop_stall_frames[index].saturating_add(1);
                }
                if !result.1 && !was_rebuffering && !stream.ended() {
                    self.deck_output_underruns[index] =
                        self.deck_output_underruns[index].saturating_add(1);
                }
                result
            }
            Some(CallbackSource::StemStream(stream)) => {
                let was_rebuffering = self.stem_stream_playback[index].rebuffering;
                let loop_out = self.deck_loop_out_seconds(index);
                let looping = self.loop_transport_active(index);
                let (raw, advanced) = stream_output_frame(
                    &mut self.stem_stream_playback[index],
                    stream,
                    self.output_sample_rate,
                    looping,
                    loop_out,
                    self.deck_loop_generations[index],
                    StreamRecoverPolicy::PacketCushion,
                );
                if !advanced {
                    if self.loop_transport_active(index) {
                        self.deck_loop_stall_frames[index] =
                            self.deck_loop_stall_frames[index].saturating_add(1);
                    }
                    if !was_rebuffering && !stream.ended() {
                        self.deck_output_underruns[index] =
                            self.deck_output_underruns[index].saturating_add(1);
                        record_stem_output_underrun_for_deck(index);
                    }
                    return ([0.0; 2], false);
                }
                self.adopt_stream_loop_timing(index, self.stem_stream_playback[index]);
                (self.mix_stem_gains(index, raw), true)
            }
            _ => ([0.0; 2], false),
        }
    }

    fn phase_corrected_stream_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> ([f32; 2], bool) {
        let correction = self.deck_phase_corrections[index].clamp(0.75, 1.25);
        let mut cursor = self.deck_phase_resamplers[index];
        if cursor.current.is_none() {
            cursor.current = self.pop_timed_stream_frame(index, source);
        }
        if cursor.next.is_none() {
            cursor.next = self.pop_timed_stream_frame(index, source);
        }
        let (Some(current), Some(next)) = (cursor.current, cursor.next) else {
            self.deck_phase_resamplers[index] = cursor;
            return ([0.0; 2], false);
        };

        let fraction = cursor.fraction.clamp(0.0, 1.0) as f32;
        let output = current.frame.lerp(next.frame, fraction);
        let media_advance = (current.media_advance
            + (next.media_advance - current.media_advance) * f64::from(fraction))
            * correction;
        let media_time = if current.media_time.is_finite() && next.media_time.is_finite() {
            current.media_time + (next.media_time - current.media_time) * f64::from(fraction)
        } else if current.media_time.is_finite() {
            current.media_time
        } else {
            next.media_time
        };
        // A mixed boundary is not fully at the newer revision until its older left endpoint has
        // left the interpolation window. This keeps audible acknowledgements conservative.
        let tempo_revision = current.tempo_revision;

        cursor.fraction += correction;
        while cursor.fraction >= 1.0 {
            cursor.current = cursor.next;
            cursor.next = self.pop_timed_stream_frame(index, source);
            cursor.fraction -= 1.0;
        }
        self.deck_phase_resamplers[index] = cursor;
        self.set_stream_output_timing(index, source, media_advance, tempo_revision, media_time);
        (output, true)
    }

    fn pop_timed_stream_frame(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
    ) -> Option<TimedStereoFrame> {
        let (frame, advanced) = self.callback_source_frame(index, source);
        if !advanced {
            return None;
        }
        let (media_advance, tempo_revision, media_time) = match source {
            Some(CallbackSource::Stream(_)) => (
                self.stream_playback[index].media_advance,
                self.stream_playback[index].tempo_revision,
                self.stream_playback[index].media_time,
            ),
            Some(CallbackSource::StemStream(_)) => (
                self.stem_stream_playback[index].media_advance,
                self.stem_stream_playback[index].tempo_revision,
                self.stem_stream_playback[index].media_time,
            ),
            _ => return None,
        };
        Some(TimedStereoFrame {
            frame,
            media_advance,
            tempo_revision,
            media_time,
        })
    }

    fn set_stream_output_timing(
        &mut self,
        index: usize,
        source: Option<CallbackSource>,
        media_advance: f64,
        tempo_revision: u64,
        media_time: f64,
    ) {
        let state = match source {
            Some(CallbackSource::Stream(_)) => &mut self.stream_playback[index],
            Some(CallbackSource::StemStream(_)) => &mut self.stem_stream_playback[index],
            _ => return,
        };
        state.media_advance = media_advance;
        state.tempo_revision = tempo_revision;
        state.media_time = media_time;
    }

    fn apply_stream_media_playhead(&mut self, index: usize, source: Option<CallbackSource>) {
        let media_time = match source {
            Some(CallbackSource::Stream(_)) => self.stream_playback[index].media_time,
            Some(CallbackSource::StemStream(_)) => self.stem_stream_playback[index].media_time,
            _ => return,
        };
        if !(media_time.is_finite() && media_time >= 0.0) {
            return;
        }
        let sample_rate = f64::from(self.output_sample_rate.max(1));
        let next = media_time * sample_rate;
        self.deck_positions[index] = next;
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
            let fade_frames =
                if matches!(previous.kind, SourceKind::Stream | SourceKind::StemStream)
                    && matches!(source_kind, SourceKind::Stream | SourceKind::StemStream)
                    && previous.kind != source_kind
                {
                    // Raw→STEM is a timbre change. An 80ms overlap is short to operate but long
                    // enough to hide the model timbre edge without a perceived stop/start tick.
                    (self.output_sample_rate * 2 / 25).max(1)
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
        self.deck_source_origin_frames[index] = start_frame as f64;
        self.deck_discontinuity_revisions[index] = self.deck_discontinuity_revisions[index]
            .wrapping_add(1)
            .max(1);
        self.reset_scratch_motion(index);
        self.scratch_tapes[index].reset();
        self.deck_audible_rate_smooth[index] = 0.0;
        self.reset_deck_loop_state(index);
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
        self.deck_phase_corrections[index] = 1.0;
        self.deck_phase_correction_targets[index] = 1.0;
        self.deck_phase_correction_steps[index] = 0.0;
        self.deck_phase_correction_remaining[index] = 0;
        self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
        self.deck_output_underruns[index] = 0;
        self.deck_min_buffered_frames[index] = u64::MAX;
        self.deck_peak_levels[index] = 0.0;
        self.deck_spectrum[index].reset();
        self.deck_levels_active[index] = false;
    }

    fn clear_prepared(&mut self, deck: DeckId) {
        let index = deck as usize;
        let previous = std::mem::take(&mut self.deck_sources[index]);
        let replacement = std::mem::take(&mut self.replacement_sources[index]);
        self.deck_positions[index] = 0.0;
        self.deck_source_origin_frames[index] = 0.0;
        self.deck_discontinuity_revisions[index] = self.deck_discontinuity_revisions[index]
            .wrapping_add(1)
            .max(1);
        self.deck_playing[index] = false;
        self.deck_scratch_held[index] = false;
        self.reset_scratch_motion(index);
        self.scratch_tapes[index].reset();
        self.reset_deck_loop_state(index);
        self.stream_edge_gains[index] = 0.0;
        self.stream_last_frames[index] = [0.0; 2];
        self.stream_playback[index] = StreamPlaybackState::default();
        self.stem_stream_playback[index] = StreamPlaybackState::default();
        self.deck_phase_corrections[index] = 1.0;
        self.deck_phase_correction_targets[index] = 1.0;
        self.deck_phase_correction_steps[index] = 0.0;
        self.deck_phase_correction_remaining[index] = 0;
        self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
        self.replacement_stream_playback[index] = StreamPlaybackState::default();
        self.replacement_stem_playback[index] = StreamPlaybackState::default();
        self.replacement_remaining[index] = 0;
        self.replacement_total[index] = 0;
        self.deck_output_underruns[index] = 0;
        self.deck_min_buffered_frames[index] = u64::MAX;
        self.deck_peak_levels[index] = 0.0;
        self.deck_spectrum[index].reset();
        self.deck_levels_active[index] = false;
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
                let index = deck as usize;
                self.mode = PlayerMode::RealtimeDj;
                self.deck_playing[index] = playing;
                if !playing {
                    // Pause leaves the scratch voice. A frozen Rubber Band ring is fine while
                    // stopped; Play will rebuild through the normal seek/startup path.
                    self.end_scratch_voice(index);
                }
                if playing {
                    self.active_deck = deck;
                    self.transport_gain = 1.0;
                    self.transport_ramp = None;
                    if self.deck_scratch_held[index] && self.deck_scratch_playthrough[index] {
                        // A paused streaming platter may be parked behind the producer head.
                        // Accelerate through its cached history before handing back to the ring.
                        self.deck_scratch_playthrough[index] = false;
                        self.deck_scratch_releasing[index] = true;
                    }
                }
                self.playing = self.deck_playing.into_iter().any(|value| value);
                if !self.playing {
                    self.transport_gain = 0.0;
                }
            }
            RtCommand::SetDeckPfl { deck, enabled } => {
                self.deck_pfl[deck as usize] = enabled;
            }
            RtCommand::ControlDeckPlatter {
                deck,
                phase,
                velocity,
            } => {
                let index = deck as usize;
                self.mode = PlayerMode::RealtimeDj;
                match phase {
                    PlatterPhase::Start => {
                        // Instant stop under the finger without changing transport intent.
                        self.deck_scratch_held[index] = true;
                        // A platter grab is a new clock owner. Drop any fractional phase-reader
                        // state left by SYNC/legacy edge nudging and anchor at the last frame that
                        // was actually audible; otherwise first contact can advance one tiny
                        // buffered fraction before the hand starts moving.
                        self.deck_phase_corrections[index] = 1.0;
                        self.deck_phase_correction_targets[index] = 1.0;
                        self.deck_phase_correction_steps[index] = 0.0;
                        self.deck_phase_correction_remaining[index] = 0;
                        self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
                        self.reset_scratch_motion(index);
                        // Audio stops on this callback. Publish the same zero immediately rather
                        // than decaying the pre-touch transport rate for another visual sample.
                        self.deck_audible_rate_smooth[index] = 0.0;
                    }
                    PlatterPhase::Move => {
                        if self.deck_scratch_held[index]
                            && !self.deck_scratch_releasing[index]
                            && !self.deck_scratch_playthrough[index]
                        {
                            self.set_platter_velocity(
                                index,
                                velocity,
                                SCRATCH_DEFAULT_VALID_SECONDS as f32,
                            );
                        }
                    }
                    PlatterPhase::End => {
                        if self.deck_scratch_held[index] && !self.deck_scratch_playthrough[index] {
                            // End owns the final source-timestamped observation. Apply it before
                            // selecting coast/light-touch behavior; no earlier move ACK is needed.
                            self.set_platter_velocity(
                                index,
                                velocity,
                                SCRATCH_DEFAULT_VALID_SECONDS as f32,
                            );
                            self.deck_scratch_velocity[index] =
                                self.deck_scratch_target_velocity[index];
                            self.release_scratch_to_transport(index);
                        }
                    }
                    PlatterPhase::Cancel => {
                        if self.deck_scratch_held[index] || self.deck_scratch_releasing[index] {
                            self.deck_discontinuity_revisions[index] = self
                                .deck_discontinuity_revisions[index]
                                .wrapping_add(1)
                                .max(1);
                        }
                        self.end_scratch_voice(index);
                    }
                }
            }
            RtCommand::UpdateDeckPlatter {
                deck,
                velocity,
                valid_for_seconds,
            } => {
                let index = deck as usize;
                if self.deck_scratch_held[index]
                    && !self.deck_scratch_releasing[index]
                    && !self.deck_scratch_playthrough[index]
                {
                    self.set_platter_velocity(index, velocity, valid_for_seconds);
                }
            }
            RtCommand::SetRate { deck, rate } => {
                if rate.is_finite() && rate > 0.0 {
                    self.deck_rates[deck as usize] = f64::from(rate);
                    self.deck_rate_revisions[deck as usize] = self.deck_rate_revisions
                        [deck as usize]
                        .wrapping_add(1)
                        .max(1);
                }
            }
            RtCommand::SetDeckRates { rates } => {
                for (deck, rate) in rates.into_iter().enumerate() {
                    if rate.is_finite() && rate > 0.0 {
                        self.deck_rates[deck] = f64::from(rate);
                        self.deck_rate_revisions[deck] =
                            self.deck_rate_revisions[deck].wrapping_add(1).max(1);
                    }
                }
            }
            RtCommand::SetDeckPhaseCorrection { deck, multiplier } => {
                if multiplier.is_finite() && (0.75..=1.25).contains(&multiplier) {
                    let index = deck as usize;
                    let target = f64::from(multiplier);
                    let frames = (self.output_sample_rate / 200).max(1);
                    self.deck_phase_correction_targets[index] = target;
                    self.deck_phase_correction_steps[index] =
                        (target - self.deck_phase_corrections[index]) / f64::from(frames);
                    self.deck_phase_correction_remaining[index] = frames;
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
                generation,
                looping,
                start_frames,
                frames,
            } => {
                let index = deck as usize;
                let next_looping = looping && frames > 0;
                let next_start = if next_looping { start_frames } else { 0 };
                let next_frames = if next_looping { frames } else { 0 };
                if self.deck_looping[index] != next_looping
                    || self.deck_loop_generations[index] != generation
                    || self.deck_loop_start_frames[index] != next_start
                    || self.deck_loop_frames[index] != next_frames
                {
                    self.deck_looping[index] = next_looping;
                    self.deck_loop_generations[index] = generation;
                    self.deck_loop_start_frames[index] = next_start;
                    self.deck_loop_frames[index] = next_frames;
                    if matches!(self.deck_sources[index].kind, SourceKind::Decoded) {
                        self.deck_effective_looping[index] = next_looping;
                        self.deck_effective_loop_generations[index] = generation;
                        self.deck_effective_loop_start_frames[index] = next_start;
                        self.deck_effective_loop_frames[index] = next_frames;
                        if self.wrap_deck_loop(index) {
                            self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
                        }
                    }
                }
            }
            RtCommand::SetDeckPreroll { deck, frames } => {
                let index = deck as usize;
                self.deck_positions[index] = -(frames.min(i64::MAX as u64) as f64);
                self.reset_scratch_motion(index);
                self.scratch_tapes[index].reset();
                self.stream_playback[index] = StreamPlaybackState::default();
                self.stem_stream_playback[index] = StreamPlaybackState::default();
                self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
                self.deck_discontinuity_revisions[index] = self.deck_discontinuity_revisions[index]
                    .wrapping_add(1)
                    .max(1);
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
            RtCommand::SetDeckFx {
                deck,
                slots,
                pad,
                beat_seconds,
            } => {
                self.deck_manual_fx[deck as usize].configure(slots, pad, beat_seconds);
            }
            RtCommand::SeekPrepared { deck, frame } => {
                let index = deck as usize;
                self.deck_positions[index] = frame as f64;
                self.deck_source_origin_frames[index] = frame as f64;
                self.reset_scratch_motion(index);
                self.deck_eq[index].reset();
                self.deck_peak_levels[index] = 0.0;
                self.deck_spectrum[index].reset();
                self.scratch_tapes[index].reset();
                self.stream_playback[index] = StreamPlaybackState::default();
                self.stem_stream_playback[index] = StreamPlaybackState::default();
                self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
                self.stream_edge_gains[index] = 0.0;
                self.deck_discontinuity_revisions[index] = self.deck_discontinuity_revisions[index]
                    .wrapping_add(1)
                    .max(1);
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
                let index = to as usize;
                self.deck_positions[index] = target_frame as f64;
                self.deck_discontinuity_revisions[index] = self.deck_discontinuity_revisions[index]
                    .wrapping_add(1)
                    .max(1);
                self.reset_scratch_motion(index);
                self.deck_eq[index].reset();
                self.deck_peak_levels[index] = 0.0;
                self.deck_spectrum[index].reset();
                self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
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

    #[inline]
    fn rendering_active(&self) -> bool {
        self.playing || (0..2).any(|index| self.platter_active(index))
    }

    #[inline]
    fn output_transport_gain(&self) -> f32 {
        // A paused Deck has transport_gain=0, but Mixxx-style scratch takes over speed and
        // direction whether Play is on or off. Keep the logical transport paused while letting
        // only the held platter speak.
        if self.playing {
            self.transport_gain
        } else {
            1.0
        }
    }

    #[inline]
    fn render_output_channel(
        &self,
        a: [f32; 2],
        b: [f32; 2],
        transition_wet: [f32; 2],
        channel: usize,
        transition_a: f32,
        transition_b: f32,
    ) -> f32 {
        if !self.rendering_active() {
            return 0.0;
        }
        let transport = self.output_transport_gain();
        if channel < 2 {
            let side = channel;
            return ((a[side] * self.deck_gains[0] * transition_a
                + b[side] * self.deck_gains[1] * transition_b)
                + transition_wet[side])
                * self.master_gain
                * transport;
        }
        if channel < 4 {
            let side = channel - 2;
            let selected = usize::from(self.deck_pfl[0]) + usize::from(self.deck_pfl[1]);
            if selected == 0 {
                return 0.0;
            }
            let gain = if selected > 1 {
                std::f32::consts::FRAC_1_SQRT_2
            } else {
                1.0
            };
            return (if self.deck_pfl[0] { a[side] } else { 0.0 }
                + if self.deck_pfl[1] { b[side] } else { 0.0 })
                * gain
                * transport;
        }
        0.0
    }

    fn reset_scratch_motion(&mut self, index: usize) {
        self.deck_scratch_releasing[index] = false;
        self.deck_scratch_release_decay[index] = 0.0;
        self.deck_scratch_playthrough[index] = false;
        self.deck_scratch_velocity[index] = 0.0;
        self.deck_scratch_target_velocity[index] = 0.0;
        self.deck_scratch_input_at[index] = SCRATCH_NO_TICK;
        self.deck_scratch_valid_frames[index] = 0;
    }

    fn end_scratch_voice(&mut self, index: usize) {
        self.deck_scratch_held[index] = false;
        self.reset_scratch_motion(index);
        self.deck_phase_resamplers[index] = DeckPhaseResampler::default();
        self.deck_audible_rate_smooth[index] = 0.0;
    }

    fn scratch_play_velocity(&self, index: usize) -> f64 {
        self.deck_rates[index] * self.source_rate_ratios[index] * self.deck_phase_corrections[index]
    }

    fn deck_uses_scratch_tape(&self, index: usize) -> bool {
        matches!(
            self.deck_sources[index].kind,
            SourceKind::Stream | SourceKind::StemStream
        )
    }

    fn scratch_playthrough_ready(&self, index: usize) -> bool {
        if !self.deck_scratch_playthrough[index] || !self.deck_playing[index] {
            return false;
        }
        let desired = self.scratch_play_velocity(index);
        if desired <= SCRATCH_STATIONARY_VELOCITY {
            return false;
        }
        self.scratch_tapes[index]
            .end_position()
            .is_some_and(|head| self.deck_positions[index] + desired.max(1.0) >= head - 1.0)
    }

    /// Replay cached history only until its cursor catches the still-buffered stream head.
    fn enter_scratch_playthrough(&mut self, index: usize, desired: f64) {
        self.deck_scratch_releasing[index] = false;
        self.deck_scratch_playthrough[index] = true;
        self.deck_scratch_velocity[index] = desired;
        self.deck_scratch_target_velocity[index] = desired;
        self.deck_scratch_input_at[index] = SCRATCH_NO_TICK;
        let ratio = self.source_rate_ratios[index].max(f64::EPSILON);
        self.deck_audible_rate_smooth[index] = (desired / ratio) as f32;
    }

    /// Capacitive note-off. Light lift snaps to play speed; a real throw coasts from the
    /// *current* velocity. Streaming Decks stay on ScratchTape playthrough so Rubber Band
    /// never restarts from an empty ring (that restart is the playback-key "woom").
    fn release_scratch_to_transport(&mut self, index: usize) {
        let desired = if self.deck_playing[index] {
            self.scratch_play_velocity(index)
        } else {
            0.0
        };
        let velocity = self.deck_scratch_velocity[index];
        let difference = (velocity - desired).abs();
        let handoff_epsilon = if desired.abs() > SCRATCH_STATIONARY_VELOCITY {
            SCRATCH_HANDOFF_RATE_EPSILON
        } else {
            SCRATCH_STATIONARY_VELOCITY
        };

        if difference <= handoff_epsilon
            || self.deck_playing[index] && velocity.abs() <= SCRATCH_CONTACT_JITTER_VELOCITY
        {
            if self.deck_uses_scratch_tape(index) {
                self.enter_scratch_playthrough(index, desired);
            } else {
                self.end_scratch_voice(index);
            }
            return;
        }
        if !self.deck_playing[index] && velocity.abs() <= SCRATCH_STATIONARY_VELOCITY {
            if self.deck_uses_scratch_tape(index) {
                self.enter_scratch_playthrough(index, 0.0);
            } else {
                self.end_scratch_voice(index);
            }
            return;
        }

        self.deck_scratch_releasing[index] = true;
        self.deck_scratch_playthrough[index] = false;
        let linear = (difference / SCRATCH_COAST_REFERENCE_DIFFERENCE).clamp(0.0, 1.0);
        let intensity = linear * linear * (3.0 - 2.0 * linear);
        let settle_seconds = SCRATCH_COAST_MIN_SECONDS
            + (SCRATCH_COAST_MAX_SECONDS - SCRATCH_COAST_MIN_SECONDS) * intensity;
        let settle_frames = (f64::from(self.output_sample_rate.max(1)) * settle_seconds).max(1.0);
        self.deck_scratch_release_decay[index] = (handoff_epsilon
            / difference.max(handoff_epsilon))
        .clamp(1.0e-9, 0.999_999)
        .powf(1.0 / settle_frames);
    }

    fn advance_deck_phase_correction(&mut self, index: usize) {
        let remaining = self.deck_phase_correction_remaining[index];
        if remaining == 0 {
            return;
        }
        self.deck_phase_corrections[index] += self.deck_phase_correction_steps[index];
        self.deck_phase_correction_remaining[index] = remaining - 1;
        if remaining == 1 {
            self.deck_phase_corrections[index] = self.deck_phase_correction_targets[index];
            self.deck_phase_correction_steps[index] = 0.0;
        }
    }

    fn next_scratch_position(&mut self, index: usize) -> f64 {
        let sample_rate = f64::from(self.output_sample_rate.max(1));
        if self.deck_scratch_releasing[index] {
            let desired = if self.deck_playing[index] {
                self.scratch_play_velocity(index)
            } else {
                0.0
            };
            let velocity = self.deck_scratch_velocity[index];
            let decay = self.deck_scratch_release_decay[index].clamp(0.0, 0.999_999_999);
            let mut next_velocity = desired + (velocity - desired) * decay;
            let max_velocity = SCRATCH_VELOCITY_MAX * self.source_rate_ratios[index].max(1.0);
            if next_velocity.abs() > max_velocity {
                next_velocity = next_velocity.signum() * max_velocity;
            }
            if desired.abs() <= SCRATCH_STATIONARY_VELOCITY
                && next_velocity.abs() <= SCRATCH_STATIONARY_VELOCITY
            {
                if !self.deck_uses_scratch_tape(index) {
                    self.end_scratch_voice(index);
                } else {
                    self.enter_scratch_playthrough(index, 0.0);
                }
                return self.deck_positions[index];
            }
            if desired.abs() > SCRATCH_STATIONARY_VELOCITY
                && (next_velocity - desired).abs() <= SCRATCH_HANDOFF_RATE_EPSILON
                && next_velocity.signum() == desired.signum()
            {
                // Settled onto transport speed. A stream replays only the history between its
                // scratched cursor and producer head, then leaves the scratch voice in-place.
                if self.deck_uses_scratch_tape(index) {
                    self.enter_scratch_playthrough(index, desired);
                    return self
                        .clamp_scratch_position(index, self.deck_positions[index] + desired);
                }
                self.end_scratch_voice(index);
                return self.deck_positions[index] + self.scratch_play_velocity(index);
            }
            self.deck_scratch_velocity[index] = next_velocity;
            return self.clamp_scratch_position(index, self.deck_positions[index] + next_velocity);
        }

        if !self.deck_scratch_playthrough[index] {
            let last = self.deck_scratch_input_at[index];
            let idle = if last == SCRATCH_NO_TICK {
                f64::INFINITY
            } else {
                self.output_frames.saturating_sub(last) as f64
            };
            let input_fresh = idle < self.deck_scratch_valid_frames[index] as f64;
            let target = if input_fresh {
                self.deck_scratch_target_velocity[index]
            } else {
                0.0
            };
            let response_seconds = if input_fresh {
                SCRATCH_RESPONSE_SECONDS
            } else {
                SCRATCH_STILL_FRICTION_SECONDS
            };
            let response_frames = (sample_rate * response_seconds).max(1.0);
            let mut velocity = self.deck_scratch_velocity[index]
                + (target - self.deck_scratch_velocity[index]) / response_frames;
            if (velocity - target).abs() <= SCRATCH_STATIONARY_VELOCITY {
                velocity = target;
            }
            self.deck_scratch_velocity[index] = velocity;
        }

        self.clamp_scratch_position(
            index,
            self.deck_positions[index] + self.deck_scratch_velocity[index],
        )
    }

    fn clamp_scratch_position(&mut self, index: usize, mut next: f64) -> f64 {
        let preroll = f64::from(self.output_sample_rate.max(1)) * PERFORMANCE_PREROLL_SECONDS;
        if next < -preroll {
            next = -preroll;
            if self.deck_scratch_velocity[index] < 0.0 {
                self.deck_scratch_velocity[index] = 0.0;
            }
        }
        next
    }

    fn wrap_deck_loop(&mut self, index: usize) -> bool {
        if !self.deck_looping[index] || self.deck_loop_frames[index] == 0 {
            return false;
        }
        let start = self.deck_loop_start_frames[index] as f64;
        let length = self.deck_loop_frames[index] as f64;
        let position = self.deck_positions[index];
        if position >= start + length {
            self.deck_positions[index] = start + (position - start) % length;
            self.deck_loop_wrap_counts[index] = self.deck_loop_wrap_counts[index].saturating_add(1);
            true
        } else {
            false
        }
    }

    fn ensure_eq_sample_rate(&mut self) {
        for eq in &mut self.deck_eq {
            eq.ensure_sample_rate(self.output_sample_rate);
        }
        for spectrum in &mut self.deck_spectrum {
            spectrum.ensure_sample_rate(self.output_sample_rate);
        }
    }

    fn required_decks(&self) -> [bool; 2] {
        let mut required = if !self.playing {
            [false, false]
        } else if let Some(transition) = self.transition {
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
        };
        for (index, held) in self.deck_scratch_held.into_iter().enumerate() {
            if held {
                required[index] = true;
            }
        }
        required
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
        for index in 0..2 {
            self.smooth_audible_rate(index);
        }
        if self.playing {
            let required = self.required_decks();
            for index in 0..2 {
                if required[index] && advanced[index] {
                    if self.stream_media_clock_active(index) {
                        continue;
                    }
                    let was_preroll = self.deck_positions[index] < 0.0;
                    self.deck_positions[index] += self.deck_media_advance(index);
                    if was_preroll && self.deck_positions[index] > 0.0 {
                        // Never skip a fraction of source frame 0 when TEMPO crosses the boundary.
                        self.deck_positions[index] = 0.0;
                    }
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
            _ => {
                self.deck_rates[index]
                    * self.source_rate_ratios[index]
                    * self.deck_phase_corrections[index]
            }
        }
    }

    fn stream_media_clock_active(&self, index: usize) -> bool {
        match self.deck_sources[index].kind {
            SourceKind::Stream => self.stream_playback[index].media_time.is_finite(),
            SourceKind::StemStream => self.stem_stream_playback[index].media_time.is_finite(),
            _ => false,
        }
    }

    fn publish(&self) {
        let deck_audible_rates = [
            self.published_audible_rate(0),
            self.published_audible_rate(1),
        ];
        let deck_audible_rate_revisions =
            [self.audible_rate_revision(0), self.audible_rate_revision(1)];
        self.shared.publish(
            self.mode,
            self.playing,
            self.deck_playing,
            self.active_deck,
            self.transition.map(|transition| transition.to),
            self.output_frames,
            self.output_sample_rate,
            self.callback_timing.callback_time_ns,
            self.presentation_time_ns,
            [
                self.deck_positions[0].round() as i64,
                self.deck_positions[1].round() as i64,
            ],
            [self.deck_sources[0].id, self.deck_sources[1].id],
            self.deck_rates.map(|rate| rate as f32),
            deck_audible_rates,
            self.deck_rate_revisions,
            deck_audible_rate_revisions,
            self.deck_discontinuity_revisions,
            [self.platter_active(0), self.platter_active(1)],
            self.deck_effective_loop_generations,
            self.deck_effective_looping,
            self.deck_effective_loop_start_frames,
            self.deck_effective_loop_frames,
            self.deck_loop_wrap_counts,
            self.deck_loop_stall_frames,
            self.deck_output_underruns,
            self.deck_min_buffered_frames
                .map(|frames| if frames == u64::MAX { 0 } else { frames }),
            self.deck_peak_levels,
            [
                self.deck_spectrum[0].levels(),
                self.deck_spectrum[1].levels(),
            ],
        );
    }

    fn raw_audible_rate(&self, index: usize) -> f32 {
        if self.deck_scratch_held[index] {
            let ratio = self.source_rate_ratios[index].max(f64::EPSILON);
            return (self.deck_scratch_velocity[index] / ratio) as f32;
        }
        // Paused / stopped Decks must report 0. Publishing TEMPO here made the waveform
        // compositor treat every parked Deck as a spinning platter.
        if !self.deck_playing[index] {
            return 0.0;
        }
        match self.deck_sources[index].kind {
            SourceKind::Stream if self.stream_playback[index].media_advance > 0.0 => {
                self.stream_playback[index].media_advance as f32
            }
            SourceKind::StemStream if self.stem_stream_playback[index].media_advance > 0.0 => {
                self.stem_stream_playback[index].media_advance as f32
            }
            _ => (self.deck_rates[index] * self.deck_phase_corrections[index]) as f32,
        }
    }

    fn platter_active(&self, index: usize) -> bool {
        self.deck_scratch_held[index] && !self.deck_scratch_playthrough[index]
    }

    fn smooth_audible_rate(&mut self, index: usize) {
        let raw = self.raw_audible_rate(index);
        if self.deck_scratch_held[index] {
            let sample_rate = f64::from(self.output_sample_rate.max(1));
            let alpha = (1.0 / (sample_rate * SCRATCH_AUDIBLE_RATE_SMOOTH_SECONDS).max(1.0)) as f32;
            let smooth = self.deck_audible_rate_smooth[index];
            self.deck_audible_rate_smooth[index] = smooth + (raw - smooth) * alpha.clamp(0.0, 1.0);
        } else {
            self.deck_audible_rate_smooth[index] = raw;
        }
    }

    fn published_audible_rate(&self, index: usize) -> f32 {
        if self.deck_scratch_held[index] {
            self.deck_audible_rate_smooth[index]
        } else {
            self.raw_audible_rate(index)
        }
    }

    fn audible_rate(&self, index: usize) -> f32 {
        self.published_audible_rate(index)
    }

    fn audible_rate_revision(&self, index: usize) -> u64 {
        match self.deck_sources[index].kind {
            SourceKind::Stream => self.stream_playback[index].tempo_revision,
            SourceKind::StemStream => self.stem_stream_playback[index].tempo_revision,
            _ => self.deck_rate_revisions[index],
        }
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

fn callback_source_buffered_frames(source: Option<CallbackSource>) -> Option<u64> {
    match source {
        Some(CallbackSource::Stream(stream)) => Some(stream.buffered_frames()),
        Some(CallbackSource::StemStream(stream)) => Some(stream.buffered_frames()),
        _ => None,
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

fn stream_packet_past_loop_out(media_time: f64, loop_out: Option<f64>) -> bool {
    // Half-open frame boundary: the final packet below out belongs to the loop. The former 100 µs
    // tolerance discarded several valid 48 kHz frames on every cycle and made short loops drift.
    loop_out.is_some_and(|out| media_time.is_finite() && media_time >= out)
}

fn stream_packet_loop_generation_is_current(
    state: &StreamPlaybackState,
    source_timing: crate::time_stretch::SourceTiming,
    desired_loop_generation: u64,
    looping: bool,
) -> bool {
    (!looping && !source_timing.loop_active)
        || source_timing.loop_generation == state.loop_generation
        || source_timing.loop_generation == desired_loop_generation
}

fn stream_output_frame<F: FrameLerp>(
    state: &mut StreamPlaybackState,
    stream: &StreamSource<F>,
    output_sample_rate: u32,
    looping: bool,
    loop_out: Option<f64>,
    desired_loop_generation: u64,
    policy: StreamRecoverPolicy,
) -> (F, bool) {
    state.media_advance = 0.0;
    let loop_out = looping.then_some(loop_out).flatten();
    if policy == StreamRecoverPolicy::Immediate {
        loop {
            let Some((frame, media_advance, tempo_revision, source_timing)) =
                stream.pop_callback_timed()
            else {
                state.rebuffering = !stream.ended();
                if state.rebuffering {
                    state.missed_frames = state.missed_frames.saturating_add(1);
                }
                return (F::silence(), false);
            };
            if !stream_packet_loop_generation_is_current(
                state,
                source_timing,
                desired_loop_generation,
                looping,
            ) {
                continue;
            }
            // LOOP on must never play the linear look-ahead past out (blue zone behind the needle).
            if stream_packet_past_loop_out(source_timing.media_time, loop_out) {
                continue;
            }
            state.rebuffering = false;
            state.missed_frames = 0;
            state.media_advance = f64::from(media_advance);
            state.tempo_revision = tempo_revision;
            state.media_time = source_timing.media_time;
            state.loop_generation = source_timing.loop_generation;
            state.loop_active = source_timing.loop_active;
            state.loop_wrapped = source_timing.loop_wrapped;
            return (frame, true);
        }
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

    loop {
        let Some((frame, media_advance, tempo_revision, source_timing)) =
            stream.pop_callback_timed()
        else {
            state.rebuffering = !stream.ended();
            if state.rebuffering {
                state.missed_frames = state.missed_frames.saturating_add(1);
            }
            return (F::silence(), false);
        };
        if !stream_packet_loop_generation_is_current(
            state,
            source_timing,
            desired_loop_generation,
            looping,
        ) {
            continue;
        }
        if stream_packet_past_loop_out(source_timing.media_time, loop_out) {
            if stream.buffered_frames() == 0 && !stream.ended() {
                state.rebuffering = true;
                state.missed_frames = state.missed_frames.saturating_add(1);
                return (F::silence(), false);
            }
            continue;
        }
        state.media_advance = f64::from(media_advance);
        state.tempo_revision = tempo_revision;
        state.media_time = source_timing.media_time;
        state.loop_generation = source_timing.loop_generation;
        state.loop_active = source_timing.loop_active;
        state.loop_wrapped = source_timing.loop_wrapped;
        return (frame, true);
    }
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
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
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
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Cancel,
                velocity: 0.0,
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
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        let mut held = [9.0; 4];
        renderer.render_tracks(&track, &silent, &mut held, 48_000, 2);
        assert!(
            held.iter().any(|sample| sample.abs() > 0.0),
            "a stationary held platter must keep speaking the grain under the needle"
        );
        assert_eq!(controller.snapshot().deck_frames[0], frozen);

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 0.625,
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
    fn paused_platter_scratch_is_audible_without_changing_play_intent() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 0.625,
            })
            .unwrap();

        let mut scratched = vec![0.0; 4_000];
        renderer.render_tracks(&track, &silent, &mut scratched, 48_000, 2);
        let snapshot = controller.snapshot();
        assert!(scratched.iter().any(|sample| sample.abs() > 0.0));
        assert!(
            snapshot.deck_frames[0] > 0,
            "a paused platter must move with the tick instead of waiting for note-off"
        );
        assert!(
            !snapshot.playing,
            "scratch must not become a global Play command"
        );
        assert!(
            !snapshot.deck_playing[0],
            "the paused Deck must stay logically paused"
        );
    }

    #[test]
    fn paused_deck_b_platter_can_pull_frame_zero_into_negative_preroll() {
        let (mut controller, mut renderer) = command_channel(8);
        let silent =
            DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(48_000), 48_000).unwrap();
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::B,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::B,
                phase: PlatterPhase::Move,
                velocity: -1.0,
            })
            .unwrap();
        renderer.render_tracks(&silent, &track, &mut vec![0.0; 4_096], 48_000, 2);

        let snapshot = controller.snapshot();
        assert_eq!(snapshot.deck_frames[0], 0, "Deck A must remain untouched");
        assert!(
            snapshot.deck_frames[1] < -500,
            "paused Deck B must own the same negative timeline as Deck A, got {}",
            snapshot.deck_frames[1]
        );
        assert!(
            !snapshot.deck_playing[1],
            "platter motion is not a hidden Play command"
        );
        assert!(snapshot.deck_scratch_held[1]);
    }

    #[test]
    fn platter_start_anchors_without_consuming_a_fractional_nudge_frame() {
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
        controller
            .send(RtCommand::SetDeckPhaseCorrection {
                deck: DeckId::A,
                multiplier: 1.18,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 1_024], 48_000, 2);
        let before = renderer.deck_positions[0];
        assert!(renderer.deck_phase_corrections[0] > 1.0);

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut [0.0; 2], 48_000, 2);

        assert_eq!(renderer.deck_positions[0], before);
        assert_eq!(renderer.deck_phase_corrections[0], 1.0);
        assert_eq!(renderer.deck_phase_correction_remaining[0], 0);
    }

    #[test]
    fn light_touch_release_resumes_play_immediately() {
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
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 24_000], 48_000, 2);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 64], 48_000, 2);
        let frozen = controller.snapshot().deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 0.0,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 128], 48_000, 2);
        let snapshot = controller.snapshot();
        assert!(
            !snapshot.deck_scratch_held[0],
            "decoded tap leaves the scratch voice instead of a vinyl motor ramp"
        );
        assert!(
            (snapshot.deck_audible_rates[0] - 1.0).abs() < 0.05,
            "play speed must return immediately, got {}",
            snapshot.deck_audible_rates[0]
        );
        assert!(
            snapshot.deck_frames[0] >= frozen + 50,
            "the needle must be walking at play speed after a tap ({frozen} -> {})",
            snapshot.deck_frames[0]
        );

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        // A few encoder jitter ticks must still count as a light touch, not a throw.
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 0.10416666666666667,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 32], 48_000, 2);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 0.10416666666666667,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 128], 48_000, 2);
        let again = controller.snapshot();
        assert!(
            (again.deck_audible_rates[0] - 1.0).abs() < 0.05,
            "repeated taps must not stack a slower and slower startup, got {}",
            again.deck_audible_rates[0]
        );
    }

    #[test]
    fn streaming_light_touch_hands_back_at_the_buffered_head() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(32_768);
        for frame in 0..24_000 {
            let sample = 0.2 + (frame as f32 / 24_000.0) * 0.6;
            writer.push([sample, -sample], || false).unwrap();
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
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_prepared(&mut vec![0.0; 8_000], 48_000, 1);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        renderer.render_prepared(&mut vec![0.0; 64], 48_000, 1);
        let frozen = controller.snapshot().deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 0.0,
            })
            .unwrap();
        let mut out = vec![0.0; 2_048];
        renderer.render_prepared(&mut out, 48_000, 1);
        let snapshot = controller.snapshot();
        assert!(
            !snapshot.deck_scratch_held[0],
            "a tap already at the buffered head should leave the temporary scratch voice"
        );
        assert!(
            (snapshot.deck_audible_rates[0] - 1.0).abs() < 0.08,
            "streaming tap must snap to play speed, got {}",
            snapshot.deck_audible_rates[0]
        );
        assert!(
            snapshot.deck_frames[0] >= frozen + 1_000,
            "playthrough must keep walking ({frozen} -> {})",
            snapshot.deck_frames[0]
        );
        assert!(
            out.iter().any(|sample| sample.abs() > 0.05),
            "scratch-tape playthrough must keep speaking after a light lift"
        );
    }

    #[test]
    fn streaming_throw_catches_the_buffered_head_after_inertia() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(750_000);
        for frame in 0..700_000 {
            let sample = 0.2 + (frame as f32 / 700_000.0) * 0.6;
            writer.push([sample, -sample], || false).unwrap();
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
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_prepared(&mut vec![0.0; 8_000], 48_000, 1);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 8.0,
            })
            .unwrap();
        renderer.render_prepared(&mut vec![0.0; 64], 48_000, 1);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 8.0,
            })
            .unwrap();
        // Vinyl mass approaches transport asymptotically; wait until the handoff snaps.
        let mut audible = 0.0_f32;
        for _ in 0..40 {
            renderer.render_prepared(&mut vec![0.0; 24_000], 48_000, 1);
            audible = controller.snapshot().deck_audible_rates[0];
            if (audible - 1.0).abs() < 0.1 {
                break;
            }
        }
        assert!(
            (audible - 1.0).abs() < 0.1,
            "throw coast must settle onto play speed, got {audible}"
        );
        // Well past parked-finger still-friction (160ms). Playthrough must not brake to 0.
        renderer.render_prepared(&mut vec![0.0; 24_000], 48_000, 1);
        let settled = controller.snapshot();
        assert!(
            !settled.deck_scratch_held[0],
            "once cached history catches the source head, scratch ownership must end"
        );
        assert!(
            (settled.deck_audible_rates[0] - 1.0).abs() < 0.1,
            "after inertia settles, play speed must stick — still-friction must not brake to 0, got {}",
            settled.deck_audible_rates[0]
        );
        let at = settled.deck_frames[0];
        renderer.render_prepared(&mut vec![0.0; 8_000], 48_000, 1);
        assert!(
            controller.snapshot().deck_frames[0] > at + 4_000,
            "playthrough must keep walking after the coast window"
        );
    }

    #[test]
    fn paused_deck_reports_zero_audible_rate() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(8_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0; 8].to_vec(), 48_000).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 1_024], 48_000, 2);
        assert!((controller.snapshot().deck_audible_rates[0] - 1.0).abs() < 0.05);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: false,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 1_024], 48_000, 2);
        assert!(
            controller.snapshot().deck_audible_rates[0].abs() < 0.02,
            "a parked Deck must not publish TEMPO as audible rate, got {}",
            controller.snapshot().deck_audible_rates[0]
        );
    }

    #[test]
    fn a_fast_jog_burst_accelerates_instead_of_teleporting_to_the_hand() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(96_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        // A high-magnitude Reloop packet is a speed observation. It must ramp toward 8x rather
        // than applying all encoded distance as an absolute playhead target.
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 8.0,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 768], 48_000, 2);
        let frames = controller.snapshot().deck_frames[0];
        assert!(
            frames > 700 && frames < 3_000,
            "a flick should accelerate the platter, not teleport to a hand target, got {frames}"
        );
        assert!(
            controller.snapshot().deck_audible_rates[0] > 2.0,
            "the 10ms anti-jitter response must still feel like an immediate fast throw"
        );
    }

    #[test]
    fn scratch_release_coasts_instead_of_jumping_to_transport_in_five_milliseconds() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(480_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 24_000], 48_000, 2);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: -6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 64], 48_000, 2);
        let released_at = controller.snapshot().deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: -6.25,
            })
            .unwrap();
        let mut bridge = vec![0.0; 2_000];
        renderer.render_tracks(&track, &silent, &mut bridge, 48_000, 2);
        let snapshot = controller.snapshot();
        assert!(
            snapshot.deck_scratch_held[0],
            "Mixxx keeps scratch2_enable on through the disable ramp"
        );
        assert!(
            snapshot.deck_audible_rates[0] < 0.5,
            "vinyl mass must not snap back to +1x in a handful of milliseconds, got {}",
            snapshot.deck_audible_rates[0]
        );
        assert!(
            bridge.iter().any(|sample| sample.abs() > 0.05),
            "coasting reverse must keep speaking already-decoded PCM"
        );
        assert!(snapshot.deck_frames[0] < released_at);

        renderer.render_tracks(&track, &silent, &mut vec![0.0; 192_000], 48_000, 2);
        let settled = controller.snapshot();
        assert!(
            settled.deck_audible_rates[0] > snapshot.deck_audible_rates[0],
            "a playing spin-back must be ramping back toward transport, got {} from {}",
            settled.deck_audible_rates[0],
            snapshot.deck_audible_rates[0]
        );
        assert!(settled.deck_playing[0]);
    }

    #[test]
    fn scratch_tape_keeps_history_across_reverse_lookups() {
        let mut tape = ScratchTape::new();
        tape.push_at(0.0, [0.0, 0.0], 1.0);
        tape.push_at(1.0, [1.0, -1.0], 1.0);
        tape.push_at(2.0, [2.0, -2.0], 1.0);
        let middle = tape.get(0.5);
        assert!((middle[0] - 0.5).abs() < 0.000_1, "{middle:?}");
        assert!((middle[1] + 0.5).abs() < 0.000_1, "{middle:?}");
        assert!(
            tape.get(0.25)[0] > 0.0,
            "a reverse lookup must replay history instead of going silent"
        );

        tape.push_at(1.0, [1.0, -1.0], 1.0);
        assert!(
            (tape.get(0.5)[0] - 0.5).abs() < 0.000_1,
            "rewriting an interior frame must not wipe earlier vinyl history"
        );
        assert_eq!(tape.end_position(), Some(3.0));

        tape.push_at(4.0, [4.0, -4.0], 1.0);
        tape.push_at(3.0, [3.0, -3.0], 1.0);
        assert_eq!(tape.get(4.0)[0], 4.0);
        assert!(
            (tape.get(0.5)[0] - 0.5).abs() < 0.000_1,
            "appending and filling a one-frame hole must keep earlier history"
        );

        tape.push_at(8.0, [8.0, -8.0], 4.0);
        assert!(
            (tape.get(6.0)[0] - 6.0).abs() < 0.000_1,
            "tempo gaps must interpolate neighbouring PCM instead of repeating one held sample"
        );

        tape.push_at(10_000.0, [0.4, 0.4], 1.0);
        assert_eq!(
            tape.end_position(),
            Some(10_001.0),
            "a far seek starts a new cache window"
        );
        assert_eq!(tape.get(0.5), [0.0, 0.0]);
    }

    #[test]
    fn callback_snapshot_carries_dac_presentation_time() {
        let (controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        let mut output = [0.0; 480];
        renderer.render_prepared_timed(
            &mut output,
            48_000,
            1,
            OutputCallbackTiming {
                callback_time_ns: 1_000_000,
                playback_time_ns: 2_000_000,
            },
        );
        let snapshot = controller.snapshot();
        assert_eq!(snapshot.callback_time_ns, 1_000_000);
        assert_eq!(snapshot.presentation_time_ns, 12_000_000);
        assert_eq!(snapshot.output_sample_rate, 48_000);
    }

    #[test]
    fn held_platter_keeps_spinning_between_ticks_instead_of_stopping_on_the_hand() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 1.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 480], 48_000, 2);
        let after_tick = controller.snapshot().deck_frames[0];
        assert!(after_tick > 0, "the first tick must start the platter");

        renderer.render_tracks(&track, &silent, &mut vec![0.0; 480], 48_000, 2);
        let between = controller.snapshot().deck_frames[0];
        assert!(
            between > after_tick,
            "between ticks the needle must keep integrating velocity ({after_tick} -> {between})"
        );

        renderer.render_tracks(&track, &silent, &mut vec![0.0; 192_000], 48_000, 2);
        let parked = controller.snapshot().deck_frames[0];
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 4_000], 48_000, 2);
        assert!(
            (controller.snapshot().deck_frames[0] - parked).abs() <= 2,
            "a parked finger must friction to rest, not keep flying"
        );
    }

    #[test]
    fn sparse_platter_observation_keeps_its_device_derived_lifetime() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::UpdateDeckPlatter {
                deck: DeckId::A,
                velocity: 0.25,
                valid_for_seconds: 0.25,
            })
            .unwrap();

        renderer.render_tracks(&track, &silent, &mut vec![0.0; 480], 48_000, 2);
        let first = controller.snapshot().deck_frames[0];
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 17_280], 48_000, 2);
        let after_180_ms = controller.snapshot().deck_frames[0];
        assert!(
            after_180_ms > first + 1_000,
            "a low-speed encoder interval above 100ms must not self-brake"
        );

        renderer.render_tracks(&track, &silent, &mut vec![0.0; 48_000], 48_000, 2);
        let parked = controller.snapshot().deck_frames[0];
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 9_600], 48_000, 2);
        assert!(
            (controller.snapshot().deck_frames[0] - parked).abs() <= 2,
            "the same observation must still expire and settle after its 250ms horizon"
        );
    }

    #[test]
    fn releasing_while_the_platter_is_still_spinning_coasts() {
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
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 8_000], 48_000, 2);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 6.25,
            })
            .unwrap();
        // One 10ms response window is enough to distinguish a real throw from contact jitter.
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 960], 48_000, 2);
        let spinning = controller.snapshot();
        assert!(
            spinning.deck_audible_rates[0] > 0.5,
            "release must happen while the platter still has throw velocity, got {}",
            spinning.deck_audible_rates[0]
        );
        let at_release = spinning.deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 8_000], 48_000, 2);
        let coasting = controller.snapshot();
        assert!(
            coasting.deck_frames[0] > at_release,
            "note-off must keep integrating the throw ({at_release} -> {})",
            coasting.deck_frames[0]
        );
        assert!(
            coasting.deck_playing[0],
            "playing throw coast keeps transport intent"
        );
    }

    #[test]
    fn atomic_midi_note_off_preserves_final_velocity_after_delivery_gap() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(480_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 8_000], 48_000, 2);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 960], 48_000, 2);
        let spinning = controller.snapshot();
        assert!(
            spinning.deck_audible_rates[0] > 0.5,
            "the throw must be armed before the capacitive lift gap, got {}",
            spinning.deck_audible_rates[0]
        );
        // Simulate 220 ms of IPC/event delay. End carries the source-timestamped final velocity,
        // so callback idling before delivery cannot turn the throw into zero.
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 10_560], 48_000, 2);
        let at_release = controller.snapshot().deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 8_000], 48_000, 2);
        let coasting = controller.snapshot();
        assert!(
            coasting.deck_frames[0] > at_release + 1_000,
            "note-off after a MIDI-sized gap must keep the throw ({at_release} -> {})",
            coasting.deck_frames[0]
        );
        assert!(
            coasting.deck_audible_rates[0].abs() > 0.2,
            "the restored throw must still be audible, got {}",
            coasting.deck_audible_rates[0]
        );
    }

    #[test]
    fn maximum_pointer_velocity_stays_inside_decoded_audio() {
        let (mut controller, mut renderer) = command_channel(8);
        let samples: Vec<f32> = (0..48_000)
            .flat_map(|index| {
                let value = (index as f32 / 48_000.0) * 0.8 + 0.1;
                [value, -value]
            })
            .collect();
        let track = DecodedTrack::from_interleaved_stereo(samples, 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 8.0,
            })
            .unwrap();
        let mut scratched = vec![0.0; 4_000];
        renderer.render_tracks(&track, &silent, &mut scratched, 48_000, 2);
        let peak = scratched
            .iter()
            .copied()
            .map(f32::abs)
            .fold(0.0_f32, f32::max);
        assert!(
            peak > 0.05,
            "a maximum-speed flick must keep speaking instead of snapping past the file, peak={peak}"
        );
        let frames = controller.snapshot().deck_frames[0];
        assert!(
            frames <= 48_000,
            "velocity clamp must keep the needle inside already-decoded PCM, got {frames}"
        );
    }

    #[test]
    fn paused_scratch_release_coasts_to_rest_without_starting_transport() {
        let (mut controller, mut renderer) = command_channel(8);
        let track =
            DecodedTrack::from_interleaved_stereo([0.5, -0.5].repeat(48_000), 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 64], 48_000, 2);
        let at_release = controller.snapshot().deck_frames[0];
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::End,
                velocity: 6.25,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 8_000], 48_000, 2);
        let coasting = controller.snapshot();
        assert!(coasting.deck_scratch_held[0]);
        assert!(coasting.deck_frames[0] > at_release);
        for _ in 0..20 {
            renderer.render_tracks(&track, &silent, &mut vec![0.0; 24_000], 48_000, 2);
            if !controller.snapshot().deck_scratch_held[0] {
                break;
            }
        }
        let settled = controller.snapshot();
        assert!(
            !settled.deck_scratch_held[0],
            "paused throw must eventually release the scratch voice"
        );
        assert!(
            !settled.deck_playing[0],
            "paused coast must not become a hidden Play command"
        );
        assert!(
            settled.deck_audible_rates[0].abs() < 0.02,
            "paused lift must report zero audible rate, got {}",
            settled.deck_audible_rates[0]
        );
        assert!(
            settled.deck_frames[0] > at_release,
            "paused throw should coast audibly before stopping ({at_release} -> {})",
            settled.deck_frames[0]
        );
        let mut parked = vec![1.0; 512];
        renderer.render_tracks(&track, &silent, &mut parked, 48_000, 2);
        assert!(
            parked.iter().all(|sample| sample.abs() < f32::EPSILON),
            "a settled paused platter must be silent"
        );
    }

    #[test]
    fn held_scratch_keeps_speaking_between_ticks() {
        let (mut controller, mut renderer) = command_channel(8);
        let samples: Vec<f32> = (0..48_000)
            .flat_map(|index| {
                let value = (index as f32 / 48_000.0) * 0.8 + 0.1;
                [value, -value]
            })
            .collect();
        let track = DecodedTrack::from_interleaved_stereo(samples, 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 0.625,
            })
            .unwrap();
        let mut first = vec![0.0; 2_000];
        renderer.render_tracks(&track, &silent, &mut first, 48_000, 2);
        let mut gap = vec![0.0; 2_000];
        renderer.render_tracks(&track, &silent, &mut gap, 48_000, 2);
        assert!(
            gap.iter().any(|sample| sample.abs() > 0.05),
            "between ticks the platter must keep speaking the moving grain, not digital zero"
        );
    }

    #[test]
    fn reverse_platter_scratch_stays_audible_instead_of_dropping_to_silence() {
        let (mut controller, mut renderer) = command_channel(8);
        let samples: Vec<f32> = (0..48_000)
            .flat_map(|index| {
                let value = (index as f32 / 48_000.0) * 0.8 + 0.1;
                [value, -value]
            })
            .collect();
        let track = DecodedTrack::from_interleaved_stereo(samples, 48_000).unwrap();
        let silent = DecodedTrack::from_interleaved_stereo([0.0, 0.0].repeat(8), 48_000).unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_tracks(&track, &silent, &mut vec![0.0; 24_000], 48_000, 2);
        let started = controller.snapshot().deck_frames[0];
        assert!(started > 1_000);

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: -8.0,
            })
            .unwrap();
        let mut reversed = vec![0.0; 512];
        renderer.render_tracks(&track, &silent, &mut reversed, 48_000, 2);
        assert!(
            reversed.iter().any(|sample| sample.abs() > 0.05),
            "reverse vinyl must keep speaking from already-decoded PCM"
        );
        let after_reverse = controller.snapshot().deck_frames[0];
        assert!(after_reverse < started, "{after_reverse} vs {started}");

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 6.25,
            })
            .unwrap();
        let mut forward = vec![0.0; 512];
        renderer.render_tracks(&track, &silent, &mut forward, 48_000, 2);
        assert!(
            forward.iter().any(|sample| sample.abs() > 0.05),
            "a direction change must retarget rate, not output a silent gap"
        );
    }

    #[test]
    fn streaming_reverse_scratch_replays_tape_instead_of_going_silent() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(32_768);
        for frame in 0..16_000 {
            let sample = 0.2 + (frame as f32 / 16_000.0) * 0.6;
            writer.push([sample, -sample], || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                91,
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

        renderer.render_prepared(&mut vec![0.0; 8_000], 48_000, 1);
        let started = controller.snapshot().deck_frames[0];
        assert!(
            started > 7_000,
            "forward stream must fill vinyl history first"
        );
        let consumed_before_hold = stream.consumed_frames();

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: -8.0,
            })
            .unwrap();
        let mut reversed = vec![0.0; 512];
        renderer.render_prepared(&mut reversed, 48_000, 1);
        assert!(
            reversed.iter().any(|sample| sample.abs() > 0.05),
            "streaming reverse must speak ScratchTape history, not digital zero"
        );
        let after_reverse = controller.snapshot().deck_frames[0];
        assert!(after_reverse < started, "{after_reverse} vs {started}");
        assert_eq!(
            stream.consumed_frames(),
            consumed_before_hold,
            "a reverse lookup inside the tape must not consume the forward ring"
        );

        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 5.208333333333333,
            })
            .unwrap();
        let mut forward = vec![0.0; 512];
        renderer.render_prepared(&mut forward, 48_000, 1);
        assert!(
            forward.iter().any(|sample| sample.abs() > 0.05),
            "turning the stream platter the other way must not wipe tape into silence"
        );
        let longest_silence = longest_near_zero_run(&reversed) + longest_near_zero_run(&forward);
        assert!(
            longest_silence < 32,
            "back-and-forth streaming scratch must not insert a digital-zero gap, longest={longest_silence}"
        );
        drop(writer);
    }

    #[test]
    fn prepared_stream_can_cross_its_decode_origin_into_negative_preroll() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(256);
        for _ in 0..128 {
            writer.push([0.4, -0.4], || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        let cue_frame = 48_000;
        controller
            .install_prepared(
                DeckId::B,
                93,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                cue_frame,
            )
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::B,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::B,
                phase: PlatterPhase::Move,
                velocity: -8.0,
            })
            .unwrap();

        renderer.render_prepared(&mut vec![0.0; 16_000], 48_000, 1);

        assert!(
            controller.snapshot().deck_frames[1] < 0,
            "a paused prepared Deck must pass its cue/cache edge and own signed pre-roll"
        );
        assert!(controller.snapshot().deck_scratch_held[1]);
        drop(writer);
    }

    #[test]
    fn fast_streaming_platter_holds_real_audio_when_future_pcm_is_not_ready() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(512);
        for _ in 0..256 {
            writer.push([0.4, -0.4], || false).unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                92,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                0,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        renderer.render_prepared(&mut vec![0.0; 128], 48_000, 1);
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Start,
                velocity: 0.0,
            })
            .unwrap();
        controller
            .send(RtCommand::ControlDeckPlatter {
                deck: DeckId::A,
                phase: PlatterPhase::Move,
                velocity: 8.0,
            })
            .unwrap();
        let mut output = vec![0.0; 1_024];
        renderer.render_prepared(&mut output, 48_000, 1);

        assert!(
            output.iter().any(|sample| sample.abs() > 0.2),
            "a depleted future ring must hold the last real grain, not switch to digital zero"
        );
        assert!(
            controller.snapshot().deck_frames[0] <= 256,
            "the audio-authority cursor must not run beyond prepared PCM"
        );
        drop(writer);
    }

    fn longest_near_zero_run(samples: &[f32]) -> usize {
        let mut longest = 0;
        let mut current = 0;
        for sample in samples {
            if sample.abs() < 0.02 {
                current += 1;
                longest = longest.max(current);
            } else {
                current = 0;
            }
        }
        longest
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
    fn negative_preroll_is_silent_then_releases_source_frame_zero() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckPreroll {
                deck: DeckId::A,
                frames: 3,
            })
            .unwrap();

        let mut output = [0.0; 6];
        renderer.render(&[1.0; 6], &[], &mut output, 1);

        assert_eq!(&output[..3], &[0.0; 3]);
        assert_eq!(&output[3..], &[1.0; 3]);
        assert_eq!(controller.snapshot().deck_frames[0], 3);
    }

    #[test]
    fn pfl_uses_output_pair_three_four_before_the_channel_fader() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
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
            .send(RtCommand::SetDeckPfl {
                deck: DeckId::A,
                enabled: true,
            })
            .unwrap();

        let mut output = [0.0; 4];
        renderer.render(&[0.8, 0.4, 0.0, 0.0], &[], &mut output, 4);

        assert_eq!(&output[..2], &[0.0, 0.0], "channel fader mutes only master");
        assert!((output[2] - 0.8).abs() < 0.000_01);
        assert!((output[3] - 0.4).abs() < 0.000_01);
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
    fn manual_echo_fx_is_audible_after_its_beat_synced_delay() {
        let (mut controller, mut renderer) = command_channel(8);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        controller
            .send(RtCommand::SetDeckFx {
                deck: DeckId::A,
                slots: [
                    crate::DeckFxSlot {
                        kind: crate::DeckFxKind::Echo,
                        enabled: true,
                        mix: 1.0,
                        parameter: 0.0,
                    },
                    crate::DeckFxSlot::default(),
                    crate::DeckFxSlot::default(),
                ],
                pad: 0,
                beat_seconds: 0.1,
            })
            .unwrap();
        // Let the newly selected PARAMETER/MIX controls finish their click-free ramp before the
        // probe impulse, otherwise the changing delay time intentionally sweeps past that impulse.
        renderer.render(&[0.0; 600], &[], &mut [0.0; 600], 1);
        let mut input = vec![0.0; 1_000];
        input[0] = 1.0;
        let mut output = vec![0.0; input.len()];
        renderer.render(&input, &[], &mut output, 1);
        assert!(
            output.iter().skip(500).any(|sample| sample.abs() > 0.01),
            "the manual echo must produce a delayed wet sample",
        );
    }

    #[test]
    fn realtime_peak_snapshot_preserves_over_zero_dbfs_values() {
        let (mut controller, mut renderer) = command_channel(4);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        let mut output = [0.0; 16];
        renderer.render(&[1.2; 16], &[], &mut output, 1);
        assert!(controller.snapshot().deck_peak_levels[0] >= 1.2);
    }

    #[test]
    fn realtime_snapshot_exposes_independent_post_eq_spectrum_bands() {
        let (mut controller, mut renderer) = command_channel(4);
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        let input = (0..12_000)
            .map(|frame| (std::f32::consts::TAU * 1_000.0 * frame as f32 / 48_000.0).sin() * 0.5)
            .collect::<Vec<_>>();
        let mut output = vec![0.0; input.len()];
        renderer.render(&input, &[], &mut output, 1);
        let snapshot = controller.snapshot();
        let strongest = snapshot.deck_spectrum_levels[0]
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(index, _)| index);
        assert_eq!(strongest, Some(7));
        assert_eq!(
            snapshot.deck_spectrum_levels[1],
            [0.0; crate::EQ_SPECTRUM_BANDS]
        );
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
        // Deck spectrum and scratch commands carry fixed arrays; keep the enum within half a
        // cache line while preserving the no-allocation realtime contract.
        assert!(std::mem::size_of::<RtCommand>() <= 64);
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
        assert_eq!(controller.snapshot().deck_output_underruns[0], 1);
        assert!(
            controller.snapshot().deck_min_buffered_frames[0] <= 2,
            "callback-boundary minimum should expose the exhausted cushion"
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
    fn linked_deck_rates_are_applied_in_one_callback_command() {
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .send(RtCommand::SetDeckRates { rates: [1.2, 0.8] })
            .unwrap();
        let mut output = [0.0; 2];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!((renderer.deck_rates[0] - 1.2).abs() < 1e-6);
        assert!((renderer.deck_rates[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn streaming_clock_uses_the_rate_carried_by_post_stretch_pcm() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        for _ in 0..12_000 {
            writer
                .push_with_media_timing([0.5, 0.5], 1.5, 42, f64::NAN, || false)
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
        let snapshot = controller.snapshot();
        assert!((snapshot.deck_frames[0] as i64 - 768).abs() <= 2);
        assert!((snapshot.deck_audible_rates[0] - 1.5).abs() < 0.000_1);
        assert_eq!(snapshot.deck_audible_rate_revisions[0], 42);
        drop(writer);
    }

    #[test]
    fn callback_phase_correction_resamples_buffered_pcm_without_retargeting_rubber_band() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        for frame in 0..12_000 {
            let sample = frame as f32 / 12_000.0;
            writer
                .push_with_media_timing([sample, sample], 1.0, 7, f64::NAN, || false)
                .unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                79,
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
        controller
            .send(RtCommand::SetDeckPhaseCorrection {
                deck: DeckId::A,
                multiplier: 1.01,
            })
            .unwrap();

        let mut output = [0.0; 480];
        renderer.render_prepared(&mut output, 48_000, 1);
        let snapshot = controller.snapshot();
        assert!(output[100..].windows(2).all(|pair| pair[1] >= pair[0]));
        assert!((snapshot.deck_frames[0] - 484).abs() <= 2);
        assert!((snapshot.deck_audible_rates[0] - 1.01).abs() < 0.000_1);
        assert_eq!(snapshot.deck_audible_rate_revisions[0], 7);
        assert!(stream.consumed_frames() <= 486);
        drop(writer);
    }

    #[test]
    fn repeated_sync_phase_corrections_do_not_starve_a_live_r3_ring() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::{Duration, Instant};

        let sample_rate = 12_000u32;
        let (stream, writer) = StreamSource::<[f32; 2]>::bounded(sample_rate as usize / 2);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker = std::thread::spawn(move || {
            let cancelled: Arc<dyn Fn() -> bool + Send + Sync> =
                Arc::new(move || worker_cancel.load(Ordering::Acquire));
            crate::stream::run_pitch_preserving_pipeline(
                crate::TempoControl::new(0.9),
                sample_rate,
                sample_rate as usize,
                writer,
                move |mut raw, cancelled| {
                    for frame in 0..sample_rate as usize * 3 {
                        let sample = (frame as f32 * 0.013).sin() * 0.5;
                        raw.push([sample, sample], || cancelled())?;
                    }
                    raw.finish();
                    Ok(crate::stream::StreamMetadata {
                        duration: Some(3.0),
                        source_sample_rate: sample_rate,
                        output_sample_rate: sample_rate,
                    })
                },
                cancelled,
                None,
                None,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while stream.buffered_frames() < u64::from(sample_rate) / 10 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(stream.buffered_frames() >= u64::from(sample_rate) / 10);

        let (mut controller, mut renderer, _retired) = dynamic_command_channel(32, 8);
        controller
            .install_prepared(
                DeckId::A,
                80,
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
        for step in 0..50 {
            let multiplier = if step % 2 == 0 { 0.99 } else { 1.01 };
            controller
                .send(RtCommand::SetDeckPhaseCorrection {
                    deck: DeckId::A,
                    multiplier,
                })
                .unwrap();
            let mut output = vec![0.0; sample_rate as usize / 50];
            renderer.render_prepared(&mut output, sample_rate, 1);
            assert!(output.iter().all(|sample| sample.is_finite()));
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(controller.snapshot().deck_output_underruns[0], 0);
        cancel.store(true, Ordering::Release);
        let _ = worker.join();
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
                generation: 2,
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
        assert_eq!(
            controller.snapshot().deck_discontinuity_revisions[0],
            1,
            "a natural decoded loop wrap is not a seek"
        );
    }

    #[test]
    fn redundant_set_deck_loop_does_not_bump_discontinuity() {
        let region =
            Arc::new(DecodedTrack::from_interleaved_stereo([0.5, 0.5].repeat(96), 48_000).unwrap());
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                70,
                SourceKind::Decoded,
                Arc::as_ptr(&region) as usize,
                0,
            )
            .unwrap();
        let mut output = [0.0; 32];
        renderer.render_prepared(&mut output, 48_000, 1);
        let after_install = controller.snapshot().deck_discontinuity_revisions[0];
        assert!(after_install >= 1);
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                generation: 2,
                looping: false,
                start_frames: 0,
                frames: 0,
            })
            .unwrap();
        renderer.render_prepared(&mut output, 48_000, 1);
        assert_eq!(
            controller.snapshot().deck_discontinuity_revisions[0],
            after_install,
            "install already cleared the loop; repeating SetDeckLoop(false) must not look like a seek"
        );
    }

    #[test]
    fn arming_loop_inside_the_window_does_not_bump_discontinuity() {
        let region = Arc::new(
            DecodedTrack::from_interleaved_stereo([0.5, 0.5].repeat(480), 48_000).unwrap(),
        );
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                71,
                SourceKind::Decoded,
                Arc::as_ptr(&region) as usize,
                24,
            )
            .unwrap();
        let mut output = [0.0; 32];
        renderer.render_prepared(&mut output, 48_000, 1);
        let after_install = controller.snapshot().deck_discontinuity_revisions[0];
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                generation: 2,
                looping: true,
                start_frames: 0,
                frames: 96,
            })
            .unwrap();
        renderer.render_prepared(&mut output, 48_000, 1);
        assert_eq!(
            controller.snapshot().deck_discontinuity_revisions[0],
            after_install,
            "arming LOOP while the cursor is inside the window is not a seek"
        );
        assert!(
            (controller.snapshot().deck_frames[0] - 24).abs() < 32,
            "arming LOOP must not wrap the playhead back to loop-in"
        );
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
                generation: 2,
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

    #[test]
    fn streaming_fifo_playhead_follows_packet_media_time_through_loop_out() {
        let sample_rate = 48_000u32;
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        let loop_start = 1.0;
        let loop_length = 0.1;
        let loop_end = loop_start + loop_length;
        for frame in 0..12_000 {
            let linear = loop_start + f64::from(frame) / f64::from(sample_rate);
            let cycles = ((linear - loop_start) / loop_length).floor();
            let media_time = loop_start + (linear - loop_start - cycles * loop_length);
            writer
                .push_with_transport_timing(
                    [0.5, 0.5],
                    1.0,
                    0,
                    crate::time_stretch::SourceTiming {
                        media_time,
                        loop_generation: 2,
                        loop_active: true,
                        loop_wrapped: frame > 0 && frame % 4_800 == 0,
                    },
                    || false,
                )
                .unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                80,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                (loop_start * f64::from(sample_rate)).round() as u64,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                generation: 2,
                looping: true,
                start_frames: (loop_start * f64::from(sample_rate)).round() as u64,
                frames: (loop_length * f64::from(sample_rate)).round() as u64,
            })
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();

        let mut output = [0.0; 6_000];
        renderer.render_prepared(&mut output, sample_rate, 1);
        let playhead = controller.snapshot().deck_frames[0] as f64 / f64::from(sample_rate);
        assert!(
            playhead >= loop_start && playhead < loop_end,
            "stream playhead must stay inside the armed window, got {playhead}"
        );
        assert_eq!(
            controller.snapshot().deck_discontinuity_revisions[0],
            1,
            "FIFO loop wrap must not bump discontinuity"
        );
        assert!(controller.snapshot().deck_loop_active[0]);
        assert_eq!(controller.snapshot().deck_loop_generations[0], 2);
        assert!(controller.snapshot().deck_loop_wrap_counts[0] >= 1);
        drop(writer);
    }

    #[test]
    fn disabled_loop_generation_from_a_reused_window_does_not_starve_new_source() {
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(1_024);
        for frame in 0..512 {
            writer
                .push_with_transport_timing(
                    [0.4, -0.4],
                    1.0,
                    0,
                    crate::time_stretch::SourceTiming {
                        media_time: frame as f64 / 48_000.0,
                        loop_generation: 6,
                        loop_active: false,
                        loop_wrapped: false,
                    },
                    || false,
                )
                .unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                82,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                0,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckPlaying {
                deck: DeckId::A,
                playing: true,
            })
            .unwrap();
        let mut output = [0.0; 256];
        renderer.render_prepared(&mut output, 48_000, 1);
        assert!(output.iter().any(|sample| sample.abs() > 0.1));
        drop(writer);
    }

    #[test]
    fn streaming_callback_discards_look_ahead_past_loop_out() {
        let sample_rate = 48_000u32;
        let (stream, mut writer) = StreamSource::<[f32; 2]>::bounded(16_384);
        let loop_start = 1.0;
        let loop_length = 0.1;
        let loop_end = loop_start + loop_length;
        // Audible ring already holds linear look-ahead past out (pre-arm decode).
        for frame in 0..8_000 {
            let media_time = loop_start + f64::from(frame) / f64::from(sample_rate);
            writer
                .push_with_media_timing([0.25, 0.25], 1.0, 0, media_time, || false)
                .unwrap();
        }
        // Then the decoder's loop-in refill.
        for frame in 0..4_000 {
            let media_time = loop_start + f64::from(frame) / f64::from(sample_rate);
            writer
                .push_with_transport_timing(
                    [0.75, 0.75],
                    1.0,
                    0,
                    crate::time_stretch::SourceTiming {
                        media_time,
                        loop_generation: 2,
                        loop_active: true,
                        loop_wrapped: frame == 0,
                    },
                    || false,
                )
                .unwrap();
        }
        let (mut controller, mut renderer, _retired) = dynamic_command_channel(8, 8);
        controller
            .install_prepared(
                DeckId::A,
                81,
                SourceKind::Stream,
                Arc::as_ptr(&stream) as usize,
                (loop_start * f64::from(sample_rate)).round() as u64,
            )
            .unwrap();
        controller
            .send(RtCommand::SetDeckLoop {
                deck: DeckId::A,
                generation: 2,
                looping: true,
                start_frames: (loop_start * f64::from(sample_rate)).round() as u64,
                frames: (loop_length * f64::from(sample_rate)).round() as u64,
            })
            .unwrap();
        controller
            .send(RtCommand::SetPlaying {
                playing: true,
                fade_frames: 0,
            })
            .unwrap();

        let mut output = [0.0; 8_000];
        renderer.render_prepared(&mut output, sample_rate, 1);
        let playhead = controller.snapshot().deck_frames[0] as f64 / f64::from(sample_rate);
        assert!(
            playhead >= loop_start && playhead < loop_end,
            "callback must skip FIFO past loop-out so the needle stays in the blue zone, got {playhead}"
        );
        assert_eq!(controller.snapshot().deck_loop_generations[0], 2);
        assert!(controller.snapshot().deck_loop_active[0]);
        drop(writer);
    }
}
