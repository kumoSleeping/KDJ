//! 分析总入口：解码一段音频 → BPM / 调性 / 响度 → 汇总成一条 `AnalysisResult`。

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::decode::{decode_audio_from, probe_duration, DEFAULT_SR};
use crate::dj_grid::{fit_dj_grid, GridMode};
use crate::key::analyze_key;
use crate::loudness::analyze_loudness;
use crate::tempo::analyze_tempo;

/// 短于这个长度的曲子不做 15% 偏移，直接整段分析（interlude / 采样包常见）
const SHORT_TRACK_SECONDS: f64 = 60.0;
/// 从 15% 处开始截取：跳过 intro 的静音铺垫和无节奏段，BPM 稳定得多
const ANALYSIS_OFFSET_RATIO: f64 = 0.15;
/// BPM / Key 只需要 intro 之后一段稳定节奏。再解整首只会多做两遍 STFT。
pub const ANALYSIS_AUDIO_CAP: f64 = 90.0;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub duration: f64,
    pub bpm: Option<f64>,
    pub bpm_raw: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub first_beat: Option<f64>,
    pub beat_times: Vec<f64>,
    pub beat_origin: Option<f64>,
    pub downbeat_origin: Option<f64>,
    pub downbeats: Vec<f64>,
    pub downbeat_confidence: Option<f64>,
    pub key: String,
    pub key_short: String,
    pub camelot: String,
    pub open_key: String,
    pub key_confidence: Option<f64>,
    pub chroma: Vec<f64>,
    pub rms_db: Option<f64>,
    pub peak_db: Option<f64>,
    pub crest_db: Option<f64>,
    pub energy: Option<i64>,
    pub errors: Vec<String>,
}

/// 单次分析各阶段墙钟时间。只进日志，不入库。
#[derive(Debug, Clone, Default)]
pub struct AnalysisTiming {
    pub probe_ms: u64,
    pub decode_ms: u64,
    pub tempo_ms: u64,
    pub key_ms: u64,
    pub loudness_ms: u64,
    pub total_ms: u64,
    pub offset_seconds: f64,
    pub decoded_seconds: f64,
    pub sample_rate: u32,
}

fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// 算出 `(起始偏移秒, 最长截取秒)`。
pub fn analysis_window(duration: Option<f64>, duration_limit: f64) -> (f64, Option<f64>) {
    let Some(duration) = duration.filter(|d| *d > 0.0) else {
        return (0.0, Some(duration_limit));
    };
    if duration < SHORT_TRACK_SECONDS {
        return (0.0, None);
    }
    let offset = duration * ANALYSIS_OFFSET_RATIO;
    let remain = (duration - offset).max(0.0);
    if remain <= 0.0 {
        return (0.0, Some(duration_limit));
    }
    (offset, Some(duration_limit.min(remain)))
}

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

/// Fit one fixed-period phase from every detected beat rather than extrapolating the quantization
/// error of a single onset frame. Circular averaging also keeps phases near 0/period adjacent.
fn fitted_grid_phase(events: &[f64], period: f64) -> Option<f64> {
    if !period.is_finite() || period <= 0.0 {
        return None;
    }
    let scale = std::f64::consts::TAU / period;
    let (x, y, count) = events
        .iter()
        .copied()
        .filter(|event| event.is_finite())
        .fold((0.0, 0.0, 0usize), |(x, y, count), event| {
            let angle = event.rem_euclid(period) * scale;
            (x + angle.cos(), y + angle.sin(), count + 1)
        });
    if count == 0 || x.hypot(y) <= f64::EPSILON {
        return None;
    }
    Some((y.atan2(x) / scale).rem_euclid(period))
}

/// A classified downbeat chooses the beat number inside the bar, but its raw onset timestamp has
/// one analysis-hop of jitter. Snap that classification onto the already-fitted beat lattice so
/// beat alignment and bar alignment cannot disagree by 10–20 ms.
fn fitted_event_on_grid(event: f64, phase: f64, period: f64) -> Option<f64> {
    if !event.is_finite() || !phase.is_finite() || !period.is_finite() || period <= 0.0 {
        return None;
    }
    Some(phase + ((event - phase) / period).round() * period)
}

/// 对已解码的样本做全部分析。`offset` 是这段样本在原曲里的起始秒数。
///
/// 三个子分析互不影响：任何一个没结果都只记 errors，其余字段照常产出——
/// 曲库里宁可有一半信息，也不要因为某首怪文件整条记录变空。
pub fn analyze_samples(samples: &[f32], sr: f64, offset: f64) -> AnalysisResult {
    analyze_samples_timed(samples, sr, offset).0
}

fn analyze_samples_timed(samples: &[f32], sr: f64, offset: f64) -> (AnalysisResult, u64, u64, u64) {
    let mut result = AnalysisResult {
        duration: offset
            + if sr > 0.0 {
                samples.len() as f64 / sr
            } else {
                0.0
            },
        ..Default::default()
    };

    let tempo_started = Instant::now();
    let tempo = analyze_tempo(samples, sr);
    let tempo_ms = elapsed_ms(tempo_started);
    if tempo.bpm > 0.0 {
        // `beat_times[0] % interval` 会把分析窗中段的一次整数帧误差外推到整首；BPM 只要
        // 精修了 0.1%，曲首相位就能漂几十毫秒。复用 DJ Grid Fitter 对全部检测拍做
        // Huber/相位残差验证，只在固定网格成立时发布 first_beat。
        let (detected_downbeats, downbeat_confidence) =
            infer_downbeats(&tempo.beat_times, &tempo.beat_strengths);
        let grid = fit_dj_grid(&tempo.beat_times, &detected_downbeats, Some(tempo.bpm));
        result.bpm = Some(tempo.bpm);
        result.bpm_raw = Some(tempo.bpm_raw);
        result.bpm_confidence = Some(tempo.confidence.min(grid.confidence.overall));
        // 拍点换算回全曲绝对时间
        result.beat_times = tempo
            .beat_times
            .iter()
            .map(|t| round_to(offset + t, 4))
            .collect();
        result.downbeats = detected_downbeats
            .iter()
            .map(|time| round_to(offset + time, 4))
            .collect();
        result.downbeat_confidence = downbeat_confidence;
        let stable_phase = tempo.confidence >= 0.70
            && (grid.grid_mode == GridMode::Constant || grid.confidence.overall >= 0.45);
        if stable_phase && tempo.beat_interval > 0.0 {
            // Fit phase against the exact interval represented by the persisted BPM. The DJ-grid
            // validator may use a nearby candidate internally, while all later render/SYNC paths
            // reconstruct their period as 60/BPM; mixing those two periods creates slow drift.
            let grid_phase = fitted_grid_phase(&tempo.beat_times, tempo.beat_interval)
                .unwrap_or_else(|| {
                    if grid.beat_interval_seconds.is_some() {
                        grid.first_beat_seconds.rem_euclid(tempo.beat_interval)
                    } else {
                        tempo.first_beat.rem_euclid(tempo.beat_interval)
                    }
                });
            let beat_origin = (offset + grid_phase).rem_euclid(tempo.beat_interval);
            result.beat_origin = Some(round_to(beat_origin, 4));
            let bar_interval = tempo.beat_interval * 4.0;
            result.downbeat_origin = detected_downbeats.first().and_then(|time| {
                fitted_event_on_grid(*time, grid_phase, tempo.beat_interval)
                    .map(|fitted| round_to((offset + fitted).rem_euclid(bar_interval), 4))
            });
            // Compatibility field: only a trustworthy musical downbeat wins. A weak classifier
            // result remains available as diagnostics, but must not bypass the frontend confidence
            // gate through `first_beat` and silently label an arbitrary beat as the yellow line.
            let trusted_downbeat = downbeat_confidence.is_some_and(|value| value >= 0.5);
            let origin = result
                .downbeat_origin
                .filter(|_| trusted_downbeat)
                .unwrap_or_else(|| (offset + grid_phase).rem_euclid(bar_interval));
            result.first_beat = Some(round_to(origin, 4));
        }
    }

    let key_started = Instant::now();
    let key = analyze_key(samples, sr);
    let key_ms = elapsed_ms(key_started);
    result.key = key.key;
    result.key_short = key.key_short;
    result.camelot = key.camelot;
    result.open_key = key.open_key;
    result.key_confidence = Some(key.confidence);
    result.chroma = key.chroma;

    let loud_started = Instant::now();
    let loud = analyze_loudness(samples);
    let loudness_ms = elapsed_ms(loud_started);
    result.rms_db = Some(loud.rms_db);
    result.peak_db = Some(loud.peak_db);
    result.crest_db = Some(loud.crest_db);
    result.energy = Some(loud.energy);

    (result, tempo_ms, key_ms, loudness_ms)
}

/// Choose one of four beat-index phases only when its accents remain stronger in both halves of
/// the analysis window. This deliberately returns no answer for four-on-the-floor material whose
/// beats are equal; a false yellow bar is worse than an explicitly unknown downbeat.
fn infer_downbeats(beat_times: &[f64], strengths: &[f64]) -> (Vec<f64>, Option<f64>) {
    let count = beat_times.len().min(strengths.len());
    if count < 16 {
        return (Vec::new(), None);
    }
    let phase_scores = |range: std::ops::Range<usize>| -> [f64; 4] {
        let mut sums = [0.0; 4];
        let mut counts = [0usize; 4];
        for index in range {
            let value = strengths[index];
            if value.is_finite() && value >= 0.0 {
                sums[index % 4] += value;
                counts[index % 4] += 1;
            }
        }
        std::array::from_fn(|phase| {
            (counts[phase] > 0)
                .then_some(sums[phase] / counts[phase] as f64)
                .unwrap_or(0.0)
        })
    };
    let all = phase_scores(0..count);
    let first = phase_scores(0..count / 2);
    let second = phase_scores(count / 2..count);
    let best_phase = |scores: &[f64; 4]| {
        (0..4)
            .max_by(|left, right| scores[*left].total_cmp(&scores[*right]))
            .unwrap_or(0)
    };
    let best = best_phase(&all);
    if best_phase(&first) != best || best_phase(&second) != best {
        return (Vec::new(), None);
    }
    let mut ordered = all;
    ordered.sort_by(|left, right| right.total_cmp(left));
    let strongest = ordered[0];
    let runner_up = ordered[1];
    let separation = if strongest > f64::EPSILON {
        (strongest - runner_up) / strongest
    } else {
        0.0
    };
    if separation < 0.10 || strongest < runner_up * 1.12 {
        return (Vec::new(), None);
    }
    let confidence = ((separation - 0.08) / 0.35).clamp(0.0, 1.0);
    let downbeats = beat_times
        .iter()
        .enumerate()
        .filter_map(|(index, time)| (index % 4 == best).then_some(*time))
        .collect();
    (downbeats, Some(round_to(confidence, 3)))
}

/// 分析一个音频文件。
///
/// 解码失败退化成一条带 errors 的空结果，让扫描任务能继续跑下去。
pub fn analyze_file(path: &Path, duration_limit: f64) -> AnalysisResult {
    analyze_file_timed(path, duration_limit).0
}

/// 与 [`analyze_file`] 相同，并带上各阶段耗时，供曲库任务写入 KDJ 日志。
pub fn analyze_file_timed(path: &Path, duration_limit: f64) -> (AnalysisResult, AnalysisTiming) {
    let started = Instant::now();
    let duration_limit = duration_limit.abs().clamp(1.0, ANALYSIS_AUDIO_CAP);

    let probe_started = Instant::now();
    let probed_duration = probe_duration(path).ok().flatten();
    let probe_ms = elapsed_ms(probe_started);
    let (offset, max_seconds) = analysis_window(probed_duration, duration_limit);

    let decode_started = Instant::now();
    let decoded = match decode_audio_from(path, DEFAULT_SR, max_seconds, offset) {
        Ok(decoded) => decoded,
        Err(err) => {
            return (
                AnalysisResult {
                    duration: probed_duration.unwrap_or(0.0),
                    errors: vec![format!("decode: {err}")],
                    ..Default::default()
                },
                AnalysisTiming {
                    probe_ms,
                    decode_ms: elapsed_ms(decode_started),
                    total_ms: elapsed_ms(started),
                    offset_seconds: offset,
                    ..Default::default()
                },
            );
        }
    };
    let decode_ms = elapsed_ms(decode_started);
    if decoded.samples.is_empty() {
        return (
            AnalysisResult {
                duration: probed_duration.unwrap_or(0.0),
                errors: vec!["decode: 解出 0 个采样点".to_string()],
                ..Default::default()
            },
            AnalysisTiming {
                probe_ms,
                decode_ms,
                total_ms: elapsed_ms(started),
                offset_seconds: offset,
                sample_rate: decoded.sample_rate,
                ..Default::default()
            },
        );
    }

    let sr = decoded.sample_rate as f64;
    let decoded_seconds = if sr > 0.0 {
        decoded.samples.len() as f64 / sr
    } else {
        0.0
    };
    let (mut result, tempo_ms, key_ms, loudness_ms) =
        analyze_samples_timed(&decoded.samples, sr, offset);
    result.duration = round_to(
        probed_duration
            .or(decoded.duration)
            .unwrap_or(result.duration),
        3,
    );
    (
        result,
        AnalysisTiming {
            probe_ms,
            decode_ms,
            tempo_ms,
            key_ms,
            loudness_ms,
            total_ms: elapsed_ms(started),
            offset_seconds: offset,
            decoded_seconds,
            sample_rate: decoded.sample_rate,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_tracks_are_analysed_whole() {
        // 短于 60 秒不偏移、不截断，否则采样包/间奏根本剩不下东西
        assert_eq!(analysis_window(Some(30.0), 240.0), (0.0, None));
        assert_eq!(analysis_window(Some(59.9), 240.0), (0.0, None));
    }

    #[test]
    fn long_tracks_start_at_fifteen_percent() {
        let (offset, limit) = analysis_window(Some(300.0), 240.0);
        assert!((offset - 45.0).abs() < 1e-9);
        assert_eq!(limit, Some(240.0), "剩下 255 秒，但上限是 240");
    }

    #[test]
    fn the_window_never_runs_past_the_end() {
        // 100 秒的曲子：偏移 15，剩 85，上限 240 → 取 85
        let (offset, limit) = analysis_window(Some(100.0), 240.0);
        assert!((offset - 15.0).abs() < 1e-9);
        assert_eq!(limit, Some(85.0));
    }

    #[test]
    fn unknown_duration_falls_back_to_the_limit() {
        assert_eq!(analysis_window(None, 240.0), (0.0, Some(240.0)));
        assert_eq!(analysis_window(Some(0.0), 240.0), (0.0, Some(240.0)));
    }

    #[test]
    fn fitted_downbeat_stays_on_the_same_lattice_as_regular_beats() {
        let period = 0.5;
        let beats = [0.101, 0.598, 1.103, 1.599, 2.102, 2.601];
        let phase = fitted_grid_phase(&beats, period).expect("phase");
        let raw_downbeat = 1.623; // one onset-frame late
        let fitted = fitted_event_on_grid(raw_downbeat, phase, period).expect("downbeat");
        let residual = (fitted - phase).rem_euclid(period);
        assert!(residual.min(period - residual) < 1e-12);
        assert!(
            (fitted - raw_downbeat).abs() > 0.01,
            "raw hop jitter should be removed"
        );
    }

    #[test]
    fn circular_phase_fit_does_not_split_events_around_period_zero() {
        let phase = fitted_grid_phase(&[0.499, 0.001, 0.502, 0.998], 0.5).expect("phase");
        assert!(phase < 0.01 || phase > 0.49, "phase={phase}");
    }

    #[test]
    fn first_beat_is_wrapped_into_one_bar_period() {
        // 分析窗从 45 秒开始时，首拍的绝对时间可能是 45.3；
        // first_beat 要表达小节相位，必须折回 [0, 一小节) 内，不能只折一拍。
        let sr = 22050.0;
        let period = 60.0 / 120.0;
        let bar = period * 4.0;
        let n = (sr * 20.0) as usize;
        let mut samples = vec![0.0f32; n];
        let step = (period * sr) as usize;
        for start in (0..n).step_by(step) {
            for i in 0..(0.005 * sr) as usize {
                if start + i < n {
                    let t = i as f64 / sr;
                    samples[start + i] = ((-t * 600.0).exp()
                        * (2.0 * std::f64::consts::PI * 180.0 * t).sin())
                        as f32;
                }
            }
        }
        let result = analyze_samples(&samples, sr, 45.0);
        let first = result.first_beat.expect("应当有首拍");
        assert!(
            (0.0..bar).contains(&first),
            "first_beat={first} 应当落在 [0, {bar})"
        );
        // 拍点本身仍然是绝对时间，且 first_beat 必须落在同一套拍网格上。
        assert!(result.beat_times[0] >= 45.0);
        let residual = (result.beat_times[0] - first).rem_euclid(period);
        let folded = residual.min(period - residual);
        assert!(
            folded < 0.08,
            "first_beat={first} 应与检测拍 {detected} 共网格，残差 {folded}",
            detected = result.beat_times[0]
        );
    }

    #[test]
    fn tempo_transition_does_not_publish_a_fake_fixed_phase() {
        let sr = 22_050.0;
        let seconds = 36.0;
        let mut samples = vec![0.0f32; (seconds * sr) as usize];
        let mut at = 0.15;
        while at < seconds {
            let bpm = if at < seconds / 2.0 { 120.0 } else { 145.0 };
            let start = (at * sr) as usize;
            for index in 0..(0.005 * sr) as usize {
                if start + index >= samples.len() {
                    break;
                }
                let time = index as f64 / sr;
                samples[start + index] = ((-time * 600.0).exp()
                    * (2.0 * std::f64::consts::PI * 180.0 * time).sin())
                    as f32;
            }
            at += 60.0 / bpm;
        }

        let result = analyze_samples(&samples, sr, 0.0);
        assert!(
            result.first_beat.is_none() || result.bpm_confidence.unwrap_or(0.0) < 0.45,
            "变速曲不能以高置信度发布固定相位：{result:#?}"
        );
    }

    #[test]
    fn downbeat_classifier_requires_a_stable_four_beat_accent() {
        let beats: Vec<f64> = (0..32).map(|index| index as f64 * 0.5).collect();
        let accents: Vec<f64> = (0..32)
            .map(|index| if index % 4 == 2 { 1.0 } else { 0.45 })
            .collect();
        let (downbeats, confidence) = infer_downbeats(&beats, &accents);
        assert_eq!(downbeats[0], 1.0);
        assert!(confidence.is_some_and(|value| value > 0.5));

        let equal = vec![1.0; beats.len()];
        assert!(infer_downbeats(&beats, &equal).0.is_empty());

        let mut unstable = accents;
        for (index, value) in unstable.iter_mut().enumerate().skip(16) {
            *value = if index % 4 == 1 { 1.0 } else { 0.45 };
        }
        assert!(infer_downbeats(&beats, &unstable).0.is_empty());
    }

    #[test]
    fn a_silent_file_still_reports_loudness_and_duration() {
        // 子分析互不拖累：没有 BPM 不代表响度也没有
        let result = analyze_samples(&vec![0.0f32; 22050 * 5], 22050.0, 0.0);
        assert!(result.bpm.is_none());
        assert!(result.energy.is_some());
        assert!((result.duration - 5.0).abs() < 1e-6);
    }

    #[test]
    fn analysis_audio_is_capped_so_typical_tracks_are_not_fully_decoded() {
        assert_eq!(ANALYSIS_AUDIO_CAP, 90.0);
        let (offset, limit) = analysis_window(Some(300.0), 240.0);
        assert!((offset - 45.0).abs() < 1e-9);
        assert_eq!(limit, Some(240.0));
        let clipped = 240.0_f64.abs().clamp(1.0, ANALYSIS_AUDIO_CAP);
        let (_, capped) = analysis_window(Some(300.0), clipped);
        assert_eq!(capped, Some(90.0));
    }
}
