use anyhow::{bail, Result};

use crate::DecodedTrack;

const WINDOW_FRAMES: usize = 1_024;
const SYNTHESIS_HOP: usize = WINDOW_FRAMES / 2;
const SEARCH_RADIUS: usize = WINDOW_FRAMES / 4;
const COARSE_STEP: usize = 8;

/// Offline WSOLA tempo conversion. It changes duration while copying waveform periods rather than
/// resampling them, so BPM synchronization does not shift pitch. All allocation and correlation
/// work happens on a decode worker; the realtime callback receives ordinary immutable PCM.
pub fn stretch_preserving_pitch(track: &DecodedTrack, rate: f32) -> Result<DecodedTrack> {
    stretch_preserving_pitch_with_cancel(track, rate, || false)
}

pub fn stretch_preserving_pitch_with_cancel<F>(
    track: &DecodedTrack,
    rate: f32,
    cancelled: F,
) -> Result<DecodedTrack>
where
    F: Fn() -> bool,
{
    if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
        bail!("tempo rate must be finite and within 0.5..=2.0");
    }
    if (rate - 1.0).abs() < 0.000_1 {
        return DecodedTrack::from_interleaved_stereo(
            track.interleaved().to_vec(),
            track.sample_rate(),
        );
    }

    let input_frames = track.frames();
    if input_frames < WINDOW_FRAMES * 2 {
        bail!("track is too short for pitch-preserving tempo preparation");
    }
    let target_frames = ((input_frames as f64 / f64::from(rate)).round() as usize).max(1);
    let work_frames = target_frames.saturating_add(WINDOW_FRAMES);
    let mut mixed = vec![0.0f32; work_frames * 2];
    let mut weights = vec![0.0f32; work_frames];
    let window = hann_window();
    let mut output_start = 0usize;
    let mut previous_input = 0usize;

    while output_start < target_frames {
        if cancelled() {
            bail!("tempo preparation cancelled");
        }
        let expected = ((output_start as f64 * f64::from(rate)).round() as usize)
            .min(input_frames.saturating_sub(WINDOW_FRAMES));
        let input_start = if output_start == 0 {
            0
        } else {
            best_aligned_start(
                track,
                &mixed,
                &weights,
                output_start,
                expected,
                previous_input,
            )
        };
        overlap_window(
            track,
            input_start,
            &window,
            &mut mixed,
            &mut weights,
            output_start,
        );
        previous_input = input_start;
        output_start = output_start.saturating_add(SYNTHESIS_HOP);
    }

    let mut output = Vec::with_capacity(target_frames * 2);
    for frame in 0..target_frames {
        let weight = weights[frame];
        let scale = if weight > 0.000_01 {
            weight.recip()
        } else {
            0.0
        };
        output.push(mixed[frame * 2] * scale);
        output.push(mixed[frame * 2 + 1] * scale);
    }
    DecodedTrack::from_interleaved_stereo(output, track.sample_rate())
}

fn hann_window() -> [f32; WINDOW_FRAMES] {
    std::array::from_fn(|index| {
        let phase = std::f32::consts::TAU * index as f32 / (WINDOW_FRAMES - 1) as f32;
        0.5 - 0.5 * phase.cos()
    })
}

fn best_aligned_start(
    track: &DecodedTrack,
    mixed: &[f32],
    weights: &[f32],
    output_start: usize,
    expected: usize,
    previous_input: usize,
) -> usize {
    let max_start = track.frames().saturating_sub(WINDOW_FRAMES);
    let minimum = expected
        .saturating_sub(SEARCH_RADIUS)
        .max(previous_input.saturating_add(1).min(max_start));
    let maximum = expected.saturating_add(SEARCH_RADIUS).min(max_start);
    if minimum >= maximum {
        return expected.min(max_start);
    }

    let mut best = expected.clamp(minimum, maximum);
    let mut best_score = f64::NEG_INFINITY;
    let mut candidate = minimum;
    while candidate <= maximum {
        let score = correlation(track, mixed, weights, output_start, candidate);
        if score > best_score {
            best = candidate;
            best_score = score;
        }
        candidate = candidate.saturating_add(COARSE_STEP);
        if candidate == usize::MAX {
            break;
        }
    }

    let refine_min = best.saturating_sub(COARSE_STEP).max(minimum);
    let refine_max = best.saturating_add(COARSE_STEP).min(maximum);
    for candidate in refine_min..=refine_max {
        let score = correlation(track, mixed, weights, output_start, candidate);
        if score > best_score {
            best = candidate;
            best_score = score;
        }
    }
    best
}

fn correlation(
    track: &DecodedTrack,
    mixed: &[f32],
    weights: &[f32],
    output_start: usize,
    input_start: usize,
) -> f64 {
    let input = track.interleaved();
    let mut dot = 0.0f64;
    let mut left_energy = 0.0f64;
    let mut right_energy = 0.0f64;
    // Every second frame is sufficient for alignment and halves worker CPU cost.
    for offset in (0..SYNTHESIS_HOP).step_by(2) {
        let output_frame = output_start + offset;
        let weight = weights.get(output_frame).copied().unwrap_or(0.0);
        if weight <= 0.000_01 {
            continue;
        }
        let existing = (mixed[output_frame * 2] + mixed[output_frame * 2 + 1]) * 0.5 / weight;
        let input_frame = input_start + offset;
        let candidate = (input[input_frame * 2] + input[input_frame * 2 + 1]) * 0.5;
        let existing = f64::from(existing);
        let candidate = f64::from(candidate);
        dot += existing * candidate;
        left_energy += existing * existing;
        right_energy += candidate * candidate;
    }
    if left_energy <= 1e-12 || right_energy <= 1e-12 {
        f64::NEG_INFINITY
    } else {
        dot / (left_energy * right_energy).sqrt()
    }
}

fn overlap_window(
    track: &DecodedTrack,
    input_start: usize,
    window: &[f32; WINDOW_FRAMES],
    mixed: &mut [f32],
    weights: &mut [f32],
    output_start: usize,
) {
    let input = track.interleaved();
    for (offset, weight) in window.iter().copied().enumerate() {
        let output_frame = output_start + offset;
        if output_frame >= weights.len() {
            break;
        }
        let input_frame = input_start + offset;
        if input_frame >= track.frames() {
            break;
        }
        mixed[output_frame * 2] += input[input_frame * 2] * weight;
        mixed[output_frame * 2 + 1] += input[input_frame * 2 + 1] * weight;
        weights[output_frame] += weight;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency: f32, seconds: f32) -> DecodedTrack {
        let rate = 48_000;
        let frames = (rate as f32 * seconds) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let sample = (std::f32::consts::TAU * frequency * frame as f32 / rate as f32).sin();
            samples.extend_from_slice(&[sample, sample]);
        }
        DecodedTrack::from_interleaved_stereo(samples, rate).unwrap()
    }

    fn frequency_from_upward_crossings(track: &DecodedTrack) -> f32 {
        let samples = track.interleaved();
        let mut crossings = 0usize;
        for frame in 1..track.frames() {
            if samples[(frame - 1) * 2] <= 0.0 && samples[frame * 2] > 0.0 {
                crossings += 1;
            }
        }
        crossings as f32 / track.duration_seconds() as f32
    }

    #[test]
    fn changes_duration_without_changing_tone_pitch() {
        let source = sine(440.0, 1.0);
        let faster = stretch_preserving_pitch(&source, 1.25).unwrap();
        assert!((faster.duration_seconds() - 0.8).abs() < 0.01);
        assert!((frequency_from_upward_crossings(&faster) - 440.0).abs() < 12.0);

        let slower = stretch_preserving_pitch(&source, 0.8).unwrap();
        assert!((slower.duration_seconds() - 1.25).abs() < 0.01);
        assert!((frequency_from_upward_crossings(&slower) - 440.0).abs() < 12.0);
    }

    #[test]
    fn rejects_unsafe_tempo_ranges() {
        let source = sine(440.0, 0.1);
        assert!(stretch_preserving_pitch(&source, 0.0).is_err());
        assert!(stretch_preserving_pitch(&source, 2.1).is_err());
    }
}
