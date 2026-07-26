//! 分析总入口：解码一段音频 → BPM / 调性 / 响度 → 汇总成一条 `AnalysisResult`。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::decode::{decode_audio_from, DEFAULT_SR};
use crate::key::analyze_key;
use crate::loudness::analyze_loudness;
use crate::tempo::analyze_tempo;

/// 短于这个长度的曲子不做 15% 偏移，直接整段分析（interlude / 采样包常见）
const SHORT_TRACK_SECONDS: f64 = 60.0;
/// 从 15% 处开始截取：跳过 intro 的静音铺垫和无节奏段，BPM 稳定得多
const ANALYSIS_OFFSET_RATIO: f64 = 0.15;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub duration: f64,
    pub bpm: Option<f64>,
    pub bpm_raw: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub first_beat: Option<f64>,
    pub beat_times: Vec<f64>,
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

/// 对已解码的样本做全部分析。`offset` 是这段样本在原曲里的起始秒数。
///
/// 三个子分析互不影响：任何一个没结果都只记 errors，其余字段照常产出——
/// 曲库里宁可有一半信息，也不要因为某首怪文件整条记录变空。
pub fn analyze_samples(samples: &[f32], sr: f64, offset: f64) -> AnalysisResult {
    let mut result = AnalysisResult {
        duration: offset + if sr > 0.0 { samples.len() as f64 / sr } else { 0.0 },
        ..Default::default()
    };

    let tempo = analyze_tempo(samples, sr);
    if tempo.bpm > 0.0 {
        result.bpm = Some(tempo.bpm);
        result.bpm_raw = Some(tempo.bpm_raw);
        result.bpm_confidence = Some(tempo.confidence);
        // 拍点换算回全曲绝对时间
        result.beat_times = tempo
            .beat_times
            .iter()
            .map(|t| round_to(offset + t, 4))
            .collect();
        if let Some(first) = result.beat_times.first().copied() {
            let interval = if tempo.beat_interval > 0.0 {
                tempo.beat_interval
            } else {
                60.0 / tempo.bpm
            };
            // first_beat 表达的是"网格相位"：按恒定速度把首拍外推回 [0, 一拍) 区间，
            // 这样即使分析窗从曲子中段开始，DJ 也能用它对齐整首的网格。
            let phase = if interval > 0.0 {
                first - interval * (first / interval).floor()
            } else {
                first
            };
            result.first_beat = Some(round_to(phase, 4));
        }
    }

    let key = analyze_key(samples, sr);
    result.key = key.key;
    result.key_short = key.key_short;
    result.camelot = key.camelot;
    result.open_key = key.open_key;
    result.key_confidence = Some(key.confidence);
    result.chroma = key.chroma;

    let loud = analyze_loudness(samples);
    result.rms_db = Some(loud.rms_db);
    result.peak_db = Some(loud.peak_db);
    result.crest_db = Some(loud.crest_db);
    result.energy = Some(loud.energy);

    result
}

/// 分析一个音频文件。
///
/// 解码失败退化成一条带 errors 的空结果，让扫描任务能继续跑下去。
pub fn analyze_file(path: &Path, duration_limit: f64) -> AnalysisResult {
    // 先粗解一小段拿总时长（symphonia 从容器头就能读出来，不用解完）
    let probed_duration = crate::decode::decode_audio(path, DEFAULT_SR, Some(0.05))
        .ok()
        .and_then(|audio| audio.duration);
    let (offset, max_seconds) = analysis_window(probed_duration, duration_limit);

    let decoded = match decode_audio_from(path, DEFAULT_SR, max_seconds, offset) {
        Ok(decoded) => decoded,
        Err(err) => {
            return AnalysisResult {
                duration: probed_duration.unwrap_or(0.0),
                errors: vec![format!("decode: {err}")],
                ..Default::default()
            }
        }
    };
    if decoded.samples.is_empty() {
        return AnalysisResult {
            duration: probed_duration.unwrap_or(0.0),
            errors: vec!["decode: 解出 0 个采样点".to_string()],
            ..Default::default()
        };
    }

    let mut result = analyze_samples(&decoded.samples, decoded.sample_rate as f64, offset);
    result.duration = round_to(
        probed_duration.or(decoded.duration).unwrap_or(result.duration),
        3,
    );
    result
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
    fn first_beat_is_wrapped_into_one_beat_period() {
        // 分析窗从 45 秒开始时，首拍的绝对时间可能是 45.3；
        // first_beat 要表达"网格相位"，必须折回 [0, 一拍) 内
        let sr = 22050.0;
        let period = 60.0 / 120.0;
        let n = (sr * 20.0) as usize;
        let mut samples = vec![0.0f32; n];
        let step = (period * sr) as usize;
        for start in (0..n).step_by(step) {
            for i in 0..(0.005 * sr) as usize {
                if start + i < n {
                    let t = i as f64 / sr;
                    samples[start + i] =
                        ((-t * 600.0).exp() * (2.0 * std::f64::consts::PI * 180.0 * t).sin()) as f32;
                }
            }
        }
        let result = analyze_samples(&samples, sr, 45.0);
        let first = result.first_beat.expect("应当有首拍");
        assert!(
            (0.0..period).contains(&first),
            "first_beat={first} 应当落在 [0, {period})"
        );
        // 拍点本身仍然是绝对时间
        assert!(result.beat_times[0] >= 45.0);
    }

    #[test]
    fn a_silent_file_still_reports_loudness_and_duration() {
        // 子分析互不拖累：没有 BPM 不代表响度也没有
        let result = analyze_samples(&vec![0.0f32; 22050 * 5], 22050.0, 0.0);
        assert!(result.bpm.is_none());
        assert!(result.energy.is_some());
        assert!((result.duration - 5.0).abs() < 1e-6);
    }
}
