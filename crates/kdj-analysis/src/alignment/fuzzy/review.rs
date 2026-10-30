//! Cover/remix alternatives: sustained tonal correspondence with weaker, but
//! independently localized, spectral evidence. Never feed these into cut assembly.
use super::*;

pub(super) fn collect_anchor(
    anchors: &mut Vec<Anchor>,
    anchor: Anchor,
    chroma_score: f64,
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
) {
    // A new singer can change the spectral detail substantially. Still require
    // some acoustic evidence at a distinct time, not just the same key or beat.
    if anchor.score < 0.18 {
        return;
    }
    let alternative = [-200., -100., -50., -25., 25., 50., 100., 200.]
        .into_iter()
        .map(|delta| mapped_score(a, b, (anchor.source / 10.).round() as usize,
            anchor.target / 10. + delta, anchor.slope, 800))
        .fold(-1., f64::max);
    if anchor.score - alternative >= 0.04 {
        anchors.push(Anchor { score: chroma_score, ..anchor });
    }
}

pub(super) fn suggestions(anchors: &[Anchor], verified: &[FuzzyPlacement]) -> Vec<FuzzyPlacement> {
    // Three non-overlapping eight-second anchors spanning >=28 seconds establish
    // a reviewable mapping. Strict acceptance still requires four AND verify_span.
    let mut candidates = fit_groups_with_minimum(anchors, 3);
    candidates.retain(|c| c.similarity >= 0.42);
    let at = |c: &FuzzyPlacement, source: f64| {
        c.reference_start_ms + (source - c.source_start_ms) / c.speed
    };
    let same_mapping = |a: &FuzzyPlacement, b: &FuzzyPlacement| {
        let lo = a.source_start_ms.min(b.source_start_ms);
        let hi = a.source_end_ms.max(b.source_end_ms);
        (at(a, lo) - at(b, lo)).abs() <= 200.
            && (at(a, hi) - at(b, hi)).abs() <= 200.
    };
    let strength = |c: &FuzzyPlacement| {
        c.similarity * ((c.source_end_ms - c.source_start_ms) / 1000.).sqrt()
    };
    candidates.sort_by(|a, b| strength(b).total_cmp(&strength(a))
        .then_with(|| a.reference_start_ms.total_cmp(&b.reference_start_ms)));
    let mut result = Vec::new();
    for candidate in candidates {
        if verified.iter().chain(&result).any(|old| same_mapping(old, &candidate)) {
            continue;
        }
        result.push(candidate);
        // Distinct repeated hooks remain alternatives; nearby fits of the same
        // mapping collapse. Bounded output does not lower automatic acceptance.
        if result.len() == 3 {
            break;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchors(offset: f64, score: f64) -> Vec<Anchor> {
        (0..4).map(|i| Anchor {
            source: i as f64 * 10000., target: i as f64 * 10000. + offset,
            slope: 1., score,
        }).collect()
    }

    #[test]
    fn three_stable_phrases_can_be_reviewed_without_weakening_strict_groups() {
        let a = anchors(48850., 0.54);
        assert!(fit_groups(&a[..3]).is_empty());
        let result = suggestions(&a[..3], &[]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].reference_start_ms, 48850.);
        assert_eq!(result[0].source_end_ms, 28000.);
        assert_eq!(result[0].speed, 1.);
        assert!(suggestions(&a[..2], &[]).is_empty());
        assert!(suggestions(&anchors(48850., 0.40), &[]).is_empty());
        let mut inconsistent = a.clone();
        inconsistent[1].target += 1000.;
        assert!(suggestions(&inconsistent, &[]).is_empty());
    }

    #[test]
    fn distinct_alternatives_are_ranked_bounded_and_not_assembled_as_cuts() {
        let mut a = Vec::new();
        for offset in [48850., 48880., 108850., 168850., 228850.] {
            a.extend(anchors(offset, 0.54));
        }
        let result = suggestions(&a, &[]);
        assert_eq!(result.len(), 3);
        assert!(result.windows(2).all(|c|
            c[1].reference_start_ms - c[0].reference_start_ms > 50000.));
        assert!(result.iter().all(|c| c.source_start_ms == 0. && c.source_end_ms == 38000.));
        let filtered = suggestions(&a, &result[..1]);
        assert_eq!(filtered.len(), 3);
        assert!(filtered.iter().all(|c| (c.reference_start_ms - result[0].reference_start_ms).abs() > 200.));
    }

    #[test]
    fn spectral_peak_must_be_distinct_even_for_strong_tonal_similarity() {
        let mut seed = 91u32;
        let mut random = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let a: Vec<[f32; BANDS]> = (0..1200)
            .map(|_| std::array::from_fn(|_| random())).collect();
        let b: Vec<[f32; BANDS]> = a.iter().map(|frame|
            std::array::from_fn(|band| 0.25 * frame[band] + (1f32 - 0.25 * 0.25).sqrt() * random())
        ).collect();
        let anchor = Anchor { source: 0., target: 0., slope: 1., score: mapped_score(&a, &b, 0, 0., 1., 800) };
        let mut collected = vec![];
        collect_anchor(&mut collected, anchor, 0.54, &a, &b);
        assert_eq!(collected.len(), 1, "different timbres still supply weak evidence: {anchor:?}");
        collect_anchor(&mut collected, Anchor { score: 0.10, ..anchor }, 0.9, &a, &b);
        assert_eq!(collected.len(), 1);
        let periodic: Vec<_> = (0..1200).map(|i| a[i % 25]).collect();
        collect_anchor(&mut collected, Anchor { score: 1., ..anchor }, 0.9, &periodic, &periodic);
        assert_eq!(collected.len(), 1, "a repeated beat is not a localized phrase");
    }
}
