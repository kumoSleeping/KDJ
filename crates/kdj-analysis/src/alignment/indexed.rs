//! Bounded-block retrieval and global correspondence assembly. Coarse scores are
//! proposals only; all accepted positions still pass the acoustic verifier.
use super::*;
use kdj_core::composition::CompositionVideoSection;

#[derive(Clone, Default)]
pub struct RecordingMatch {
    pub offset_ms: Option<f64>,
    pub sections: Vec<CompositionVideoSection>,
    pub fuzzy: PositionSuggestions,
    /// Coherent forward-only short-version alternatives, always explicit review.
    pub short_review: Vec<Vec<FuzzyPlacement>>,
    pub reason: String,
}

// Deliberately non-generic: DSP must be code-generated in this optimized crate,
// not monomorphized in the debug/size-optimized server that supplies the callback.
pub fn compare_blocks(
    source: &AudioFeatures,
    reference: &AudioFeatures,
    allow_fuzzy: bool,
    segment_only: bool,
    canceled: &dyn Fn() -> bool,
) -> Result<RecordingMatch> {
    if !segment_only {
        let (result, sections) = align_sections_prepared(reference, source, &canceled)?;
        if result.matched {
            return Ok(RecordingMatch {
                offset_ms: Some(-result.offset_ms as f64),
                sections,
                ..Default::default()
            });
        }
    }
    let result = align_segment_prepared(source, reference, &canceled)?;
    let fuzzy = if !result.matched && allow_fuzzy {
        suggest_positions_prepared(source, reference, &canceled)?
    } else {
        PositionSuggestions::default()
    };
    Ok(RecordingMatch {
        offset_ms: result.matched.then_some(result.offset_ms as f64),
        fuzzy,
        reason: result.reason,
        ..Default::default()
    })
}

/// Search every reference block with small independent phrases, including both
/// edges. Chroma keeps speed/cover candidates eligible when loudness differs.
pub fn coarse_similarity(
    source: &AudioSummary,
    reference: &AudioSummary,
    allow_fuzzy: bool,
    canceled: &dyn Fn() -> bool,
) -> Result<f64> {
    let width = 160.min(source.envelope.len() / 3);
    if width < 36 || reference.envelope.len() < width {
        return Ok(-1.);
    }
    let search = EnvelopeSearch::new(&reference.envelope, width);
    let last = source.envelope.len() - width;
    let mut best = -1f64;
    for start in (0..=last).step_by(400).chain(std::iter::once(last)) {
        for (_, score) in search.scores(&source.envelope[start..start + width], width, &canceled)? {
            best = best.max(score);
        }
    }
    if allow_fuzzy && source.chroma.len() >= 120 && reference.chroma.len() >= 150 {
        for start in (0..=source.chroma.len() - 120).step_by(200) {
            if canceled() {
                bail!("匹配已取消")
            }
            for slope in [0.8, 0.9, 1., 1.1, 1.25] {
                for target in (0..reference.chroma.len() - 150).step_by(5) {
                    let score = (0..12)
                        .map(|i| {
                            let a = &source.chroma[start + i * 10];
                            let b = &reference.chroma[target + (i as f64 * 10. * slope) as usize];
                            a.iter()
                                .zip(b)
                                .map(|(a, b)| (*a as f64) * (*b as f64))
                                .sum::<f64>()
                        })
                        .sum::<f64>()
                        / 12.;
                    best = best.max(score);
                }
            }
        }
    }
    Ok(best)
}

/// Keep only source intervals whose independently verified reference mappings
/// agree. Overlapping storage blocks are duplicate evidence, not extra placements.
/// A repeated phrase at genuinely different set positions remains ambiguous.
pub fn unambiguous_spans(candidates: &[FuzzyPlacement]) -> Vec<FuzzyPlacement> {
    // Enforce uniqueness in both domains: neither repeated reference phrases nor
    // different video passages competing for one output interval can auto-win.
    let invert = |c: FuzzyPlacement| FuzzyPlacement {
        source_start_ms: c.reference_start_ms,
        source_end_ms: c.reference_start_ms + (c.source_end_ms - c.source_start_ms) / c.speed,
        reference_start_ms: c.source_start_ms,
        speed: 1. / c.speed,
        ..c
    };
    let reversed: Vec<_> = unique_source_spans(candidates)
        .into_iter()
        .map(invert)
        .collect();
    let mut result: Vec<_> = unique_source_spans(&reversed)
        .into_iter()
        .map(invert)
        .collect();
    result.sort_by(|a, b| a.source_start_ms.total_cmp(&b.source_start_ms));
    result
}

fn unique_source_spans(candidates: &[FuzzyPlacement]) -> Vec<FuzzyPlacement> {
    let mut edges: Vec<_> = candidates
        .iter()
        .flat_map(|c| [c.source_start_ms, c.source_end_ms])
        .collect();
    edges.sort_by(f64::total_cmp);
    edges.dedup_by(|a, b| (*a - *b).abs() < 0.01);
    let target_at =
        |c: &FuzzyPlacement, t: f64| c.reference_start_ms + (t - c.source_start_ms) / c.speed;
    let mut result: Vec<FuzzyPlacement> = vec![];
    for edge in edges.windows(2) {
        let (lo, hi) = (edge[0], edge[1]);
        let choices: Vec<_> = candidates
            .iter()
            .filter(|c| c.source_start_ms <= lo + 0.01 && c.source_end_ms >= hi - 0.01)
            .collect();
        let Some(best) = choices
            .iter()
            .max_by(|a, b| a.similarity.total_cmp(&b.similarity))
        else {
            continue;
        };
        if choices.iter().any(|other| {
            (target_at(best, lo) - target_at(other, lo)).abs() > 50.
                || (target_at(best, hi) - target_at(other, hi)).abs() > 50.
        }) {
            continue;
        }
        let piece = FuzzyPlacement {
            source_start_ms: lo,
            source_end_ms: hi,
            reference_start_ms: target_at(best, lo),
            ..(*best).clone()
        };
        if let Some(last) = result.last_mut() {
            if (last.source_end_ms - lo).abs() < 0.01
                && (last.speed - piece.speed).abs() < 0.0001
                && (target_at(last, hi) - target_at(&piece, hi)).abs() <= 50.
            {
                last.source_end_ms = hi;
                last.similarity = last.similarity.min(piece.similarity);
                continue;
            }
        }
        result.push(piece);
    }
    result.retain(|c| c.source_end_ms - c.source_start_ms >= 100.);
    result
}
