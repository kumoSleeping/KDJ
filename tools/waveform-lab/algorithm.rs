//! Standalone candidate waveform algorithm used by the comparison lab.
//!
//! This file is intentionally not imported by the KDJ runtime.  It keeps the current two-profile
//! contract (full-track overview and 100 columns/second detail), but replaces amp-only rectangles
//! with a signed min/max contour.  Without real cached STEM PCM, colour comes only from measured
//! low/mid/high energy and transient evidence (proposal D in the research package).  Proposal 05
//! remains a future progressive layer and is not approximated with guessed instrument roles.

use kdj_analysis::waveform::band_energy;
use serde::Serialize;

const MAX_BUCKETS: usize = 24_000;

#[derive(Debug, Clone, Copy)]
pub enum ContourProfile {
    Overview,
    Detail,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpectralEvidence {
    pub low: Vec<u8>,
    pub mid: Vec<u8>,
    pub high: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContourWaveform {
    pub duration: f64,
    /// Signed lower contour in the range -1..=0.
    pub minimum: Vec<f32>,
    /// Signed upper contour in the range 0..=1.
    pub maximum: Vec<f32>,
    /// Height authority retained for metrics and future v1 fallbacks.
    pub amp: Vec<f32>,
    /// Display colour derived only from measured low/mid/high energy, with a perceptual chroma cap.
    pub r: Vec<u8>,
    pub g: Vec<u8>,
    pub b: Vec<u8>,
    /// Robust onset evidence: P93 starts the one-physical-pixel highlight, P99.7 reaches 255.
    pub transient: Vec<u8>,
    /// Measured per-column band proportions; these sum to approximately 255.
    pub spectral_evidence: SpectralEvidence,
}

#[derive(Debug, Clone, Copy)]
struct BucketStats {
    minimum: f64,
    maximum: f64,
    peak: f64,
    rms: f64,
}

pub fn analyze_contour(
    samples: &[f32],
    sample_rate: f64,
    requested_buckets: usize,
    profile: ContourProfile,
) -> ContourWaveform {
    if samples.is_empty() || !sample_rate.is_finite() || sample_rate <= 0.0 {
        return empty_waveform();
    }

    let duration = samples.len() as f64 / sample_rate;
    let master_frames = (duration * 200.0).ceil().max(1.0) as usize;
    let count = requested_buckets
        .clamp(64, MAX_BUCKETS)
        .min(master_frames)
        .min(samples.len());
    let mut stats = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * samples.len() / count;
        let end = ((index + 1) * samples.len() / count)
            .max(start + 1)
            .min(samples.len());
        let mut minimum = 0.0f64;
        let mut maximum = 0.0f64;
        let mut square_sum = 0.0f64;
        for sample in &samples[start..end] {
            let value = if sample.is_finite() {
                f64::from(*sample)
            } else {
                0.0
            };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
            square_sum += value * value;
        }
        stats.push(BucketStats {
            minimum,
            maximum,
            peak: maximum.max(-minimum),
            rms: (square_sum / (end - start).max(1) as f64).sqrt(),
        });
    }

    let peak_scale = percentile(
        &stats.iter().map(|bucket| bucket.peak).collect::<Vec<_>>(),
        99.5,
    )
    .max(1e-9);
    let rms_scale = percentile(
        &stats.iter().map(|bucket| bucket.rms).collect::<Vec<_>>(),
        99.5,
    )
    .max(1e-9);
    let (peak_weight, rms_weight, gamma, boundary_peak_keep, colour_radius) = match profile {
        ContourProfile::Detail => (0.66, 0.34, 0.76, 0.80, 1),
        ContourProfile::Overview => (0.36, 0.64, 0.72, 0.68, 2),
    };

    let mut height = Vec::with_capacity(count);
    let mut top = Vec::with_capacity(count);
    let mut bottom = Vec::with_capacity(count);
    let mut raw_envelope = Vec::with_capacity(count);
    for bucket in &stats {
        let peak = (bucket.peak / peak_scale).clamp(0.0, 1.0);
        let rms = (bucket.rms / rms_scale).clamp(0.0, 1.0);
        let mixed = (peak_weight * peak + rms_weight * rms).clamp(0.0, 1.0);
        let display = mixed.powf(gamma);
        let polarity_scale = bucket.peak.max(1e-12);
        height.push(display);
        top.push(display * bucket.maximum.max(0.0) / polarity_scale);
        bottom.push(display * (-bucket.minimum).max(0.0) / polarity_scale);
        raw_envelope.push((bucket.rms * bucket.peak).sqrt());
    }

    // A short contour reconstruction replaces rectangular steps without smearing the transient
    // time coordinate.  The peak-keep term is deliberately high for detail and lower for overview.
    top = peak_preserving_boundary(&top, boundary_peak_keep);
    bottom = peak_preserving_boundary(&bottom, boundary_peak_keep);

    let transient_strength = robust_transients(&raw_envelope);
    let transient: Vec<u8> = transient_strength
        .iter()
        .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();

    let energy = band_energy(samples, sample_rate, count);
    let usable = count
        .min(energy.overall.len())
        .min(energy.low.len())
        .min(energy.mid.len())
        .min(energy.high.len());
    if usable == 0 {
        return empty_waveform();
    }
    stats.truncate(usable);
    height.truncate(usable);
    top.truncate(usable);
    bottom.truncate(usable);

    let mut low = energy.low[..usable].to_vec();
    let mut mid = energy.mid[..usable].to_vec();
    let mut high = energy.high[..usable].to_vec();
    // This is a de-confetti kernel, not a musical-time blur: one neighbour in detail and two in
    // overview.  All RGB smoothing is performed in linear light later.
    if matches!(profile, ContourProfile::Detail) {
        low = triangular_smooth(&low, 1);
        mid = triangular_smooth(&mid, 1);
        high = triangular_smooth(&high, 1);
    }

    let spectral_rgb = spectral_frequency_rgb(&low, &mid, &high);
    let onset = &transient_strength[..usable];
    let (band_low, band_mid, band_high) = spectral_evidence(&low, &mid, &high);

    let mut r = Vec::with_capacity(usable);
    let mut g = Vec::with_capacity(usable);
    let mut b = Vec::with_capacity(usable);
    for index in 0..usable {
        let display = restrained_spectral_rgb(spectral_rgb[index], height[index], onset[index]);
        r.push(display[0]);
        g.push(display[1]);
        b.push(display[2]);
    }
    let (r, g, b) = smooth_rgb_linear(&r, &g, &b, colour_radius);

    ContourWaveform {
        duration: (duration * 1000.0).round() / 1000.0,
        minimum: bottom[..usable]
            .iter()
            .map(|value| -value.clamp(0.0, 1.0) as f32)
            .collect(),
        maximum: top[..usable]
            .iter()
            .map(|value| value.clamp(0.0, 1.0) as f32)
            .collect(),
        amp: height[..usable]
            .iter()
            .map(|value| value.clamp(0.0, 1.0) as f32)
            .collect(),
        r,
        g,
        b,
        transient: transient[..usable].to_vec(),
        spectral_evidence: SpectralEvidence {
            low: band_low,
            mid: band_mid,
            high: band_high,
        },
    }
}

fn empty_waveform() -> ContourWaveform {
    ContourWaveform {
        duration: 0.0,
        minimum: Vec::new(),
        maximum: Vec::new(),
        amp: Vec::new(),
        r: Vec::new(),
        g: Vec::new(),
        b: Vec::new(),
        transient: Vec::new(),
        spectral_evidence: SpectralEvidence {
            low: Vec::new(),
            mid: Vec::new(),
            high: Vec::new(),
        },
    }
}

fn peak_preserving_boundary(values: &[f64], keep: f64) -> Vec<f64> {
    let smooth = triangular_smooth(values, 1);
    values
        .iter()
        .zip(smooth)
        .map(|(original, filtered)| (original * keep + filtered * (1.0 - keep)).clamp(0.0, 1.0))
        .collect()
}

fn robust_transients(envelope: &[f64]) -> Vec<f64> {
    if envelope.is_empty() {
        return Vec::new();
    }
    let mut previous = envelope[0];
    let mut delta = Vec::with_capacity(envelope.len());
    for value in envelope {
        let positive = (value - previous).max(0.0);
        delta.push(positive);
        previous += 0.18 * (value - previous);
    }
    let threshold = percentile(&delta, 93.0);
    let ceiling = percentile(&delta, 99.7).max(threshold + 1e-12);
    delta
        .into_iter()
        .map(|value| ((value - threshold) / (ceiling - threshold)).clamp(0.0, 1.0))
        .collect()
}

fn spectral_evidence(low: &[f64], mid: &[f64], high: &[f64]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let count = low.len().min(mid.len()).min(high.len());
    let mut low_share = Vec::with_capacity(count);
    let mut mid_share = Vec::with_capacity(count);
    let mut high_share = Vec::with_capacity(count);
    for index in 0..count {
        let low_value = low[index].max(0.0);
        let mid_value = mid[index].max(0.0);
        let high_value = high[index].max(0.0);
        let total = (low_value + mid_value + high_value).max(1e-12);
        low_share.push((low_value / total * 255.0).round() as u8);
        mid_share.push((mid_value / total * 255.0).round() as u8);
        high_share.push((high_value / total * 255.0).round() as u8);
    }
    (low_share, mid_share, high_share)
}

fn spectral_frequency_rgb(low: &[f64], mid: &[f64], high: &[f64]) -> Vec<[u8; 3]> {
    let count = low.len().min(mid.len()).min(high.len());
    let mut share = [vec![0.0; count], vec![0.0; count], vec![0.0; count]];
    for index in 0..count {
        let total = (low[index] + mid[index] + high[index]).max(1e-12);
        share[0][index] = low[index] / total;
        share[1][index] = mid[index] / total;
        share[2][index] = high[index] / total;
    }
    let reference = [
        percentile(&share[0], 50.0).max(1e-12),
        percentile(&share[1], 50.0).max(1e-12),
        percentile(&share[2], 50.0).max(1e-12),
    ];
    (0..count)
        .map(|index| {
            let dev = [
                share[0][index].powf(0.24) * (share[0][index] / reference[0]).max(1e-12).powf(0.88),
                share[1][index].powf(0.24) * (share[1][index] / reference[1]).max(1e-12).powf(0.88),
                share[2][index].powf(0.24) * (share[2][index] / reference[2]).max(1e-12).powf(0.88),
            ];
            let peak = dev.iter().copied().fold(0.0f64, f64::max).max(1e-9);
            dev.map(|value| {
                let lifted = 0.04 + 0.96 * (value / peak).clamp(0.0, 1.0);
                (lifted * 255.0).round() as u8
            })
        })
        .collect()
}

fn restrained_spectral_rgb(source: [u8; 3], amplitude: f64, transient: f64) -> [u8; 3] {
    // Hue is untouched evidence: low/mid/high remain the R/G/B axes used by KDJ.  Only perceptual
    // lightness and chroma are bounded, so green or violet may appear when the spectrum warrants
    // them but cannot become a full-intensity neon field.
    let linear = source.map(|value| srgb_to_linear(f64::from(value) / 255.0));
    let [_, mut a, mut b] = linear_srgb_to_oklab(linear);
    let chroma = a.hypot(b);
    let source_max = source.iter().copied().max().unwrap_or(0) as f64;
    let source_min = source.iter().copied().min().unwrap_or(0) as f64;
    let spectral_definition = ((source_max - source_min) / source_max.max(1.0)).clamp(0.0, 1.0);
    let chroma_cap = 0.070 + 0.090 * spectral_definition.powf(1.6);
    if chroma > chroma_cap {
        let scale = chroma_cap / chroma;
        a *= scale;
        b *= scale;
    }
    let lightness =
        (0.66 + 0.060 * amplitude.clamp(0.0, 1.0).sqrt() + 0.015 * transient.clamp(0.0, 1.0))
            .clamp(0.65, 0.745);
    let mut mapped = oklab_to_linear_srgb([lightness, a, b]);
    // Simple chroma-only gamut mapping keeps the measured hue and lightness stable.
    let mut attempts = 0;
    while mapped.iter().any(|value| !(0.0..=1.0).contains(value)) && attempts < 8 {
        a *= 0.86;
        b *= 0.86;
        mapped = oklab_to_linear_srgb([lightness, a, b]);
        attempts += 1;
    }
    mapped.map(|value| (linear_to_srgb(value.clamp(0.0, 1.0)) * 255.0).round() as u8)
}

fn linear_srgb_to_oklab(rgb: [f64; 3]) -> [f64; 3] {
    let l = 0.412_221_470_8 * rgb[0] + 0.536_332_536_3 * rgb[1] + 0.051_445_992_9 * rgb[2];
    let m = 0.211_903_498_2 * rgb[0] + 0.680_699_545_1 * rgb[1] + 0.107_396_956_6 * rgb[2];
    let s = 0.088_302_461_9 * rgb[0] + 0.281_718_837_6 * rgb[1] + 0.629_978_700_5 * rgb[2];
    let l_root = l.cbrt();
    let m_root = m.cbrt();
    let s_root = s.cbrt();
    [
        0.210_454_255_3 * l_root + 0.793_617_785 * m_root - 0.004_072_046_8 * s_root,
        1.977_998_495_1 * l_root - 2.428_592_205 * m_root + 0.450_593_709_9 * s_root,
        0.025_904_037_1 * l_root + 0.782_771_766_2 * m_root - 0.808_675_766 * s_root,
    ]
}

fn oklab_to_linear_srgb(lab: [f64; 3]) -> [f64; 3] {
    let l_root = lab[0] + 0.396_337_777_4 * lab[1] + 0.215_803_757_3 * lab[2];
    let m_root = lab[0] - 0.105_561_345_8 * lab[1] - 0.063_854_172_8 * lab[2];
    let s_root = lab[0] - 0.089_484_177_5 * lab[1] - 1.291_485_548 * lab[2];
    let l = l_root.powi(3);
    let m = m_root.powi(3);
    let s = s_root.powi(3);
    [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
    ]
}

fn smooth_rgb_linear(r: &[u8], g: &[u8], b: &[u8], radius: usize) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    if radius == 0 || r.is_empty() {
        return (r.to_vec(), g.to_vec(), b.to_vec());
    }
    let channels = [r, g, b];
    let mut output = [
        Vec::with_capacity(r.len()),
        Vec::with_capacity(r.len()),
        Vec::with_capacity(r.len()),
    ];
    for channel in 0..3 {
        let linear: Vec<f64> = channels[channel]
            .iter()
            .map(|value| srgb_to_linear(f64::from(*value) / 255.0))
            .collect();
        let smooth = triangular_smooth(&linear, radius);
        output[channel] = smooth
            .into_iter()
            .map(|value| (linear_to_srgb(value.clamp(0.0, 1.0)) * 255.0).round() as u8)
            .collect();
    }
    (output[0].clone(), output[1].clone(), output[2].clone())
}

fn triangular_smooth(values: &[f64], radius: usize) -> Vec<f64> {
    if radius == 0 || values.len() < 2 {
        return values.to_vec();
    }
    (0..values.len())
        .map(|index| {
            let start = index.saturating_sub(radius);
            let end = (index + radius + 1).min(values.len());
            let mut sum = 0.0;
            let mut weight_sum = 0.0;
            for source in start..end {
                let distance = index.abs_diff(source);
                let weight = (radius + 1 - distance) as f64;
                sum += values[source] * weight;
                weight_sum += weight;
            }
            sum / weight_sum.max(1.0)
        })
        .collect()
}

fn percentile(values: &[f64], percent: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if sorted.is_empty() {
        return 0.0;
    }
    sorted.sort_by(f64::total_cmp);
    let position = (percent.clamp(0.0, 100.0) / 100.0) * (sorted.len() - 1) as f64;
    let left = position.floor() as usize;
    let right = position.ceil() as usize;
    let mix = position - left as f64;
    sorted[left] + (sorted[right] - sorted[left]) * mix
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(value: f64) -> f64 {
    if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_track(sample_rate: f64, seconds: f64) -> Vec<f32> {
        (0..(sample_rate * seconds) as usize)
            .map(|index| {
                let time = index as f64 / sample_rate;
                let section = if time < seconds / 2.0 { 0.45 } else { 0.9 };
                let bass = (2.0 * std::f64::consts::PI * 110.0 * time).sin() * 0.45;
                let vocal = (2.0 * std::f64::consts::PI * 880.0 * time).sin() * 0.24;
                let click = if index % (sample_rate as usize / 4) < 8 {
                    0.75
                } else {
                    0.0
                };
                ((bass + vocal + click) * section) as f32
            })
            .collect()
    }

    #[test]
    fn contour_contract_is_aligned_and_bounded() {
        let sample_rate = 22_050.0;
        let wave = analyze_contour(
            &synthetic_track(sample_rate, 4.0),
            sample_rate,
            400,
            ContourProfile::Detail,
        );
        let count = wave.amp.len();
        assert_eq!(count, 400);
        assert_eq!(wave.minimum.len(), count);
        assert_eq!(wave.maximum.len(), count);
        assert_eq!(wave.r.len(), count);
        assert_eq!(wave.g.len(), count);
        assert_eq!(wave.b.len(), count);
        assert_eq!(wave.transient.len(), count);
        assert_eq!(wave.spectral_evidence.low.len(), count);
        assert_eq!(wave.spectral_evidence.mid.len(), count);
        assert_eq!(wave.spectral_evidence.high.len(), count);
        assert!(wave
            .minimum
            .iter()
            .all(|value| (-1.0..=0.0).contains(value)));
        assert!(wave.maximum.iter().all(|value| (0.0..=1.0).contains(value)));
        assert!(wave.amp.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn overview_and_detail_keep_separate_envelope_profiles() {
        let sample_rate = 22_050.0;
        let samples = synthetic_track(sample_rate, 4.0);
        let overview = analyze_contour(&samples, sample_rate, 400, ContourProfile::Overview);
        let detail = analyze_contour(&samples, sample_rate, 400, ContourProfile::Detail);
        assert_ne!(overview.amp, detail.amp);
        assert_ne!(overview.maximum, detail.maximum);
    }

    #[test]
    fn measured_mid_band_maps_greener_than_measured_bass_band() {
        let sample_rate = 22_050.0;
        let tone = |frequency: f64| {
            (0..(sample_rate * 2.0) as usize)
                .map(|index| {
                    let time = index as f64 / sample_rate;
                    ((2.0 * std::f64::consts::PI * frequency * time).sin() * 0.7) as f32
                })
                .collect::<Vec<_>>()
        };
        let vocal = analyze_contour(&tone(880.0), sample_rate, 200, ContourProfile::Detail);
        let bass = analyze_contour(&tone(110.0), sample_rate, 200, ContourProfile::Detail);
        let mean = |values: &[u8]| {
            values.iter().map(|value| f64::from(*value)).sum::<f64>() / values.len() as f64
        };
        let vocal_green_margin = mean(&vocal.g) - (mean(&vocal.r) + mean(&vocal.b)) * 0.5;
        let bass_green_margin = mean(&bass.g) - (mean(&bass.r) + mean(&bass.b)) * 0.5;
        assert!(
            vocal_green_margin > bass_green_margin + 6.0,
            "vocal margin={vocal_green_margin:.2}, bass margin={bass_green_margin:.2}"
        );
    }
}
