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

#[derive(Clone, Copy, Debug, Default)]
struct BiquadState {
    z1: f32,
    z2: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct StereoBiquad {
    coefficients: Coefficients,
    state: [BiquadState; 2],
}

impl StereoBiquad {
    fn set_coefficients(&mut self, coefficients: Coefficients) {
        self.coefficients = coefficients;
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

/// Two-band DJ isolator. Coefficients are recalculated only when a command or device rate changes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeckEq {
    low_db: f32,
    high_db: f32,
    sample_rate: u32,
    low: StereoBiquad,
    high: StereoBiquad,
}

impl Default for DeckEq {
    fn default() -> Self {
        Self {
            low_db: 0.0,
            high_db: 0.0,
            sample_rate: 0,
            low: StereoBiquad::default(),
            high: StereoBiquad::default(),
        }
    }
}

impl DeckEq {
    pub(crate) fn configure(&mut self, sample_rate: u32, low_db: f32, high_db: f32) {
        let low_db = finite_db(low_db);
        let high_db = finite_db(high_db);
        if self.sample_rate == sample_rate && self.low_db == low_db && self.high_db == high_db {
            return;
        }
        self.sample_rate = sample_rate.max(1);
        self.low_db = low_db;
        self.high_db = high_db;
        self.low
            .set_coefficients(shelf(self.sample_rate, 250.0, low_db, false));
        self.high
            .set_coefficients(shelf(self.sample_rate, 4_000.0, high_db, true));
    }

    pub(crate) fn ensure_sample_rate(&mut self, sample_rate: u32) {
        self.configure(sample_rate, self.low_db, self.high_db);
    }

    pub(crate) fn reset(&mut self) {
        self.low.state = [BiquadState::default(); 2];
        self.high.state = [BiquadState::default(); 2];
    }

    pub(crate) fn process_stereo(&mut self, input: [f32; 2]) -> [f32; 2] {
        let mut output = [0.0; 2];
        for channel in 0..2 {
            output[channel] = self
                .high
                .process(channel, self.low.process(channel, input[channel]));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TransitionPlan;

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
