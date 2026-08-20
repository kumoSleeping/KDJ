//! Spleeter4 magnitude packing, ratio masks and waveform reconstruction.
//!
//! Each independent ELU U-Net accepts `[2, 1, 512, 1024]` magnitudes. Rust owns the exact
//! periodic-Hann STFT, runs all four estimates through one soft ratio-mask denominator, extends
//! the unmodelled high band with each mask's per-frame mean and applies the masks to the original
//! complex mixture. The public lane order is `drums / bass / other / vocals`.

use anyhow::{bail, Result};
use rustfft::num_complex::Complex32;

use crate::debug_dsp::{istft, stft, DebugSpectrum, DebugWindow};
use crate::{
    MOBILENET_SEGMENT_SAMPLES, SEGMENT_CONTEXT_SAMPLES, SEGMENT_CORE_SAMPLES, SEGMENT_SAMPLES,
};

pub(crate) const MODEL_CHANNELS: usize = 2;
pub(crate) const MODEL_STEMS: usize = 4;
pub(crate) const SPLEETER_FFT: usize = 4_096;
pub(crate) const SPLEETER_HOP: usize = 1_024;
pub(crate) const SPLEETER_FULL_BINS: usize = 2_049;
pub(crate) const SPLEETER_BINS: usize = 1_024;
pub(crate) const SPLEETER_FRAMES: usize = 512;
pub(crate) const MODEL_INPUT_ELEMENTS: usize = MODEL_CHANNELS * SPLEETER_FRAMES * SPLEETER_BINS;
pub(crate) const MODEL_OUTPUT_ELEMENTS: usize = MODEL_STEMS * MODEL_INPUT_ELEMENTS;

pub(crate) const MOBILENET_INPUT_ELEMENTS: usize = MODEL_CHANNELS * MOBILENET_SEGMENT_SAMPLES;
pub(crate) const MOBILENET_OUTPUT_ELEMENTS: usize = MOBILENET_INPUT_ELEMENTS;

const RATIO_EPSILON: f32 = 1e-10;
const MODEL_PEAK_TARGET: f32 = 0.95;
const FP16_MAX: f32 = 65_504.0;

pub(crate) struct PackedInput {
    pub values: Vec<f32>,
    context: ReconstructionContext,
}

enum ReconstructionContext {
    Spleeter([DebugSpectrum; MODEL_CHANNELS]),
    MobileNet { left: Vec<f32>, right: Vec<f32> },
}

pub(crate) fn pack_model_input_for_mode(
    mode: kdj_core::StemMode,
    left: &[f32],
    right: &[f32],
) -> Result<PackedInput> {
    if mode == kdj_core::StemMode::MobileNetTwo {
        pack_mobilenet_input(left, right)
    } else {
        pack_spleeter_input(left, right)
    }
}

#[cfg(test)]
fn pack_model_input(left: &[f32], right: &[f32]) -> Result<PackedInput> {
    pack_model_input_for_mode(crate::runtime::stem_runtime_preference().mode, left, right)
}

pub(crate) fn pack_spleeter_input(left: &[f32], right: &[f32]) -> Result<PackedInput> {
    if left.len() != SEGMENT_SAMPLES || right.len() != SEGMENT_SAMPLES {
        bail!("Spleeter4 tile must contain {SEGMENT_SAMPLES} stereo frames");
    }
    // FP16 convolution can overflow on decoded float material whose true peak exceeds 0 dBFS.
    // Scale only the magnitudes seen by the U-Nets; masks are still applied to the untouched
    // complex mixture, so neutral four-lane reconstruction keeps the original sample level.
    let model_gain = model_input_gain(left, right);
    let spectra = [spleeter_stft(left), spleeter_stft(right)];
    for spectrum in &spectra {
        if spectrum.bins != SPLEETER_FULL_BINS || spectrum.frames != SPLEETER_FRAMES {
            bail!(
                "Spleeter4 STFT shape [{}, {}] != [{SPLEETER_FULL_BINS}, {SPLEETER_FRAMES}]",
                spectrum.bins,
                spectrum.frames
            );
        }
    }

    let mut values = vec![0.0f32; MODEL_INPUT_ELEMENTS];
    for channel in 0..MODEL_CHANNELS {
        for time in 0..SPLEETER_FRAMES {
            for frequency in 0..SPLEETER_BINS {
                let magnitude = spectra[channel].values[frequency * SPLEETER_FRAMES + time].norm();
                values[input_index(channel, time, frequency)] =
                    (finite(magnitude).max(0.0) * model_gain).min(FP16_MAX);
            }
        }
    }
    Ok(PackedInput {
        values,
        context: ReconstructionContext::Spleeter(spectra),
    })
}

fn pack_mobilenet_input(left: &[f32], right: &[f32]) -> Result<PackedInput> {
    if left.len() != MOBILENET_SEGMENT_SAMPLES || right.len() != MOBILENET_SEGMENT_SAMPLES {
        bail!("ByteDance MobileNet tile must contain {MOBILENET_SEGMENT_SAMPLES} stereo frames");
    }
    let left = left
        .iter()
        .map(|sample| finite(*sample))
        .collect::<Vec<_>>();
    let right = right
        .iter()
        .map(|sample| finite(*sample))
        .collect::<Vec<_>>();
    let mut values = Vec::with_capacity(MOBILENET_INPUT_ELEMENTS);
    values.extend_from_slice(&left);
    values.extend_from_slice(&right);
    Ok(PackedInput {
        values,
        context: ReconstructionContext::MobileNet { left, right },
    })
}

pub(crate) fn unpack_model_output(
    output: &[f32],
    packed: &PackedInput,
) -> Result<[Vec<[f32; 2]>; MODEL_STEMS]> {
    if matches!(packed.context, ReconstructionContext::MobileNet { .. }) {
        return unpack_mobilenet_output(output, packed);
    }
    unpack_spleeter_output(output, packed)
}

pub(crate) fn unpack_spleeter_output(
    output: &[f32],
    packed: &PackedInput,
) -> Result<[Vec<[f32; 2]>; MODEL_STEMS]> {
    if output.len() != MODEL_OUTPUT_ELEMENTS {
        bail!(
            "Spleeter4 output elements {} != {MODEL_OUTPUT_ELEMENTS}",
            output.len()
        );
    }
    let ReconstructionContext::Spleeter(spectra) = &packed.context else {
        bail!("Spleeter output cannot use a waveform reconstruction context");
    };
    if spectra
        .iter()
        .any(|spectrum| spectrum.bins != SPLEETER_FULL_BINS || spectrum.frames != SPLEETER_FRAMES)
    {
        bail!("Spleeter4 mixture spectrum no longer matches the deployment shape");
    }

    let mut stems: [Vec<[f32; 2]>; MODEL_STEMS] =
        std::array::from_fn(|_| vec![[0.0, 0.0]; SEGMENT_SAMPLES]);
    // Two-stem runtime pads Drums/Bass with exact zeros. Keep those lanes mathematically absent
    // rather than letting ratio-mask epsilon create a faint duplicate of the mix.
    let active = std::array::from_fn::<_, MODEL_STEMS, _>(|stem| {
        output[stem * MODEL_INPUT_ELEMENTS..(stem + 1) * MODEL_INPUT_ELEMENTS]
            .iter()
            .any(|value| *value != 0.0)
    });
    let active_count = active.iter().filter(|active| **active).count().max(1);
    let mut denominator = vec![0.0f32; MODEL_INPUT_ELEMENTS];
    for stem in 0..MODEL_STEMS {
        if !active[stem] {
            continue;
        }
        for index in 0..MODEL_INPUT_ELEMENTS {
            let estimate = finite(output[stem * MODEL_INPUT_ELEMENTS + index]);
            denominator[index] += estimate * estimate;
        }
    }
    for value in &mut denominator {
        *value += RATIO_EPSILON;
    }

    for stem in 0..MODEL_STEMS {
        if !active[stem] {
            continue;
        }
        for channel in 0..MODEL_CHANNELS {
            let mut masked = vec![Complex32::default(); SPLEETER_FULL_BINS * SPLEETER_FRAMES];
            for time in 0..SPLEETER_FRAMES {
                let mut mean = 0.0f32;
                for frequency in 0..SPLEETER_BINS {
                    let index = input_index(channel, time, frequency);
                    let estimate = finite(output[stem * MODEL_INPUT_ELEMENTS + index]);
                    let mask = ((estimate * estimate + RATIO_EPSILON / active_count as f32)
                        / denominator[index])
                        .clamp(0.0, 1.0);
                    mean += mask;
                    masked[frequency * SPLEETER_FRAMES + time] =
                        spectra[channel].values[frequency * SPLEETER_FRAMES + time] * mask;
                }
                mean /= SPLEETER_BINS as f32;
                for frequency in SPLEETER_BINS..SPLEETER_FULL_BINS {
                    masked[frequency * SPLEETER_FRAMES + time] =
                        spectra[channel].values[frequency * SPLEETER_FRAMES + time] * mean;
                }
            }
            let waveform = istft(
                &masked,
                SPLEETER_FULL_BINS,
                SPLEETER_FRAMES,
                SPLEETER_FFT,
                SPLEETER_HOP,
                DebugWindow::Hann,
                false,
                false,
                SEGMENT_SAMPLES,
            );
            for (frame, sample) in stems[stem].iter_mut().zip(waveform) {
                frame[channel] = finite(sample);
            }
        }
    }
    Ok(stems)
}

fn unpack_mobilenet_output(
    output: &[f32],
    packed: &PackedInput,
) -> Result<[Vec<[f32; 2]>; MODEL_STEMS]> {
    if output.len() != MOBILENET_OUTPUT_ELEMENTS {
        bail!(
            "ByteDance MobileNet output elements {} != {MOBILENET_OUTPUT_ELEMENTS}",
            output.len()
        );
    }
    let ReconstructionContext::MobileNet { left, right } = &packed.context else {
        bail!("ByteDance MobileNet output cannot use a spectral reconstruction context");
    };
    let mut stems: [Vec<[f32; 2]>; MODEL_STEMS] =
        std::array::from_fn(|_| vec![[0.0, 0.0]; MOBILENET_SEGMENT_SAMPLES]);
    for frame in 0..MOBILENET_SEGMENT_SAMPLES {
        let instrumental = [
            finite(output[frame]),
            finite(output[MOBILENET_SEGMENT_SAMPLES + frame]),
        ];
        stems[2][frame] = instrumental;
        stems[3][frame] = [
            finite(left[frame] - instrumental[0]),
            finite(right[frame] - instrumental[1]),
        ];
        for channel in 0..MODEL_CHANNELS {
            debug_assert!((stems[2][frame][channel] + stems[3][frame][channel]).is_finite());
        }
    }
    Ok(stems)
}

/// Collapse separator residue only when the retained source core is effectively silent. This
/// never raises a quiet stem or changes inter-stem balance.
pub(crate) fn apply_soft_gate(
    left: &[f32],
    right: &[f32],
    stems: &mut [Vec<[f32; 2]>; MODEL_STEMS],
) {
    const FLOOR: f64 = 1e-10;
    let geometry = crate::stem_tile_geometry();
    let start = geometry.context.min(left.len().min(right.len()));
    let end = (start + geometry.core).min(left.len()).min(right.len());
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

fn spleeter_stft(input: &[f32]) -> DebugSpectrum {
    let clean = input
        .iter()
        .map(|sample| finite(*sample))
        .collect::<Vec<_>>();
    stft(
        &clean,
        SPLEETER_FFT,
        SPLEETER_HOP,
        DebugWindow::Hann,
        false,
        false,
    )
}

fn input_index(channel: usize, time: usize, frequency: usize) -> usize {
    (channel * SPLEETER_FRAMES + time) * SPLEETER_BINS + frequency
}

fn model_input_gain(left: &[f32], right: &[f32]) -> f32 {
    let peak = left
        .iter()
        .chain(right)
        .map(|sample| finite(*sample).abs())
        .fold(0.0f32, f32::max);
    if peak > MODEL_PEAK_TARGET {
        MODEL_PEAK_TARGET / peak
    } else {
        1.0
    }
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

    fn test_stereo() -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; SEGMENT_SAMPLES];
        let mut right = vec![0.0; SEGMENT_SAMPLES];
        for index in 0..SEGMENT_SAMPLES {
            left[index] = (std::f32::consts::TAU * 440.0 * index as f32 / 44_100.0).sin() * 0.2;
            right[index] = (std::f32::consts::TAU * 880.0 * index as f32 / 44_100.0).sin() * 0.1;
        }
        (left, right)
    }

    #[test]
    fn deployment_shape_matches_spleeter4() {
        assert_eq!(
            SEGMENT_SAMPLES,
            SPLEETER_FFT + (SPLEETER_FRAMES - 1) * SPLEETER_HOP
        );
        assert_eq!(SEGMENT_CONTEXT_SAMPLES / SPLEETER_HOP, 173);
        assert_eq!(SEGMENT_CORE_SAMPLES / SPLEETER_HOP, 169);
        assert_eq!(MODEL_INPUT_ELEMENTS, 1_048_576);
        assert_eq!(MODEL_OUTPUT_ELEMENTS, 4_194_304);
    }

    #[test]
    fn mobilenet_packs_fixed_three_second_channel_major_waveform() {
        let mut left = vec![0.0; MOBILENET_SEGMENT_SAMPLES];
        let mut right = vec![0.0; MOBILENET_SEGMENT_SAMPLES];
        left[17] = 0.25;
        right[23] = -0.5;
        let packed = pack_mobilenet_input(&left, &right).unwrap();
        assert_eq!(packed.values.len(), MOBILENET_INPUT_ELEMENTS);
        assert_eq!(packed.values[17], 0.25);
        assert_eq!(packed.values[MOBILENET_SEGMENT_SAMPLES + 23], -0.5);
        assert!(matches!(
            packed.context,
            ReconstructionContext::MobileNet { .. }
        ));
    }

    #[test]
    fn mobilenet_instrumental_and_residual_vocals_reconstruct_mix_exactly() {
        let left = vec![0.4; MOBILENET_SEGMENT_SAMPLES];
        let right = vec![-0.2; MOBILENET_SEGMENT_SAMPLES];
        let packed = pack_mobilenet_input(&left, &right).unwrap();
        let mut output = vec![0.0; MOBILENET_OUTPUT_ELEMENTS];
        output[..MOBILENET_SEGMENT_SAMPLES].fill(0.3);
        output[MOBILENET_SEGMENT_SAMPLES..].fill(-0.1);
        let stems = unpack_mobilenet_output(&output, &packed).unwrap();
        assert!(stems[0].iter().all(|frame| *frame == [0.0, 0.0]));
        assert!(stems[1].iter().all(|frame| *frame == [0.0, 0.0]));
        assert_eq!(stems[2][0], [0.3, -0.1]);
        assert!((stems[3][0][0] - 0.1).abs() < 1e-6);
        assert!((stems[3][0][1] + 0.1).abs() < 1e-6);
        for channel in 0..2 {
            let source = if channel == 0 { left[0] } else { right[0] };
            assert!((stems[2][0][channel] + stems[3][0][channel] - source).abs() < 1e-6);
        }
    }

    #[test]
    fn pack_layout_is_channel_time_frequency_magnitude() {
        let (left, right) = test_stereo();
        let packed = pack_model_input(&left, &right).unwrap();
        assert_eq!(packed.values.len(), MODEL_INPUT_ELEMENTS);
        assert!(packed
            .values
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0));
        assert_ne!(
            packed.values[input_index(0, 200, 41)],
            packed.values[input_index(1, 200, 41)]
        );
        assert_eq!(model_input_gain(&left, &right), 1.0);
    }

    #[test]
    fn over_zero_dbfs_input_is_scaled_only_at_the_fp16_boundary() {
        let mut left = vec![0.0; SEGMENT_SAMPLES];
        let mut right = vec![0.0; SEGMENT_SAMPLES];
        left[SEGMENT_SAMPLES / 2] = 3.2;
        right[SEGMENT_SAMPLES / 2] = -1.6;
        let packed = pack_model_input(&left, &right).unwrap();
        assert!((model_input_gain(&left, &right) - MODEL_PEAK_TARGET / 3.2).abs() < 1e-7);
        assert!(packed.values.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn ratio_masks_reconstruct_the_retained_mix_and_preserve_lane_order() {
        let (left, right) = test_stereo();
        let packed = pack_model_input(&left, &right).unwrap();
        let mut estimates = vec![0.01f32; MODEL_OUTPUT_ELEMENTS];
        for value in &mut estimates[..MODEL_INPUT_ELEMENTS] {
            *value = 1.0;
        }
        let stems = unpack_model_output(&estimates, &packed).unwrap();
        let core = SEGMENT_CONTEXT_SAMPLES..SEGMENT_CONTEXT_SAMPLES + SEGMENT_CORE_SAMPLES;
        let mut peak_error = 0.0f32;
        let mut energy = [0.0f64; MODEL_STEMS];
        for frame in core {
            for channel in 0..2 {
                let sum = stems.iter().map(|stem| stem[frame][channel]).sum::<f32>();
                let source = if channel == 0 {
                    left[frame]
                } else {
                    right[frame]
                };
                peak_error = peak_error.max((sum - source).abs());
                for stem in 0..MODEL_STEMS {
                    energy[stem] += f64::from(stems[stem][frame][channel]).powi(2);
                }
            }
        }
        assert!(peak_error < 2e-5, "peak reconstruction error={peak_error}");
        assert!(energy[0] > energy[1] * 1_000.0, "lane energy={energy:?}");
        assert!(energy[1..]
            .windows(2)
            .all(|pair| (pair[0] - pair[1]).abs() < 1e-8));
    }

    #[test]
    fn silent_core_gates_model_residue() {
        let input = vec![0.0; SEGMENT_SAMPLES];
        let mut stems: [Vec<[f32; 2]>; MODEL_STEMS] =
            std::array::from_fn(|_| vec![[0.05, 0.05]; SEGMENT_SAMPLES]);
        apply_soft_gate(&input, &input, &mut stems);
        assert_eq!(stems[0][SEGMENT_CONTEXT_SAMPLES], [0.0, 0.0]);
    }

    #[test]
    fn padded_two_stem_output_keeps_drums_and_bass_exactly_silent() {
        let (left, right) = test_stereo();
        let packed = pack_model_input(&left, &right).unwrap();
        let mut estimates = vec![0.0f32; MODEL_OUTPUT_ELEMENTS];
        estimates[2 * MODEL_INPUT_ELEMENTS..3 * MODEL_INPUT_ELEMENTS].fill(0.7);
        estimates[3 * MODEL_INPUT_ELEMENTS..4 * MODEL_INPUT_ELEMENTS].fill(0.3);
        let stems = unpack_model_output(&estimates, &packed).unwrap();
        assert!(stems[0].iter().all(|frame| *frame == [0.0, 0.0]));
        assert!(stems[1].iter().all(|frame| *frame == [0.0, 0.0]));
        assert!(stems[2].iter().any(|frame| *frame != [0.0, 0.0]));
        assert!(stems[3].iter().any(|frame| *frame != [0.0, 0.0]));
    }
}
