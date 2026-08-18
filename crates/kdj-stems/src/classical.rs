//! Model-free, streaming-friendly source decomposition.
//!
//! The production profile combines two established DSP ideas without copying an external
//! implementation: an Adobe Audition Center Channel Extractor-style common-component estimator
//! for centre-panned vocals and Fitzgerald-style median-filter HPSS for the residual. The code is
//! a clean-room implementation from documented behaviour, not Adobe source. Its three audible
//! outputs always reconstruct the input instead of inventing or discarding energy.

use anyhow::{bail, Result};
use rustfft::num_complex::Complex32;

use crate::debug_dsp::{istft, stft, DebugSpectrum, DebugWindow};
use crate::SAMPLE_RATE;

// Adobe documents 4,096–8,192 as the useful range for Center Channel Extractor. 4,096 with eight
// overlapping Hann windows fits the live tile's 93 ms context and remains practical in Rust.
pub(crate) const FFT_SIZE: usize = 4_096;
pub(crate) const HOP_SIZE: usize = 512;
const MEDIAN_KERNEL: usize = 17;
const EPSILON: f32 = 1.0e-12;
const VOCAL_SPECTRAL_DECAY: f32 = 0.92;

type Stereo = Vec<[f32; 2]>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClassicalProfile {
    HybridFourStem,
    Hpss,
    StereoCenter,
}

/// The legacy transport remains four slots, but only three have semantic output:
/// `transient / (silent compatibility slot) / tonal / vocal`. This keeps the player ABI stable
/// without presenting model-style bass isolation that classical DSP cannot honestly provide.
pub(crate) fn separate_live(left: &[f32], right: &[f32]) -> Result<[Stereo; 4]> {
    let separated = separate_spectral(left, right, ClassicalProfile::HybridFourStem)?;
    separated
        .try_into()
        .map_err(|_| anyhow::anyhow!("classical four-stem profile returned the wrong lane count"))
}

pub(crate) fn separate_hpss(left: &[f32], right: &[f32]) -> Result<Vec<Stereo>> {
    separate_spectral(left, right, ClassicalProfile::Hpss)
}

pub(crate) fn separate_center(left: &[f32], right: &[f32]) -> Result<Vec<Stereo>> {
    separate_spectral(left, right, ClassicalProfile::StereoCenter)
}

/// A zero-look-ahead envelope splitter used as the second debug recommendation. It is deliberately
/// independent from ZLSplitter's AGPL implementation: one fast and one slow energy follower drive
/// a smoothed complementary mask, a conventional transient-detector construction.
pub(crate) fn separate_transient_steady(left: &[f32], right: &[f32]) -> Result<Vec<Stereo>> {
    validate_stereo(left, right)?;
    let attack_fast = coefficient(0.0015);
    let release_fast = coefficient(0.018);
    let attack_slow = coefficient(0.020);
    let release_slow = coefficient(0.180);
    let mask_attack = coefficient(0.0007);
    let mask_release = coefficient(0.045);
    let mut fast = 0.0_f32;
    let mut slow = 0.0_f32;
    let mut mask = 0.0_f32;
    let mut transient = Vec::with_capacity(left.len());
    let mut steady = Vec::with_capacity(left.len());
    for (&left, &right) in left.iter().zip(right) {
        let left = finite(left);
        let right = finite(right);
        let energy = 0.5 * (left * left + right * right);
        fast = follow(fast, energy, attack_fast, release_fast);
        slow = follow(slow, energy, attack_slow, release_slow);
        let ratio = ((fast + EPSILON) / (slow + EPSILON)).sqrt();
        let target = ((ratio - 1.08) / 1.35).clamp(0.0, 1.0);
        mask = follow(mask, target, mask_attack, mask_release).clamp(0.0, 1.0);
        let peak = [left * mask, right * mask];
        transient.push(peak);
        steady.push([left - peak[0], right - peak[1]]);
    }
    Ok(vec![transient, steady])
}

pub(crate) fn separate_mid_side(left: &[f32], right: &[f32]) -> Result<Vec<Stereo>> {
    validate_stereo(left, right)?;
    let mut center = Vec::with_capacity(left.len());
    let mut sides = Vec::with_capacity(left.len());
    for (&left, &right) in left.iter().zip(right) {
        let left = finite(left);
        let right = finite(right);
        let mid = (left + right) * 0.5;
        center.push([mid, mid]);
        sides.push([left - mid, right - mid]);
    }
    Ok(vec![center, sides])
}

fn separate_spectral(
    left: &[f32],
    right: &[f32],
    profile: ClassicalProfile,
) -> Result<Vec<Stereo>> {
    validate_stereo(left, right)?;
    if left.is_empty() {
        return Ok(match profile {
            ClassicalProfile::HybridFourStem => vec![Vec::new(); 4],
            ClassicalProfile::Hpss | ClassicalProfile::StereoCenter => vec![Vec::new(); 2],
        });
    }
    let left: Vec<f32> = left.iter().copied().map(finite).collect();
    let right: Vec<f32> = right.iter().copied().map(finite).collect();
    let left_spectrum = stft(&left, FFT_SIZE, HOP_SIZE, DebugWindow::Hann, true, false);
    let right_spectrum = stft(&right, FFT_SIZE, HOP_SIZE, DebugWindow::Hann, true, false);
    if left_spectrum.bins != right_spectrum.bins || left_spectrum.frames != right_spectrum.frames {
        bail!("classical stereo STFT shape mismatch");
    }
    let mut output = match profile {
        ClassicalProfile::Hpss => {
            let magnitudes = joint_magnitudes(&left_spectrum, &right_spectrum);
            let (harmonic, percussive) =
                hpss_masks(&magnitudes, left_spectrum.bins, left_spectrum.frames);
            render_masks(
                &left_spectrum,
                &right_spectrum,
                &[harmonic, percussive],
                left.len(),
            )
        }
        ClassicalProfile::StereoCenter => {
            let vocal = extract_vocal_spectra(&left_spectrum, &right_spectrum);
            render_spectrum_lanes(
                &left_spectrum,
                &[
                    (&vocal.center_left, &vocal.center_right),
                    (&vocal.residual_left, &vocal.residual_right),
                ],
                left.len(),
            )
        }
        ClassicalProfile::HybridFourStem => {
            let vocal = extract_vocal_spectra(&left_spectrum, &right_spectrum);
            let magnitudes = joint_magnitude_values(&vocal.residual_left, &vocal.residual_right);
            let (harmonic, percussive) =
                hpss_masks(&magnitudes, left_spectrum.bins, left_spectrum.frames);
            let transient_left = multiply_spectrum(&vocal.residual_left, &percussive);
            let transient_right = multiply_spectrum(&vocal.residual_right, &percussive);
            let tonal_left = multiply_spectrum(&vocal.residual_left, &harmonic);
            let tonal_right = multiply_spectrum(&vocal.residual_right, &harmonic);
            let silence = vec![Complex32::default(); vocal.center_left.len()];
            render_spectrum_lanes(
                &left_spectrum,
                &[
                    (&transient_left, &transient_right),
                    (&silence, &silence),
                    (&tonal_left, &tonal_right),
                    (&vocal.center_left, &vocal.center_right),
                ],
                left.len(),
            )
        }
    };
    force_reconstruction(&left, &right, &mut output);
    Ok(output)
}

fn validate_stereo(left: &[f32], right: &[f32]) -> Result<()> {
    if left.len() != right.len() {
        bail!("classical separator requires equal stereo channel lengths");
    }
    Ok(())
}

fn joint_magnitudes(left: &DebugSpectrum, right: &DebugSpectrum) -> Vec<f32> {
    joint_magnitude_values(&left.values, &right.values)
}

fn joint_magnitude_values(left: &[Complex32], right: &[Complex32]) -> Vec<f32> {
    left.iter()
        .zip(right)
        .map(|(left, right)| (0.5 * (left.norm_sqr() + right.norm_sqr())).sqrt())
        .collect()
}

fn hpss_masks(magnitude: &[f32], bins: usize, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let radius = MEDIAN_KERNEL / 2;
    let mut horizontal = vec![0.0_f32; magnitude.len()];
    let mut vertical = vec![0.0_f32; magnitude.len()];
    let mut scratch = Vec::with_capacity(MEDIAN_KERNEL);
    for frequency in 0..bins {
        for time in 0..frames {
            scratch.clear();
            let start = time.saturating_sub(radius);
            let end = (time + radius + 1).min(frames);
            scratch.extend((start..end).map(|candidate| magnitude[frequency * frames + candidate]));
            horizontal[frequency * frames + time] = median(&mut scratch);
        }
    }
    for frequency in 0..bins {
        let start = frequency.saturating_sub(radius);
        let end = (frequency + radius + 1).min(bins);
        for time in 0..frames {
            scratch.clear();
            scratch.extend((start..end).map(|candidate| magnitude[candidate * frames + time]));
            vertical[frequency * frames + time] = median(&mut scratch);
        }
    }
    let mut harmonic = Vec::with_capacity(magnitude.len());
    let mut percussive = Vec::with_capacity(magnitude.len());
    for (horizontal, vertical) in horizontal.into_iter().zip(vertical) {
        let horizontal = horizontal * horizontal;
        let vertical = vertical * vertical;
        let denominator = horizontal + vertical + EPSILON;
        let h = if horizontal + vertical <= EPSILON {
            0.5
        } else {
            horizontal / denominator
        };
        harmonic.push(h);
        percussive.push(1.0 - h);
    }
    (harmonic, percussive)
}

struct VocalSpectra {
    center_left: Vec<Complex32>,
    center_right: Vec<Complex32>,
    residual_left: Vec<Complex32>,
    residual_right: Vec<Complex32>,
}

/// Estimate the complex component shared by both stereo channels. This follows the documented
/// behaviour of classic Center Channel Extractors: a voice-band selector plus phase and amplitude
/// discrimination, spectral-bandwidth smoothing, and temporal spectral decay. Unlike plain M/S,
/// the minimum-magnitude common component preserves unmatched energy in the louder channel.
fn extract_vocal_spectra(left: &DebugSpectrum, right: &DebugSpectrum) -> VocalSpectra {
    let mut evidence = vec![0.0_f32; left.values.len()];
    for frequency in 0..left.bins {
        let hz = frequency as f32 * SAMPLE_RATE as f32 / FFT_SIZE as f32;
        let low_edge = smooth_step(80.0, 140.0, hz);
        let high_edge = 1.0 - smooth_step(9_000.0, 12_000.0, hz);
        let vocal_band = low_edge * high_edge;
        for time in 0..left.frames {
            let index = frequency * left.frames + time;
            let l = left.values[index];
            let r = right.values[index];
            let l_mag = l.norm();
            let r_mag = r.norm();
            let maximum = l_mag.max(r_mag);
            if maximum <= EPSILON {
                continue;
            }
            let phase_cosine = (l * r.conj()).re / (l_mag * r_mag + EPSILON);
            let phase_match = smooth_step(0.70, 0.995, phase_cosine);
            let amplitude_balance = l_mag.min(r_mag) / maximum;
            let amplitude_match = smooth_step(0.25, 0.90, amplitude_balance);
            evidence[index] = (vocal_band * phase_match * amplitude_match).clamp(0.0, 1.0);
        }
    }

    // Adobe exposes amplitude bandwidth as a quality/separation control. A small triangular
    // neighbourhood avoids isolated musical-noise bins without smearing across formants.
    let mut smoothed = vec![0.0_f32; evidence.len()];
    const WEIGHTS: [f32; 5] = [1.0, 2.0, 3.0, 2.0, 1.0];
    for frequency in 0..left.bins {
        for time in 0..left.frames {
            let mut weighted = 0.0_f32;
            let mut weight_sum = 0.0_f32;
            for (offset, weight) in (-2_isize..=2).zip(WEIGHTS) {
                let candidate = frequency as isize + offset;
                if (0..left.bins as isize).contains(&candidate) {
                    weighted += evidence[candidate as usize * left.frames + time] * weight;
                    weight_sum += weight;
                }
            }
            smoothed[frequency * left.frames + time] = weighted / weight_sum.max(1.0);
        }
    }

    let mut center_left = vec![Complex32::default(); left.values.len()];
    let mut center_right = vec![Complex32::default(); left.values.len()];
    let mut residual_left = left.values.clone();
    let mut residual_right = right.values.clone();
    for frequency in 0..left.bins {
        let mut decayed = 0.0_f32;
        for time in 0..left.frames {
            let index = frequency * left.frames + time;
            decayed = smoothed[index].max(decayed * VOCAL_SPECTRAL_DECAY);
            let l = left.values[index];
            let r = right.values[index];
            let l_mag = l.norm();
            let r_mag = r.norm();
            let aligned = if l_mag > EPSILON && r_mag > EPSILON {
                l * (1.0 / l_mag) + r * (1.0 / r_mag)
            } else {
                Complex32::default()
            };
            let aligned_mag = aligned.norm();
            let common = if aligned_mag > EPSILON {
                aligned * (l_mag.min(r_mag) * decayed / aligned_mag)
            } else {
                Complex32::default()
            };
            center_left[index] = common;
            center_right[index] = common;
            residual_left[index] = l - common;
            residual_right[index] = r - common;
        }
    }
    VocalSpectra {
        center_left,
        center_right,
        residual_left,
        residual_right,
    }
}

fn multiply_spectrum(values: &[Complex32], mask: &[f32]) -> Vec<Complex32> {
    values
        .iter()
        .zip(mask)
        .map(|(value, mask)| *value * *mask)
        .collect()
}

fn render_masks(
    left: &DebugSpectrum,
    right: &DebugSpectrum,
    masks: &[Vec<f32>],
    output_len: usize,
) -> Vec<Stereo> {
    masks
        .iter()
        .map(|mask| {
            let masked_left: Vec<Complex32> = left
                .values
                .iter()
                .zip(mask)
                .map(|(value, mask)| *value * *mask)
                .collect();
            let masked_right: Vec<Complex32> = right
                .values
                .iter()
                .zip(mask)
                .map(|(value, mask)| *value * *mask)
                .collect();
            let left = istft(
                &masked_left,
                left.bins,
                left.frames,
                FFT_SIZE,
                HOP_SIZE,
                DebugWindow::Hann,
                true,
                false,
                output_len,
            );
            let right = istft(
                &masked_right,
                right.bins,
                right.frames,
                FFT_SIZE,
                HOP_SIZE,
                DebugWindow::Hann,
                true,
                false,
                output_len,
            );
            left.into_iter()
                .zip(right)
                .map(|(left, right)| [left, right])
                .collect()
        })
        .collect()
}

fn render_spectrum_lanes(
    shape: &DebugSpectrum,
    lanes: &[(&[Complex32], &[Complex32])],
    output_len: usize,
) -> Vec<Stereo> {
    lanes
        .iter()
        .map(|(left, right)| {
            let left = istft(
                left,
                shape.bins,
                shape.frames,
                FFT_SIZE,
                HOP_SIZE,
                DebugWindow::Hann,
                true,
                false,
                output_len,
            );
            let right = istft(
                right,
                shape.bins,
                shape.frames,
                FFT_SIZE,
                HOP_SIZE,
                DebugWindow::Hann,
                true,
                false,
                output_len,
            );
            left.into_iter()
                .zip(right)
                .map(|(left, right)| [left, right])
                .collect()
        })
        .collect()
}

/// Assign floating-point/STFT round-trip residue to the final complementary lane. The masks are
/// already mass-conserving; this only makes the transport's unity-sum contract sample-exact.
fn force_reconstruction(left: &[f32], right: &[f32], lanes: &mut [Stereo]) {
    let Some((last, previous)) = lanes.split_last_mut() else {
        return;
    };
    for index in 0..left.len().min(right.len()).min(last.len()) {
        let used_left: f32 = previous.iter().map(|lane| lane[index][0]).sum();
        let used_right: f32 = previous.iter().map(|lane| lane[index][1]).sum();
        last[index] = [left[index] - used_left, right[index] - used_right];
    }
}

fn median(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let middle = values.len() / 2;
    values
        .select_nth_unstable_by(middle, f32::total_cmp)
        .1
        .to_owned()
}

fn coefficient(seconds: f32) -> f32 {
    (-1.0 / (seconds * SAMPLE_RATE as f32).max(1.0)).exp()
}

fn follow(current: f32, target: f32, attack: f32, release: f32) -> f32 {
    let coefficient = if target > current { attack } else { release };
    coefficient * current + (1.0 - coefficient) * target
}

fn smooth_step(low: f32, high: f32, value: f32) -> f32 {
    let value = ((value - low) / (high - low)).clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
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

    fn fixture(frames: usize) -> (Vec<f32>, Vec<f32>) {
        let left = (0..frames)
            .map(|index| {
                let time = index as f32 / SAMPLE_RATE as f32;
                0.25 * (std::f32::consts::TAU * 220.0 * time).sin()
                    + if index % 2_048 < 12 { 0.6 } else { 0.0 }
            })
            .collect::<Vec<_>>();
        let right = (0..frames)
            .map(|index| {
                let time = index as f32 / SAMPLE_RATE as f32;
                0.25 * (std::f32::consts::TAU * 220.0 * time).sin()
                    - 0.08 * (std::f32::consts::TAU * 880.0 * time).sin()
                    + if index % 2_048 < 12 { 0.5 } else { 0.0 }
            })
            .collect::<Vec<_>>();
        (left, right)
    }

    #[test]
    fn hybrid_masks_reconstruct_stereo_input() {
        let (left, right) = fixture(24_576);
        let stems = separate_live(&left, &right).unwrap();
        let mut peak = 0.0_f32;
        for index in 0..left.len() {
            let sum_left: f32 = stems.iter().map(|stem| stem[index][0]).sum();
            let sum_right: f32 = stems.iter().map(|stem| stem[index][1]).sum();
            peak = peak.max((sum_left - left[index]).abs());
            peak = peak.max((sum_right - right[index]).abs());
        }
        assert!(peak < 2.0e-4, "reconstruction peak={peak}");
    }

    #[test]
    fn adobe_style_vocal_lane_removes_strict_center_from_residual() {
        let frames = 24_576;
        let mut left = Vec::with_capacity(frames);
        let mut right = Vec::with_capacity(frames);
        let mut vocal = Vec::with_capacity(frames);
        for index in 0..frames {
            let time = index as f32 / SAMPLE_RATE as f32;
            let center = 0.35 * (std::f32::consts::TAU * 440.0 * time).sin();
            let side = 0.18 * (std::f32::consts::TAU * 1_100.0 * time).sin();
            vocal.push(center);
            left.push(center + side);
            right.push(center - side);
        }
        let [transient, _compatibility, tonal, extracted] = separate_live(&left, &right).unwrap();
        let guard = FFT_SIZE;
        let mut source_energy = 0.0_f64;
        let mut residual_energy = 0.0_f64;
        let mut extraction_error = 0.0_f64;
        for index in guard..frames - guard {
            let residual_mid = 0.5
                * (transient[index][0] + transient[index][1] + tonal[index][0] + tonal[index][1]);
            source_energy += f64::from(vocal[index]).powi(2);
            residual_energy += f64::from(residual_mid).powi(2);
            extraction_error += f64::from(extracted[index][0] - vocal[index]).powi(2);
        }
        let residual_db = 10.0 * ((residual_energy + 1.0e-12) / source_energy).log10();
        let extraction_db = 10.0 * ((extraction_error + 1.0e-12) / source_energy).log10();
        assert!(residual_db < -30.0, "center residual={residual_db:.2} dB");
        assert!(
            extraction_db < -30.0,
            "vocal estimate error={extraction_db:.2} dB"
        );
    }

    #[test]
    fn transient_and_steady_are_complementary() {
        let (left, right) = fixture(8_192);
        let lanes = separate_transient_steady(&left, &right).unwrap();
        for index in 0..left.len() {
            assert!((lanes[0][index][0] + lanes[1][index][0] - left[index]).abs() < 1.0e-6);
            assert!((lanes[0][index][1] + lanes[1][index][1] - right[index]).abs() < 1.0e-6);
        }
    }

    #[test]
    fn all_profiles_return_finite_samples() {
        let (mut left, mut right) = fixture(4_096);
        left[3] = f32::NAN;
        right[9] = f32::INFINITY;
        for lanes in [
            separate_hpss(&left, &right).unwrap(),
            separate_center(&left, &right).unwrap(),
            separate_mid_side(&left, &right).unwrap(),
        ] {
            assert!(lanes
                .iter()
                .flatten()
                .flatten()
                .all(|sample| sample.is_finite()));
        }
    }

    #[test]
    fn production_chunk_stays_below_its_realtime_budget() {
        let (left, right) = fixture(crate::SEGMENT_SAMPLES);
        let mut timings = Vec::new();
        for _ in 0..8 {
            let started = std::time::Instant::now();
            let _ = separate_live(&left, &right).unwrap();
            timings.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        timings.sort_by(f64::total_cmp);
        let mean = timings.iter().sum::<f64>() / timings.len() as f64;
        let p95 = timings[timings.len() - 1];
        let budget = crate::SEGMENT_CORE_SAMPLES as f64 / f64::from(SAMPLE_RATE) * 1_000.0;
        eprintln!(
            "classical_stream mean_ms={mean:.3} p95_ms={p95:.3} budget_ms={budget:.3} rtf={:.4}",
            mean / budget
        );
        assert!(p95 < budget, "p95={p95:.3}ms budget={budget:.3}ms");
    }

    /// Research-only evaluator. Prepare child directories containing mixture/drums/bass/other/
    /// vocals WAV files and set `KDJ_CLASSICAL_MUSDB_DIR`; no corpus is shipped with KDJ.
    #[test]
    #[ignore = "requires an external MUSDB fixture"]
    fn report_external_three_lane_sdr() {
        let root = std::env::var_os("KDJ_CLASSICAL_MUSDB_DIR")
            .map(std::path::PathBuf::from)
            .expect("KDJ_CLASSICAL_MUSDB_DIR");
        let mut scores = Vec::<[f64; 3]>::new();
        let mut entries: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let mixture = crate::audio::decode_stereo(&path.join("mixture.wav")).unwrap();
            let drums = crate::audio::decode_stereo(&path.join("drums.wav")).unwrap();
            let bass = crate::audio::decode_stereo(&path.join("bass.wav")).unwrap();
            let other = crate::audio::decode_stereo(&path.join("other.wav")).unwrap();
            let vocals = crate::audio::decode_stereo(&path.join("vocals.wav")).unwrap();
            let frames = mixture.left.len().min(mixture.right.len());
            let separated =
                separate_live(&mixture.left[..frames], &mixture.right[..frames]).unwrap();
            let targets = [
                stereo_target(&drums.left, &drums.right, None, None, frames),
                stereo_target(
                    &bass.left,
                    &bass.right,
                    Some(&other.left),
                    Some(&other.right),
                    frames,
                ),
                stereo_target(&vocals.left, &vocals.right, None, None, frames),
            ];
            let estimates = [&separated[0], &separated[2], &separated[3]];
            let score = std::array::from_fn(|index| sdr(&targets[index], estimates[index]));
            eprintln!(
                "musdb track={} transient_sdr={:.3} tonal_sdr={:.3} center_sdr={:.3}",
                entry.file_name().to_string_lossy(),
                score[0],
                score[1],
                score[2]
            );
            scores.push(score);
        }
        assert!(!scores.is_empty());
        let mean: [f64; 3] = std::array::from_fn(|lane| {
            scores.iter().map(|score| score[lane]).sum::<f64>() / scores.len() as f64
        });
        eprintln!(
            "musdb mean tracks={} transient_sdr={:.3} tonal_sdr={:.3} center_sdr={:.3}",
            scores.len(),
            mean[0],
            mean[1],
            mean[2]
        );
    }

    fn stereo_target(
        left: &[f32],
        right: &[f32],
        add_left: Option<&[f32]>,
        add_right: Option<&[f32]>,
        frames: usize,
    ) -> Stereo {
        (0..frames)
            .map(|index| {
                [
                    left.get(index).copied().unwrap_or(0.0)
                        + add_left
                            .and_then(|lane| lane.get(index))
                            .copied()
                            .unwrap_or(0.0),
                    right.get(index).copied().unwrap_or(0.0)
                        + add_right
                            .and_then(|lane| lane.get(index))
                            .copied()
                            .unwrap_or(0.0),
                ]
            })
            .collect()
    }

    fn sdr(target: &[[f32; 2]], estimate: &[[f32; 2]]) -> f64 {
        let mut signal = 0.0_f64;
        let mut error = 0.0_f64;
        for (target, estimate) in target.iter().zip(estimate) {
            for channel in 0..2 {
                signal += f64::from(target[channel]).powi(2);
                error += f64::from(target[channel] - estimate[channel]).powi(2);
            }
        }
        10.0 * ((signal + 1.0e-12) / (error + 1.0e-12)).log10()
    }
}
