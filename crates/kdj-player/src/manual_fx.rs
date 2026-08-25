//! Fixed-allocation manual DJ effects for the realtime renderer.
//!
//! Every slot owns its delay storage up front. Selecting an effect therefore only changes
//! callback-local state; it never allocates, locks, or rebuilds the audio graph.
//!
//! Provenance and scope:
//! - Echo, Flanger, Phaser, Bit Crusher, and beat-volume modulation use the conventional DSP
//!   topologies documented by Mixxx's builtin effects. This is an independent Rust
//!   implementation, not vendored Mixxx code:
//!   <https://github.com/mixxxdj/mixxx/tree/main/src/effects/backends/builtin>.
//! - Reverb uses a reduced Schroeder/Moorer network and public-domain Freeverb delay tunings:
//!   <https://ccrma.stanford.edu/~jos/pasp/Freeverb.html>.
//! - Alarm is KDJ's own siren oscillator. Hydrant and Rocket are KDJ approximations of djay's
//!   proprietary macro effects (shrinking loop + reverb, and filtered input + white noise).
//!   No Algoriddim source code was available or copied.

use std::f32::consts::{PI, TAU};

use crate::{DeckFxKind, DeckFxSlot};

pub(crate) const MANUAL_FX_SLOTS: usize = 3;
/// Bounded manual-delay storage. At the normal 48 kHz output rate this is two seconds per slot;
/// unusually long beat divisions at very low BPM clamp to that realtime-safe ceiling.
const MAX_DELAY_FRAMES: usize = 96_001;
const PARAMETER_RAMP_SECONDS: f32 = 0.012;

pub(crate) struct DeckManualFx {
    slots: [ManualFxSlot; MANUAL_FX_SLOTS],
    pad_slot: ManualFxSlot,
    pad: u8,
    pad_filter_mix: f32,
    pad_filter_target: f32,
    pad_filter_low: [f32; 2],
    beat_seconds: f32,
}

impl DeckManualFx {
    pub(crate) fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| ManualFxSlot::new()),
            pad_slot: ManualFxSlot::new(),
            pad: 0,
            pad_filter_mix: 0.0,
            pad_filter_target: 0.0,
            pad_filter_low: [0.0; 2],
            beat_seconds: 0.5,
        }
    }

    pub(crate) fn configure(
        &mut self,
        slots: [DeckFxSlot; MANUAL_FX_SLOTS],
        pad: u8,
        beat_seconds: f32,
    ) {
        for (state, slot) in self.slots.iter_mut().zip(slots) {
            state.configure(slot);
        }
        self.beat_seconds = if beat_seconds.is_finite() {
            beat_seconds.clamp(0.1, 4.0)
        } else {
            0.5
        };

        let requested_pad = pad.min(8);
        if requested_pad > 0 {
            self.pad = requested_pad;
        }
        self.pad_filter_target = if matches!(requested_pad, 7 | 8) {
            1.0
        } else {
            0.0
        };
        let pad_effect = match requested_pad {
            1 => Some((DeckFxKind::Echo, 0.0)),
            2 => Some((DeckFxKind::Echo, 0.25)),
            3 => Some((DeckFxKind::Reverb, 0.3)),
            4 => Some((DeckFxKind::Reverb, 0.9)),
            5 => Some((DeckFxKind::Gate, 0.5)),
            6 => Some((DeckFxKind::Gate, 0.75)),
            _ => None,
        };
        let slot = match pad_effect {
            Some((kind, parameter)) => DeckFxSlot {
                kind,
                enabled: true,
                mix: 1.0,
                parameter,
            },
            None => DeckFxSlot {
                kind: self.pad_slot.kind,
                enabled: false,
                mix: self.pad_slot.mix_target,
                parameter: self.pad_slot.parameter_target,
            },
        };
        self.pad_slot.configure(slot);
    }

    #[inline]
    pub(crate) fn process(&mut self, mut input: [f32; 2], sample_rate: u32) -> [f32; 2] {
        let sample_rate = sample_rate.max(1);
        for slot in &mut self.slots {
            input = slot.process(input, sample_rate, self.beat_seconds);
        }
        input = self.pad_slot.process(input, sample_rate, self.beat_seconds);

        let ramp = parameter_ramp(sample_rate);
        approach(&mut self.pad_filter_mix, self.pad_filter_target, ramp);
        if self.pad_filter_mix > f32::EPSILON {
            let cutoff = if self.pad == 7 { 700.0 } else { 1_600.0 };
            let alpha = one_pole_alpha(cutoff, sample_rate as f32);
            for channel in 0..2 {
                self.pad_filter_low[channel] +=
                    alpha * (input[channel] - self.pad_filter_low[channel]);
                let filtered = if self.pad == 7 {
                    self.pad_filter_low[channel]
                } else {
                    input[channel] - self.pad_filter_low[channel]
                };
                input[channel] += (filtered - input[channel]) * self.pad_filter_mix;
            }
        }
        if self.pad_filter_target == 0.0
            && self.pad_filter_mix <= f32::EPSILON
            && self.pad_slot.mix_target == 0.0
            && self.pad_slot.mix <= f32::EPSILON
        {
            self.pad = 0;
        }
        input.map(finite_sample)
    }
}

struct ManualFxSlot {
    kind: DeckFxKind,
    enabled: bool,
    mix: f32,
    mix_target: f32,
    parameter: f32,
    parameter_target: f32,
    processor: EffectProcessor,
}

impl ManualFxSlot {
    fn new() -> Self {
        Self {
            kind: DeckFxKind::Echo,
            enabled: false,
            mix: 0.0,
            mix_target: 0.0,
            parameter: 0.5,
            parameter_target: 0.5,
            processor: EffectProcessor::new(),
        }
    }

    fn configure(&mut self, slot: DeckFxSlot) {
        let mix = finite_unit(slot.mix);
        let parameter = finite_unit(slot.parameter);
        let activating = self.mix_target <= f32::EPSILON && slot.enabled && mix > 0.0;
        if self.kind != slot.kind || activating {
            self.processor.reset();
        }
        self.kind = slot.kind;
        self.enabled = slot.enabled;
        self.mix_target = if slot.enabled { mix } else { 0.0 };
        self.parameter_target = parameter;
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], sample_rate: u32, beat_seconds: f32) -> [f32; 2] {
        let ramp = parameter_ramp(sample_rate);
        approach(&mut self.mix, self.mix_target, ramp);
        approach(&mut self.parameter, self.parameter_target, ramp);
        if self.mix <= f32::EPSILON && self.mix_target <= f32::EPSILON {
            return input;
        }

        let effected =
            self.processor
                .process(self.kind, input, sample_rate, beat_seconds, self.parameter);
        // DRY/WET has one job: select between the unprocessed input and this effect's output.
        // PARAMETER semantics are owned by each processor and never applied as a second global
        // loudness multiplier here.
        let wet = self.mix.clamp(0.0, 1.0);
        let dry = 1.0 - wet;
        [
            finite_sample(input[0] * dry + effected[0] * wet),
            finite_sample(input[1] * dry + effected[1] * wet),
        ]
    }
}

struct EffectProcessor {
    delay: StereoDelay,
    reverb: SchroederReverb,
    flanger_phase: f32,
    phaser: Phaser,
    crusher: BitCrusher,
    gate: RhythmicGate,
    alarm: Alarm,
    rocket: Rocket,
}

impl EffectProcessor {
    fn new() -> Self {
        Self {
            delay: StereoDelay::new(MAX_DELAY_FRAMES),
            reverb: SchroederReverb::new(),
            flanger_phase: 0.0,
            phaser: Phaser::default(),
            crusher: BitCrusher::default(),
            gate: RhythmicGate::default(),
            alarm: Alarm::default(),
            rocket: Rocket::default(),
        }
    }

    fn reset(&mut self) {
        self.delay.reset();
        self.reverb.reset();
        self.flanger_phase = 0.0;
        self.phaser.reset();
        self.crusher.reset();
        self.gate.reset();
        self.alarm.reset();
        self.rocket.reset();
    }

    #[inline]
    fn process(
        &mut self,
        kind: DeckFxKind,
        input: [f32; 2],
        sample_rate: u32,
        beat_seconds: f32,
        parameter: f32,
    ) -> [f32; 2] {
        let sample_rate_f = sample_rate as f32;
        match kind {
            DeckFxKind::Echo => {
                // PARAMETER selects 1/8..2 beats (bounded by MAX_DELAY_FRAMES). Feedback and wet
                // level stay fixed.
                let division = 0.125 * 16.0f32.powf(parameter);
                self.delay
                    .process(input, sample_rate_f * beat_seconds * division, 0.48)
                    .map(|sample| sample * 0.86)
            }
            DeckFxKind::Reverb => self.reverb.process(input, sample_rate, parameter),
            DeckFxKind::Flanger => {
                // PARAMETER is only the LFO frequency. Width, feedback and output gain are fixed.
                let speed_hz = modulation_frequency(parameter);
                self.flanger_phase = (self.flanger_phase + TAU * speed_hz / sample_rate_f) % TAU;
                let sweep = 0.5 + 0.5 * self.flanger_phase.sin();
                let delay_ms = 0.8 + sweep * 7.2;
                let delayed = self
                    .delay
                    .process(input, sample_rate_f * delay_ms / 1_000.0, 0.34);
                [
                    input[0] * 0.68 + delayed[0] * 0.62,
                    input[1] * 0.68 + delayed[1] * 0.62,
                ]
            }
            DeckFxKind::Phaser => self.phaser.process(input, sample_rate, parameter),
            DeckFxKind::BitCrusher => self.crusher.process(input, parameter),
            DeckFxKind::Gate => {
                // PARAMETER selects a 1/2..1/32-beat chopping period, not gate loudness.
                let division = 0.5 * 16.0f32.powf(-parameter);
                self.gate
                    .process(input, sample_rate, beat_seconds * division)
            }
            DeckFxKind::Alarm => self.alarm.process(input, sample_rate, parameter),
            DeckFxKind::Hydrant => {
                // Proprietary-macro approximation: PARAMETER advances the shrinking loop and
                // reverb build. At zero the wet generator is silent by design.
                let division = 0.5 * (1.0 - parameter) + 0.03125 * parameter;
                let delayed = self.delay.process(
                    input,
                    sample_rate_f * beat_seconds * division,
                    0.2 + parameter * 0.48,
                );
                let wash = self
                    .reverb
                    .process(delayed, sample_rate, 0.35 + parameter * 0.6);
                [
                    (delayed[0] * 0.66 + wash[0] * 0.42) * parameter,
                    (delayed[1] * 0.66 + wash[1] * 0.42) * parameter,
                ]
            }
            DeckFxKind::Rocket => self.rocket.process(input, sample_rate, parameter),
        }
    }
}

/// Circular fractional-delay line shared by the conventional Echo/Flanger/Hydrant topologies.
/// Compare Mixxx `echoeffect.cpp` (feedback ring) and `flangereffect.cpp` (LFO-modulated,
/// linearly interpolated delay reads) at the builtin-effects URL in the module documentation.
struct StereoDelay {
    frames: Box<[[f32; 2]]>,
    write: usize,
    valid: usize,
}

impl StereoDelay {
    fn new(frames: usize) -> Self {
        Self {
            frames: vec![[0.0; 2]; frames.max(3)].into_boxed_slice(),
            write: 0,
            valid: 0,
        }
    }

    fn reset(&mut self) {
        // `valid` hides stale storage, avoiding a multi-megabyte clear on the audio callback.
        self.write = 0;
        self.valid = 0;
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], delay_frames: f32, feedback: f32) -> [f32; 2] {
        let delay = delay_frames.clamp(1.0, (self.frames.len() - 2) as f32);
        let whole = delay.floor() as usize;
        let fraction = delay - whole as f32;
        let newer = (self.write + self.frames.len() - whole) % self.frames.len();
        let older = (newer + self.frames.len() - 1) % self.frames.len();
        let delayed = if self.valid > whole {
            [
                self.frames[newer][0] * (1.0 - fraction) + self.frames[older][0] * fraction,
                self.frames[newer][1] * (1.0 - fraction) + self.frames[older][1] * fraction,
            ]
        } else {
            [0.0; 2]
        };
        let feedback = feedback.clamp(0.0, 0.78);
        self.frames[self.write] = [
            (input[0] + delayed[0] * feedback).clamp(-4.0, 4.0),
            (input[1] + delayed[1] * feedback).clamp(-4.0, 4.0),
        ];
        self.write = (self.write + 1) % self.frames.len();
        self.valid = self.valid.saturating_add(1).min(self.frames.len());
        delayed
    }
}

struct MonoDelay {
    frames: Box<[f32]>,
    write: usize,
    valid: usize,
}

impl MonoDelay {
    fn new(max_frames: usize) -> Self {
        Self {
            frames: vec![0.0; max_frames.max(2)].into_boxed_slice(),
            write: 0,
            valid: 0,
        }
    }

    fn reset(&mut self) {
        self.write = 0;
        self.valid = 0;
    }

    #[inline]
    fn read(&self, delay: usize) -> f32 {
        let delay = delay.clamp(1, self.frames.len() - 1);
        if self.valid < delay {
            0.0
        } else {
            self.frames[(self.write + self.frames.len() - delay) % self.frames.len()]
        }
    }

    #[inline]
    fn write(&mut self, value: f32) {
        self.frames[self.write] = finite_sample(value).clamp(-4.0, 4.0);
        self.write = (self.write + 1) % self.frames.len();
        self.valid = self.valid.saturating_add(1).min(self.frames.len());
    }
}

struct Comb {
    delay: MonoDelay,
    filtered: f32,
}

impl Comb {
    fn new(max_frames: usize) -> Self {
        Self {
            delay: MonoDelay::new(max_frames),
            filtered: 0.0,
        }
    }

    fn reset(&mut self) {
        self.delay.reset();
        self.filtered = 0.0;
    }

    #[inline]
    fn process(&mut self, input: f32, delay: usize, feedback: f32, damping: f32) -> f32 {
        let output = self.delay.read(delay);
        self.filtered = output * (1.0 - damping) + self.filtered * damping;
        self.delay.write(input + self.filtered * feedback);
        output
    }
}

struct Allpass {
    delay: MonoDelay,
}

impl Allpass {
    fn new(max_frames: usize) -> Self {
        Self {
            delay: MonoDelay::new(max_frames),
        }
    }

    fn reset(&mut self) {
        self.delay.reset();
    }

    #[inline]
    fn process(&mut self, input: f32, delay: usize) -> f32 {
        let buffered = self.delay.read(delay);
        let output = buffered - input;
        self.delay.write(input + buffered * 0.5);
        output
    }
}

/// Compact Schroeder/Moorer topology: four parallel combs and two serial allpasses per channel.
/// It is intentionally implemented here instead of adding a binary-size dependency.
struct SchroederReverb {
    combs: [[Comb; 4]; 2],
    allpasses: [[Allpass; 2]; 2],
    sample_rate: u32,
    comb_lengths: [[usize; 4]; 2],
    allpass_lengths: [[usize; 2]; 2],
}

impl SchroederReverb {
    const COMB_BASE: [[usize; 4]; 2] = [[1_116, 1_188, 1_277, 1_356], [1_139, 1_211, 1_300, 1_379]];
    const ALLPASS_BASE: [[usize; 2]; 2] = [[556, 441], [579, 464]];

    fn new() -> Self {
        Self {
            combs: std::array::from_fn(|channel| {
                std::array::from_fn(|index| Comb::new(Self::COMB_BASE[channel][index] * 4))
            }),
            allpasses: std::array::from_fn(|channel| {
                std::array::from_fn(|index| Allpass::new(Self::ALLPASS_BASE[channel][index] * 4))
            }),
            sample_rate: 0,
            comb_lengths: Self::COMB_BASE,
            allpass_lengths: Self::ALLPASS_BASE,
        }
    }

    fn reset(&mut self) {
        for channel in &mut self.combs {
            for comb in channel {
                comb.reset();
            }
        }
        for channel in &mut self.allpasses {
            for allpass in channel {
                allpass.reset();
            }
        }
    }

    fn ensure_sample_rate(&mut self, sample_rate: u32) {
        if self.sample_rate == sample_rate {
            return;
        }
        self.sample_rate = sample_rate;
        let scale = sample_rate as f32 / 44_100.0;
        for channel in 0..2 {
            for index in 0..4 {
                self.comb_lengths[channel][index] =
                    ((Self::COMB_BASE[channel][index] as f32 * scale).round() as usize)
                        .clamp(1, self.combs[channel][index].delay.frames.len() - 1);
            }
            for index in 0..2 {
                self.allpass_lengths[channel][index] =
                    ((Self::ALLPASS_BASE[channel][index] as f32 * scale).round() as usize)
                        .clamp(1, self.allpasses[channel][index].delay.frames.len() - 1);
            }
        }
        self.reset();
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], sample_rate: u32, parameter: f32) -> [f32; 2] {
        self.ensure_sample_rate(sample_rate);
        // PARAMETER controls room decay/damping, never the reverb output level.
        let feedback = 0.68 + parameter * 0.24;
        let damping = 0.16 + (1.0 - parameter) * 0.28;
        let driven = [
            (input[0] * 0.78 + input[1] * 0.22) * 0.24,
            (input[1] * 0.78 + input[0] * 0.22) * 0.24,
        ];
        let mut output = [0.0; 2];
        for channel in 0..2 {
            for index in 0..4 {
                output[channel] += self.combs[channel][index].process(
                    driven[channel],
                    self.comb_lengths[channel][index],
                    feedback,
                    damping,
                );
            }
            output[channel] *= 0.25;
            for index in 0..2 {
                output[channel] = self.allpasses[channel][index]
                    .process(output[channel], self.allpass_lengths[channel][index]);
            }
        }
        output
    }
}

#[derive(Clone, Copy, Default)]
struct AllpassStage {
    state: [f32; 2],
}

impl AllpassStage {
    #[inline]
    fn process(&mut self, input: [f32; 2], coefficient: f32) -> [f32; 2] {
        let mut output = [0.0; 2];
        for channel in 0..2 {
            output[channel] = -coefficient * input[channel] + self.state[channel];
            self.state[channel] = input[channel] + coefficient * output[channel];
        }
        output
    }
}

/// Six first-order allpass stages with LFO-modulated coefficients and feedback.
/// This is the classic virtual-analog phaser topology also identified in Mixxx's Phaser manifest.
#[derive(Default)]
struct Phaser {
    stages: [AllpassStage; 6],
    feedback: [f32; 2],
    phase: f32,
    coefficient: f32,
    coefficient_tick: u8,
}

impl Phaser {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], sample_rate: u32, parameter: f32) -> [f32; 2] {
        let sample_rate = sample_rate as f32;
        // Like Flanger, PARAMETER changes only LFO frequency. The allpass range, feedback and
        // wet gain remain fixed, so DRY/WET is the sole loudness/blend control.
        let speed_hz = modulation_frequency(parameter);
        self.phase = (self.phase + TAU * speed_hz / sample_rate) % TAU;
        if self.coefficient_tick == 0 {
            let sweep = 0.5 + 0.5 * self.phase.sin();
            let frequency = 180.0 * (12.0f32).powf(sweep);
            let tangent = (PI * frequency.min(sample_rate * 0.42) / sample_rate).tan();
            self.coefficient = ((1.0 - tangent) / (1.0 + tangent)).clamp(-0.98, 0.98);
        }
        self.coefficient_tick = (self.coefficient_tick + 1) & 31;
        let feedback = 0.38;
        let mut phased = [
            input[0] + self.feedback[0] * feedback,
            input[1] + self.feedback[1] * feedback,
        ];
        for stage in &mut self.stages {
            phased = stage.process(phased, self.coefficient);
        }
        self.feedback = phased;
        [
            input[0] * 0.62 + phased[0] * 0.62,
            input[1] * 0.62 + phased[1] * 0.62,
        ]
    }
}

/// Sample-and-hold downsampling plus amplitude quantization. PARAMETER lowers both effective
/// sample rate and bit depth, matching the two parameters linked by Mixxx's Bitcrusher metaknob.
#[derive(Default)]
struct BitCrusher {
    held: [f32; 2],
    remaining: u32,
}

impl BitCrusher {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], parameter: f32) -> [f32; 2] {
        let hold_frames = 1 + (parameter * parameter * 31.0).round() as u32;
        if self.remaining == 0 {
            let bits = (16.0 - parameter * 12.0).round().clamp(4.0, 16.0);
            let levels = 2.0f32.powf(bits - 1.0);
            self.held = [
                (input[0] * levels).round() / levels,
                (input[1] * levels).round() / levels,
            ];
            self.remaining = hold_frames;
        }
        self.remaining = self.remaining.saturating_sub(1);
        self.held
    }
}

/// KDJ beat-synchronised square-wave chopper. This is the hard-gate variant of the standard
/// tempo-synchronised volume modulation represented by Mixxx's Tremolo effect.
#[derive(Default)]
struct RhythmicGate {
    phase: u64,
    gain: f32,
}

impl RhythmicGate {
    fn reset(&mut self) {
        self.phase = 0;
        self.gain = 1.0;
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], sample_rate: u32, seconds: f32) -> [f32; 2] {
        let period = (sample_rate as f32 * seconds.max(1.0 / sample_rate as f32)) as u64;
        let open = self.phase % period.max(2) < period.max(2) / 2;
        self.phase = self.phase.wrapping_add(1);
        let target = if open { 1.0 } else { 0.015 };
        let speed = if open {
            1.0 / (sample_rate as f32 * 0.002)
        } else {
            1.0 / (sample_rate as f32 * 0.004)
        };
        approach(&mut self.gain, target, speed);
        [input[0] * self.gain, input[1] * self.gain]
    }
}

/// KDJ-authored two-oscillator siren approximation; this is not Algoriddim's proprietary code.
#[derive(Default)]
struct Alarm {
    carrier_phase: f32,
    siren_phase: f32,
}

impl Alarm {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn process(&mut self, _input: [f32; 2], sample_rate: u32, parameter: f32) -> [f32; 2] {
        let sample_rate = sample_rate as f32;
        self.siren_phase = (self.siren_phase + TAU * (0.45 + parameter * 1.2) / sample_rate) % TAU;
        let siren = self.siren_phase.sin();
        let frequency = 620.0 + parameter * 260.0 + siren * (110.0 + parameter * 310.0);
        self.carrier_phase = (self.carrier_phase + TAU * frequency.max(80.0) / sample_rate) % TAU;
        // Alarm and the other generator macros deliberately produce no wet signal at PARAMETER=0.
        let tone =
            (self.carrier_phase.sin() + 0.22 * (self.carrier_phase * 2.0).sin()) * 0.38 * parameter;
        [tone, tone]
    }
}

/// KDJ-authored Rocket approximation: rising high-pass treatment plus swept white noise.
/// The white-noise crossfade primitive is conventional (see Mixxx `whitenoiseeffect.cpp`), while
/// the macro mapping and constants here are original to KDJ.
struct Rocket {
    random: u32,
    music_low: [f32; 2],
    noise_low: [f32; 2],
}

impl Default for Rocket {
    fn default() -> Self {
        Self {
            random: 0x6d2b_79f5,
            music_low: [0.0; 2],
            noise_low: [0.0; 2],
        }
    }
}

impl Rocket {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn process(&mut self, input: [f32; 2], sample_rate: u32, parameter: f32) -> [f32; 2] {
        let sample_rate = sample_rate as f32;
        let music_alpha = one_pole_alpha(140.0 + parameter * parameter * 7_500.0, sample_rate);
        let noise_alpha = one_pole_alpha(900.0 + parameter * 13_500.0, sample_rate);
        let mut output = [0.0; 2];
        for channel in 0..2 {
            self.random = self
                .random
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            let noise = (((self.random >> 8) as f32 / 16_777_215.0) * 2.0 - 1.0) * 0.3;
            self.music_low[channel] += music_alpha * (input[channel] - self.music_low[channel]);
            self.noise_low[channel] += noise_alpha * (noise - self.noise_low[channel]);
            let high_passed_music = input[channel] - self.music_low[channel];
            output[channel] = (high_passed_music * 0.72
                + self.noise_low[channel] * (0.35 + parameter * 0.38))
                * parameter;
        }
        output
    }
}

#[inline]
fn modulation_frequency(parameter: f32) -> f32 {
    // Shared Phaser/Flanger PARAMETER mapping: 0.05..2 Hz on a logarithmic scale.
    0.05 * 40.0f32.powf(parameter.clamp(0.0, 1.0))
}

#[inline]
fn parameter_ramp(sample_rate: u32) -> f32 {
    1.0 / (sample_rate.max(1) as f32 * PARAMETER_RAMP_SECONDS)
}

#[inline]
fn approach(current: &mut f32, target: f32, step: f32) {
    *current += (target - *current).clamp(-step, step);
}

#[inline]
fn finite_unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[inline]
fn finite_sample(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

#[inline]
fn one_pole_alpha(cutoff: f32, sample_rate: f32) -> f32 {
    1.0 - (-TAU * cutoff.clamp(10.0, sample_rate * 0.45) / sample_rate).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled(kind: DeckFxKind, mix: f32, parameter: f32) -> DeckFxSlot {
        DeckFxSlot {
            kind,
            enabled: true,
            mix,
            parameter,
        }
    }

    #[test]
    fn zero_dry_wet_is_sample_transparent_for_every_effect() {
        let mut fx = DeckManualFx::new();
        for kind in DeckFxKind::ALL {
            fx.configure(
                [
                    enabled(kind, 0.0, 1.0),
                    DeckFxSlot::default(),
                    DeckFxSlot::default(),
                ],
                0,
                0.1,
            );
            for frame in 0..128 {
                let input = [(frame as f32 * 0.1).sin() * 0.4; 2];
                assert_eq!(fx.process(input, 48_000), input, "{kind:?}");
            }
        }
    }

    #[test]
    fn phaser_and_flanger_parameter_zero_are_slow_not_silent() {
        assert!((modulation_frequency(0.0) - 0.05).abs() < f32::EPSILON);
        assert!((modulation_frequency(1.0) - 2.0).abs() < 0.000_01);
        for kind in [DeckFxKind::Phaser, DeckFxKind::Flanger] {
            let mut fx = DeckManualFx::new();
            fx.configure(
                [
                    enabled(kind, 1.0, 0.0),
                    DeckFxSlot::default(),
                    DeckFxSlot::default(),
                ],
                0,
                0.1,
            );
            let mut energy = 0.0;
            for frame in 0..8_000 {
                let source = (TAU * 440.0 * frame as f32 / 48_000.0).sin() * 0.35;
                let output = fx.process([source, source], 48_000);
                if frame > 1_000 {
                    energy += output[0] * output[0];
                }
            }
            assert!(energy > 1.0, "{kind:?} PARAMETER=0 must remain audible");
        }
    }

    #[test]
    fn generator_macros_are_silent_at_parameter_zero_when_fully_wet() {
        for kind in [DeckFxKind::Alarm, DeckFxKind::Hydrant, DeckFxKind::Rocket] {
            let mut fx = DeckManualFx::new();
            fx.configure(
                [
                    enabled(kind, 1.0, 0.0),
                    DeckFxSlot::default(),
                    DeckFxSlot::default(),
                ],
                0,
                0.1,
            );
            let mut peak = 0.0f32;
            for frame in 0..8_000 {
                let source = (TAU * 440.0 * frame as f32 / 48_000.0).sin() * 0.35;
                let output = fx.process([source, source], 48_000);
                if frame > 2_000 {
                    peak = peak.max(output[0].abs()).max(output[1].abs());
                }
            }
            assert!(peak < 0.000_01, "{kind:?} PARAMETER=0 peak={peak}");
        }
    }

    #[test]
    fn every_effect_has_a_finite_audible_dsp_path() {
        let mut fx = DeckManualFx::new();
        for kind in DeckFxKind::ALL {
            fx.configure(
                [
                    enabled(kind, 1.0, 1.0),
                    DeckFxSlot::default(),
                    DeckFxSlot::default(),
                ],
                0,
                0.1,
            );
            let mut changed = false;
            for frame in 0..8_000 {
                let source = (TAU * 440.0 * frame as f32 / 48_000.0).sin() * 0.35;
                let input = [source, source * 0.83];
                let output = fx.process(input, 48_000);
                assert!(output.into_iter().all(f32::is_finite), "{kind:?}");
                if frame > 1_000 && (output[0] - input[0]).abs() > 0.01 {
                    changed = true;
                }
            }
            assert!(changed, "{kind:?} must audibly differ from dry audio");
        }
    }
}
