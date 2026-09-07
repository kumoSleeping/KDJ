//! Conservative fixed-offset acoustic matching, not semantic song/lyric recognition.
//! A loudness envelope proposes lags; temporally whitened spectra verify independent
//! beginning/middle/end windows. Short versions use their longest stable shared section
//! to place the whole video once; ordinary full-length matching still rejects ambiguity.
use anyhow::{bail, Result};
use rustfft::{num_complex::Complex32, FftPlanner};
mod sections;
pub use sections::align_sections;
mod fuzzy;
pub use fuzzy::{suggest_constant_speed, suggest_positions, FuzzyPlacement, PositionSuggestions};

pub const SAMPLE_RATE: usize = 8000;
const HOP: usize = 80;
const FFT: usize = 256;
const BANDS: usize = 16;
const WINDOW: usize = 1000; // ten seconds at 100 Hz

#[derive(Debug, Clone)]
pub struct Alignment {
    pub offset_ms: i64,
    pub matched: bool,
    pub reason: String,
}

fn ncc(a: impl Iterator<Item = f32>, b: impl Iterator<Item = f32>) -> f64 {
    let (mut n, mut sa, mut sb, mut aa, mut bb, mut ab) = (0., 0., 0., 0., 0., 0.);
    for (a, b) in a.zip(b) {
        let (a, b) = (a as f64, b as f64);
        n += 1.;
        sa += a;
        sb += b;
        aa += a * a;
        bb += b * b;
        ab += a * b;
    }
    if n < 2. {
        return 0.;
    }
    let denominator = ((aa - sa * sa / n).max(0.) * (bb - sb * sb / n).max(0.)).sqrt();
    if denominator < 1e-9 {
        0.
    } else {
        ((ab - sa * sb / n) / denominator).clamp(-1., 1.)
    }
}

fn envelope(pcm: &[f32]) -> Vec<f32> {
    pcm.chunks_exact(400)
        .map(|chunk| {
            let rms = (chunk.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / 400.).sqrt();
            (rms.max(1e-7).ln()) as f32
        })
        .collect()
}

fn spectra(pcm: &[f32], canceled: &impl Fn() -> bool) -> Result<Vec<[f32; BANDS]>> {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT);
    let mut buffer = vec![Complex32::default(); FFT];
    let mut scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
    let hann: Vec<f32> = (0..FFT)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT as f32).cos())
        .collect();
    let bins: Vec<usize> = (0..=BANDS)
        .map(|i| {
            (60f64 * (3800f64 / 60.).powf(i as f64 / BANDS as f64) * FFT as f64
                / SAMPLE_RATE as f64)
                .round() as usize
        })
        .collect();
    let mut raw = Vec::with_capacity(pcm.len() / HOP);
    for start in (0..pcm.len().saturating_sub(FFT)).step_by(HOP) {
        if start % (HOP * 100) == 0 && canceled() {
            bail!("校准已取消");
        }
        for i in 0..FFT {
            buffer[i] = Complex32::new(pcm[start + i] * hann[i], 0.);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        let mut bands = [0.; BANDS];
        for i in 0..BANDS {
            let lo = bins[i].max(1);
            let hi = bins[i + 1].max(lo + 1).min(FFT / 2);
            let power = buffer[lo..hi].iter().map(|x| x.norm_sqr()).sum::<f32>() / (hi - lo) as f32;
            bands[i] = power.max(1e-10).ln();
        }
        raw.push(bands);
    }
    // Remove slowly changing timbre/EQ and gain. Comparing changes rather than the average
    // spectral colour prevents two unrelated tracks in the same key from looking identical.
    let mut result = vec![[0.; BANDS]; raw.len()];
    for band in 0..BANDS {
        let mut sums = vec![0f64; raw.len() + 1];
        for (i, frame) in raw.iter().enumerate() {
            sums[i + 1] = sums[i] + frame[band] as f64;
        }
        for (i, frame) in raw.iter().enumerate() {
            let lo = i.saturating_sub(50);
            let hi = (i + 51).min(raw.len());
            result[i][band] = frame[band] - ((sums[hi] - sums[lo]) / (hi - lo) as f64) as f32;
        }
    }
    Ok(result)
}

fn overlap(a: usize, b: usize, lag: i32) -> (usize, usize, usize) {
    let x = (-lag).max(0) as usize;
    let y = lag.max(0) as usize;
    (x, y, a.saturating_sub(x).min(b.saturating_sub(y)))
}

fn spectral_score(a: &[[f32; BANDS]], b: &[[f32; BANDS]], x: usize, y: usize, count: usize) -> f64 {
    if x + count > a.len() || y + count > b.len() {
        return -1.;
    }
    ncc(
        a[x..x + count].iter().flat_map(|x| x.iter().copied()),
        b[y..y + count].iter().flat_map(|x| x.iter().copied()),
    )
}

pub fn align(audio: &[f32], video_audio: &[f32], canceled: impl Fn() -> bool) -> Result<Alignment> {
    align_inner(audio, video_audio, canceled, false)
}

/// A dragged overlay may be a short chorus anywhere in the main video, not just its intro.
pub fn align_segment(
    audio: &[f32],
    video_audio: &[f32],
    canceled: impl Fn() -> bool,
) -> Result<Alignment> {
    align_inner(audio, video_audio, canceled, true)
}

fn align_inner(
    audio: &[f32],
    video_audio: &[f32],
    canceled: impl Fn() -> bool,
    segment: bool,
) -> Result<Alignment> {
    let review = |offset_ms, reason: &str| Alignment {
        offset_ms,
        matched: false,
        reason: reason.into(),
    };
    let minimum = if segment { 6 } else { 30 };
    if audio.len().min(video_audio.len()) < SAMPLE_RATE * minimum {
        return Ok(review(
            0,
            if segment {
                "叠加片段不足 6 秒，请手动定位"
            } else {
                "可用于自动校准的内容不足 30 秒"
            },
        ));
    }
    let window = if segment {
        (audio.len().min(video_audio.len()) / HOP / 3)
            .saturating_sub(20)
            .clamp(180, WINDOW)
    } else {
        WINDOW
    };
    if audio.iter().chain(video_audio).any(|v| !v.is_finite()) {
        bail!("音频解码包含无效采样");
    }
    let short_version = !segment
        && audio.len() >= video_audio.len().saturating_add(SAMPLE_RATE * 10)
        && audio.len() as f64 >= video_audio.len() as f64 * 1.2;
    let (ea, eb) = (envelope(audio), envelope(video_audio));
    let mut coarse = Vec::new();
    let range = if segment || short_version {
        -(ea.len() as i32)..=eb.len() as i32
    } else {
        -3600..=3600
    };
    for lag in range {
        if lag % 100 == 0 && canceled() {
            bail!("校准已取消");
        }
        let (x, y, count) = overlap(ea.len(), eb.len(), lag);
        if count < (window * 3 + 20) / 5 {
            continue;
        }
        let count = count.min(2400);
        let score = ncc(
            ea[x..x + count].iter().copied(),
            eb[y..y + count].iter().copied(),
        );
        coarse.push((lag, score));
    }
    coarse.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut candidates: Vec<(i32, f64)> = Vec::new();
    for candidate in coarse {
        if candidates
            .iter()
            .all(|old| (old.0 - candidate.0).abs() >= 10)
        {
            candidates.push(candidate);
        }
        if candidates.len() == 8 {
            break;
        }
    }
    if short_version {
        // A TV edit's removed bars can dominate the whole-overlap envelope score.
        // Propose offsets from independent local windows too; the same long-run
        // spectral verification below still decides whether any candidate is safe.
        let width = 160; // eight seconds, envelope sampled at 20 Hz
        for fraction in [1, 4, 7] {
            let y = eb.len().saturating_sub(width) * fraction / 10;
            if y + width > eb.len() || ea.len() < width {
                continue;
            }
            let mut local = (0..=ea.len() - width)
                .map(|x| {
                    (
                        (y as i32 - x as i32),
                        ncc(
                            ea[x..x + width].iter().copied(),
                            eb[y..y + width].iter().copied(),
                        ),
                    )
                })
                .collect::<Vec<_>>();
            if canceled() {
                bail!("校准已取消");
            }
            local.sort_by(|a, b| b.1.total_cmp(&a.1));
            let mut added = 0;
            for candidate in local {
                if candidates
                    .iter()
                    .all(|old| (old.0 - candidate.0).abs() >= 10)
                {
                    candidates.push(candidate);
                    added += 1;
                }
                if added == 3 {
                    break;
                }
            }
        }
    }
    let (a, b) = (spectra(audio, &canceled)?, spectra(video_audio, &canceled)?);
    let mut verified = Vec::new();
    for (coarse_lag, _) in candidates {
        let lag = coarse_lag * 5;
        let (x, _, count) = overlap(a.len(), b.len(), lag);
        if count < window * 3 + 20 {
            continue;
        }
        let starts: Vec<_> = if short_version {
            (x + 10..=x + count - window - 10).step_by(500).collect()
        } else {
            vec![x + 10, x + (count - window) / 2, x + count - window - 10]
        };
        let mut windows = Vec::new();
        for start in starts {
            if canceled() {
                bail!("校准已取消");
            }
            let mut best = (lag, -1f64);
            for fine in lag - 10..=lag + 10 {
                let y = start as i64 + fine as i64;
                if y < 0 {
                    continue;
                }
                let score = spectral_score(&a, &b, start, y as usize, window);
                if score > best.1 {
                    best = (fine, score);
                }
            }
            windows.push(best);
        }
        let score = windows.iter().map(|w| w.1).sum::<f64>() / windows.len() as f64;
        verified.push((score, windows));
    }
    if short_version {
        // A short/TV version may edit its intro while preserving a long section of the
        // recording. Pick one placement by shared duration, then acoustic quality. The
        // caller keeps the full song and pads outside this single video with black.
        let best = verified
            .iter()
            .filter_map(|(_, windows)| longest_shared_section(windows))
            .max_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));
        if let Some((_, _, offset_ms)) = best {
            return Ok(Alignment {
                offset_ms,
                matched: true,
                reason: String::new(),
            });
        }
        let offset = verified
            .iter()
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .and_then(|(_, windows)| windows.iter().max_by(|a, b| a.1.total_cmp(&b.1)))
            .map_or(0, |(lag, _)| *lag as i64 * 10);
        return Ok(review(offset, "未找到足够长且稳定的共同片段，请试听确认"));
    }
    verified.sort_by(|a, b| b.0.total_cmp(&a.0));
    let Some((score, windows)) = verified.first() else {
        return Ok(review(0, "有效重叠不足，需手动校准"));
    };
    let mut lags: Vec<_> = windows.iter().map(|w| w.0).collect();
    lags.sort();
    let offset = lags[1] as i64 * 10;
    if *score < 0.62 || windows.iter().any(|w| w.1 < 0.50) {
        // A TV edit can share the main recording but cut a few bars from its intro.
        // Preserve the consistent, verified placement and explain the unmatched region;
        // this still requires review because one offset cannot repair local edits.
        let mut shared: Vec<_> = windows
            .iter()
            .filter(|w| w.1 >= 0.62)
            .map(|w| w.0)
            .collect();
        shared.sort();
        if shared.len() >= 2 && shared[shared.len() - 1] - shared[0] <= 5 {
            let regions: Vec<_> = windows
                .iter()
                .zip(["开头", "中段", "结尾"])
                .filter_map(|(window, label)| (window.1 < 0.62).then_some(label))
                .collect();
            return Ok(review(
                shared[shared.len() / 2] as i64 * 10,
                &format!(
                    "检测到共同音频，但重叠区间的{}未对齐；可能存在剪辑或内容差异，请试听确认",
                    regions.join("、")
                ),
            ));
        }
        return Ok(review(offset, "音轨相似度不足，需确认配对"));
    }
    if lags[2] - lags[0] > 5 {
        return Ok(review(
            offset,
            "前后对齐位置漂移，无法用单一 Offset 可靠校准",
        ));
    }
    if verified.get(1).is_some_and(|next| score - next.0 < 0.08) {
        return Ok(review(offset, "存在多个相似片段，需确认对齐位置"));
    }
    Ok(Alignment {
        offset_ms: offset,
        matched: true,
        reason: String::new(),
    })
}

/// Windows start five seconds apart. A run must cover at least thirty seconds and
/// stay within 50 ms across its length; isolated similar chords or speed drift fail.
fn longest_shared_section(windows: &[(i32, f64)]) -> Option<(usize, f64, i64)> {
    let mut best: Option<(usize, f64, i64)> = None;
    for start in 0..windows.len() {
        let (mut low, mut high) = (windows[start].0, windows[start].0);
        let mut lags = Vec::new();
        let mut score = 0.;
        for &(lag, similarity) in &windows[start..] {
            low = low.min(lag);
            high = high.max(lag);
            if similarity < 0.62 || high - low > 5 {
                break;
            }
            lags.push(lag);
            score += similarity;
        }
        let covered = WINDOW + lags.len().saturating_sub(1) * 500;
        if covered < 3000 {
            continue;
        }
        lags.sort();
        let candidate = (
            covered,
            score / lags.len() as f64,
            lags[lags.len() / 2] as i64 * 10,
        );
        if best
            .as_ref()
            .is_none_or(|old| candidate.0 > old.0 || (candidate.0 == old.0 && candidate.1 > old.1))
        {
            best = Some(candidate);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(seconds: usize) -> Vec<f32> {
        let mut seed = 17u32;
        (0..seconds * SAMPLE_RATE)
            .map(|i| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let t = i as f32 / SAMPLE_RATE as f32;
                let frequency = 180. + 140. * (t * 0.71).sin() + 65. * (t * t * 0.19).sin();
                let envelope = 0.2 + 0.15 * (t * 3.7 + (t * 0.13).sin() * 4.).sin();
                envelope * (std::f32::consts::TAU * frequency * t).sin()
                    + (seed as f32 / u32::MAX as f32 - 0.5) * 0.01
            })
            .collect()
    }
    #[test]
    fn acoustic_alignment_handles_gain_and_signed_offsets() {
        let original = sample(40);
        let mut delayed = vec![0.; 123 * SAMPLE_RATE / 100];
        delayed.extend(original.iter().map(|x| x * 0.43));
        let result = align(&original, &delayed, || false).unwrap();
        assert!(result.matched, "{result:?}");
        assert!((result.offset_ms - 1230).abs() <= 50, "{result:?}");
        let reverse = align(&delayed, &original, || false).unwrap();
        assert!(reverse.matched, "{reverse:?}");
        assert!((reverse.offset_ms + 1230).abs() <= 50, "{reverse:?}");
    }
    #[test]
    fn silence_short_inputs_and_cancellation_do_not_pass() {
        assert!(
            !align(
                &vec![0.; SAMPLE_RATE * 35],
                &vec![0.; SAMPLE_RATE * 35],
                || false
            )
            .unwrap()
            .matched
        );
        assert!(!align(&[0.; 100], &[0.; 100], || false).unwrap().matched);
        assert!(align(&sample(31), &sample(31), || true).is_err());
    }
    #[test]
    fn chorus_is_found_inside_full_song_and_ambiguous_repeats_abstain() {
        let full = sample(55);
        let start = 2123 * SAMPLE_RATE / 100;
        let chorus: Vec<_> = full[start..start + 9 * SAMPLE_RATE]
            .iter()
            .map(|v| v * 0.27)
            .collect();
        let result = align_segment(&chorus, &full, || false).unwrap();
        assert!(result.matched, "{result:?}");
        assert!((result.offset_ms - 21230).abs() <= 50, "{result:?}");
        let repeated: Vec<_> = chorus
            .iter()
            .chain(&chorus)
            .chain(&chorus)
            .copied()
            .collect();
        assert!(!align_segment(&chorus, &repeated, || false).unwrap().matched);
    }
    #[test]
    fn different_content_and_speed_drift_require_review() {
        let source = sample(42);
        let reversed: Vec<_> = source.iter().rev().copied().collect();
        assert!(!align(&source, &reversed, || false).unwrap().matched);
        let drift: Vec<_> = (0..source.len())
            .map(|i| source[((i as f64 * 1.01) as usize).min(source.len() - 1)])
            .collect();
        assert!(!align(&source, &drift, || false).unwrap().matched);
        let result = align(&source, &source, || false).unwrap();
        assert!(result.matched && result.offset_ms == 0, "{result:?}");
    }

    #[test]
    fn short_version_uses_one_best_placement_despite_an_edited_intro() {
        let full = sample(65);
        let edited: Vec<_> = full[..10 * SAMPLE_RATE]
            .iter()
            .chain(&full[17 * SAMPLE_RATE..55 * SAMPLE_RATE])
            .map(|v| v * 0.4)
            .collect();
        let result = align(&full, &edited, || false).unwrap();
        assert!(result.matched, "{result:?}");
        assert!((result.offset_ms + 7000).abs() <= 50, "{result:?}");
        assert!(result.reason.is_empty(), "{result:?}");
    }

    #[test]
    fn short_version_searches_the_whole_song_and_selects_only_one_repeat() {
        let full = sample(260);
        let clip = &full[211 * SAMPLE_RATE..251 * SAMPLE_RATE];
        let result = align(&full, clip, || false).unwrap();
        assert!(
            result.matched && (result.offset_ms + 211_000).abs() <= 50,
            "{result:?}"
        );
        let repeated: Vec<_> = clip.iter().chain(clip).copied().collect();
        let result = align(&repeated, clip, || false).unwrap();
        assert!(result.matched, "{result:?}");
        assert!(
            result.offset_ms.abs() <= 50 || (result.offset_ms + 40_000).abs() <= 50,
            "{result:?}"
        );
    }

    #[test]
    fn short_version_rejects_unrelated_music_and_speed_drift() {
        let full = sample(80);
        let reversed: Vec<_> = full[..40 * SAMPLE_RATE].iter().rev().copied().collect();
        assert!(!align(&full, &reversed, || false).unwrap().matched);
        let drift: Vec<_> = (0..40 * SAMPLE_RATE)
            .map(|i| full[20 * SAMPLE_RATE + (i as f64 * 1.01) as usize])
            .collect();
        assert!(!align(&full, &drift, || false).unwrap().matched);
    }

    #[test]
    fn sections_cut_once_and_leave_the_missing_song_passage_uncovered() {
        let full = sample(90);
        let short: Vec<_> = full[7 * SAMPLE_RATE..24 * SAMPLE_RATE]
            .iter()
            .chain(&full[31 * SAMPLE_RATE..80 * SAMPLE_RATE])
            .copied()
            .collect();
        let (matched, sections) = align_sections(&full, &short, || false).unwrap();
        assert!(matched.matched, "{matched:?}");
        assert_eq!(sections.len(), 2, "{sections:?}");
        assert!(
            (sections[0].audio_start_ms - 7000).abs() <= 50,
            "{sections:?}"
        );
        assert!(
            (sections[0].duration_ms - 17000).abs() <= 80,
            "{sections:?}"
        );
        assert_eq!(
            sections[0].video_start_ms + sections[0].duration_ms,
            sections[1].video_start_ms
        );
        let gap = sections[1].audio_start_ms - sections[0].audio_start_ms - sections[0].duration_ms;
        assert!((gap - 7000).abs() <= 50, "{sections:?}");
    }
}
