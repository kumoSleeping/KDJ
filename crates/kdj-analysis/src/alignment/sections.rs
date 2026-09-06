use super::*;
use kdj_core::composition::CompositionVideoSection;

const WIDTH: usize = 800;
const STEP: usize = 400;
#[derive(Clone, Copy, Debug)]
struct Hit {
    start: usize,
    lag: i32,
    score: f64,
}

/// First establish a long common recording, then find forward-only cuts. Each piece
/// of video appears at most once; missing song sections are not filled with repeats.
pub fn align_sections(
    audio: &[f32],
    video: &[f32],
    canceled: impl Fn() -> bool,
) -> Result<(Alignment, Vec<CompositionVideoSection>)> {
    let alignment = align(audio, video, &canceled)?;
    if !alignment.matched
        || audio.len() < video.len().saturating_add(SAMPLE_RATE * 10)
        || (audio.len() as f64) < video.len() as f64 * 1.2
    {
        return Ok((alignment, Vec::new()));
    }
    let (a, b) = (spectra(audio, &canceled)?, spectra(video, &canceled)?);
    let (ea, eb) = (envelope(audio), envelope(video));
    let mut rows = Vec::new();
    let mut offsets = vec![(-alignment.offset_ms / 10) as i32];
    for start in (0..=b.len().saturating_sub(WIDTH)).step_by(STEP) {
        if canceled() {
            bail!("校准已取消");
        }
        let mut coarse = Vec::new();
        for target in 0..ea.len().saturating_sub(WIDTH / 5) {
            let score = ncc(
                eb[start / 5..start / 5 + WIDTH / 5].iter().copied(),
                ea[target..target + WIDTH / 5].iter().copied(),
            );
            coarse.push((target as i32 * 5 - start as i32, score));
        }
        coarse.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut candidates: Vec<i32> = Vec::new();
        for (lag, _) in coarse {
            if candidates.iter().all(|old| (*old - lag).abs() >= 50) {
                candidates.push(lag);
            }
            if candidates.len() == 5 {
                break;
            }
        }
        candidates.push((-alignment.offset_ms / 10) as i32);
        let mut hits = Vec::new();
        for lag in candidates {
            if let Some(hit) = verify(&a, &b, start, lag, 10) {
                if hit.score >= 0.55 && offsets.iter().all(|old| (*old - hit.lag).abs() > 5) {
                    offsets.push(hit.lag);
                }
                hits.push(hit);
            }
        }
        rows.push((start, hits));
    }
    // A weak intro can inherit an offset corroborated by its later vocal phrase.
    for (start, hits) in &mut rows {
        for &lag in &offsets {
            if let Some(hit) = verify(&a, &b, *start, lag, 3) {
                hits.push(hit);
            }
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut unique: Vec<Hit> = Vec::new();
        for hit in hits.iter().copied().filter(|h| h.score >= 0.35) {
            if unique.iter().all(|old| (old.lag - hit.lag).abs() > 5) {
                unique.push(hit);
            }
            if unique.len() == 6 {
                break;
            }
        }
        *hits = unique;
    }
    #[derive(Clone)]
    struct Path {
        value: f64,
        lag: Option<i32>,
        hits: Vec<Option<Hit>>,
    }
    let mut paths = vec![Path {
        value: 0.,
        lag: None,
        hits: Vec::new(),
    }];
    for (_, hits) in &rows {
        if canceled() {
            bail!("校准已取消");
        }
        let mut next = Vec::new();
        for path in &paths {
            let mut skip = path.clone();
            skip.value -= 0.05;
            skip.hits.push(None);
            next.push(skip);
            for &hit in hits {
                let jump = path.lag.map_or(0, |old| hit.lag - old);
                if jump < -5 || (jump > 5 && jump < 25) {
                    continue;
                }
                let mut choice = path.clone();
                choice.value += hit.score - 0.3 - if jump > 5 { 0.35 } else { 0. };
                if path.lag.is_none() {
                    choice.value -= hit.lag.max(0) as f64 * 0.00001;
                }
                choice.lag = Some(hit.lag);
                choice.hits.push(Some(hit));
                next.push(choice);
            }
        }
        next.sort_by(|a, b| b.value.total_cmp(&a.value));
        paths.clear();
        for path in next {
            if paths.iter().all(|old| match (old.lag, path.lag) {
                (Some(a), Some(b)) => (a - b).abs() > 5,
                (None, None) => false,
                _ => true,
            }) {
                paths.push(path);
            }
            if paths.len() == 12 {
                break;
            }
        }
    }
    let Some(path) = paths.first() else {
        return Ok((alignment, Vec::new()));
    };
    let mut groups: Vec<Vec<Hit>> = Vec::new();
    let mut separated = true;
    for hit in &path.hits {
        let Some(hit) = hit else {
            separated = true;
            continue;
        };
        if !separated
            && groups
                .last()
                .is_some_and(|g| (g[0].lag - hit.lag).abs() <= 5)
        {
            groups.last_mut().unwrap().push(*hit);
        } else {
            groups.push(vec![*hit]);
        }
        separated = false;
    }
    groups.retain(|group| group.len() >= 2);
    let mut sections: Vec<CompositionVideoSection> = Vec::new();
    for group in groups {
        let mut lags: Vec<_> = group.iter().map(|h| h.lag).collect();
        lags.sort();
        let lag = lags[lags.len() / 2];
        let mut start = group[0].start;
        let last = group.last().unwrap().start;
        let end = if last + WIDTH + STEP >= b.len() {
            video.len() / HOP
        } else {
            last + WIDTH
        };
        if let Some(previous) = sections.last_mut() {
            let previous_end = (previous.video_start_ms + previous.duration_ms) / 10;
            if previous_end > start as i64 {
                let old_lag = ((previous.audio_start_ms - previous.video_start_ms) / 10) as i32;
                start = cut_point(&a, &b, start, previous_end as usize, old_lag, lag);
                previous.duration_ms = start as i64 * 10 - previous.video_start_ms;
            }
        }
        let start = (start as i64).max(-(lag as i64));
        let end = (end as i64).min(audio.len() as i64 / HOP as i64 - lag as i64);
        if end > start {
            sections.push(CompositionVideoSection {
                video_start_ms: start * 10,
                audio_start_ms: (start + lag as i64) * 10,
                duration_ms: (end - start) * 10,
            });
        }
    }
    sections.retain(|s| s.duration_ms > 0);
    if sections.len() > 128 {
        return Ok((alignment, Vec::new()));
    }
    Ok((alignment, sections))
}

fn verify(
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
    start: usize,
    lag: i32,
    radius: i32,
) -> Option<Hit> {
    let mut best = Hit {
        start,
        lag,
        score: -1.,
    };
    for fine in lag - radius..=lag + radius {
        let target = start as i64 + fine as i64;
        if target < 0 {
            continue;
        }
        let score = spectral_score(b, a, start, target as usize, WIDTH);
        if score > best.score {
            best = Hit {
                start,
                lag: fine,
                score,
            };
        }
    }
    (best.score >= 0.).then_some(best)
}

fn cut_point(
    a: &[[f32; BANDS]],
    b: &[[f32; BANDS]],
    lo: usize,
    hi: usize,
    old: i32,
    new: i32,
) -> usize {
    let (mut sum, mut best, mut cut) = (0., 0., lo);
    for frame in lo..hi.min(b.len()) {
        let similarity = |lag: i32| {
            let index = frame as i64 + lag as i64;
            if index < 0 || index >= a.len() as i64 {
                return 0.;
            }
            let (mut dot, mut aa, mut bb) = (0f64, 0f64, 0f64);
            for (&x, &y) in a[index as usize].iter().zip(&b[frame]) {
                dot += x as f64 * y as f64;
                aa += (x as f64).powi(2);
                bb += (y as f64).powi(2);
            }
            dot / (aa * bb).sqrt().max(1e-9)
        };
        sum += similarity(old) - similarity(new);
        if sum > best {
            best = sum;
            cut = frame + 1;
        }
    }
    cut
}
