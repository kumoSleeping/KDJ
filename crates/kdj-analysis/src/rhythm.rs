//! V4 full-track tempo: bounded PCM -> multiband flux -> local tempo path -> beat events.
//! No model/runtime assets. Times are source seconds; uncertainty is preserved in the result.
use crate::dsp::{autocorrelate, median};
use anyhow::Result;
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path};
pub const REVISION: &str = "kdj-rust-rhythm-v4.0.1";
const SR: u32 = 22050;
const FFT: usize = 2048;
const HOP: usize = 220;
const FPS: f64 = SR as f64 / HOP as f64;
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Segment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub bpm: f64,
    pub confidence: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RhythmAnalysis {
    #[serde(default)]
    pub audio_offset_seconds: f64,
    pub revision: String,
    pub precise: bool,
    pub duration: f64,
    pub bpm: Option<f64>,
    pub confidence: f64,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub downbeat_confidence: f64,
    pub segments: Vec<Segment>,
    pub coverage: Vec<[f64; 2]>,
}
#[derive(Default)]
struct Features {
    onset: Vec<f64>,
    low: Vec<f64>,
    attack: Vec<f64>,
}

pub fn analyze(
    path: &Path,
    precise: bool,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<Option<RhythmAnalysis>> {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT);
    let mut pending = VecDeque::from(vec![0.; FFT / 2]);
    let mut previous = vec![0f64; 64];
    let mel = crate::dsp::sparse_mel_filterbank(SR as f64, FFT, 64, 30., 11000.);
    let mut buffer = vec![Complex::new(0., 0.); FFT];
    let window: Vec<f32> = (0..FFT)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FFT as f64).cos()) as f32)
        .collect();
    let mut features = Features::default();
    let mut previous_energy = 0.;
    let Some(duration) = crate::decode::stream_mono(path, SR, cancelled, |samples| {
        pending.extend(samples);
        while pending.len() >= FFT {
            for i in 0..FFT {
                buffer[i] = Complex::new(pending[i] * window[i], 0.);
            }
            fft.process(&mut buffer);
            let mut bands = [0.; 3];
            for (i, band) in mel.iter().enumerate() {
                let energy: f64 = band
                    .weights
                    .iter()
                    .enumerate()
                    .map(|(j, &w)| buffer[band.start_bin + j].norm() as f64 * w as f64)
                    .sum();
                let value = (1. + energy * 10.).ln();
                let delta = (value - previous[i]).max(0.);
                bands[if i < 10 {
                    0
                } else if i < 40 {
                    1
                } else {
                    2
                }] += delta;
                previous[i] = value;
            }
            features.onset.push(bands[0] + bands[1] + bands[2]);
            features.low.push(bands[0]);
            // A short centered energy window locates the physical attack. Spectral flux uses
            // a longer window and can precede the transient by tens of milliseconds.
            let energy = pending
                .iter()
                .skip(FFT / 2 - HOP / 2)
                .take(HOP)
                .map(|&v| (v as f64).powi(2))
                .sum::<f64>()
                / HOP as f64;
            let energy = (1. + energy * 1000.).ln();
            features.attack.push((energy - previous_energy).max(0.));
            previous_energy = energy;
            pending.drain(..HOP);
        }
    })?
    else {
        return Ok(None);
    };
    Ok(track(features, duration, precise, cancelled))
}

fn candidates(env: &[f64], low: &[f64], count: usize) -> Vec<(f64, f64)> {
    let max = (FPS * 60. / 40.) as usize;
    if env.len() < max * 2 {
        return vec![];
    }
    let ac = autocorrelate(env, max * 3 + 2);
    let bass = autocorrelate(low, max * 3 + 2);
    let (hint, _) = crate::tempo::choose_tempo(low, FPS);
    let energy = ac[0].max(1e-12);
    let min = (FPS * 60. / 240.) as usize;
    let mut peaks: Vec<_> = (min..max)
        .filter(|&i| ac[i] > ac[i - 1] && ac[i] >= ac[i + 1])
        .map(|i| {
            let denom = ac[i - 1] - 2. * ac[i] + ac[i + 1];
            let offset = if denom.abs() > 1e-12 {
                (0.5 * (ac[i - 1] - ac[i + 1]) / denom).clamp(-0.5, 0.5)
            } else {
                0.
            };
            let period = i as f64 + offset;
            // Penalize a half-time candidate whose intervening beats are equally strong.
            let at = |lag: f64| crate::dsp::interp_at(&ac, lag).max(0.) / energy;
            let off = [1.5, 2., 2.5, 3., 3.5, 4.]
                .iter()
                .map(|d| at(period / d))
                .fold(0., f64::max);
            let support = (at(period) + at(period * 2.) + at(period * 3.)) / 3.;
            let bpm = 60. * FPS / period;
            let prior = (-0.5 * ((bpm / 120.).log2() / 1.2).powi(2)).exp();
            let agreement = if hint > 0. {
                (-0.5 * ((bpm / hint).ln() / 0.04).powi(2)).exp()
            } else {
                0.
            };
            let bass_at = |lag: f64| crate::dsp::interp_at(&bass, lag).max(0.) / bass[0].max(1e-12);
            let bass_support = (bass_at(period) + bass_at(period * 2.) + bass_at(period * 3.)) / 3.;
            let bass_off = [1.5, 2., 2.5, 3., 3.5, 4.]
                .iter()
                .map(|d| bass_at(period / d))
                .fold(0., f64::max);
            let score = ((support - 0.8 * off + 0.7 * (bass_support - 0.8 * bass_off))
                * (0.65 + 0.35 * prior)
                + 0.15 * agreement * bass_support.max(0.1))
            .max(0.);
            (period, score)
        })
        .collect();
    peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
    peaks.truncate(count);
    peaks
}

fn track(
    mut f: Features,
    duration: f64,
    precise: bool,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<RhythmAnalysis> {
    let n = f.onset.len();
    let mut result = RhythmAnalysis {
        revision: REVISION.into(),
        precise,
        duration,
        ..Default::default()
    };
    if n < 32 {
        return Some(result);
    }
    let average = crate::dsp::moving_average(&f.onset, (FPS * 0.5) as usize | 1);
    for (v, a) in f.onset.iter_mut().zip(average) {
        *v = (*v - a * 0.6).max(0.);
    }
    let peak = f.onset.iter().copied().fold(0., f64::max);
    if peak < 1e-8 {
        return Some(result);
    }
    for v in &mut f.onset {
        *v /= peak;
    }
    // Four-second cadence, overlapping twelve-second context. Precise mode doubles cadence.
    let step = (FPS * if precise { 2. } else { 4. }) as usize;
    let radius = (FPS * 6.) as usize;
    let mut windows: Vec<(usize, Vec<(f64, f64)>)> = Vec::new();
    for center in (0..n).step_by(step) {
        if cancelled() {
            return None;
        }
        let a = center.saturating_sub(radius);
        let b = (center + radius).min(n);
        let mut choices = candidates(&f.onset[a..b], &f.low[a..b], if precise { 24 } else { 12 });
        // A candidate conflict expands the search without decoding again or smearing a
        // short true tempo region into a longer window.
        if !precise && choices.len() > 1 && choices[0].1 - choices[1].1 < 0.02 {
            choices = candidates(&f.onset[a..b], &f.low[a..b], 24);
        }
        // Automatic refinement shares features and increases context at ambiguous windows.
        if choices.first().is_some_and(|c| c.1 < 0.12) || choices.len() < 2 {
            choices = candidates(
                &f.onset[center.saturating_sub(radius * 2)..(center + radius * 2).min(n)],
                &f.low[center.saturating_sub(radius * 2)..(center + radius * 2).min(n)],
                12,
            );
        }
        if choices.is_empty() {
            choices.push((FPS * 0.5, 0.));
        }
        windows.push((center, choices));
    }
    // Viterbi across a bounded set of tempo hypotheses, permitting real jumps but discouraging
    // alternating half/double-time interpretations in adjacent windows.
    let mut scores: Vec<Vec<f64>> = Vec::new();
    let mut parents: Vec<Vec<usize>> = Vec::new();
    for (i, (_, options)) in windows.iter().enumerate() {
        let mut row = vec![0.; options.len()];
        let mut links = vec![0; options.len()];
        for (j, &(period, strength)) in options.iter().enumerate() {
            row[j] = strength * step as f64 / (FPS * 4.);
            if i > 0 {
                let previous = &windows[i - 1].1;
                let (k, value) = previous
                    .iter()
                    .enumerate()
                    .map(|(k, &(p, _))| {
                        let change = (period / p).ln().abs();
                        (k, scores[i - 1][k] - (change * 1.5).min(0.9))
                    })
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .unwrap();
                row[j] += value;
                links[j] = k;
            }
        }
        scores.push(row);
        parents.push(links);
    }
    let mut chosen = vec![0; windows.len()];
    *chosen.last_mut().unwrap() = scores
        .last()
        .unwrap()
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap()
        .0;
    for i in (1..windows.len()).rev() {
        chosen[i - 1] = parents[i][chosen[i]];
    }
    let mut periods = vec![FPS * 0.5; n];
    let mut strengths = vec![0.; n];
    for i in 0..windows.len() {
        let a = windows[i].0;
        let b = windows.get(i + 1).map_or(n, |w| w.0);
        let (period, strength) = windows[i].1[chosen[i]];
        periods[a..b].fill(period);
        strengths[a..b].fill(strength);
    }
    // Tempo comes from the spectrally rich long windows; event timing comes from the
    // centered short-window attacks, so long-window anticipation cannot bias every cut.
    let timing = if f.attack.len() == n {
        let peak = f.attack.iter().copied().fold(0., f64::max).max(1e-12);
        f.attack.iter().map(|v| v / peak).collect::<Vec<_>>()
    } else {
        f.onset.clone()
    };
    // Local-energy normalization preserves quiet rhythm after a loud intro.
    let local = crate::dsp::moving_average(&timing, (FPS * 4.) as usize | 1);
    let bass_local = crate::dsp::moving_average(&f.low, (FPS * 4.) as usize | 1);
    let mut score = vec![0f64; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        if t % 2048 == 0 && cancelled() {
            return None;
        }
        let period = periods[t];
        let start = t.saturating_sub((period * 1.8) as usize);
        let end = t.saturating_sub((period * 0.55) as usize);
        let mut best = 0.;
        for prev in start..end {
            let delta = (t - prev) as f64;
            let candidate = score[prev] * 0.97 - 12. * (delta / period).ln().powi(2);
            if candidate > best {
                best = candidate;
                back[t] = prev;
            }
        }
        // Broadband attacks alone can pull the path onto louder offbeat hats during a
        // quiet passage. Bass flux anchors metrical phase, but never manufactures an attack.
        // Its longer FFT window can anticipate the short-window attack by a few frames.
        let bass = f.low[t.saturating_sub(3)..(t + 4).min(n)]
            .iter()
            .copied()
            .fold(0., f64::max);
        let anchor = (bass / (bass_local[t] * 5.).max(1e-9)).min(1.);
        score[t] = best + (timing[t] / (local[t] * 5.).max(0.015)).min(3.) * (0.25 + 0.75 * anchor);
    }
    let mut last = (n.saturating_sub((FPS * 3.) as usize)..n)
        .max_by(|&a, &b| score[a].total_cmp(&score[b]))
        .unwrap();
    let mut frames = vec![];
    loop {
        // Never fill silence with manufactured beats.
        if timing[last] > 0.003 && local[last] > 0.0005 && strengths[last] > 0.01 {
            frames.push(last);
        }
        let prev = back[last];
        if prev == usize::MAX || prev >= last {
            if last < (FPS * 0.4) as usize {
                break;
            }
            let end = last - (FPS * 0.3) as usize;
            last = (end.saturating_sub((FPS * 3.) as usize)..end)
                .max_by(|&a, &b| score[a].total_cmp(&score[b]))
                .unwrap_or(0);
        } else {
            last = prev;
        }
    }
    frames.reverse();
    // Align to the local flux maximum and interpolate to sub-frame timing.
    for frame in frames {
        let envelope = &timing;
        let radius = 2;
        let a = frame.saturating_sub(radius);
        let b = (frame + radius + 1).min(n);
        let weighted = |t: usize| {
            envelope[t] * (-0.5 * ((t as f64 - frame as f64) / radius as f64).powi(2)).exp()
        };
        let t = (a..b)
            .max_by(|&x, &y| weighted(x).total_cmp(&weighted(y)))
            .unwrap();
        let offset = if t > 0 && t + 1 < n {
            let d = envelope[t - 1] - 2. * envelope[t] + envelope[t + 1];
            if d.abs() > 1e-12 {
                (0.5 * (envelope[t - 1] - envelope[t + 1]) / d).clamp(-0.5, 0.5)
            } else {
                0.
            }
        } else {
            0.
        };
        let time = ((t as f64 + offset) / FPS).clamp(0., duration);
        if result.beats.last().is_none_or(|prev| time - prev > 0.1) {
            result.beats.push(time);
        }
    }
    result.segments = segment_beats_cancellable(&result.beats, cancelled)?;
    for segment in &mut result.segments {
        let a = (segment.start_seconds * FPS) as usize;
        let b = ((segment.end_seconds * FPS) as usize).min(n);
        let evidence = if b > a {
            strengths[a..b].iter().sum::<f64>() / (b - a) as f64
        } else {
            0.
        };
        segment.confidence *= evidence.sqrt().clamp(0., 0.95);
    }
    for seg in &result.segments {
        result.coverage.push([seg.start_seconds, seg.end_seconds]);
    }
    let mut histogram = std::collections::BTreeMap::<i64, f64>::new();
    for seg in &result.segments {
        *histogram.entry((seg.bpm * 2.).round() as i64).or_default() +=
            seg.end_seconds - seg.start_seconds;
    }
    result.bpm = histogram
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(&bucket, _)| {
            let group: Vec<_> = result
                .segments
                .iter()
                .filter(|s| (s.bpm * 2.).round() as i64 == bucket)
                .collect();
            let weight: f64 = group.iter().map(|s| s.end_seconds - s.start_seconds).sum();
            group
                .iter()
                .map(|s| s.bpm * (s.end_seconds - s.start_seconds))
                .sum::<f64>()
                / weight.max(1e-9)
        });
    result.confidence = if result.segments.is_empty() {
        0.
    } else {
        result.segments.iter().map(|s| s.confidence).sum::<f64>() / result.segments.len() as f64
    };
    // Conservative 4/4 accent evidence. Equal kicks cannot establish the first beat of a bar.
    let mut accents = [0.; 4];
    let mut counts = [0f64; 4];
    for (i, &beat) in result.beats.iter().enumerate() {
        let t = (beat * FPS).round() as usize;
        if t < f.low.len() {
            accents[i % 4] += f.low[t];
            counts[i % 4] += 1.;
        }
    }
    for i in 0..4 {
        accents[i] /= counts[i].max(1.);
    }
    let mut order = [0, 1, 2, 3];
    order.sort_by(|&a, &b| accents[b].total_cmp(&accents[a]));
    let contrast = (accents[order[0]] - accents[order[1]]) / accents[order[0]].max(1e-9);
    if result.beats.len() >= 16 && contrast > 0.25 {
        result.downbeat_confidence = contrast;
        result.downbeats = result
            .beats
            .iter()
            .skip(order[0])
            .step_by(4)
            .copied()
            .collect();
    }
    Some(result)
}

/// Fit sustained tempo regions, not individual inter-onset intervals. Eight intervals
/// provide two bars of evidence in 4/4, without assuming that the meter itself is known.
/// Missing events affect the fit's beat indices, never the returned event sequence.
pub fn segment_beats(beats: &[f64]) -> Vec<Segment> {
    segment_beats_cancellable(beats, &|| false).unwrap_or_default()
}

fn segment_beats_cancellable(
    beats: &[f64],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<Vec<Segment>> {
    if cancelled() {
        return None;
    }
    if beats.len() < 9 {
        return Some(Vec::new());
    }
    let gaps: Vec<_> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    let local: Vec<_> = (0..gaps.len())
        .map(|i| median(&mut gaps[i.saturating_sub(8)..(i + 9).min(gaps.len())].to_vec()))
        .collect();
    let mut indices = vec![0.; beats.len()];
    let mut runs = Vec::new();
    let mut start = 0;
    for (i, &gap) in gaps.iter().enumerate() {
        let period = local[i];
        if !gap.is_finite() || gap <= 0. || !(0.25..=1.5).contains(&period) || gap > period * 4.25 {
            runs.push((start, i));
            start = i + 1;
            continue;
        }
        let multiple = (gap / period).round();
        // Only infer short dropouts when the observed rhythm on BOTH sides agrees.
        // A sustained half-time section must remain a real tempo change.
        let neighbors_agree = i >= 3
            && i + 3 < gaps.len()
            && gaps[i - 3..i]
                .iter()
                .chain(&gaps[i + 1..i + 4])
                .all(|&g| (g / period - 1.).abs() < 0.15);
        let advance = if (2. ..=4.).contains(&multiple)
            && (gap / period - multiple).abs() < 0.12
            && neighbors_agree
        {
            multiple
        } else {
            1.
        };
        indices[i + 1] = indices[i] + advance;
    }
    runs.push((start, beats.len() - 1));
    let mut segments = Vec::new();
    for (start, end) in runs {
        if end - start < 8 {
            continue;
        }
        fit_tempo_run(
            &beats[start..=end],
            &indices[start..=end],
            &mut segments,
            cancelled,
        )?;
    }
    Some(segments)
}

/// Prefer one clock when it explains each local neighborhood, not merely the whole-track
/// average. Rounded grid indices tolerate missing beats and off-grid attack outliers. Local
/// occupancy checks prevent a genuine half/double-time section from passing this test.
fn constant_tempo_run(beats: &[f64]) -> Option<Segment> {
    let mut gaps: Vec<_> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    let mut period = median(&mut gaps);
    if !(0.25..=1.5).contains(&period) {
        return None;
    }
    // Longer baselines reduce frame quantization before assigning integer beat indices.
    let stride = 16.min(beats.len() - 1);
    let mut seeds: Vec<_> = beats
        .windows(stride + 1)
        .map(|w| {
            let span = w[stride] - w[0];
            span / (span / period).round().max(1.)
        })
        .collect();
    period = median(&mut seeds);
    let times: Vec<_> = beats.iter().map(|t| t - beats[0]).collect();
    let mut origin = 0.;
    for _ in 0..6 {
        let mut count = 0.;
        let (mut x, mut y, mut xx, mut xy) = (0., 0., 0., 0.);
        for &time in &times {
            let index = ((time - origin) / period).round();
            let residual = (time - origin - index * period).abs();
            if residual > 0.07_f64.min(period * 0.2) {
                continue;
            }
            count += 1.;
            x += index;
            y += time;
            xx += index * index;
            xy += index * time;
        }
        if count < beats.len() as f64 * 0.7 {
            return None;
        }
        period = (xy - x * y / count) / (xx - x * x / count).max(1e-9);
        origin = (y - period * x) / count;
        if !(0.25..=1.5).contains(&period) {
            return None;
        }
    }
    let indices: Vec<_> = times
        .iter()
        .map(|t| ((t - origin) / period).round())
        .collect();
    let errors: Vec<_> = times
        .iter()
        .zip(&indices)
        .map(|(t, i)| (t - origin - i * period).abs())
        .collect();
    let tolerance = 0.04_f64.min(period * 0.12);
    let window = 16.min(beats.len());
    for a in 0..=beats.len() - window {
        let b = a + window;
        let inliers = errors[a..b].iter().filter(|&&e| e <= tolerance).count();
        let occupancy = (window - 1) as f64 / (indices[b - 1] - indices[a]).max(1.);
        if inliers as f64 / (window as f64) < 0.75 || !(0.7..=1.15).contains(&occupancy) {
            return None;
        }
        // A ramp can have good modulo-phase coverage but sustained signed drift.
        let mut signed: Vec<_> = (a..b)
            .map(|i| times[i] - origin - indices[i] * period)
            .collect();
        if median(&mut signed).abs() > 0.025 {
            return None;
        }
    }
    let support = errors.iter().filter(|&&e| e <= tolerance).count() as f64 / beats.len() as f64;
    let occupancy = (beats.len() - 1) as f64 / (indices.last()? - indices[0]).max(1.);
    let residual = median(&mut errors.clone());
    Some(Segment {
        start_seconds: beats[0],
        end_seconds: *beats.last()?,
        bpm: 60. / period,
        confidence: support * occupancy.min(1.) * (1. - residual / 0.06).clamp(0., 1.),
    })
}

/// Prefix moments keep each candidate boundary O(1), including very long recordings.
#[derive(Clone, Copy, Default)]
struct PhaseMoments {
    x: f64,
    y: f64,
    xx: f64,
    xy: f64,
    yy: f64,
}

fn fit_tempo_run(
    beats: &[f64],
    indices: &[f64],
    segments: &mut Vec<Segment>,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<()> {
    if cancelled() {
        return None;
    }
    if let Some(segment) = constant_tempo_run(beats) {
        segments.push(segment);
        return Some(());
    }
    const MIN_INTERVALS: usize = 8;
    // Seconds squared: a new region must explain sustained drift, not a 25ms attack shift.
    const SPLIT_PENALTY: f64 = 0.025;
    let mut times = beats.to_vec();
    for i in 2..beats.len() - 2 {
        let before = (beats[i - 1] - beats[i - 2]) / (indices[i - 1] - indices[i - 2]);
        let after = (beats[i + 2] - beats[i + 1]) / (indices[i + 2] - indices[i + 1]);
        let span = (beats[i + 1] - beats[i - 1]) / (indices[i + 1] - indices[i - 1]);
        if (before / span - 1.).abs() < 0.15 && (after / span - 1.).abs() < 0.15 {
            let expected = beats[i - 1] + (indices[i] - indices[i - 1]) * span;
            // Limit isolated timing outliers only in the regression copy. The physical
            // attacks and their confidence residuals remain untouched.
            times[i] = expected + (beats[i] - expected).clamp(-0.03, 0.03);
        }
    }
    let mut sums = vec![PhaseMoments::default()];
    for (&index, &time) in indices.iter().zip(&times) {
        let x = index - indices[0];
        let y = time - beats[0];
        let prev = *sums.last().unwrap();
        sums.push(PhaseMoments {
            x: prev.x + x,
            y: prev.y + y,
            xx: prev.xx + x * x,
            xy: prev.xy + x * y,
            yy: prev.yy + y * y,
        });
    }
    let fit = |a: usize, b: usize| {
        let n = (b - a + 1) as f64;
        let lo = sums[a];
        let hi = sums[b + 1];
        let x = hi.x - lo.x;
        let y = hi.y - lo.y;
        let xx = (hi.xx - lo.xx - x * x / n).max(1e-9);
        let xy = hi.xy - lo.xy - x * y / n;
        let period = xy / xx;
        let origin = (y - period * x) / n;
        let error = (hi.yy - lo.yy - y * y / n - xy * period).max(0.);
        (period, origin, error)
    };
    // Globally penalized partitioning avoids greedy boundaries leaving a short bogus
    // "transition tempo" between two real regions. Constant runs took the linear fast
    // path above; this variable-tempo fallback uses O(n²) time / O(n) memory, with no
    // segment-count limit. Shared boundary events keep adjoining regions contiguous.
    let mut costs = vec![f64::INFINITY; beats.len()];
    let mut parents = vec![0; beats.len()];
    costs[0] = -SPLIT_PENALTY;
    for b in MIN_INTERVALS..beats.len() {
        if b % 64 == 0 && cancelled() {
            return None;
        }
        for a in 0..=b - MIN_INTERVALS {
            if !costs[a].is_finite() || costs[a] + SPLIT_PENALTY >= costs[b] {
                continue;
            }
            let cost = costs[a] + fit(a, b).2 + SPLIT_PENALTY;
            if cost < costs[b] {
                costs[b] = cost;
                parents[b] = a;
            }
        }
    }
    let mut regions = Vec::new();
    let mut b = beats.len() - 1;
    while b > 0 {
        let a = parents[b];
        regions.push((a, b));
        b = a;
    }
    for (a, b) in regions.into_iter().rev() {
        let (period, origin, _) = fit(a, b);
        if !(0.25 - 1e-9..=1.5 + 1e-9).contains(&period) {
            continue;
        }
        let mut residuals: Vec<_> = (a..=b)
            .map(|i| (beats[i] - beats[0] - origin - (indices[i] - indices[0]) * period).abs())
            .collect();
        residuals.sort_by(f64::total_cmp);
        let residual = residuals[((residuals.len() - 1) as f64 * 0.9) as usize];
        let occupancy = (b - a) as f64 / (indices[b] - indices[a]).max(1.);
        segments.push(Segment {
            start_seconds: beats[a],
            end_seconds: beats[b],
            bpm: 60. / period,
            confidence: (1. - residual / 0.06).clamp(0., 1.) * occupancy,
        });
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_and_unlimited_segments() {
        let beats: Vec<_> = (0..2000).map(|i| 0.13 + i as f64 * 60. / 127.93).collect();
        let s = segment_beats(&beats);
        assert_eq!(s.len(), 1);
        assert!((s[0].bpm - 127.93).abs() < 0.001);
        let mut beats = vec![0.];
        let mut time = 0.;
        for n in 0..300 {
            for _ in 0..16 {
                time += 60. / if n % 2 == 0 { 100. } else { 150. };
                beats.push(time);
            }
        }
        let s = segment_beats(&beats);
        assert!(s.len() >= 300, "{}", s.len());
    }
    #[test]
    fn steady_tempo_with_jitter_and_displaced_attacks_is_one_segment() {
        for bpm in [70., 127.93, 220.] {
            let beats: Vec<_> = (0..640)
                .map(|i| {
                    let jitter = ((i * 73 % 101) as f64 / 100. - 0.5) * 0.04;
                    let displaced = if i % 47 == 13 { 0.12 } else { 0. };
                    0.2 + i as f64 * 60. / bpm + jitter + displaced
                })
                .collect();
            let segments = segment_beats(&beats);
            assert_eq!(segments.len(), 1, "{bpm}: {segments:?}");
            assert!((segments[0].bpm - bpm).abs() < 0.02);
        }
    }

    #[test]
    fn missing_beats_do_not_change_tempo_or_create_events() {
        let beats: Vec<_> = (0..400)
            .filter(|i| i % 53 != 11 && i % 53 != 12)
            .map(|i| 0.13 + i as f64 * 60. / 127.93)
            .collect();
        let original = beats.clone();
        let segments = segment_beats(&beats);
        assert_eq!(segments.len(), 1, "{segments:?}");
        assert!((segments[0].bpm - 127.93).abs() < 0.001);
        assert_eq!(beats, original);
    }

    #[test]
    fn genuine_half_and_double_time_sections_are_not_missing_beats() {
        let mut beats = vec![0.13];
        for bpm in [120., 60., 120., 240.] {
            for _ in 0..32 {
                beats.push(beats.last().unwrap() + 60. / bpm);
            }
        }
        let segments = segment_beats(&beats);
        assert_eq!(segments.len(), 4, "{segments:?}");
        for (segment, expected) in segments.iter().zip([120., 60., 120., 240.]) {
            assert!((segment.bpm - expected).abs() < 0.1, "{segment:?}");
        }
    }

    #[test]
    fn insufficient_events_do_not_claim_short_tempo_regions() {
        for count in 0..9 {
            let beats: Vec<_> = (0..count).map(|i| i as f64 * 0.5).collect();
            assert!(segment_beats(&beats).is_empty());
        }
    }

    #[test]
    fn sustained_small_tempo_change_is_not_flattened() {
        let beats: Vec<_> = (0usize..257)
            .map(|i| 0.13 + i.min(128) as f64 * 0.5 + i.saturating_sub(128) as f64 * 60. / 122.)
            .collect();
        let segments = segment_beats(&beats);
        assert_eq!(segments.len(), 2, "{segments:?}");
        assert!((segments[0].bpm - 120.).abs() < 0.1);
        assert!((segments[1].bpm - 122.).abs() < 0.1);
        assert!((segments[1].start_seconds - beats[128]).abs() < 0.51);
    }

    #[test]
    fn silence_has_no_grid() {
        let f = Features {
            onset: vec![0.; 3000],
            low: vec![0.; 3000],
            ..Default::default()
        };
        let r = track(f, 30., false, &|| false).unwrap();
        assert!(r.beats.is_empty());
        assert!(r.bpm.is_none());
    }
    #[test]
    fn variable_segmentation_can_be_cancelled() {
        let beats: Vec<_> = (0..1000)
            .map(|i| i as f64 * 0.5 + (i as f64 / 100.).powi(2))
            .collect();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        assert!(segment_beats_cancellable(&beats, &|| {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 3
        })
        .is_none());
    }

    #[test]
    fn cancellation() {
        let f = Features {
            onset: vec![1.; 3000],
            low: vec![1.; 3000],
            ..Default::default()
        };
        assert!(track(f, 30., false, &|| true).is_none());
    }
}

#[cfg(test)]
mod regression {
    use super::*;
    fn pulse_features(sections: &[(f64, f64)], silence: f64) -> (Features, Vec<f64>, f64) {
        let duration = sections.iter().map(|(seconds, _)| seconds).sum::<f64>() + silence;
        let n = (duration * FPS).ceil() as usize;
        let mut onset = vec![0.; n];
        let mut beats = Vec::new();
        let mut at = 0.;
        for (section, &(seconds, bpm)) in sections.iter().enumerate() {
            if section == 1 {
                at += silence;
            }
            let mut t = at + 0.15;
            while t < at + seconds - 0.05 {
                beats.push(t);
                let center = t * FPS;
                for i in (center as usize).saturating_sub(2)..((center as usize) + 3).min(n) {
                    onset[i] += (-((i as f64 - center) / 0.7).powi(2)).exp();
                }
                t += 60. / bpm;
            }
            at += seconds;
        }
        (
            Features {
                low: onset.clone(),
                onset,
                ..Default::default()
            },
            beats,
            duration,
        )
    }
    #[test]
    fn full_track_fixed_tempo_and_phase() {
        for bpm in [70., 100., 127.93, 170., 220.] {
            let (f, truth, duration) = pulse_features(&[(60., bpm)], 0.);
            let r = track(f, duration, false, &|| false).unwrap();
            assert!(
                (r.bpm.unwrap_or(0.) - bpm).abs() < 0.1,
                "wanted {bpm}, got {:?}",
                r.bpm
            );
            let mut errors: Vec<_> = r
                .beats
                .iter()
                .map(|b| {
                    truth
                        .iter()
                        .map(|t| (t - b).abs())
                        .fold(f64::INFINITY, f64::min)
                })
                .collect();
            errors.sort_by(f64::total_cmp);
            assert!(
                errors[(errors.len() as f64 * 0.95) as usize] < 0.02,
                "{bpm} phase"
            );
            assert!(
                r.beats.len() as f64 > truth.len() as f64 * 0.95,
                "{bpm} coverage {} / {}",
                r.beats.len(),
                truth.len()
            );
        }
    }
    #[test]
    fn fixed_tempo_survives_arrangement_changes_in_both_modes() {
        let bpm = 127.93;
        let duration = 120.;
        let n = (duration * FPS) as usize;
        let mut f = Features {
            onset: vec![0.; n],
            low: vec![0.; n],
            attack: vec![0.; n],
        };
        let pulse = |env: &mut [f64], time: f64, strength: f64| {
            let center = time * FPS;
            for i in (center as usize).saturating_sub(2)..(center as usize + 3).min(n) {
                env[i] += strength * (-((i as f64 - center) / 0.7).powi(2)).exp();
            }
        };
        let mut i = 0;
        let mut time = 0.15;
        while time < duration - 0.1 {
            // Sparse breaks, changing bar accents, quiet passages and stronger offbeats
            // all retain the same underlying clock.
            if i % 53 != 11 && i % 53 != 12 {
                let strength = if time > 40. && time < 70. { 0.25 } else { 1. };
                let accent = if i % 4 == 0 { 1. } else { 0.6 };
                pulse(&mut f.onset, time, strength * accent);
                pulse(&mut f.low, time, strength * accent);
                let displaced = if i % 47 == 13 { 0.10 } else { 0. };
                pulse(&mut f.attack, time + displaced, strength * accent);
            }
            if i % 53 > 15 && time > 20. && time < 100. {
                pulse(&mut f.onset, time + 30. / bpm, 0.4);
                pulse(&mut f.attack, time + 30. / bpm, 0.4);
            }
            i += 1;
            time += 60. / bpm;
        }
        for precise in [false, true] {
            let copy = Features {
                onset: f.onset.clone(),
                low: f.low.clone(),
                attack: f.attack.clone(),
            };
            let r = track(copy, duration, precise, &|| false).unwrap();
            assert_eq!(r.segments.len(), 1, "precise={precise}: {:?}", r.segments);
            assert!((r.bpm.unwrap() - bpm).abs() < 0.1);
            assert!(r.beats.len() > 220);
        }
    }

    #[test]
    fn variable_and_silent_regions_keep_both_sides() {
        let (f, _, duration) = pulse_features(&[(40., 100.), (40., 150.)], 20.);
        let r = track(f, duration, false, &|| false).unwrap();
        assert!(r.beats.iter().any(|&b| b < 10.));
        assert!(r.beats.iter().any(|&b| b > 90.));
        assert!(!r.beats.iter().any(|&b| b > 41. && b < 59.));
        assert!(!r.coverage.iter().any(|s| s[0] < 59. && s[1] > 41.));
        assert!(r.segments.iter().any(|s| (s.bpm - 100.).abs() < 0.1));
        assert!(r.segments.iter().any(|s| (s.bpm - 150.).abs() < 0.1));
    }
    #[test]
    fn full_pipeline_more_than_256_tempo_changes() {
        let sections: Vec<_> = (0..300)
            .map(|i| (16., if i % 2 == 0 { 100. } else { 150. }))
            .collect();
        let (f, _, duration) = pulse_features(&sections, 0.);
        let r = track(f, duration, false, &|| false).unwrap();
        assert!(r.segments.len() > 256, "{} segments", r.segments.len());
        assert!(r.beats.last().unwrap() > &(duration - 2.));
        assert!(
            r.segments
                .iter()
                .filter(|s| (s.bpm - 100.).abs() < 0.1)
                .count()
                > 100
        );
        assert!(
            r.segments
                .iter()
                .filter(|s| (s.bpm - 150.).abs() < 0.1)
                .count()
                > 100
        );
    }
    #[test]
    fn gradual_tempo_preserves_events_and_syncopated_pickup() {
        let n = (120. * FPS) as usize;
        let mut onset = vec![0.; n];
        let mut low = vec![0.; n];
        let mut truth = vec![];
        let mut t = 0.73;
        while t < 119. {
            truth.push(t);
            let center = t * FPS;
            for i in (center as usize).saturating_sub(2)..((center as usize) + 3).min(n) {
                let v = (-((i as f64 - center) / 0.7).powi(2)).exp();
                onset[i] += v;
                low[i] += v;
            }
            let period = 60. / (100. + t * 0.3);
            let off = ((t + period * 0.5) * FPS) as usize;
            if off < n {
                onset[off] += 0.35;
            }
            t += period;
        }
        let r = track(
            Features {
                onset,
                low,
                ..Default::default()
            },
            120.,
            false,
            &|| false,
        )
        .unwrap();
        assert!(r.segments.len() > 2);
        assert!(r.segments.first().unwrap().bpm < 110.);
        assert!(r.segments.last().unwrap().bpm > 130.);
        let matched = truth
            .iter()
            .filter(|&&t| r.beats.iter().any(|b| (b - t).abs() < 0.02))
            .count();
        assert!(
            matched as f64 / truth.len() as f64 > 0.9,
            "{} / {}",
            matched,
            truth.len()
        );
        assert!(
            r.downbeats.is_empty(),
            "equal accents are not a reliable first bar beat"
        );
    }

    #[test]
    fn decoded_pcm_phase_accuracy() {
        let path =
            std::env::temp_dir().join(format!("kdj-v4-pcm-regression-{}.wav", std::process::id()));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let samples = SR * 30;
        let bytes = samples * 2;
        let mut wav = Vec::with_capacity(bytes as usize + 44);
        wav.extend(b"RIFF");
        wav.extend((bytes + 36).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(SR.to_le_bytes());
        wav.extend((SR * 2).to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(bytes.to_le_bytes());
        let period = 60. / 127.93;
        for n in 0..samples {
            let t = n as f64 / SR as f64;
            let age = (t - 0.13).rem_euclid(period);
            let v = if t >= 0.13 && age < 0.045 {
                (-age * 100.).exp() * (std::f64::consts::TAU * 100. * age).sin() * 0.8
            } else {
                0.
            };
            wav.extend(((v * 32767.) as i16).to_le_bytes());
        }
        std::fs::write(&path, wav).unwrap();
        for precise in [false, true] {
            let r = analyze(&path, precise, &|| false).unwrap().unwrap();
            assert!((r.bpm.unwrap() - 127.93).abs() < 0.1);
            let mut errors: Vec<_> = r
                .beats
                .iter()
                .map(|&t| {
                    let phase = (t - 0.13).rem_euclid(period);
                    phase.min(period - phase)
                })
                .collect();
            errors.sort_by(f64::total_cmp);
            assert!(
                errors[(errors.len() as f64 * 0.95) as usize] < 0.02,
                "{errors:?}"
            );
            assert!(r.beats.len() > 60);
        }
    }
}
