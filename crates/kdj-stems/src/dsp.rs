//! ByteDance MobileNet waveform packing and two-stem reconstruction.

use anyhow::{bail, Result};

use crate::MOBILENET_SEGMENT_SAMPLES;

pub(crate) const MODEL_STEMS: usize = 4;
pub(crate) const MOBILENET_INPUT_ELEMENTS: usize = 2 * MOBILENET_SEGMENT_SAMPLES;
pub(crate) const MOBILENET_OUTPUT_ELEMENTS: usize = MOBILENET_INPUT_ELEMENTS;

pub(crate) struct PackedInput {
    pub values: Vec<f32>,
    context: ReconstructionContext,
}

enum ReconstructionContext {
    MobileNet { left: Vec<f32>, right: Vec<f32> },
}

pub(crate) fn pack_model_input_for_mode(
    mode: kdj_core::StemMode,
    left: &[f32],
    right: &[f32],
) -> Result<PackedInput> {
    if mode != kdj_core::StemMode::MobileNetTwo {
        bail!("仅支持 ByteDance MobileNet STEM runtime");
    }
    pack_mobilenet_input(left, right)
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
    unpack_mobilenet_output(output, packed)
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
    let ReconstructionContext::MobileNet { left, right } = &packed.context;
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
    fn packs_fixed_three_second_channel_major_waveform() {
        let mut left = vec![0.0; MOBILENET_SEGMENT_SAMPLES];
        let mut right = vec![0.0; MOBILENET_SEGMENT_SAMPLES];
        left[17] = 0.25;
        right[23] = -0.5;
        let packed = pack_mobilenet_input(&left, &right).unwrap();
        assert_eq!(packed.values.len(), MOBILENET_INPUT_ELEMENTS);
        assert_eq!(packed.values[17], 0.25);
        assert_eq!(packed.values[MOBILENET_SEGMENT_SAMPLES + 23], -0.5);
    }

    #[test]
    fn instrumental_and_residual_vocals_reconstruct_mix_exactly() {
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
    }

    #[test]
    fn silent_core_gates_model_residue() {
        let input = vec![0.0; MOBILENET_SEGMENT_SAMPLES];
        let mut stems: [Vec<[f32; 2]>; MODEL_STEMS] =
            std::array::from_fn(|_| vec![[0.05, 0.05]; MOBILENET_SEGMENT_SAMPLES]);
        apply_soft_gate(&input, &input, &mut stems);
        assert_eq!(stems[0][crate::SEGMENT_CONTEXT_SAMPLES], [0.0, 0.0]);
    }
}
