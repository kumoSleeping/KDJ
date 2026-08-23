//! Model-free stereo source separation for the realtime DJ path.
//!
//! Test A is the classical centre extraction baseline. Test B follows de Frein's Redress
//! formulation: build the two-sided ADRess azimugram (paper equations 8-10), precompute source
//! azimuth trajectories (equations 22-24), and solve the non-negative quadratic programme with
//! the Lee-Seung multiplicative update from equation 25. KDJ groups the centre trajectory as the
//! vocal estimate and the left/right trajectories as accompaniment, then applies a complementary
//! soft ratio mask to both stereo channels. The complementary mask is a product adaptation: it
//! preserves the original stereo image and guarantees that vocals + instrumental reconstruct the
//! input.

use std::sync::Arc;

use anyhow::{bail, Result};
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

pub const FFT_SIZE: usize = 2_048;
pub const HOP_SIZE: usize = 512;
pub const ALGORITHMIC_LATENCY_FRAMES: usize = FFT_SIZE / 2;
pub const REDRESS_GAIN_STEPS: usize = 100;
pub const REDRESS_ITERATIONS: usize = 100;
const SOURCE_COUNT: usize = 3;
const AZIMUTH_COLUMNS: usize = (REDRESS_GAIN_STEPS + 1) * 2;
const EPSILON: f32 = 1.0e-12;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ClassicalMode {
    /// Test A: `(L + R) / 2` duplicated to stereo, with accompaniment as the exact residual.
    Center,
    /// Test B: Redress NQP with left / centre / right azimuth trajectories.
    #[default]
    Redress,
}

#[derive(Clone, Debug)]
pub struct SeparationOutput {
    pub vocals: Vec<[f32; 2]>,
    pub instrumental: Vec<[f32; 2]>,
}

impl SeparationOutput {
    pub fn frames(&self) -> usize {
        self.vocals.len().min(self.instrumental.len())
    }
}

/// Reusable CPU separator. It owns only FFT plans and the precomputed Redress trajectory table;
/// no weights, runtime downloads, accelerator sessions, or whole-track analysis are involved.
pub struct ClassicalSeparator {
    mode: ClassicalMode,
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    redress: RedressNqp,
}

impl ClassicalSeparator {
    pub fn new(mode: ClassicalMode) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(FFT_SIZE);
        let inverse = planner.plan_fft_inverse(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|index| {
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / FFT_SIZE as f32).cos()
            })
            .collect();
        Self {
            mode,
            forward,
            inverse,
            window,
            redress: RedressNqp::new(),
        }
    }

    pub fn mode(&self) -> ClassicalMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: ClassicalMode) {
        self.mode = mode;
        self.reset();
    }

    /// Redress Test B is frame-local. Reset is intentionally cheap and deterministic so a seek
    /// can discard all short-term state without waiting for previous audio or a full-track pass.
    pub fn reset(&mut self) {}

    pub fn algorithmic_latency_frames(&self) -> usize {
        match self.mode {
            ClassicalMode::Center => 0,
            ClassicalMode::Redress => ALGORITHMIC_LATENCY_FRAMES,
        }
    }

    pub fn workspace_bytes(&self) -> usize {
        self.window.len() * size_of::<f32>()
            + self.redress.workspace_bytes()
            + FFT_SIZE * size_of::<Complex32>() * 8
    }

    pub fn process_stereo(&mut self, input: &[[f32; 2]]) -> Result<SeparationOutput> {
        match self.mode {
            ClassicalMode::Center => Ok(center_extract(input)),
            ClassicalMode::Redress => self.redress_stft(input),
        }
    }

    fn redress_stft(&mut self, input: &[[f32; 2]]) -> Result<SeparationOutput> {
        if input.iter().flatten().any(|sample| !sample.is_finite()) {
            bail!("经典 STEM 输入含非有限采样");
        }
        if input.is_empty() {
            return Ok(SeparationOutput {
                vocals: Vec::new(),
                instrumental: Vec::new(),
            });
        }

        // Centred STFT: one half-window of future context gives 23.2 ms algorithmic latency at
        // 44.1 kHz. Extra aligned padding ensures every source sample receives full OLA weight.
        let pad = FFT_SIZE;
        let required = input.len() + pad * 2;
        let padded_len =
            FFT_SIZE + (required.saturating_sub(FFT_SIZE) + HOP_SIZE - 1) / HOP_SIZE * HOP_SIZE;
        let mut left = vec![0.0f32; padded_len];
        let mut right = vec![0.0f32; padded_len];
        for (index, frame) in input.iter().enumerate() {
            left[pad + index] = frame[0];
            right[pad + index] = frame[1];
        }

        let mut vocal_left = vec![0.0f32; padded_len];
        let mut vocal_right = vec![0.0f32; padded_len];
        let mut instrumental_left = vec![0.0f32; padded_len];
        let mut instrumental_right = vec![0.0f32; padded_len];
        let mut ola_norm = vec![0.0f32; padded_len];
        let mut spectrum_left = vec![Complex32::new(0.0, 0.0); FFT_SIZE];
        let mut spectrum_right = vec![Complex32::new(0.0, 0.0); FFT_SIZE];
        let mut vocal_spectrum_left = spectrum_left.clone();
        let mut vocal_spectrum_right = spectrum_left.clone();
        let mut instrumental_spectrum_left = spectrum_left.clone();
        let mut instrumental_spectrum_right = spectrum_left.clone();
        let bins = FFT_SIZE / 2 + 1;
        let mut mask = vec![0.0f32; bins];

        for start in (0..=padded_len - FFT_SIZE).step_by(HOP_SIZE) {
            for index in 0..FFT_SIZE {
                let window = self.window[index];
                spectrum_left[index] = Complex32::new(left[start + index] * window, 0.0);
                spectrum_right[index] = Complex32::new(right[start + index] * window, 0.0);
            }
            self.forward.process(&mut spectrum_left);
            self.forward.process(&mut spectrum_right);

            for bin in 0..bins {
                mask[bin] = self
                    .redress
                    .centre_soft_mask(spectrum_left[bin], spectrum_right[bin]);
            }
            // A one-bin triangular frequency smoother is deliberately applied after the paper's
            // NQP, never inside it. It keeps isolated FFT holes from becoming musical-noise ticks.
            if bins > 2 {
                let original = mask.clone();
                for bin in 1..bins - 1 {
                    mask[bin] =
                        0.25 * original[bin - 1] + 0.5 * original[bin] + 0.25 * original[bin + 1];
                }
            }

            for bin in 0..FFT_SIZE {
                let positive = if bin <= FFT_SIZE / 2 {
                    bin
                } else {
                    FFT_SIZE - bin
                };
                let vocal = mask[positive].clamp(0.0, 1.0);
                let instrumental = 1.0 - vocal;
                vocal_spectrum_left[bin] = spectrum_left[bin] * vocal;
                vocal_spectrum_right[bin] = spectrum_right[bin] * vocal;
                instrumental_spectrum_left[bin] = spectrum_left[bin] * instrumental;
                instrumental_spectrum_right[bin] = spectrum_right[bin] * instrumental;
            }
            self.inverse.process(&mut vocal_spectrum_left);
            self.inverse.process(&mut vocal_spectrum_right);
            self.inverse.process(&mut instrumental_spectrum_left);
            self.inverse.process(&mut instrumental_spectrum_right);
            let inverse_scale = 1.0 / FFT_SIZE as f32;
            for index in 0..FFT_SIZE {
                let window = self.window[index];
                let output_index = start + index;
                let scale = window * inverse_scale;
                vocal_left[output_index] += vocal_spectrum_left[index].re * scale;
                vocal_right[output_index] += vocal_spectrum_right[index].re * scale;
                instrumental_left[output_index] += instrumental_spectrum_left[index].re * scale;
                instrumental_right[output_index] += instrumental_spectrum_right[index].re * scale;
                ola_norm[output_index] += window * window;
            }
        }

        let mut vocals = Vec::with_capacity(input.len());
        let mut instrumental = Vec::with_capacity(input.len());
        for index in 0..input.len() {
            let source = pad + index;
            let norm = ola_norm[source].max(EPSILON);
            vocals.push([vocal_left[source] / norm, vocal_right[source] / norm]);
            instrumental.push([
                instrumental_left[source] / norm,
                instrumental_right[source] / norm,
            ]);
        }
        Ok(SeparationOutput {
            vocals,
            instrumental,
        })
    }
}

/// Test A baseline. The residual construction makes reconstruction exact even though centred
/// drums, bass, and snare leak heavily into the vocal estimate.
pub fn center_extract(input: &[[f32; 2]]) -> SeparationOutput {
    let mut vocals = Vec::with_capacity(input.len());
    let mut instrumental = Vec::with_capacity(input.len());
    for &[left, right] in input {
        let center = 0.5 * (left + right);
        vocals.push([center, center]);
        instrumental.push([left - center, right - center]);
    }
    SeparationOutput {
        vocals,
        instrumental,
    }
}

struct RedressNqp {
    /// One row per azimugram column, with left / centre / right trajectories.
    trajectories: Vec<[f32; SOURCE_COUNT]>,
    hht: [[f32; SOURCE_COUNT]; SOURCE_COUNT],
}

impl RedressNqp {
    fn new() -> Self {
        // Fixed source positions for a DJ vocal reducer: two symmetric accompaniment bases and
        // one exact-centre basis. `pan_ratio=0.35` is the paper's worked left-source attenuation;
        // right is its mirror. The centre trajectory uses equal channel gains.
        let gains = [[1.0, 0.35], [1.0, 1.0], [0.35, 1.0]];
        let mut trajectories = Vec::with_capacity(AZIMUTH_COLUMNS);
        for half in 0..2 {
            for step in 0..=REDRESS_GAIN_STEPS {
                let g = step as f32 / REDRESS_GAIN_STEPS as f32;
                trajectories.push(std::array::from_fn(|source| {
                    let [left, right] = gains[source];
                    if half == 0 {
                        (left - g * right).abs()
                    } else {
                        (right - g * left).abs()
                    }
                }));
            }
        }
        let hht = std::array::from_fn(|row| {
            std::array::from_fn(|column| {
                trajectories
                    .iter()
                    .map(|values| values[row] * values[column])
                    .sum::<f32>()
            })
        });
        Self { trajectories, hht }
    }

    fn workspace_bytes(&self) -> usize {
        self.trajectories.len() * size_of::<[f32; SOURCE_COUNT]>()
            + size_of::<[[f32; SOURCE_COUNT]; SOURCE_COUNT]>()
    }

    fn centre_soft_mask(&self, left: Complex32, right: Complex32) -> f32 {
        let mut aht = [0.0f32; SOURCE_COUNT];
        let mut column = 0;
        for half in 0..2 {
            for step in 0..=REDRESS_GAIN_STEPS {
                let g = step as f32 / REDRESS_GAIN_STEPS as f32;
                let azimuth = if half == 0 {
                    (left - right * g).norm()
                } else {
                    (right - left * g).norm()
                };
                for source in 0..SOURCE_COUNT {
                    aht[source] += azimuth * self.trajectories[column][source];
                }
                column += 1;
            }
        }
        let mixture = 0.5 * (left.norm() + right.norm());
        if mixture <= EPSILON {
            return 0.0;
        }
        let mut weights = [mixture / SOURCE_COUNT as f32; SOURCE_COUNT];
        for _ in 0..REDRESS_ITERATIONS {
            let previous = weights;
            for source in 0..SOURCE_COUNT {
                let denominator = (0..SOURCE_COUNT)
                    .map(|other| previous[other] * self.hht[other][source])
                    .sum::<f32>()
                    .max(EPSILON);
                weights[source] = (previous[source] * aht[source] / denominator).max(EPSILON);
            }
        }
        let total = weights.iter().sum::<f32>().max(EPSILON);
        (weights[1] / total).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms_error(actual: &[[f32; 2]], expected: &[[f32; 2]]) -> f64 {
        let energy = actual
            .iter()
            .zip(expected)
            .flat_map(|(actual, expected)| [actual[0] - expected[0], actual[1] - expected[1]])
            .map(|value| f64::from(value) * f64::from(value))
            .sum::<f64>();
        (energy / (actual.len().max(1) * 2) as f64).sqrt()
    }

    #[test]
    fn both_modes_are_finite_and_reconstruct_the_input() {
        let input: Vec<_> = (0..8_192)
            .map(|index| {
                let time = index as f32 / 44_100.0;
                [
                    0.4 * (std::f32::consts::TAU * 220.0 * time).sin(),
                    0.3 * (std::f32::consts::TAU * 330.0 * time).sin(),
                ]
            })
            .collect();
        for mode in [ClassicalMode::Center, ClassicalMode::Redress] {
            let output = ClassicalSeparator::new(mode)
                .process_stereo(&input)
                .unwrap();
            assert_eq!(output.frames(), input.len());
            for ((vocal, instrumental), source) in
                output.vocals.iter().zip(&output.instrumental).zip(&input)
            {
                for channel in 0..2 {
                    assert!(vocal[channel].is_finite());
                    assert!(instrumental[channel].is_finite());
                    assert!(
                        (vocal[channel] + instrumental[channel] - source[channel]).abs() < 2.0e-4
                    );
                }
            }
        }
    }

    #[test]
    fn redress_beats_center_extraction_for_panned_accompaniment() {
        let frames = 16_384;
        let mut input = Vec::with_capacity(frames);
        let mut wanted_vocal = Vec::with_capacity(frames);
        for index in 0..frames {
            let time = index as f32 / 44_100.0;
            let vocal = 0.35 * (std::f32::consts::TAU * 440.0 * time).sin();
            let left_bed = 0.25 * (std::f32::consts::TAU * 220.0 * time).sin();
            let right_bed = 0.22 * (std::f32::consts::TAU * 660.0 * time).sin();
            input.push([
                vocal + left_bed + 0.35 * right_bed,
                vocal + 0.35 * left_bed + right_bed,
            ]);
            wanted_vocal.push([vocal, vocal]);
        }
        let center = ClassicalSeparator::new(ClassicalMode::Center)
            .process_stereo(&input)
            .unwrap();
        let redress = ClassicalSeparator::new(ClassicalMode::Redress)
            .process_stereo(&input)
            .unwrap();
        let center_error = rms_error(&center.vocals, &wanted_vocal);
        let redress_error = rms_error(&redress.vocals, &wanted_vocal);
        assert!(
            redress_error < center_error * 0.8,
            "Redress RMS {redress_error} should beat center baseline {center_error}"
        );
    }

    #[test]
    fn reset_after_seek_is_immediate_and_deterministic() {
        let input = vec![[0.2, -0.1]; 4_096];
        let mut separator = ClassicalSeparator::new(ClassicalMode::Redress);
        let first = separator.process_stereo(&input).unwrap();
        separator.reset();
        let after_seek = separator.process_stereo(&input).unwrap();
        assert_eq!(first.vocals, after_seek.vocals);
        assert!(separator.algorithmic_latency_frames() <= 11_025);
    }
}
