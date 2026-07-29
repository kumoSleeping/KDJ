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
