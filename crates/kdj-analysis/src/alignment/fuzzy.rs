//! Reviewable local correspondences, deliberately separate from exact `matched`.
//! Chroma proposes phrases despite a replaced backing track. Independent whitened
//! spectra refine anchors; a sustained affine fit estimates a constant playback rate.
use super::*;

const PHRASE: usize = 120;
const STRIDE: usize = 100;

#[derive(Debug, Clone)]
pub struct FuzzyPlacement {
    pub source_start_ms: f64,
    pub source_end_ms: f64,
    pub reference_start_ms: f64,
    /// Source seconds consumed per reference second. Multiply the existing speed.
    pub speed: f64,
    pub similarity: f64,
    pub anchors: usize,
}

#[derive(Clone, Copy, Debug)]
struct Anchor {
    source: f64,
    target: f64,
    slope: f64,
    score: f64,
}

fn chroma(pcm: &[f32], canceled: &impl Fn() -> bool) -> Result<Vec<[f32; 12]>> {
    const SIZE: usize = 2048;
    let fft = FftPlanner::<f32>::new().plan_fft_forward(SIZE);
    let mut buffer = vec![Complex32::default(); SIZE];
    let mut scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
    let hann: Vec<_> = (0..SIZE)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (SIZE - 1) as f32).cos())
        .collect();
    let notes: Vec<Vec<usize>> = (48..108)
        .map(|note| {
            (1..=SIZE / 2)
                .filter(|&bin| {
                    let midi =
                        69. + 12. * (bin as f64 * SAMPLE_RATE as f64 / SIZE as f64 / 440.).log2();
                    (midi - note as f64).abs() < 0.5
                })
                .collect()
        })
        .collect();
    let mut frames = Vec::new();
    for start in (0..pcm.len().saturating_sub(SIZE)).step_by(800) {
        if canceled() {
            bail!("匹配已取消")
        }
        for i in 0..SIZE {
            buffer[i] = Complex32::new(pcm[start + i] * hann[i], 0.);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        let mut frame = [0f32; 12];
        for (note, bins) in notes.iter().enumerate() {
            frame[note % 12] += bins
                .iter()
                .map(|&i| buffer[i].norm_sqr())
                .sum::<f32>()
                .sqrt();
        }
        normalize(&mut frame);
        frames.push(frame);
    }
    // Remove each recording's persistent tonal colour, so sharing a key alone
    // contributes little. Silence stays zero and cannot become a match.
    let mut mean = [0.; 12];
    for f in &frames {
        for i in 0..12 {
            mean[i] += f[i] / frames.len() as f32;
        }
    }
    for f in &mut frames {
        if f.iter().any(|v| *v != 0.) {
            for i in 0..12 {
                f[i] -= mean[i];
            }
            normalize(f);
        }
    }
    Ok(frames)
}
fn normalize(frame: &mut [f32; 12]) {
    let norm = frame.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for v in frame {
            *v /= norm;
        }
    }
}

/// Inputs are rendered mono PCM at SAMPLE_RATE (8 kHz), including existing clip
/// speed. Suggestions cover only corroborated phrases, never the entire song by
/// extrapolation. No result changes the strict matcher's acceptance thresholds.
pub fn suggest_constant_speed(
    source: &[f32],
    reference: &[f32],
    canceled: impl Fn() -> bool,
) -> Result<Vec<FuzzyPlacement>> {
    if canceled() {
        bail!("匹配已取消")
    }
    if source.iter().chain(reference).any(|v| !v.is_finite()) {
        bail!("音频解码包含无效采样")
    }
    if source.len().min(reference.len()) < SAMPLE_RATE * 32 {
        return Ok(vec![]);
    }
    let a = chroma(source, &canceled)?;
    let b = chroma(reference, &canceled)?;
    let sa = spectra(source, &canceled)?;
    let sb = spectra(reference, &canceled)?;
    let mut anchors = Vec::new();
    // One phrase matrix at a time: memory remains bounded for long source files.
    for start in (0..=a.len().saturating_sub(PHRASE)).step_by(STRIDE) {
        if canceled() {
            bail!("匹配已取消")
        }
        let mut similarity = vec![0f32; PHRASE * b.len()];
        for i in 0..PHRASE {
            for (j, frame) in b.iter().enumerate() {
                similarity[i * b.len() + j] =
                    a[start + i].iter().zip(frame).map(|(x, y)| x * y).sum();
            }
        }
        let mut candidates: Vec<(f64, usize, f64)> = Vec::new();
        for step in 0..=90 {
            if canceled() {
                bail!("匹配已取消")
            }
            let slope = 0.8 + step as f64 * 0.005;
            let indices: Vec<_> = (0..PHRASE)
                .map(|i| (i as f64 * slope).round() as usize)
                .collect();
            for target in 0..b.len().saturating_sub(indices[PHRASE - 1]) {
                // Half the phrase frames suffice for proposals; spectral refinement
                // below uses an independent, higher resolution representation.
                let score = (0..PHRASE)
                    .step_by(2)
                    .map(|i| similarity[i * b.len() + target + indices[i]] as f64)
                    .sum::<f64>()
                    / (PHRASE / 2) as f64;
                if score < 0.32 {
                    continue;
                }
                if let Some(old) = candidates.iter_mut().find(|c| c.1.abs_diff(target) < 40) {
                    if score > old.0 {
                        *old = (score, target, slope);
                    }
                } else {
                    candidates.push((score, target, slope));
                }
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, target, slope) in candidates.into_iter().take(3) {
            if canceled() {
                bail!("匹配已取消")
            }
            if let Some(anchor) = refine(&sa, &sb, start * 10, target * 10, slope, &canceled)? {
                anchors.push(anchor);
            }
        }
    }
    let groups = fit_groups(&anchors);
    let mut mappings = groups.clone();
    // A sustained correspondence establishes a speed, not a global offset.
    // Other independently verified anchors at that speed may belong to short
    // cuts, reordered verses or repeated hooks in the remix.
    let mut ranked = anchors.clone();
    ranked.sort_by(|a, b| b.score.total_cmp(&a.score));
    for anchor in ranked.iter().filter(|a| a.score >= 0.40) {
        let Some(rate) = groups
            .iter()
            .filter(|g| (1. / g.speed - anchor.slope).abs() <= 0.006)
            .min_by(|a, b| {
                (1. / a.speed - anchor.slope)
                    .abs()
                    .total_cmp(&(1. / b.speed - anchor.slope).abs())
            })
        else {
            continue;
        };
        if mappings.iter().any(|m| {
            (m.reference_start_ms + (anchor.source - m.source_start_ms) / m.speed - anchor.target)
                .abs()
                < 120.
        }) {
            continue;
        }
        mappings.push(FuzzyPlacement {
            source_start_ms: anchor.source,
            source_end_ms: anchor.source + 8000.,
            reference_start_ms: anchor.target,
            speed: rate.speed,
            similarity: anchor.score,
            anchors: 1,
        });
    }
    let mut verified = Vec::new();
    for mapping in mappings {
        let full = FuzzyPlacement {
            reference_start_ms: mapping.reference_start_ms
                - mapping.source_start_ms / mapping.speed,
            source_start_ms: 0.,
            source_end_ms: sa.len() as f64 * 10.,
            ..mapping
        };
        verified.extend(verify_span(&sa, &sb, &full, &canceled)?);
    }
    Ok(assemble_spans(&verified))
}

fn refine(
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
    source: usize,
    target: usize,
    slope: f64,
    canceled: &impl Fn() -> bool,
) -> Result<Option<Anchor>> {
    let mut best = Anchor {
        source: source as f64 * 10.,
        target: 0.,
        slope,
        score: 0.,
    };
    // Eight seconds, mid/high bands reduce replacement kick/bass influence.
    for rate in -7..=7 {
        if canceled() {
            bail!("匹配已取消")
        }
        let slope = slope + rate as f64 * 0.001;
        for delta in -20..=20 {
            let target = target as f64 + delta as f64;
            if target < 0.
                || target + 798. * slope + 1. >= b.len() as f64
                || source + 798 >= a.len()
            {
                continue;
            }
            let score = mapped_score(a, b, source, target, slope, 800);
            if score > best.score {
                best.target = target * 10.;
                best.slope = slope;
                best.score = score;
            }
        }
    }
    Ok((best.score >= 0.30).then_some(best))
}

// Evaluate the final mapping without moving individual windows to a better peak.
fn mapped_score(
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
    source: usize,
    target: f64,
    slope: f64,
    count: usize,
) -> f64 {
    if target < 0.
        || source + count > a.len()
        || target + (count - 1) as f64 * slope + 1. >= b.len() as f64
    {
        return -1.;
    }
    ncc(
        (0..count)
            .step_by(2)
            .flat_map(|i| a[source + i][5..].iter().copied()),
        (0..count).step_by(2).flat_map(|i| {
            let t = target + i as f64 * slope;
            let lo = t as usize;
            let fraction = (t - lo as f64) as f32;
            (5..BANDS).map(move |band| b[lo][band] * (1. - fraction) + b[lo + 1][band] * fraction)
        }),
    )
}

fn verify_span(
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
    candidate: &FuzzyPlacement,
    canceled: &impl Fn() -> bool,
) -> Result<Vec<FuzzyPlacement>> {
    const BLOCK: usize = 200; // two seconds; also check the gaps between proposal windows
    let lo = (candidate.source_start_ms / 10.).round() as usize;
    let hi = (candidate.source_end_ms / 10.).round() as usize;
    let mut result = Vec::new();
    let mut run = Vec::new();
    let finish = |run: &mut Vec<(usize, f64)>, result: &mut Vec<FuzzyPlacement>| {
        if run.len() * BLOCK >= 800 {
            let mean = run.iter().map(|v| v.1).sum::<f64>() / run.len() as f64;
            if mean >= 0.40 {
                let start = run[0].0 as f64 * 10.;
                result.push(FuzzyPlacement {
                    source_start_ms: start,
                    source_end_ms: (run.last().unwrap().0 + BLOCK) as f64 * 10.,
                    reference_start_ms: candidate.reference_start_ms
                        + (start - candidate.source_start_ms) / candidate.speed,
                    similarity: mean,
                    ..candidate.clone()
                });
            }
        }
        run.clear();
    };
    for source in (lo..=hi.saturating_sub(BLOCK)).step_by(BLOCK) {
        if canceled() {
            bail!("匹配已取消")
        }
        let target = (candidate.reference_start_ms
            + (source as f64 * 10. - candidate.source_start_ms) / candidate.speed)
            / 10.;
        let score = mapped_score(a, b, source, target, 1. / candidate.speed, BLOCK);
        let alternative = [-200., -100., -50., -25., 25., 50., 100., 200.]
            .into_iter()
            .map(|delta| mapped_score(a, b, source, target + delta, 1. / candidate.speed, BLOCK))
            .fold(-1., f64::max);
        if score >= 0.30 && score - alternative >= 0.08 {
            run.push((source, score));
        } else {
            finish(&mut run, &mut result);
        }
    }
    finish(&mut run, &mut result);
    Ok(result)
}

fn assemble_spans(candidates: &[FuzzyPlacement]) -> Vec<FuzzyPlacement> {
    let end =
        |c: &FuzzyPlacement| c.reference_start_ms + (c.source_end_ms - c.source_start_ms) / c.speed;
    let source_at =
        |c: &FuzzyPlacement, t: f64| c.source_start_ms + (t - c.reference_start_ms) * c.speed;
    let mut boundaries: Vec<_> = candidates
        .iter()
        .flat_map(|c| [c.reference_start_ms, end(c)])
        .collect();
    boundaries.sort_by(f64::total_cmp);
    boundaries.dedup_by(|a, b| (*a - *b).abs() < 0.01);
    let mut result: Vec<FuzzyPlacement> = Vec::new();
    for edge in boundaries.windows(2) {
        let (lo, hi) = (edge[0], edge[1]);
        let mid = (lo + hi) / 2.;
        let mut choices: Vec<_> = candidates
            .iter()
            .filter(|c| c.reference_start_ms <= lo + 0.01 && end(c) >= hi - 0.01)
            .collect();
        // Continuous evidence on either side of an overlap distinguishes a
        // complete verse from a shorter, similar-sounding chorus elsewhere.
        let strength =
            |c: &FuzzyPlacement| c.similarity * ((end(c) - c.reference_start_ms) / 1000.).sqrt();
        choices.sort_by(|a, b| strength(b).total_cmp(&strength(a)));
        let Some(best) = choices.first() else {
            continue;
        };
        // Distinct source passages competing for the SAME remix time are
        // alternatives. Reusing one source passage at different remix times is
        // legitimate repetition and must not delete both occurrences.
        if choices.iter().skip(1).any(|other| {
            (source_at(best, mid) - source_at(other, mid)).abs() > 200.
                && (other.similarity > best.similarity + 0.08
                    || (best.similarity - other.similarity < 0.08
                        && strength(best) < strength(other) * 1.20))
        }) {
            continue;
        }
        let piece = FuzzyPlacement {
            source_start_ms: source_at(best, lo),
            source_end_ms: source_at(best, hi),
            reference_start_ms: lo,
            ..(*best).clone()
        };
        if let Some(last) = result.last_mut() {
            if (end(last) - lo).abs() < 0.01
                && (source_at(last, hi) - piece.source_end_ms).abs() < 100.
                && (last.speed - piece.speed).abs() < 0.001
            {
                last.source_end_ms = source_at(last, hi);
                continue;
            }
        }
        result.push(piece);
    }
    result.retain(|c| end(c) - c.reference_start_ms >= 6000.);
    result
}

fn fit_groups(anchors: &[Anchor]) -> Vec<FuzzyPlacement> {
    let mut groups: Vec<FuzzyPlacement> = Vec::new();
    for seed in anchors {
        let mut group = vec![*seed];
        let mut starts: Vec<_> = anchors
            .iter()
            .filter(|a| a.source > seed.source)
            .map(|a| a.source)
            .collect();
        starts.sort_by(f64::total_cmp);
        starts.dedup();
        for source in starts {
            let last = group.last().unwrap();
            if source - last.source > 10_001. {
                break;
            }
            let (slope, intercept) = fit(&group);
            let next = anchors
                .iter()
                .filter(|a| {
                    a.source == source
                        && (a.target - (slope * a.source + intercept)).abs() <= 180.
                        && (a.slope - slope).abs() <= 0.012
                })
                .max_by(|a, b| a.score.total_cmp(&b.score));
            if let Some(next) = next {
                group.push(*next);
            } else {
                break;
            }
        }
        if group.len() < 4 {
            continue;
        }
        let (slope, intercept) = fit(&group);
        if group
            .iter()
            .any(|a| (a.target - slope * a.source - intercept).abs() > 100.)
        {
            continue;
        }
        let source_start_ms = group[0].source;
        let source_end_ms = group.last().unwrap().source + 8000.;
        let candidate = FuzzyPlacement {
            source_start_ms,
            source_end_ms,
            reference_start_ms: slope * source_start_ms + intercept,
            speed: 1. / slope,
            similarity: group.iter().map(|a| a.score).sum::<f64>() / group.len() as f64,
            anchors: group.len(),
        };
        if candidate.reference_start_ms < 0. {
            continue;
        }
        // Suppress sub-runs of the same mapping, retaining different chorus placements.
        if groups.iter().any(|old| {
            let predicted =
                old.reference_start_ms + (source_start_ms - old.source_start_ms) / old.speed;
            (predicted - candidate.reference_start_ms).abs() < 200.
                && old.source_start_ms <= source_start_ms
                && old.source_end_ms >= source_end_ms
        }) {
            continue;
        }
        groups.push(candidate);
    }
    groups.sort_by(|a, b| {
        (b.source_end_ms - b.source_start_ms)
            .total_cmp(&(a.source_end_ms - a.source_start_ms))
            .then_with(|| b.similarity.total_cmp(&a.similarity))
    });
    groups
}
fn fit(group: &[Anchor]) -> (f64, f64) {
    if group.len() == 1 {
        let a = group[0];
        return (a.slope, a.target - a.slope * a.source);
    }
    let x = group.iter().map(|a| a.source).sum::<f64>() / group.len() as f64;
    let y = group.iter().map(|a| a.target).sum::<f64>() / group.len() as f64;
    let slope = group
        .iter()
        .map(|a| (a.source - x) * (a.target - y))
        .sum::<f64>()
        / group.iter().map(|a| (a.source - x).powi(2)).sum::<f64>();
    (slope, y - slope * x)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn affine_fit_recovers_speed_and_preserves_distinct_repeated_phrases() {
        let mut anchors = Vec::new();
        for i in 0..7 {
            let source = 20_000. + i as f64 * 10_000.;
            for offset in [7019., 52000.] {
                anchors.push(Anchor {
                    source,
                    target: source / 0.98482 + offset,
                    slope: 1. / 0.98482,
                    score: 0.52,
                });
            }
        }
        let result = fit_groups(&anchors);
        assert_eq!(result.len(), 2, "{result:?}");
        for r in &result {
            assert!((r.speed - 0.98482).abs() < 0.00001);
            assert_eq!(r.anchors, 7);
            assert_eq!(r.source_start_ms, 20000.);
            assert_eq!(r.source_end_ms, 88000.);
        }
        assert!((result[0].reference_start_ms - result[1].reference_start_ms).abs() > 40000.);
    }
    #[test]
    fn accelerating_and_isolated_matches_do_not_establish_constant_speed() {
        let anchors: Vec<_> = (0..7)
            .map(|i| {
                let source = i as f64 * 10000.;
                Anchor {
                    source,
                    target: source + source * source * 0.000002,
                    slope: 1. + source * 0.000004,
                    score: 0.9,
                }
            })
            .collect();
        assert!(fit_groups(&anchors).is_empty());
        assert!(fit_groups(&anchors[..1]).is_empty());
    }
    #[test]
    fn verification_cuts_unmatched_gaps_and_rejects_periodic_false_peaks() {
        let mut seed = 17u32;
        let a: Vec<[f32; BANDS]> = (0..8002)
            .map(|_| {
                std::array::from_fn(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
                })
            })
            .collect();
        let candidate = FuzzyPlacement {
            source_start_ms: 0.,
            source_end_ms: 80000.,
            reference_start_ms: 0.,
            speed: 1.,
            similarity: 1.,
            anchors: 8,
        };
        let mut b = a.clone();
        b[3200..3400].fill([0.; BANDS]);
        let spans = verify_span(&a, &b, &candidate, &|| false).unwrap();
        assert_eq!(spans.len(), 2);
        assert_eq!(
            (spans[0].source_start_ms, spans[0].source_end_ms),
            (0., 32000.)
        );
        assert_eq!(
            (spans[1].source_start_ms, spans[1].source_end_ms),
            (34000., 80000.)
        );
        let periodic: Vec<_> = (0..8002).map(|i| a[i % 25]).collect();
        assert!(verify_span(&periodic, &periodic, &candidate, &|| false)
            .unwrap()
            .is_empty());
        assert!(verify_span(&a, &b, &candidate, &|| true).is_err());
    }
    #[test]
    fn repeated_source_can_fill_distinct_remix_times_but_competing_sources_abstain() {
        let a = FuzzyPlacement {
            source_start_ms: 0.,
            source_end_ms: 38000.,
            reference_start_ms: 0.,
            speed: 1.,
            similarity: 0.6,
            anchors: 4,
        };
        let repeated = FuzzyPlacement {
            reference_start_ms: 60000.,
            ..a.clone()
        };
        assert_eq!(assemble_spans(&[a.clone(), repeated]).len(), 2);
        let conflict = FuzzyPlacement {
            source_start_ms: 60000.,
            source_end_ms: 98000.,
            ..a.clone()
        };
        assert!(assemble_spans(&[a.clone(), conflict]).is_empty());
        let separate = FuzzyPlacement {
            source_start_ms: 60000.,
            source_end_ms: 98000.,
            reference_start_ms: 50000.,
            ..a.clone()
        };
        assert_eq!(assemble_spans(&[a, separate]).len(), 2);
    }
    #[test]
    fn remix_assembly_recovers_short_reordered_and_repeated_sections() {
        let source: Vec<f32> = (0..SAMPLE_RATE * 112)
            .map(|i| {
                let cell = (i / 2000) as u32;
                let hash = cell
                    .wrapping_mul(1664525)
                    .wrapping_add(1013904223)
                    .rotate_left(13)
                    .wrapping_mul(22695477);
                let frequency = 200. + (hash % 2300) as f32;
                let t = i as f32 / SAMPLE_RATE as f32;
                (std::f32::consts::TAU * frequency * t).sin() * (0.2 + (hash % 17) as f32 / 100.)
            })
            .collect();
        let mut remix = Vec::new();
        for (lo, hi) in [(0, 40), (80, 96), (48, 60), (80, 96)] {
            remix.extend_from_slice(&source[lo * SAMPLE_RATE..hi * SAMPLE_RATE]);
        }
        let result = suggest_constant_speed(&source, &remix, || false).unwrap();
        for (target, source_time) in [
            (10_000., 10_000.),
            (46_000., 86_000.),
            (62_000., 54_000.),
            (74_000., 86_000.),
        ] {
            let segment = result
                .iter()
                .find(|p| {
                    p.reference_start_ms <= target
                        && p.reference_start_ms + (p.source_end_ms - p.source_start_ms) / p.speed
                            > target
                })
                .unwrap_or_else(|| panic!("missing remix time {target}: {result:?}"));
            let mapped =
                segment.source_start_ms + (target - segment.reference_start_ms) * segment.speed;
            assert!(
                (mapped - source_time).abs() < 120.,
                "{target} -> {mapped}, expected {source_time}"
            );
        }
        assert!(result.windows(2).all(|p| p[0].reference_start_ms
            + (p[0].source_end_ms - p[0].source_start_ms) / p[0].speed
            <= p[1].reference_start_ms + 0.01));
    }
    #[test]
    fn silence_invalid_samples_short_inputs_and_cancellation_abstain() {
        let silence = vec![0.; SAMPLE_RATE * 33];
        assert!(suggest_constant_speed(&silence, &silence, || false)
            .unwrap()
            .is_empty());
        assert!(suggest_constant_speed(&silence, &silence, || true).is_err());
        assert!(suggest_constant_speed(&[f32::NAN], &silence, || false).is_err());
        assert!(suggest_constant_speed(&silence, &silence[..8000], || false)
            .unwrap()
            .is_empty());
    }
}
