//! Bounded local verification of causal live features. Identity, temporal
//! ambiguity and tempo evidence stay separate from the output playback clock.
use super::*;

#[derive(Debug, Clone)]
pub struct LiveAlignment {
    pub offset_seconds: f64,
    pub rate: f64,
    pub matched: bool,
    pub supported: bool,
    pub score: f64,
    pub weakest_score: f64,
    pub runner_up: f64,
    pub retrieval_score: f64,
    pub reason: String,
}
#[derive(Clone, Copy)]
pub struct LiveHint {
    pub offset_seconds: f64,
    pub rate: f64,
}
#[derive(Clone, Copy)]
struct Proposal {
    offset: f64,
    rate: f64,
    scores: [f64; 3],
    support: f64,
}
impl Proposal {
    fn score(&self) -> f64 {
        self.scores.iter().sum::<f64>() / 3.
    }
    fn same_mapping(&self, other: &Self, frames: usize) -> bool {
        (self.offset - other.offset).abs() < 15.
            && (self.offset - other.offset + frames as f64 * (self.rate - other.rate)).abs() < 15.
    }
}
fn scores(
    query: &LiveFeatures,
    reference: &LiveFeatures,
    offset: f64,
    rate: f64,
    stride: usize,
) -> [f64; 3] {
    let guard = 2;
    let width = query.spectra.len().saturating_sub(guard * 2) / 3;
    if width < 4 {
        return [-1.; 3];
    }
    let evaluate = |pitch: f64| {
        let bands: [(usize, usize, f32); BANDS - 4] = std::array::from_fn(|i| {
            let b = (i as f64 + 3. - pitch).clamp(0., (BANDS - 1) as f64);
            let lo = b as usize;
            (lo, (lo + 1).min(BANDS - 1), (b - lo as f64) as f32)
        });
        std::array::from_fn(|window| {
            let start = guard + window * width;
            let end = start + width;
            if offset + start as f64 * rate < 0.
                || offset + end as f64 * rate + 1. >= reference.spectra.len() as f64
            {
                return -1.;
            }
            let (mut a, mut b, mut aa, mut bb, mut ab, mut n) = (0., 0., 0., 0., 0., 0.);
            for i in (start..end).step_by(stride) {
                let t = offset + i as f64 * rate;
                let lo = t as usize;
                let f = (t - lo as f64) as f32;
                for (j, &(low, high, bf)) in bands.iter().enumerate() {
                    let x = query.spectra[i][j + 3] as f64;
                    let left =
                        reference.spectra[lo][low] * (1. - bf) + reference.spectra[lo][high] * bf;
                    let right = reference.spectra[lo + 1][low] * (1. - bf)
                        + reference.spectra[lo + 1][high] * bf;
                    let y = (left * (1. - f) + right * f) as f64;
                    a += x;
                    b += y;
                    aa += x * x;
                    bb += y * y;
                    ab += x * y;
                    n += 1.;
                }
            }
            let denominator = ((aa - a * a / n).max(0.) * (bb - b * b / n).max(0.)).sqrt();
            if denominator < 1e-9 {
                0.
            } else {
                ((ab - a * b / n) / denominator).clamp(-1., 1.)
            }
        })
    };
    let locked: [f64; 3] = evaluate(0.);
    if (rate - 1.).abs() < 0.0001 {
        return locked;
    }
    let shifted: [f64; 3] = evaluate(rate.ln() / ((3800f64 / 60.).ln() / BANDS as f64));
    if shifted.iter().sum::<f64>() > locked.iter().sum::<f64>() {
        shifted
    } else {
        locked
    }
}
fn refine(
    query: &LiveFeatures,
    reference: &LiveFeatures,
    p: &mut Proposal,
    canceled: &dyn Fn() -> bool,
) -> Result<()> {
    p.scores = scores(query, reference, p.offset, p.rate, 2);
    let middle = query.spectra.len() as f64 / 2.;
    // A short-window retrieval vote has weak tempo resolution. Refine across
    // that uncertainty before narrowing; a ±0.8% hill climb can permanently
    // trap a correct location at the wrong (e.g. 1.07×) speed.
    for (dt, dr) in [
        (1., 0.04),
        (0.5, 0.02),
        (0.5, 0.01),
        (0.2, 0.004),
        (0.1, 0.001),
    ] {
        if canceled() {
            bail!("匹配已取消")
        }
        let base = *p;
        for r in -1..=1 {
            if dr == 0. && r != 0 {
                continue;
            }
            let rate = base.rate + r as f64 * dr;
            if !(0.80..=1.25).contains(&rate) {
                continue;
            }
            for t in -1..=1 {
                let offset = base.offset + (base.rate - rate) * middle + t as f64 * dt;
                let next = Proposal {
                    offset,
                    rate,
                    scores: scores(query, reference, offset, rate, 2),
                    support: base.support,
                };
                if next.score() > p.score() {
                    *p = next;
                }
            }
        }
    }
    Ok(())
}
fn result(query: &LiveFeatures, mut proposals: Vec<Proposal>) -> LiveAlignment {
    proposals.sort_by(|a, b| b.score().total_cmp(&a.score()));
    let mut value = LiveAlignment {
        offset_seconds: 0.,
        rate: 1.,
        matched: false,
        supported: false,
        score: 0.,
        weakest_score: 0.,
        runner_up: 0.,
        retrieval_score: 0.,
        reason: "有效音频或重叠不足".into(),
    };
    let Some(best) = proposals.first() else {
        return value;
    };
    value.offset_seconds = best.offset / 100.;
    value.rate = best.rate;
    value.score = best.score();
    value.retrieval_score = best.support;
    value.weakest_score = best.scores.iter().copied().fold(1., f64::min);
    value.runner_up = proposals
        .iter()
        .skip(1)
        .find(|p| !p.same_mapping(best, query.spectra.len()))
        .map_or(0., Proposal::score);
    value.matched =
        value.score >= 0.72 && value.weakest_score >= 0.60 && value.score - value.runner_up >= 0.10;
    value.supported = best.support >= 0.65
        && value.score >= 0.62
        && value.weakest_score >= 0.50
        && value.score - value.runner_up >= 0.14;
    value.reason = if value.matched {
        "声学校验通过"
    } else if value.supported {
        "短切片证据待连续确认"
    } else if value.score - value.runner_up < 0.10 {
        "存在相似位置"
    } else {
        "音轨相似度不足"
    }
    .into();
    value
}
pub fn verify_live_prepared(
    query: &LiveFeatures,
    reference: &LiveFeatures,
    seeds: &[LiveSeed],
    canceled: &dyn Fn() -> bool,
) -> Result<LiveAlignment> {
    anyhow::ensure!(query.duration_ms() <= 3000., "实时查询超过 3 秒上限");
    if query.duration_ms() < 350. || reference.spectra.len() < 40 {
        return Ok(result(query, vec![]));
    }
    let mut proposals = Vec::new();
    for seed in seeds {
        if canceled() {
            bail!("匹配已取消")
        }
        let mut best = Proposal {
            offset: seed.offset_seconds * 100.,
            rate: seed.rate,
            scores: [-1.; 3],
            support: seed.retrieval_score,
        };
        for delta in -6..=6 {
            let offset = seed.offset_seconds * 100. + delta as f64;
            let p = Proposal {
                offset,
                rate: seed.rate,
                scores: scores(query, reference, offset, seed.rate, 4),
                support: seed.retrieval_score,
            };
            if p.score() > best.score() {
                best = p;
            }
        }
        proposals.push(best);
    }
    proposals.sort_by(|a, b| b.score().total_cmp(&a.score()));
    let mut distinct: Vec<Proposal> = Vec::new();
    for p in proposals {
        if distinct
            .iter()
            .any(|old| old.same_mapping(&p, query.spectra.len()))
        {
            continue;
        }
        distinct.push(p);
        if distinct.len() == 6 {
            break;
        }
    }
    for p in &mut distinct {
        refine(query, reference, p, canceled)?;
    }
    Ok(result(query, distinct))
}
pub fn track_live_prepared(
    query: &LiveFeatures,
    reference: &LiveFeatures,
    hint: LiveHint,
    canceled: &dyn Fn() -> bool,
) -> Result<LiveAlignment> {
    let seeds: Vec<_> = [-0.06, 0., 0.06]
        .into_iter()
        .flat_map(|dt| {
            [-0.01, 0., 0.01].into_iter().map(move |dr| LiveSeed {
                target: 0,
                offset_seconds: hint.offset_seconds + dt,
                rate: (hint.rate + dr).clamp(0.80, 1.25),
                retrieval_score: 0.,
            })
        })
        .collect();
    let mut matched = verify_live_prepared(query, reference, &seeds, canceled)?;
    for dt in [-3.2, -1.6, -0.8, -0.4, 0.4, 0.8, 1.6, 3.2] {
        let rival = scores(
            query,
            reference,
            (matched.offset_seconds + dt) * 100.,
            matched.rate,
            2,
        )
        .iter()
        .sum::<f64>()
            / 3.;
        matched.runner_up = matched.runner_up.max(rival);
    }
    if matched.score - matched.runner_up < 0.10 {
        matched.matched = false;
        matched.supported = false;
        matched.reason = "局部跟踪有相似位置，重新检索".into();
    }
    if matched.score >= 0.66
        && matched.weakest_score >= 0.54
        && matched.score - matched.runner_up >= 0.14
    {
        matched.supported = true;
    }
    Ok(matched)
}
