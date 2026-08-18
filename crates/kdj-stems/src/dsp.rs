//! SCNet Small spectral-core packing and waveform reconstruction.
//!
//! The fixed deployment model accepts a normalized complex stereo STFT shaped
//! `[1, 4, 2049, 338]` (`L.re / L.im / R.re / R.im`) and returns
//! `[1, 4, 4, 2049, 338]` in `drums / bass / other / vocals` order. STFT, scalar
//! normalization and iSTFT stay in Rust so Core ML and ONNX use one signal contract.

use anyhow::{bail, Result};
use rustfft::num_complex::Complex32;

use crate::debug_dsp::{istft, stft, DebugWindow};
use crate::{SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES, SEGMENT_SAMPLES};

pub(crate) const MODEL_CHANNELS: usize = 4;
pub(crate) const MODEL_STEMS: usize = 4;
pub(crate) const SCNET_FFT: usize = 4_096;
pub(crate) const SCNET_HOP: usize = 1_024;
pub(crate) const SCNET_BINS: usize = 2_049;
pub(crate) const SCNET_FRAMES: usize = 338;
pub(crate) const SCNET_PAD_SAMPLES: usize = 1_108;
pub(crate) const SCNET_PADDED_SAMPLES: usize = SEGMENT_SAMPLES + SCNET_PAD_SAMPLES;
pub(crate) const MODEL_INPUT_ELEMENTS: usize = MODEL_CHANNELS * SCNET_BINS * SCNET_FRAMES;
pub(crate) const MODEL_OUTPUT_ELEMENTS: usize =
    MODEL_STEMS * MODEL_CHANNELS * SCNET_BINS * SCNET_FRAMES;

#[derive(Debug)]
pub(crate) struct PackedInput {
    pub values: Vec<f32>,
    pub mean: f32,
    pub std: f32,
}

pub(crate) fn pack_model_input(left: &[f32], right: &[f32]) -> Result<PackedInput> {
    if left.len() != SEGMENT_SAMPLES || right.len() != SEGMENT_SAMPLES {
        bail!("SCNet tile must contain {SEGMENT_SAMPLES} stereo frames");
    }
    let mut left = sanitize_and_pad(left);
    let mut right = sanitize_and_pad(right);
    debug_assert_eq!(left.len(), SCNET_PADDED_SAMPLES);
    debug_assert_eq!(right.len(), SCNET_PADDED_SAMPLES);
    let left_spec = stft(
        &left,
        SCNET_FFT,
        SCNET_HOP,
        DebugWindow::Rectangular,
        true,
        true,
    );
    let right_spec = stft(
        &right,
        SCNET_FFT,
        SCNET_HOP,
        DebugWindow::Rectangular,
        true,
        true,
    );
    // Release the two 1.3 MiB time-domain staging buffers before allocating model output.
    left.clear();
    right.clear();
    if left_spec.bins != SCNET_BINS
        || left_spec.frames != SCNET_FRAMES
        || right_spec.bins != SCNET_BINS
        || right_spec.frames != SCNET_FRAMES
    {
        bail!(
            "SCNet STFT shape [{}, {}] / [{}, {}] != [{SCNET_BINS}, {SCNET_FRAMES}]",
            left_spec.bins,
            left_spec.frames,
            right_spec.bins,
            right_spec.frames
        );
    }

    let mut values = vec![0.0f32; MODEL_INPUT_ELEMENTS];
    for frequency in 0..SCNET_BINS {
        for time in 0..SCNET_FRAMES {
            let source = frequency * SCNET_FRAMES + time;
            let left = left_spec.values[source];
            let right = right_spec.values[source];
            values[model_index(0, frequency, time)] = left.re;
            values[model_index(1, frequency, time)] = left.im;
            values[model_index(2, frequency, time)] = right.re;
            values[model_index(3, frequency, time)] = right.im;
        }
    }
    let (mean, std) = sample_mean_std(&values);
    let denominator = 1e-5 + std;
    for value in &mut values {
        *value = (*value - mean) / denominator;
    }
    Ok(PackedInput { values, mean, std })
}

pub(crate) fn unpack_model_output(
    output: &[f32],
    mean: f32,
    std: f32,
) -> Result<[Vec<[f32; 2]>; 4]> {
    if output.len() != MODEL_OUTPUT_ELEMENTS {
        bail!(
            "SCNet output elements {} != {MODEL_OUTPUT_ELEMENTS}",
            output.len()
        );
    }
    let scale = 1e-5 + finite(std).max(0.0);
    let mean = finite(mean);
    let mut stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| vec![[0.0, 0.0]; SEGMENT_SAMPLES]);
    for stem in 0..MODEL_STEMS {
        for channel in 0..2 {
            let real_feature = channel * 2;
            let imag_feature = real_feature + 1;
            let mut spectrum = vec![Complex32::default(); SCNET_BINS * SCNET_FRAMES];
            for frequency in 0..SCNET_BINS {
                for time in 0..SCNET_FRAMES {
                    let target = frequency * SCNET_FRAMES + time;
                    spectrum[target] = Complex32::new(
                        finite(output[output_index(stem, real_feature, frequency, time)]) * scale
                            + mean,
                        finite(output[output_index(stem, imag_feature, frequency, time)]) * scale
                            + mean,
                    );
                }
            }
            let mut waveform = istft(
                &spectrum,
                SCNET_BINS,
                SCNET_FRAMES,
                SCNET_FFT,
                SCNET_HOP,
                DebugWindow::Rectangular,
                true,
                true,
                SCNET_PADDED_SAMPLES,
            );
            waveform.truncate(SEGMENT_SAMPLES);
            for (frame, sample) in stems[stem].iter_mut().zip(waveform) {
                frame[channel] = finite(sample);
            }
        }
    }
    Ok(stems)
}

/// Collapse separator residue only when the retained source core is effectively silent. Unlike
/// the old per-hop normalizer this never raises a quiet stem or changes inter-stem balance.
pub(crate) fn apply_soft_gate(left: &[f32], right: &[f32], stems: &mut [Vec<[f32; 2]>; 4]) {
    const FLOOR: f64 = 1e-10;
    let start = SEGMENT_CONTEXT_SAMPLES;
    let end = (start + SEGMENT_CORE_SAMPLES)
        .min(left.len())
        .min(right.len());
    let energy = left[start..end]
        .iter()
        .zip(&right[start..end])
        .map(|(left, right)| {
            let left = f64::from(finite(*left));
            let right = f64::from(finite(*right));
            left * left + right * right
        })
        .sum::<f64>();
    if energy > FLOOR {
        return;
    }
    for stem in stems {
        for frame in stem {
            *frame = [0.0, 0.0];
        }
    }
}

fn sanitize_and_pad(input: &[f32]) -> Vec<f32> {
    let mut output = Vec::with_capacity(SCNET_PADDED_SAMPLES);
    output.extend(input.iter().map(|sample| finite(*sample)));
    output.resize(SCNET_PADDED_SAMPLES, 0.0);
    output
}

fn sample_mean_std(values: &[f32]) -> (f32, f32) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let count = values.len() as f64;
    let mean = values.iter().map(|value| f64::from(*value)).sum::<f64>() / count;
    let variance = if values.len() > 1 {
        values
            .iter()
            .map(|value| {
                let delta = f64::from(*value) - mean;
                delta * delta
            })
            .sum::<f64>()
            / (count - 1.0)
    } else {
        0.0
    };
    (mean as f32, variance.sqrt() as f32)
}

fn model_index(feature: usize, frequency: usize, time: usize) -> usize {
    (feature * SCNET_BINS + frequency) * SCNET_FRAMES + time
}

fn output_index(stem: usize, feature: usize, frequency: usize, time: usize) -> usize {
    ((stem * MODEL_CHANNELS + feature) * SCNET_BINS + frequency) * SCNET_FRAMES + time
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_shape_matches_the_locked_scnet_export() {
        assert_eq!(SCNET_PADDED_SAMPLES, 345_088);
        assert_eq!(SCNET_FRAMES, 338);
        assert_eq!(MODEL_INPUT_ELEMENTS, 2_770_248);
        assert_eq!(MODEL_OUTPUT_ELEMENTS, 11_080_992);
    }

    #[test]
    fn pack_layout_is_channel_major_and_normalized() {
        let mut left = vec![0.0; SEGMENT_SAMPLES];
        let mut right = vec![0.0; SEGMENT_SAMPLES];
        for index in 0..SEGMENT_SAMPLES {
            left[index] = (std::f32::consts::TAU * 440.0 * index as f32 / 44_100.0).sin() * 0.2;
            right[index] = (std::f32::consts::TAU * 880.0 * index as f32 / 44_100.0).sin() * 0.1;
        }
        let packed = pack_model_input(&left, &right).unwrap();
        assert_eq!(packed.values.len(), MODEL_INPUT_ELEMENTS);
        let mean = packed
            .values
            .iter()
            .map(|value| f64::from(*value))
            .sum::<f64>()
            / packed.values.len() as f64;
        assert!(mean.abs() < 1e-5, "normalized mean={mean}");
        assert!(packed.std > 0.0);
        assert_ne!(
            packed.values[model_index(0, 10, 10)],
            packed.values[model_index(2, 10, 10)]
        );
    }

    #[test]
    fn silent_core_gates_model_residue() {
        let input = vec![0.0; SEGMENT_SAMPLES];
        let mut stems: [Vec<[f32; 2]>; 4] =
            std::array::from_fn(|_| vec![[0.05, 0.05]; SEGMENT_SAMPLES]);
        apply_soft_gate(&input, &input, &mut stems);
        assert_eq!(stems[0][SEGMENT_CONTEXT_SAMPLES], [0.0, 0.0]);
    }
}
