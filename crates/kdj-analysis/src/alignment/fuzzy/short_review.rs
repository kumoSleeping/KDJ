//! A short edit may jump forward into a later chorus. Preserve the established
//! prefix and localize the change to a separately supported tail. This remains
//! a review plan, not stronger acoustic evidence or permission to auto-place.
use super::*;

/// Both mappings use the same reference block's clock. The prefix may begin
/// outside that block; its seam and the candidate tail must be inside it.
pub fn short_review_pair(
    source: &AudioFeatures,
    reference: &AudioFeatures,
    before: &FuzzyPlacement,
    after: &FuzzyPlacement,
    canceled: &dyn Fn() -> bool,
) -> Result<Option<Vec<FuzzyPlacement>>> {
    let at = |m: &FuzzyPlacement, s: f64| m.reference_start_ms + (s - m.source_start_ms) / m.speed;
    if before.source_end_ms - before.source_start_ms < 32_000.
        || after.anchors < 3
        || after.source_start_ms > before.source_end_ms
        || after.source_end_ms - before.source_end_ms < 8_000.
        || (before.speed - after.speed).abs() > 0.015
        || at(after, before.source_end_ms) - at(before, before.source_end_ms) < 1000.
    {
        return Ok(None);
    }
    let a = &source.spectra;
    let b = &reference.spectra;
    let score = |m: &FuzzyPlacement, frame: usize, count: usize, delta: f64| {
        mapped_score(
            a,
            b,
            frame,
            at(m, frame as f64 * 10.) / 10. + delta,
            1. / m.speed,
            count,
        )
    };
    // Review anchors often overlap the already matched chorus. Only evidence
    // in the NEW tail can justify extending a short-version plan.
    let tail_lo = (before.source_end_ms / 10.).ceil() as usize;
    let tail_hi = (after.source_end_ms / 10.).floor() as usize;
    let mut supported = 0;
    let mut windows = 0;
    for frame in (tail_lo..=tail_hi.saturating_sub(400)).step_by(400) {
        if canceled() {
            bail!("匹配已取消")
        }
        let value = score(after, frame, 400, 0.);
        let alternative = [-200., -100., -50., -25., 25., 50., 100., 200.]
            .into_iter()
            .map(|delta| score(after, frame, 400, delta))
            .fold(-1., f64::max);
        windows += 1;
        if value >= 0.18 && value - alternative >= 0.04 {
            supported += 1;
        }
    }
    if supported < 3 || supported * 3 < windows * 2 {
        return Ok(None);
    }
    // Refine the seam rather than cutting on the two-second verification grid.
    // Half-second windows are centered on each 100ms position; require sustained
    // evidence on BOTH sides so a single drum hit cannot move the cut.
    let lo = (before.source_end_ms - 4000.)
        .max(before.source_start_ms + 8000.)
        .max(after.source_start_ms);
    let hi = (before.source_end_ms + 4000.).min(after.source_end_ms - 8000.);
    let first = (lo / 100.).ceil() as usize * 10;
    let last = (hi / 100.).floor() as usize * 10;
    if last <= first + 200 {
        return Ok(None);
    }
    let mut scores = Vec::new();
    for frame in (first..=last).step_by(10) {
        if canceled() {
            bail!("匹配已取消")
        }
        let center = frame.saturating_sub(25);
        scores.push((
            frame,
            score(before, center, 50, 0.),
            score(after, center, 50, 0.),
        ));
    }
    let mut best: Option<(f64, usize)> = None;
    for cut in 10..scores.len().saturating_sub(10) {
        let left = &scores[cut - 10..cut];
        let right = &scores[cut..cut + 10];
        let mean = |v: &[(usize, f64, f64)], old: bool| {
            v.iter().map(|s| if old { s.1 } else { s.2 }).sum::<f64>() / v.len() as f64
        };
        let old = mean(left, true);
        let new = mean(right, false);
        // Prefix uniqueness already comes from its sustained verified mapping.
        // Repeated choruses can also resemble that prefix: do not demand that
        // its last second independently disambiguate the entire song again.
        // The tail must overtake the old mapping only AFTER the seam.
        if old < 0.30
            || new < 0.18
            || old < mean(left, false)
            || new - mean(right, true) < 0.08
        {
            continue;
        }
        let value = scores[..cut].iter().map(|s| s.1).sum::<f64>()
            + scores[cut..].iter().map(|s| s.2).sum::<f64>();
        if best.is_none_or(|(previous, _)| value > previous) {
            best = Some((value, scores[cut].0));
        }
    }
    let Some((_, seam)) = best else {
        return Ok(None);
    };
    let seam = seam as f64 * 10.;
    let mut prefix = before.clone();
    prefix.source_end_ms = seam;
    let mut tail = after.clone();
    tail.reference_start_ms = at(after, seam);
    tail.source_start_ms = seam;
    Ok(Some(vec![prefix, tail]))
}
