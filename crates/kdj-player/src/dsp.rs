use std::f32::consts::PI;

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

    /// FILTER knob messages arrive at control rate, not sample rate. Interpolating the biquad
    /// coefficients here avoids an audible state/coefficients discontinuity every time the knob
    /// advances; the other EQ bands remain immediate because they are normally stepped rarely.
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
        self.sample_rate = sample_rate.max(1);
        self.trim_db = trim_db;
        self.low_db = low_db;
        self.mid_db = mid_db;
        self.high_db = high_db;
        self.filter = filter;
        self.filter_resonance = filter_resonance;
        self.trim_gain = db_gain(trim_db);
        self.low
            .set_coefficients(shelf(self.sample_rate, 220.0, low_db, false));
        self.mid
            .set_coefficients(peaking(self.sample_rate, 1_200.0, 0.8, mid_db));
        self.high
            .set_coefficients(shelf(self.sample_rate, 5_500.0, high_db, true));
        let filter_coefficients = if filter < -FILTER_CENTER_DEADZONE {
            let cutoff = 18_000.0 * (90.0f32 / 18_000.0).powf(-filter);
            low_pass(self.sample_rate, cutoff, filter_resonance)
        } else if filter > FILTER_CENTER_DEADZONE {
            let cutoff = 22.0 * (8_000.0f32 / 22.0).powf(filter);
            high_pass(self.sample_rate, cutoff, filter_resonance)
        } else {
            Coefficients::default()
        };
        self.channel_filter.ramp_coefficients(
            filter_coefficients,
            filter_coefficient_ramp_frames(self.sample_rate),
        );
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
    }

    pub(crate) fn process_stereo(&mut self, input: [f32; 2]) -> [f32; 2] {
        // Advance once per stereo frame so left/right stay on identical coefficients.
        self.channel_filter.advance_coefficients();
        let protect_resonant_peak =
            self.filter.abs() > FILTER_CENTER_DEADZONE && self.filter_resonance > 1.0;
        let mut output = [0.0; 2];
        for channel in 0..2 {
            let low = self.low.process(channel, input[channel] * self.trim_gain);
            let mid = self.mid.process(channel, low);
            let high = self.high.process(channel, mid);
            let filtered = self.channel_filter.process(channel, high);
            output[channel] = if protect_resonant_peak {
                resonant_filter_soft_limit(filtered)
            } else {
                filtered
            };
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
/// A 24 ms coefficient ramp is longer than an individual callback but shorter than a normal
/// control gesture. It turns frequent 40 ms UI updates into one continuous filter sweep.
const FILTER_COEFFICIENT_RAMP_MILLIS: u32 = 24;
const FILTER_SOFT_LIMIT_KNEE: f32 = 0.92;
const FILTER_SOFT_LIMIT_CEILING: f32 = 0.985;

fn filter_coefficient_ramp_frames(sample_rate: u32) -> u32 {
    (u64::from(sample_rate.max(1)) * u64::from(FILTER_COEFFICIENT_RAMP_MILLIS) / 1_000)
        .clamp(16, 4_096) as u32
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
    fn channel_filter_coefficients_ramp_between_knob_updates() {
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
        for _ in 0..filter_coefficient_ramp_frames(48_000) {
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
        let target = eq.channel_filter.coefficient_target;
        assert!(eq.channel_filter.coefficient_ramp_remaining > 0);
        eq.process_stereo([0.2; 2]);
        let first_step = eq.channel_filter.coefficients;

        assert!(coefficient_distance(before, first_step) > 0.0);
        assert!(
            coefficient_distance(before, first_step) < coefficient_distance(before, target),
            "FILTER coefficient change skipped its smoothing ramp"
        );
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
