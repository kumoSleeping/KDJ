//! Bar lines from a beat sequence: which beat of each bar every beat is, tracked beat by beat.
//!
//! Counting `beat index mod 4` over the whole song breaks at the first beat the tracker missed
//! or added: from there on the phase is wrong, the accents of the four positions average out and
//! no bar line is found at all. Here each beat carries its own evidence of starting a bar — bass
//! weight and how much the harmony changes there — and a Viterbi path over the four positions
//! follows the bar through dropped and doubled beats (the gap to the previous beat says how many
//! positions it moves on). Times are the beats' own; nothing is moved or invented.

use crate::dsp::median;

/// This tracking's number, kept with an analysis (`RhythmAnalysis::bars`).
pub const REVISION: u32 = 1;

/// A position change the gaps do not explain costs this much evidence (a few bars of it).
const RESET: f64 = 6.;
/// How much each position of the bar is expected to be accented: 1, 2, 3, 4.
const WEIGHT: [f64; 4] = [1., -0.2, 0.25, -0.2];
/// Below this contrast the first beat of the bar is not known well enough to be given.
pub const MIN_CONFIDENCE: f64 = 0.15;
/// Beats each side whose evidence normalizes a beat's own.
const CONTEXT: usize = 16;

/// The bar lines among `beats` (seconds) and how sure they are (0..1): `low` is the bass onset
/// strength per analysis frame and `chroma` the pitch classes per frame, both at `fps` frames a
/// second. No bar lines when there are too few beats or the accents do not tell the bar.
pub fn bar_lines(beats: &[f64], low: &[f64], chroma: &[[f32; 12]], fps: f64) -> (Vec<f64>, f64) {
    let n = beats.len();
    if n < 16 || low.is_empty() {
        return (vec![], 0.);
    }
    let frame = |t: f64| ((t * fps).round().max(0.) as usize).min(low.len() - 1);
    let bass: Vec<f64> = beats.iter().map(|&b| {
        let t = frame(b);
        low[t.saturating_sub(3)..(t + 4).min(low.len())].iter().copied().fold(0., f64::max)
    }).collect();
    // How far the harmony of the two beats after a beat is from that of the two before it.
    let mean_chroma = |a: f64, b: f64| {
        let mut sum = [0f64; 12];
        if chroma.is_empty() {
            return sum;
        }
        let from = frame(a).min(chroma.len() - 1);
        let to = frame(b).clamp(from + 1, chroma.len());
        for c in &chroma[from..to] {
            for (s, v) in sum.iter_mut().zip(c) {
                *s += *v as f64;
            }
        }
        sum
    };
    let harmony: Vec<f64> = (0..n).map(|i| {
        if i < 2 || i + 2 >= n {
            return 0.;
        }
        let (x, y) = (mean_chroma(beats[i - 2], beats[i]), mean_chroma(beats[i], beats[i + 2]));
        let dot: f64 = x.iter().zip(&y).map(|(a, b)| a * b).sum();
        let norm = (x.iter().map(|v| v * v).sum::<f64>() * y.iter().map(|v| v * v).sum::<f64>()).sqrt();
        if norm > 1e-12 { 1. - dot / norm } else { 0. }
    }).collect();
    let local = |values: &[f64], i: usize| {
        let window = &values[i.saturating_sub(CONTEXT)..(i + CONTEXT + 1).min(n)];
        let mean = window.iter().sum::<f64>() / window.len() as f64;
        let spread = (window.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / window.len() as f64).sqrt();
        (mean, spread)
    };
    let score = |values: &[f64], i: usize| {
        let (mean, spread) = local(values, i);
        if spread < 1e-9 { 0. } else { ((values[i] - mean) / spread).clamp(-3., 3.) }
    };
    let evidence: Vec<f64> = (0..n).map(|i| score(&bass, i) + score(&harmony, i)).collect();
    // How many positions each beat moves on from the one before: one, or more over a dropped beat.
    let gaps: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    let steps: Vec<usize> = (0..n).map(|i| {
        if i == 0 {
            return 1;
        }
        let period = median(&mut gaps[(i - 1).saturating_sub(8)..(i + 8).min(gaps.len())].to_vec());
        if period <= 0. { 1 } else { ((gaps[i - 1] / period).round() as usize).clamp(1, 4) }
    }).collect();

    let mut scores = vec![[0f64; 4]; n];
    let mut parents = vec![[0usize; 4]; n];
    for k in 0..4 {
        scores[0][k] = evidence[0] * WEIGHT[k];
    }
    for i in 1..n {
        for k in 0..4 {
            let (from, best) = (0..4)
                .map(|p| (p, scores[i - 1][p] - if (p + steps[i]) % 4 == k { 0. } else { RESET }))
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .unwrap();
            scores[i][k] = best + evidence[i] * WEIGHT[k];
            parents[i][k] = from;
        }
    }
    let mut position = vec![0usize; n];
    position[n - 1] = (0..4).max_by(|&a, &b| scores[n - 1][a].total_cmp(&scores[n - 1][b])).unwrap();
    for i in (1..n).rev() {
        position[i - 1] = parents[i][position[i]];
    }

    // The contrast of the first position with the strongest other, as the old whole-song count
    // measured it, on positive evidence relative to its surroundings.
    let mut accents = [0f64; 4];
    let mut counts = [0f64; 4];
    for i in 0..n {
        let relative = |values: &[f64]| {
            let (mean, _) = local(values, i);
            if mean > 1e-12 { values[i] / mean } else { 0. }
        };
        accents[position[i]] += relative(&bass) + relative(&harmony);
        counts[position[i]] += 1.;
    }
    for k in 0..4 {
        accents[k] /= counts[k].max(1.);
    }
    let other = accents[1..].iter().copied().fold(0., f64::max);
    let confidence = ((accents[0] - other) / accents[0].max(1e-9)).clamp(0., 1.);
    if confidence < MIN_CONFIDENCE {
        return (vec![], confidence);
    }
    let lines = beats.iter().zip(&position).filter(|(_, &k)| k == 0).map(|(&b, _)| b).collect();
    (lines, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: f64 = 100.;

    /// Beats every half second, a bass hit and a chord change on every fourth from `first`.
    fn song(count: usize, first: usize, skip: Option<usize>) -> (Vec<f64>, Vec<f64>, Vec<[f32; 12]>) {
        let frames = (count as f64 * 0.5 * FPS) as usize + 100;
        let mut low = vec![0.1; frames];
        let mut chroma = vec![[0f32; 12]; frames];
        let mut beats = vec![];
        for i in 0..count {
            let t = i as f64 * 0.5;
            let f = (t * FPS) as usize;
            if i % 4 == first {
                low[f] = 1.;
            }
            let bar = (i + 4 - first) / 4;
            for c in &mut chroma[f..(f + 50).min(frames)] {
                *c = [0.; 12];
                c[(bar * 5) % 12] = 1.;
                c[(bar * 5 + 4) % 12] = 0.6;
            }
            if Some(i) != skip {
                beats.push(t);
            }
        }
        (beats, low, chroma)
    }

    #[test]
    fn the_bar_carries_on_past_a_dropped_beat() {
        let (beats, low, chroma) = song(96, 1, Some(42));
        let (lines, confidence) = bar_lines(&beats, &low, &chroma, FPS);
        assert!(confidence > MIN_CONFIDENCE, "{confidence}");
        let expected: Vec<f64> = (0..96).filter(|i| i % 4 == 1).map(|i| i as f64 * 0.5).collect();
        assert_eq!(lines, expected);
    }

    #[test]
    fn equal_beats_give_no_bar_lines() {
        let beats: Vec<f64> = (0..64).map(|i| i as f64 * 0.5).collect();
        let mut low = vec![0.1; 3300];
        for &b in &beats {
            low[(b * FPS) as usize] = 1.;
        }
        let (lines, _) = bar_lines(&beats, &low, &vec![[0.5; 12]; 3300], FPS);
        assert!(lines.is_empty());
    }
}
