use std::f32::consts::PI;

use crate::EQ_SPECTRUM_BANDS;

#[derive(Clone, Copy, Debug)]
struct Coefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Default for Coefficients {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

impl Coefficients {
    const fn zero() -> Self {
        Self {
            b0: 0.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    fn difference_per_frame(from: Self, to: Self, frames: u32) -> Self {
        let frames = frames.max(1) as f32;
        Self {
            b0: (to.b0 - from.b0) / frames,
            b1: (to.b1 - from.b1) / frames,
            b2: (to.b2 - from.b2) / frames,
            a1: (to.a1 - from.a1) / frames,
            a2: (to.a2 - from.a2) / frames,
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            b0: self.b0 + other.b0,
            b1: self.b1 + other.b1,
            b2: self.b2 + other.b2,
            a1: self.a1 + other.a1,
            a2: self.a2 + other.a2,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct BiquadState {
    z1: f32,
    z2: f32,
}

#[derive(Clone, Copy, Debug)]
struct StereoBiquad {
    coefficients: Coefficients,
    coefficient_target: Coefficients,
    coefficient_delta: Coefficients,
    coefficient_ramp_remaining: u32,
    state: [BiquadState; 2],
}

impl Default for StereoBiquad {
    fn default() -> Self {
        Self {
            coefficients: Coefficients::default(),
            coefficient_target: Coefficients::default(),
            coefficient_delta: Coefficients::zero(),
            coefficient_ramp_remaining: 0,
            state: [BiquadState::default(); 2],
        }
    }
}

impl StereoBiquad {
    fn set_coefficients(&mut self, coefficients: Coefficients) {
        self.coefficients = coefficients;
        self.coefficient_target = coefficients;
        self.coefficient_delta = Coefficients::zero();
        self.coefficient_ramp_remaining = 0;
    }

    /// Broad EQ bands can safely interpolate between nearby shelf/peak coefficients. The channel
    /// FILTER deliberately does not use this path: modulating its near-unit low-frequency poles
    /// injected state bursts, so that control uses two stable banks and a short crossfade below.
    fn ramp_coefficients(&mut self, coefficients: Coefficients, frames: u32) {
        let frames = frames.max(1);
        self.coefficient_target = coefficients;
        self.coefficient_delta =
            Coefficients::difference_per_frame(self.coefficients, coefficients, frames);
        self.coefficient_ramp_remaining = frames;
    }

    fn advance_coefficients(&mut self) {
        if self.coefficient_ramp_remaining == 0 {
            return;
        }
        self.coefficients = self.coefficients.add(self.coefficient_delta);
        self.coefficient_ramp_remaining -= 1;
        if self.coefficient_ramp_remaining == 0 {
            // Remove accumulated f32 rounding error at the exact end of the short ramp.
            self.coefficients = self.coefficient_target;
            self.coefficient_delta = Coefficients::zero();
        }
    }

    fn process(&mut self, channel: usize, input: f32) -> f32 {
        let state = &mut self.state[channel.min(1)];
        let c = self.coefficients;
        let output = c.b0 * input + state.z1;
        state.z1 = c.b1 * input - c.a1 * output + state.z2;
        state.z2 = c.b2 * input - c.a2 * output;
        if output.is_finite() {
            output
        } else {
            0.0
        }
    }

    fn reset(&mut self) {
        self.state = [BiquadState::default(); 2];
    }
}

/// Fifteen fixed, narrow post-EQ analysis bands. This is display metering, not another EQ: the
/// audible mixer deliberately remains LOW/MID/HIGH so hand drawing and physical three-knob
/// controllers always describe the same sound. All state is fixed-size and callback-local.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeckSpectrum {
    sample_rate: u32,
    filters: [StereoBiquad; EQ_SPECTRUM_BANDS],
    levels: [f32; EQ_SPECTRUM_BANDS],
    release_per_frame: f32,
}

impl Default for DeckSpectrum {
    fn default() -> Self {
        Self {
            sample_rate: 0,
            filters: [StereoBiquad::default(); EQ_SPECTRUM_BANDS],
            levels: [0.0; EQ_SPECTRUM_BANDS],
            release_per_frame: 0.999_9,
        }
    }
}

impl DeckSpectrum {
    /// 1/3-octave-like centres matching `src/lib/eqGraph.ts`, grouped five per broad EQ band.
    const FREQUENCIES: [f32; EQ_SPECTRUM_BANDS] = [
        40.0, 63.0, 100.0, 160.0, 250.0, 400.0, 630.0, 1_000.0, 1_600.0, 2_500.0, 4_000.0, 6_300.0,
        10_000.0, 14_000.0, 18_000.0,
    ];
    const THIRD_OCTAVE_Q: f32 = 4.318;
    const RELEASE_SECONDS: f32 = 0.16;

    pub(crate) fn ensure_sample_rate(&mut self, sample_rate: u32) {
        let sample_rate = sample_rate.max(1);
        if self.sample_rate == sample_rate {
            return;
        }
        self.sample_rate = sample_rate;
        self.release_per_frame = (-1.0 / (sample_rate as f32 * Self::RELEASE_SECONDS)).exp();
        for (filter, frequency) in self.filters.iter_mut().zip(Self::FREQUENCIES) {
            filter.set_coefficients(band_pass(sample_rate, frequency, Self::THIRD_OCTAVE_Q));
        }
        self.reset();
    }

    #[inline]
    pub(crate) fn observe(&mut self, input: [f32; 2]) {
        for index in 0..EQ_SPECTRUM_BANDS {
            let filtered = [
                self.filters[index].process(0, input[0]),
                self.filters[index].process(1, input[1]),
            ];
            let peak = filtered[0].abs().max(filtered[1].abs());
            self.levels[index] = (self.levels[index] * self.release_per_frame).max(peak);
        }
    }

    pub(crate) fn levels(&self) -> [f32; EQ_SPECTRUM_BANDS] {
        self.levels
    }

    pub(crate) fn reset(&mut self) {
        self.levels = [0.0; EQ_SPECTRUM_BANDS];
        for filter in &mut self.filters {
            filter.reset();
        }
    }
}

/// Three-band DJ isolator + bipolar channel filter. Coefficients are recalculated only when a
/// command or device rate changes; the realtime path only runs fixed biquads and one gain.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeckEq {
    trim_db: f32,
    low_db: f32,
    mid_db: f32,
    high_db: f32,
    filter: f32,
    filter_resonance: f32,
    trim_gain: f32,
    sample_rate: u32,
    low: StereoBiquad,
    mid: StereoBiquad,
    high: StereoBiquad,
    channel_filter: StereoBiquad,
    channel_filter_next: StereoBiquad,
    channel_filter_q: f32,
    channel_filter_next_q: f32,
    channel_filter_crossfade: f32,
    channel_filter_crossfade_step: f32,
    channel_filter_crossfade_remaining: u32,
}

impl Default for DeckEq {
    fn default() -> Self {
        Self {
            trim_db: 0.0,
            low_db: 0.0,
            mid_db: 0.0,
            high_db: 0.0,
            filter: 0.0,
            filter_resonance: crate::DEFAULT_FILTER_RESONANCE_Q,
            trim_gain: 1.0,
            sample_rate: 0,
            low: StereoBiquad::default(),
            mid: StereoBiquad::default(),
            high: StereoBiquad::default(),
            channel_filter: StereoBiquad::default(),
            channel_filter_next: StereoBiquad::default(),
            channel_filter_q: FILTER_NEAR_CENTER_Q,
            channel_filter_next_q: FILTER_NEAR_CENTER_Q,
            channel_filter_crossfade: 0.0,
            channel_filter_crossfade_step: 0.0,
            channel_filter_crossfade_remaining: 0,
        }
    }
}

impl DeckEq {
    pub(crate) fn configure(
        &mut self,
        sample_rate: u32,
        trim_db: f32,
        low_db: f32,
        mid_db: f32,
        high_db: f32,
        filter: f32,
        filter_resonance: f32,
    ) {
        let sample_rate = sample_rate.max(1);
        let trim_db = finite_db(trim_db).clamp(-24.0, 6.0);
        let low_db = finite_db(low_db);
        let mid_db = finite_db(mid_db);
        let high_db = finite_db(high_db);
        let filter = if filter.is_finite() {
            filter.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        let filter_resonance = normalized_filter_resonance(filter_resonance);
        let filter_effective_resonance = effective_filter_resonance(filter, filter_resonance);
        if self.sample_rate == sample_rate
            && self.trim_db == trim_db
            && self.low_db == low_db
            && self.mid_db == mid_db
            && self.high_db == high_db
            && self.filter == filter
            && self.filter_resonance == filter_resonance
        {
            return;
        }
        let initialise_coefficients = self.sample_rate == 0 || self.sample_rate != sample_rate;
        let filter_changed = initialise_coefficients
            || self.filter != filter
            || self.filter_resonance != filter_resonance;
        self.sample_rate = sample_rate;
        self.trim_db = trim_db;
        self.low_db = low_db;
        self.mid_db = mid_db;
        self.high_db = high_db;
        self.filter = filter;
        self.filter_resonance = filter_resonance;
        self.trim_gain = db_gain(trim_db);
        let low_coefficients = shelf(self.sample_rate, 220.0, low_db, false);
        let mid_coefficients = peaking(self.sample_rate, 1_200.0, 0.8, mid_db);
        let high_coefficients = shelf(self.sample_rate, 5_500.0, high_db, true);
        if initialise_coefficients {
            self.low.set_coefficients(low_coefficients);
            self.mid.set_coefficients(mid_coefficients);
            self.high.set_coefficients(high_coefficients);
        } else {
            let frames = eq_coefficient_ramp_frames(self.sample_rate);
            self.low.ramp_coefficients(low_coefficients, frames);
            self.mid.ramp_coefficients(mid_coefficients, frames);
            self.high.ramp_coefficients(high_coefficients, frames);
        }
        let filter_coefficients = if filter < -FILTER_CENTER_DEADZONE {
            let cutoff = 18_000.0 * (90.0f32 / 18_000.0).powf(-filter);
            low_pass(self.sample_rate, cutoff, filter_effective_resonance)
        } else if filter > FILTER_CENTER_DEADZONE {
            let cutoff = 22.0 * (8_000.0f32 / 22.0).powf(filter);
            high_pass(self.sample_rate, cutoff, filter_effective_resonance)
        } else {
            Coefficients::default()
        };
        if initialise_coefficients {
            self.channel_filter.set_coefficients(filter_coefficients);
            self.channel_filter_next
                .set_coefficients(filter_coefficients);
            self.channel_filter.reset();
            self.channel_filter_next.reset();
            self.channel_filter_q = filter_effective_resonance;
            self.channel_filter_next_q = filter_effective_resonance;
            self.channel_filter_crossfade = 0.0;
            self.channel_filter_crossfade_step = 0.0;
            self.channel_filter_crossfade_remaining = 0;
        } else if filter_changed {
            // UI/MIDI delivery is normally slower than this transition. If a newer command does
            // arrive mid-fade, retain the currently dominant live bank before preparing the next
            // target so an obsolete coefficient set can never win the race.
            if self.channel_filter_crossfade_remaining > 0 && self.channel_filter_crossfade >= 0.5 {
                std::mem::swap(&mut self.channel_filter, &mut self.channel_filter_next);
                self.channel_filter_q = self.channel_filter_next_q;
            }
            self.channel_filter_next
                .set_coefficients(filter_coefficients);
            self.channel_filter_next.reset();
            self.channel_filter_next_q = filter_effective_resonance;
            let frames = filter_crossfade_frames(self.sample_rate);
            self.channel_filter_crossfade = 0.0;
            self.channel_filter_crossfade_step = 1.0 / frames as f32;
            self.channel_filter_crossfade_remaining = frames;
        }
    }

    pub(crate) fn ensure_sample_rate(&mut self, sample_rate: u32) {
        self.configure(
            sample_rate,
            self.trim_db,
            self.low_db,
            self.mid_db,
            self.high_db,
            self.filter,
            self.filter_resonance,
        );
    }

    pub(crate) fn set_filter_resonance(&mut self, filter_resonance: f32) {
        self.configure(
            self.sample_rate.max(1),
            self.trim_db,
            self.low_db,
            self.mid_db,
            self.high_db,
            self.filter,
            filter_resonance,
        );
    }

    pub(crate) fn reset(&mut self) {
        self.low.state = [BiquadState::default(); 2];
        self.mid.state = [BiquadState::default(); 2];
        self.high.state = [BiquadState::default(); 2];
        self.channel_filter.state = [BiquadState::default(); 2];
        self.channel_filter_next.state = [BiquadState::default(); 2];
    }

    pub(crate) fn process_stereo(&mut self, input: [f32; 2]) -> [f32; 2] {
        // Advance once per stereo frame so left/right stay on identical coefficients.
        self.low.advance_coefficients();
        self.mid.advance_coefficients();
        self.high.advance_coefficients();
        let crossfading = self.channel_filter_crossfade_remaining > 0;
        let mix = self.channel_filter_crossfade;
        let mut output = [0.0; 2];
        for channel in 0..2 {
            let low = self.low.process(channel, input[channel] * self.trim_gain);
            let mid = self.mid.process(channel, low);
            let high = self.high.process(channel, mid);
            let current = self.channel_filter.process(channel, high);
            let current = if self.channel_filter_q > 1.0 {
                resonant_filter_soft_limit(current)
            } else {
                current
            };
            output[channel] = if crossfading {
                let next = self.channel_filter_next.process(channel, high);
                let next = if self.channel_filter_next_q > 1.0 {
                    resonant_filter_soft_limit(next)
                } else {
                    next
                };
                current + (next - current) * mix
            } else {
                current
            };
        }
        if crossfading {
            self.channel_filter_crossfade_remaining -= 1;
            self.channel_filter_crossfade =
                (self.channel_filter_crossfade + self.channel_filter_crossfade_step).min(1.0);
            if self.channel_filter_crossfade_remaining == 0 {
                std::mem::swap(&mut self.channel_filter, &mut self.channel_filter_next);
                self.channel_filter_q = self.channel_filter_next_q;
                self.channel_filter_crossfade = 0.0;
                self.channel_filter_crossfade_step = 0.0;
            }
        }
        output
    }
}

fn finite_db(db: f32) -> f32 {
    if db.is_finite() {
        db.clamp(-48.0, 12.0)
    } else {
        0.0
    }
}

fn normalized_filter_resonance(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(
            crate::FILTER_RESONANCE_LOW_Q,
            crate::FILTER_RESONANCE_HIGH_Q,
        )
    } else {
        crate::DEFAULT_FILTER_RESONANCE_Q
    }
}

/// ±1% of the bipolar FILTER throw counts as the 12 o'clock detent. Hardware mixers click there;
/// 7-bit MIDI center is 64/127 and never lands on exact 0.
const FILTER_CENTER_DEADZONE: f32 = 0.01;
/// The first tenth of the FILTER throw should remove inaudible edge content, not add a sub-bass
/// or ultrasonic resonant shelf. Q=1/sqrt(2) is monotonic, so mastered audio keeps its headroom
/// while the knob leaves its centre detent. The selected resonance fades back in beyond 10% and
/// reaches full strength at 30%, where the sweep is already an intentional audible effect.
const FILTER_NEAR_CENTER_Q: f32 = 0.707_106_77;
const FILTER_RESONANCE_RAMP_START: f32 = 0.10;
const FILTER_RESONANCE_RAMP_END: f32 = 0.30;
/// A 24 ms dual-filter crossfade is longer than an individual callback but shorter than a normal
/// control gesture. Unlike interpolating near-unit IIR coefficients, it cannot inject a resonant
/// state burst while frequent 40 ms UI updates sweep the low-frequency end of the filter.
const FILTER_CROSSFADE_MILLIS: u32 = 24;
const EQ_COEFFICIENT_RAMP_MILLIS: u32 = 24;
const FILTER_SOFT_LIMIT_KNEE: f32 = 0.92;
const FILTER_SOFT_LIMIT_CEILING: f32 = 0.985;

fn filter_crossfade_frames(sample_rate: u32) -> u32 {
    (u64::from(sample_rate.max(1)) * u64::from(FILTER_CROSSFADE_MILLIS) / 1_000).clamp(16, 4_096)
        as u32
}

fn eq_coefficient_ramp_frames(sample_rate: u32) -> u32 {
    (u64::from(sample_rate.max(1)) * u64::from(EQ_COEFFICIENT_RAMP_MILLIS) / 1_000).clamp(16, 4_096)
        as u32
}

fn effective_filter_resonance(filter: f32, selected_q: f32) -> f32 {
    let amount = filter.abs();
    let linear = ((amount - FILTER_RESONANCE_RAMP_START)
        / (FILTER_RESONANCE_RAMP_END - FILTER_RESONANCE_RAMP_START))
        .clamp(0.0, 1.0);
    let smooth = linear * linear * (3.0 - 2.0 * linear);
    FILTER_NEAR_CENTER_Q + (selected_q - FILTER_NEAR_CENTER_Q) * smooth
}

/// High resonance can lift a mastered transient beyond full scale even after its Q is kept in a
/// musical range. Use a C¹ soft knee only for the resonant channel-filter modes, rather than the
/// final renderer's abrupt ±1 clamp. Low keeps its historic path untouched.
fn resonant_filter_soft_limit(sample: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= FILTER_SOFT_LIMIT_KNEE {
        return sample;
    }
    let width = FILTER_SOFT_LIMIT_CEILING - FILTER_SOFT_LIMIT_KNEE;
    let compressed = FILTER_SOFT_LIMIT_KNEE
        + width * (1.0 - (-(magnitude - FILTER_SOFT_LIMIT_KNEE) / width).exp());
    sample.signum() * compressed
}

/// RBJ audio-EQ-cookbook shelving filter with slope 1.
const MAX_EFFECT_DELAY_FRAMES: usize = 384_000;

struct StereoDelay {
    frames: Box<[[f32; 2]]>,
    write: usize,
    valid: usize,
}

impl StereoDelay {
    fn new() -> Self {
        Self {
            frames: vec![[0.0; 2]; MAX_EFFECT_DELAY_FRAMES].into_boxed_slice(),
            write: 0,
            valid: 0,
        }
    }

    fn reset(&mut self) {
        // Do not clear several megabytes on the realtime thread. `valid` masks stale frames until
        // the new transition has written enough samples to reach its requested delay.
        self.write = 0;
        self.valid = 0;
    }

    fn process(&mut self, input: [f32; 2], delay_frames: usize, feedback: f32) -> [f32; 2] {
        let delay = delay_frames.clamp(1, self.frames.len() - 1);
        let read = (self.write + self.frames.len() - delay) % self.frames.len();
        let delayed = if self.valid >= delay {
            self.frames[read]
        } else {
            [0.0; 2]
        };
        self.frames[self.write] = [
            input[0] + delayed[0] * feedback,
            input[1] + delayed[1] * feedback,
        ];
        self.write = (self.write + 1) % self.frames.len();
        self.valid = self.valid.saturating_add(1).min(self.frames.len());
        delayed
    }
}

/// Fixed-allocation transition effects used only by the dynamic native renderer.
pub(crate) struct TransitionFx {
    low_band: [[f32; 2]; 2],
    filter_low: [[f32; 2]; 2],
    hydrant_low: [f32; 2],
    echo: StereoDelay,
    hydrant: StereoDelay,
    alarm_phase: f32,
    control_tick: u8,
    cached_sample_rate: u32,
    low_alpha: f32,
    eq_gains: [f32; 2],
    filter_alphas: [f32; 2],
    hydrant_alpha: f32,
}

impl TransitionFx {
    pub(crate) fn new() -> Self {
        Self {
            low_band: [[0.0; 2]; 2],
            filter_low: [[0.0; 2]; 2],
            hydrant_low: [0.0; 2],
            echo: StereoDelay::new(),
            hydrant: StereoDelay::new(),
            alarm_phase: 0.0,
            control_tick: 0,
            cached_sample_rate: 0,
            low_alpha: 1.0,
            eq_gains: [1.0; 2],
            filter_alphas: [1.0; 2],
            hydrant_alpha: 1.0,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.low_band = [[0.0; 2]; 2];
        self.filter_low = [[0.0; 2]; 2];
        self.hydrant_low = [0.0; 2];
        self.echo.reset();
        self.hydrant.reset();
        self.alarm_phase = 0.0;
        self.control_tick = 0;
    }

    pub(crate) fn process(
        &mut self,
        mut decks: [[f32; 2]; 2],
        from: usize,
        to: usize,
        progress: f32,
        sample_rate: u32,
        plan: crate::TransitionPlan,
    ) -> ([[f32; 2]; 2], [f32; 2]) {
        let progress = progress.clamp(0.0, 1.0);
        let sample_rate_u32 = sample_rate.max(1);
        let sample_rate = sample_rate_u32 as f32;
        if self.cached_sample_rate != sample_rate_u32 {
            self.cached_sample_rate = sample_rate_u32;
            self.low_alpha = one_pole_alpha(250.0, sample_rate);
            self.control_tick = 0;
        }
        if self.control_tick == 0 {
            self.eq_gains = [
                if from == 0 {
                    db_gain(-18.0 * progress)
                } else {
                    db_gain(-12.0 * (1.0 - progress))
                },
                if from == 1 {
                    db_gain(-18.0 * progress)
                } else {
                    db_gain(-12.0 * (1.0 - progress))
                },
            ];
            let outgoing_cutoff = 18_000.0 * (160.0f32 / 18_000.0).powf(progress);
            let incoming_cutoff = 700.0 * (10.0f32 / 700.0).powf(progress.min(0.7) / 0.7);
            self.filter_alphas = [
                one_pole_alpha(outgoing_cutoff, sample_rate),
                one_pole_alpha(incoming_cutoff, sample_rate),
            ];
            self.hydrant_alpha = one_pole_alpha(120.0 + 1_680.0 * progress, sample_rate);
        }
        self.control_tick = (self.control_tick + 1) & 63;

        if plan.contains(crate::TransitionPlan::EQ) {
            for deck in [from, to] {
                for channel in 0..2 {
                    self.low_band[deck][channel] +=
                        self.low_alpha * (decks[deck][channel] - self.low_band[deck][channel]);
                    let low = self.low_band[deck][channel];
                    decks[deck][channel] = decks[deck][channel] - low + low * self.eq_gains[deck];
                }
            }
        }

        if plan.contains(crate::TransitionPlan::FILTER) {
            let out_alpha = self.filter_alphas[0];
            let in_alpha = self.filter_alphas[1];
            for channel in 0..2 {
                self.filter_low[from][channel] +=
                    out_alpha * (decks[from][channel] - self.filter_low[from][channel]);
                decks[from][channel] = self.filter_low[from][channel];
                self.filter_low[to][channel] +=
                    in_alpha * (decks[to][channel] - self.filter_low[to][channel]);
                decks[to][channel] -= self.filter_low[to][channel];
            }
        }

        if plan.contains(crate::TransitionPlan::VOCAL_CUT) {
            let amount = ((progress - 0.08) / 0.82).clamp(0.0, 1.0);
            let left = decks[from][0];
            let right = decks[from][1];
            let side = [(left - right) * 0.5, (right - left) * 0.5];
            let makeup = 1.0 + amount * 0.35;
            decks[from] = [
                (left * (1.0 - amount) + side[0] * amount) * makeup,
                (right * (1.0 - amount) + side[1] * amount) * makeup,
            ];
        }

        let outgoing = decks[from];
        let mut wet = [0.0f32; 2];
        if plan.contains(crate::TransitionPlan::ECHO) {
            let delay = (plan.beat_frames / 2).max(1) as usize;
            let delayed = self.echo.process(outgoing, delay, 0.2 + progress * 0.14);
            let envelope = (progress / 0.82).min(1.0) * (1.0 - progress).sqrt() * 0.72;
            wet[0] += delayed[0] * envelope;
            wet[1] += delayed[1] * envelope;
        }
        if plan.contains(crate::TransitionPlan::ALARM) {
            let frequency = 760.0 + 520.0 * progress;
            self.alarm_phase = (self.alarm_phase + std::f32::consts::TAU * frequency / sample_rate)
                % std::f32::consts::TAU;
            let envelope = (std::f32::consts::PI * progress).sin().max(0.0) * 0.09;
            let tone = self.alarm_phase.sin() * envelope;
            wet[0] += tone;
            wet[1] += tone;
        }
        if plan.contains(crate::TransitionPlan::HYDRANT) {
            let delay =
                ((plan.beat_frames.max(1) as f32) * (1.0 - progress * 0.875)).max(1.0) as usize;
            let delayed = self
                .hydrant
                .process(outgoing, delay, 0.12 + progress * 0.18);
            let alpha = self.hydrant_alpha;
            let envelope = (progress / 0.82).min(1.0) * (1.0 - progress).sqrt() * 0.55;
            for channel in 0..2 {
                self.hydrant_low[channel] += alpha * (delayed[channel] - self.hydrant_low[channel]);
                wet[channel] += (delayed[channel] - self.hydrant_low[channel]) * envelope;
            }
        }
        wet[0] = wet[0].clamp(-1.0, 1.0);
        wet[1] = wet[1].clamp(-1.0, 1.0);
        (decks, wet)
    }
}

fn one_pole_alpha(cutoff: f32, sample_rate: f32) -> f32 {
    1.0 - (-2.0 * PI * cutoff.clamp(10.0, sample_rate * 0.45) / sample_rate).exp()
}

fn db_gain(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

fn shelf(sample_rate: u32, frequency: f32, gain_db: f32, high: bool) -> Coefficients {
    if gain_db.abs() < 0.000_1 {
        return Coefficients::default();
    }
    let nyquist = sample_rate as f32 * 0.5;
    let frequency = frequency.clamp(20.0, nyquist * 0.9);
    let a = 10.0f32.powf(gain_db / 40.0);
    let omega = 2.0 * PI * frequency / sample_rate as f32;
    let cosine = omega.cos();
    let sine = omega.sin();
    let alpha = sine * 0.5 * 2.0f32.sqrt();
    let beta = 2.0 * a.sqrt() * alpha;

    let (b0, b1, b2, a0, a1, a2) = if high {
        (
            a * ((a + 1.0) + (a - 1.0) * cosine + beta),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cosine),
            a * ((a + 1.0) + (a - 1.0) * cosine - beta),
            (a + 1.0) - (a - 1.0) * cosine + beta,
            2.0 * ((a - 1.0) - (a + 1.0) * cosine),
            (a + 1.0) - (a - 1.0) * cosine - beta,
        )
    } else {
        (
            a * ((a + 1.0) - (a - 1.0) * cosine + beta),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cosine),
            a * ((a + 1.0) - (a - 1.0) * cosine - beta),
            (a + 1.0) + (a - 1.0) * cosine + beta,
            -2.0 * ((a - 1.0) + (a + 1.0) * cosine),
            (a + 1.0) + (a - 1.0) * cosine - beta,
        )
    };
    Coefficients {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn peaking(sample_rate: u32, frequency: f32, q: f32, gain_db: f32) -> Coefficients {
    if gain_db.abs() < 0.000_1 {
        return Coefficients::default();
    }
    let frequency = frequency.clamp(20.0, sample_rate as f32 * 0.45);
    let a = 10.0f32.powf(gain_db / 40.0);
    let omega = 2.0 * PI * frequency / sample_rate as f32;
    let alpha = omega.sin() / (2.0 * q.max(0.1));
    let cosine = omega.cos();
    let (b0, b1, b2, a0, a1, a2) = (
        1.0 + alpha * a,
        -2.0 * cosine,
        1.0 - alpha * a,
        1.0 + alpha / a,
        -2.0 * cosine,
        1.0 - alpha / a,
    );
    normalized_coefficients(b0, b1, b2, a0, a1, a2)
}

fn low_pass(sample_rate: u32, frequency: f32, q: f32) -> Coefficients {
    let omega = 2.0 * PI * frequency.clamp(20.0, sample_rate as f32 * 0.45) / sample_rate as f32;
    let cosine = omega.cos();
    let alpha = omega.sin() / (2.0 * q.max(0.1));
    normalized_coefficients(
        (1.0 - cosine) * 0.5,
        1.0 - cosine,
        (1.0 - cosine) * 0.5,
        1.0 + alpha,
        -2.0 * cosine,
        1.0 - alpha,
    )
}

fn high_pass(sample_rate: u32, frequency: f32, q: f32) -> Coefficients {
    let omega = 2.0 * PI * frequency.clamp(20.0, sample_rate as f32 * 0.45) / sample_rate as f32;
    let cosine = omega.cos();
    let alpha = omega.sin() / (2.0 * q.max(0.1));
    normalized_coefficients(
        (1.0 + cosine) * 0.5,
        -(1.0 + cosine),
        (1.0 + cosine) * 0.5,
        1.0 + alpha,
        -2.0 * cosine,
        1.0 - alpha,
    )
}

/// RBJ constant-peak-gain band pass. A sine at the centre remains unity while frequencies
/// outside the one-third-octave window fall away, making fixed dBFS display scaling meaningful.
fn band_pass(sample_rate: u32, frequency: f32, q: f32) -> Coefficients {
    let omega = 2.0 * PI * frequency.clamp(20.0, sample_rate as f32 * 0.45) / sample_rate as f32;
    let alpha = omega.sin() / (2.0 * q.max(0.1));
    let cosine = omega.cos();
    normalized_coefficients(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha)
}

fn normalized_coefficients(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Coefficients {
    Coefficients {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TransitionPlan;

    fn tone_rms(eq: &mut DeckEq, frequency: f32) -> f32 {
        let mut energy = 0.0;
        let sample_rate = 48_000.0;
        for frame in 0..48_000 {
            let sample = (2.0 * PI * frequency * frame as f32 / sample_rate).sin() * 0.5;
            let output = eq.process_stereo([sample; 2])[0];
            if frame >= 24_000 {
                energy += output * output;
            }
        }
        (energy / 24_000.0).sqrt()
    }

    fn tone_peak(eq: &mut DeckEq, frequency: f32, amplitude: f32) -> f32 {
        let sample_rate = 48_000.0;
        let mut peak = 0.0f32;
        for frame in 0..48_000 {
            let sample = (2.0 * PI * frequency * frame as f32 / sample_rate).sin() * amplitude;
            let output = eq.process_stereo([sample; 2])[0];
            if frame >= 24_000 {
                peak = peak.max(output.abs());
            }
        }
        peak
    }

    fn coefficient_distance(left: Coefficients, right: Coefficients) -> f32 {
        (left.b0 - right.b0).abs()
            + (left.b1 - right.b1).abs()
            + (left.b2 - right.b2).abs()
            + (left.a1 - right.a1).abs()
            + (left.a2 - right.a2).abs()
    }

    #[test]
    fn three_band_deck_eq_audibly_cuts_each_target_band() {
        for (frequency, gains) in [
            (100.0, (-48.0, 0.0, 0.0)),
            (1_200.0, (0.0, -48.0, 0.0)),
            (8_000.0, (0.0, 0.0, -48.0)),
        ] {
            let mut neutral = DeckEq::default();
            neutral.configure(
                48_000,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                crate::DEFAULT_FILTER_RESONANCE_Q,
            );
            let neutral_rms = tone_rms(&mut neutral, frequency);
            let mut cut = DeckEq::default();
            cut.configure(
                48_000,
                0.0,
                gains.0,
                gains.1,
                gains.2,
                0.0,
                crate::DEFAULT_FILTER_RESONANCE_Q,
            );
            let cut_rms = tone_rms(&mut cut, frequency);
            assert!(
                cut_rms < neutral_rms * 0.2,
                "{frequency} Hz band cut stayed too loud: neutral={neutral_rms}, cut={cut_rms}",
            );
        }
    }

    #[test]
    fn live_spectrum_keeps_narrow_tones_in_their_own_band() {
        let mut spectrum = DeckSpectrum::default();
        spectrum.ensure_sample_rate(48_000);
        for frame in 0..48_000 {
            let sample = (2.0 * PI * 1_000.0 * frame as f32 / 48_000.0).sin() * 0.5;
            spectrum.observe([sample; 2]);
        }
        let levels = spectrum.levels();
        let strongest = levels
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(index, _)| index);
        assert_eq!(strongest, Some(7));
        assert!(
            levels[7] > levels[2] * 5.0,
            "1 kHz leaked into LOW: {levels:?}"
        );
        assert!(
            levels[7] > levels[12] * 5.0,
            "1 kHz leaked into HIGH: {levels:?}"
        );
    }

    #[test]
    fn channel_filter_resonance_uses_low_as_legacy_and_high_as_default() {
        // The current/legacy Q is the low setting. At a cutoff-adjacent tone, the high setting
        // must be clearly stronger without returning to the former unsafe +12 dB peak.
        let mut low = DeckEq::default();
        low.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            -0.55,
            crate::FILTER_RESONANCE_LOW_Q,
        );
        let mut high = DeckEq::default();
        high.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            -0.55,
            crate::FILTER_RESONANCE_HIGH_Q,
        );
        let low_rms = tone_rms(&mut low, 1_000.0);
        let high_rms = tone_rms(&mut high, 1_000.0);
        assert!(
            high_rms > low_rms * 1.6,
            "high resonance did not exceed legacy low response: low={low_rms}, high={high_rms}"
        );
    }

    #[test]
    fn channel_filter_treats_one_percent_as_the_center_detent() {
        let mut exact = DeckEq::default();
        exact.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            crate::FILTER_RESONANCE_HIGH_Q,
        );
        let mut near = DeckEq::default();
        near.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            0.01,
            crate::FILTER_RESONANCE_HIGH_Q,
        );
        let exact_rms = tone_rms(&mut exact, 1_000.0);
        let near_rms = tone_rms(&mut near, 1_000.0);
        assert!(
            (near_rms - exact_rms).abs() < exact_rms * 0.01,
            "±1% FILTER still engaged the channel filter: exact={exact_rms}, near={near_rms}"
        );
    }

    #[test]
    fn near_center_filter_uses_monotonic_q_without_resonant_gain() {
        for filter in [-0.10, -0.04, -0.03, 0.03, 0.04, 0.10] {
            let effective = effective_filter_resonance(filter, crate::FILTER_RESONANCE_HIGH_Q);
            assert!(
                (effective - FILTER_NEAR_CENTER_Q).abs() < 0.000_1,
                "FILTER {filter:+.0}% restored resonance inside the protected centre range: Q={effective}",
                filter = filter * 100.0,
            );

            let cutoff = if filter < 0.0 {
                18_000.0 * (90.0f32 / 18_000.0).powf(-filter)
            } else {
                22.0 * (8_000.0f32 / 22.0).powf(filter)
            };
            let peak_frequency = if filter < 0.0 {
                cutoff * 0.955
            } else {
                cutoff * 1.047
            };
            let mut dry = DeckEq::default();
            dry.configure(
                48_000,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                crate::FILTER_RESONANCE_HIGH_Q,
            );
            let mut filtered = DeckEq::default();
            filtered.configure(
                48_000,
                0.0,
                0.0,
                0.0,
                0.0,
                filter,
                crate::FILTER_RESONANCE_HIGH_Q,
            );
            let dry_rms = tone_rms(&mut dry, peak_frequency);
            let filtered_rms = tone_rms(&mut filtered, peak_frequency);
            assert!(
                filtered_rms <= dry_rms * 1.01,
                "FILTER {filter:+.0}% still boosted its former resonance: dry={dry_rms}, filtered={filtered_rms}",
                filter = filter * 100.0,
            );
        }
    }

    #[test]
    fn near_center_filter_sweep_stays_continuous_on_bass_heavy_audio() {
        let mut eq = DeckEq::default();
        let mut previous = 0.0f32;
        let mut peak = 0.0f32;
        let mut largest_step = 0.0f32;
        let mut frame = 0usize;
        for filter in [0.0, 0.02, 0.03, 0.04, 0.06, 0.08, 0.10, 0.08, 0.04, 0.0] {
            eq.configure(
                48_000,
                0.0,
                0.0,
                0.0,
                0.0,
                filter,
                crate::FILTER_RESONANCE_HIGH_Q,
            );
            for _ in 0..1_920 {
                let phase = frame as f32 / 48_000.0;
                let input = (2.0 * PI * 30.0 * phase).sin() * 0.72
                    + (2.0 * PI * 1_000.0 * phase).sin() * 0.12;
                let output = eq.process_stereo([input; 2])[0];
                assert!(output.is_finite());
                peak = peak.max(output.abs());
                largest_step = largest_step.max((output - previous).abs());
                previous = output;
                frame += 1;
            }
        }
        assert!(
            peak < 0.9,
            "near-centre sweep unexpectedly gained the input: peak={peak}"
        );
        assert!(
            largest_step < 0.08,
            "near-centre sweep produced a discontinuity: largest_step={largest_step}"
        );
    }

    #[test]
    fn selected_filter_resonance_returns_smoothly_after_the_protected_range() {
        let selected = crate::FILTER_RESONANCE_HIGH_Q;
        let at_start = effective_filter_resonance(FILTER_RESONANCE_RAMP_START, selected);
        let midway = effective_filter_resonance(
            (FILTER_RESONANCE_RAMP_START + FILTER_RESONANCE_RAMP_END) * 0.5,
            selected,
        );
        let at_end = effective_filter_resonance(FILTER_RESONANCE_RAMP_END, selected);
        assert!((at_start - FILTER_NEAR_CENTER_Q).abs() < f32::EPSILON);
        assert!(midway > at_start && midway < at_end);
        assert!((at_end - selected).abs() < f32::EPSILON);
    }

    #[test]
    fn resonant_filter_uses_a_soft_ceiling_for_near_full_scale_audio() {
        let filter = -0.55;
        let cutoff = 18_000.0 * (90.0f32 / 18_000.0).powf(-filter);
        let mut high = DeckEq::default();
        high.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            filter,
            crate::FILTER_RESONANCE_HIGH_Q,
        );

        let peak = tone_peak(&mut high, cutoff, 0.98);
        assert!(
            peak > FILTER_SOFT_LIMIT_KNEE,
            "test tone never reached the resonant limiter knee: peak={peak}"
        );
        assert!(
            peak < 0.99,
            "resonant high filter reached the renderer's hard-clipping range: peak={peak}"
        );
    }

    #[test]
    fn channel_filter_crossfades_between_knob_updates() {
        let mut eq = DeckEq::default();
        eq.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            -0.25,
            crate::FILTER_RESONANCE_HIGH_Q,
        );
        for _ in 0..filter_crossfade_frames(48_000) {
            eq.process_stereo([0.2; 2]);
        }
        let before = eq.channel_filter.coefficients;

        eq.configure(
            48_000,
            0.0,
            0.0,
            0.0,
            0.0,
            -0.75,
            crate::FILTER_RESONANCE_HIGH_Q,
        );
        let target = eq.channel_filter_next.coefficients;
        assert!(eq.channel_filter_crossfade_remaining > 0);
        eq.process_stereo([0.2; 2]);
        let first_mix = eq.channel_filter_crossfade;

        assert_eq!(
            coefficient_distance(before, eq.channel_filter.coefficients),
            0.0
        );
        assert!(
            coefficient_distance(before, target) > 0.0,
            "FILTER update did not prepare a distinct target bank"
        );
        assert!(first_mix > 0.0 && first_mix < 1.0);
        for _ in 1..filter_crossfade_frames(48_000) {
            eq.process_stereo([0.2; 2]);
        }
        assert_eq!(eq.channel_filter_crossfade_remaining, 0);
        assert!(coefficient_distance(eq.channel_filter.coefficients, target) < 0.000_1);
    }

    #[test]
    fn all_transition_effects_stay_finite_without_runtime_allocation() {
        let mut fx = TransitionFx::new();
        let plan = TransitionPlan {
            flags: TransitionPlan::EQ
                | TransitionPlan::FILTER
                | TransitionPlan::VOCAL_CUT
                | TransitionPlan::ECHO
                | TransitionPlan::ALARM
                | TransitionPlan::HYDRANT,
            beat_frames: 24_000,
        };
        let mut energy = 0.0;
        for frame in 0..96_000 {
            let progress = frame as f32 / 95_999.0;
            let (decks, wet) = fx.process([[0.4, -0.2], [-0.1, 0.3]], 0, 1, progress, 48_000, plan);
            for sample in decks.into_iter().flatten().chain(wet) {
                assert!(sample.is_finite());
                energy += sample.abs();
            }
        }
        assert!(energy > 1.0);
    }
}
