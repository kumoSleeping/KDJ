use anyhow::{bail, Result};

use crate::time_stretch::{PitchPreservingStretcher, TempoControl};
use crate::DecodedTrack;

/// In-memory pitch-preserving conversion through the same Rubber Band R3 engine used by live
/// Tempo and BPM Sync. This compatibility helper is worker-only; live Decks use the streaming
/// raw-ring → Rubber Band → callback-ring pipeline instead.
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

    let mut stretcher =
        PitchPreservingStretcher::new(TempoControl::new(rate), track.sample_rate())?;
    let mut output = Vec::with_capacity(
        ((track.frames() as f64 / f64::from(rate)).ceil() as usize).saturating_mul(2),
    );
    for (frame_index, frame) in track.interleaved().chunks_exact(2).enumerate() {
        if frame_index % 1_024 == 0 && cancelled() {
            bail!("tempo preparation cancelled");
        }
        stretcher.push([frame[0], frame[1]], |frame, _| {
            output.extend_from_slice(&frame);
            Ok(())
        })?;
    }
    stretcher.finish(|frame, _| {
        output.extend_from_slice(&frame);
        Ok(())
    })?;
    DecodedTrack::from_interleaved_stereo(output, track.sample_rate())
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
    fn rubber_band_changes_duration_without_changing_tone_pitch() {
        let source = sine(440.0, 1.0);
        let faster = stretch_preserving_pitch(&source, 1.25).unwrap();
        assert!((faster.duration_seconds() - 0.8).abs() < 0.03);
        assert!((frequency_from_upward_crossings(&faster) - 440.0).abs() < 12.0);

        let slower = stretch_preserving_pitch(&source, 0.8).unwrap();
        assert!((slower.duration_seconds() - 1.25).abs() < 0.03);
        assert!((frequency_from_upward_crossings(&slower) - 440.0).abs() < 12.0);
    }

    #[test]
    fn unity_tempo_preserves_duration_without_a_phase_vocoder() {
        let source = sine(440.0, 0.25);
        let same = stretch_preserving_pitch(&source, 1.0).unwrap();
        assert_eq!(same.frames(), source.frames());
        assert!((same.duration_seconds() - source.duration_seconds()).abs() < 1e-6);
        let left = source.interleaved();
        let right = same.interleaved();
        let mut max_delta = 0.0f32;
        for (from, to) in left.iter().zip(right) {
            max_delta = max_delta.max((from - to).abs());
        }
        assert!(
            max_delta < 1e-6,
            "0% TEMPO must not phase-vocode identity PCM"
        );
    }

    #[test]
    fn rejects_unsafe_tempo_ranges() {
        let source = sine(440.0, 0.1);
        assert!(stretch_preserving_pitch(&source, 0.0).is_err());
        assert!(stretch_preserving_pitch(&source, 2.1).is_err());
    }
}
