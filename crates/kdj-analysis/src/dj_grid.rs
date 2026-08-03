//! 面向 DJ 的 beat positions → BPM / 固定网格 / 变速段后处理。
//!
//! 检测器只负责给出 beat/downbeat 时间；本模块不依赖具体模型，也不把“拍点很规则”
//! 误当成“节奏层级一定正确”。每个 0.5×…2× 候选都会独立计算覆盖率、占用率、
//! 相位残差、downbeat 小节一致性和传统 DSP 一致性。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::dsp::{median, percentile};

const CANDIDATE_RATIOS: [f64; 7] = [0.5, 2.0 / 3.0, 0.75, 1.0, 4.0 / 3.0, 1.5, 2.0];
const MIN_BPM: f64 = 40.0;
const MAX_BPM: f64 = 240.0;
const MIR_TOLERANCE_SECONDS: f64 = 0.070;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GridMode {
    Constant,
    Variable,
    #[default]
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisWarning {
    InsufficientBeats,
    SparseDetection,
    VariableTempo,
    MetricalAmbiguity,
    DownbeatWeak,
    AnalyzerDisagreement,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AnalysisConfidence {
    pub detection: f64,
    pub grid_regularity: f64,
    pub metrical_level: f64,
    pub downbeat: f64,
    pub agreement: f64,
    pub overall: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TempoCandidate {
    /// 相对模型原始 beat 间隔的节奏层级倍率。
    pub ratio: f64,
    pub bpm: f64,
    pub score: f64,
    /// 检出的 beat 中，有多少能被候选网格解释。
    pub beat_coverage: f64,
    /// 候选网格点中，有多少实际收到了 beat；用于惩罚虚构的 2× 网格。
    pub grid_occupancy: f64,
    pub median_phase_error_seconds: f64,
    pub phase_error_p95_seconds: f64,
    pub downbeat_consistency: f64,
    pub analyzer_agreement: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TempoSegment {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub bpm: f64,
    pub beat_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BeatAnalysisResult {
    pub predominant_bpm: f64,
    pub bpm_candidates: Vec<TempoCandidate>,
    /// 检测器给出的原始拍点（清理 NaN、负数和重复值后）。
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    /// 固定速度时按拟合相位生成的 DJ 网格；变速/歧义时为空，避免伪造稳定网格。
    pub grid_beats: Vec<f64>,
    pub tempo_segments: Vec<TempoSegment>,
    pub grid_mode: GridMode,
    pub first_beat_seconds: f64,
    pub beat_interval_seconds: Option<f64>,
    pub confidence: AnalysisConfidence,
    pub warnings: Vec<AnalysisWarning>,
    pub analyzer_name: String,
    pub analyzer_version: String,
}

#[derive(Debug, Clone, Copy)]
struct BeatLine {
    period: f64,
}

#[derive(Debug)]
struct ScoredCandidate {
    public: TempoCandidate,
    phase: f64,
    signed_errors: Vec<f64>,
}

/// 用默认元数据拟合 DJ 网格。
pub fn fit_dj_grid(beats: &[f64], downbeats: &[f64], dsp_bpm: Option<f64>) -> BeatAnalysisResult {
    fit_dj_grid_with_metadata(beats, downbeats, dsp_bpm, "beat-positions", "1")
}

/// 从任意检测器的 beat/downbeat 时间拟合 DJ 网格。
pub fn fit_dj_grid_with_metadata(
    beats: &[f64],
    downbeats: &[f64],
    dsp_bpm: Option<f64>,
    analyzer_name: &str,
    analyzer_version: &str,
) -> BeatAnalysisResult {
    let beats = sanitize_events(beats);
    let downbeats = sanitize_events(downbeats);
    let mut result = BeatAnalysisResult {
        beats: beats.clone(),
        downbeats: downbeats.clone(),
        analyzer_name: analyzer_name.to_string(),
        analyzer_version: analyzer_version.to_string(),
        ..Default::default()
    };

    if beats.len() < 3 {
        result.warnings.push(AnalysisWarning::InsufficientBeats);
        if downbeats.is_empty() {
            result.warnings.push(AnalysisWarning::DownbeatWeak);
        }
        return result;
    }

    let Some(seed_period) = seed_period(&beats) else {
        result.warnings.push(AnalysisWarning::InsufficientBeats);
        return result;
    };
    let line = robust_beat_line(&beats, seed_period).unwrap_or(BeatLine {
        period: seed_period,
    });
    let base_bpm = 60.0 / line.period;

    let mut candidates: Vec<ScoredCandidate> = CANDIDATE_RATIOS
        .iter()
        .filter_map(|ratio| {
            let bpm = base_bpm * ratio;
            (MIN_BPM..=MAX_BPM)
                .contains(&bpm)
                .then(|| score_candidate(&beats, &downbeats, *ratio, bpm, dsp_bpm))
        })
        .collect();
    candidates.sort_by(|a, b| b.public.score.total_cmp(&a.public.score));
    let Some(best) = candidates.first() else {
        result.warnings.push(AnalysisWarning::MetricalAmbiguity);
        return result;
    };

    let score_gap = candidates
        .get(1)
        .map(|second| (best.public.score - second.public.score).max(0.0))
        .unwrap_or(best.public.score);
    let phase_drift = sustained_phase_drift(&best.signed_errors);
    let tempo_segments = build_tempo_segments(&beats, line.period);
    let tempo_variation = segment_variation(&tempo_segments);

    let mode = if beats.len() < 8 {
        GridMode::Ambiguous
    } else if tempo_variation > 0.05 || phase_drift > 0.12 {
        GridMode::Variable
    } else if best.public.beat_coverage < 0.65
        || score_gap < 0.075
        || best.public.phase_error_p95_seconds > 0.10
    {
        GridMode::Ambiguous
    } else {
        GridMode::Constant
    };

    let detection =
        ((beats.len() as f64 / 16.0).min(1.0) * best.public.beat_coverage).clamp(0.0, 1.0);
    let residual_scale = MIR_TOLERANCE_SECONDS;
    let residual_score =
        (1.0 - best.public.phase_error_p95_seconds / residual_scale).clamp(0.0, 1.0);
    let grid_regularity =
        (0.55 * residual_score + 0.45 * best.public.beat_coverage).clamp(0.0, 1.0);
    let metrical_level = (score_gap / best.public.score.max(1e-9)).clamp(0.0, 1.0);
    let downbeat_confidence = if downbeats.is_empty() {
        0.0
    } else {
        best.public.downbeat_consistency
    };
    let agreement = if dsp_bpm.is_some() {
        best.public.analyzer_agreement
    } else {
        0.0
    };
    let confidence = AnalysisConfidence {
        detection,
        grid_regularity,
        metrical_level,
        downbeat: downbeat_confidence,
        agreement,
        overall: overall_confidence(
            detection,
            grid_regularity,
            metrical_level,
            (!downbeats.is_empty()).then_some(downbeat_confidence),
            dsp_bpm.map(|_| agreement),
        ),
    };

    let interval = 60.0 / best.public.bpm;
    let phase = best.phase.rem_euclid(interval);
    let grid_beats = if mode == GridMode::Constant {
        generate_grid(best.phase, interval, beats[0], *beats.last().unwrap())
    } else {
        Vec::new()
    };

    let mut warnings = Vec::new();
    if beats.len() < 8 {
        warnings.push(AnalysisWarning::InsufficientBeats);
    }
    if best.public.beat_coverage < 0.80 {
        warnings.push(AnalysisWarning::SparseDetection);
    }
    match mode {
        GridMode::Variable => warnings.push(AnalysisWarning::VariableTempo),
        GridMode::Ambiguous => warnings.push(AnalysisWarning::MetricalAmbiguity),
        GridMode::Constant => {}
    }
    if downbeats.is_empty() || best.public.downbeat_consistency < 0.50 {
        warnings.push(AnalysisWarning::DownbeatWeak);
    }
    if dsp_bpm.is_some() && best.public.analyzer_agreement < 0.50 {
        warnings.push(AnalysisWarning::AnalyzerDisagreement);
    }

    result.predominant_bpm = round_to(best.public.bpm, 3);
    result.bpm_candidates = candidates.into_iter().map(|item| item.public).collect();
    result.grid_beats = grid_beats;
    result.tempo_segments = tempo_segments;
    result.grid_mode = mode;
    result.first_beat_seconds = round_to(phase, 4);
    result.beat_interval_seconds = (mode == GridMode::Constant).then(|| round_to(interval, 6));
    result.confidence = confidence;
    result.warnings = warnings;
    result
}

fn sanitize_events(events: &[f64]) -> Vec<f64> {
    let mut clean: Vec<f64> = events
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .collect();
    clean.sort_by(f64::total_cmp);
    clean.dedup_by(|a, b| (*a - *b).abs() < 0.010);
    clean
}

fn seed_period(beats: &[f64]) -> Option<f64> {
    let mut intervals: Vec<f64> = beats
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|gap| (0.15..=1.5).contains(gap))
        .collect();
    if intervals.len() < 2 {
        return None;
    }
    let period = median(&mut intervals);
    period
        .is_finite()
        .then_some(period)
        .filter(|value| *value > 0.0)
}

/// 先按种子周期给每个检测点分配整数拍号，再用 Huber IRLS 拟合 `t = phase + n*period`。
fn robust_beat_line(beats: &[f64], seed: f64) -> Option<BeatLine> {
    let mut indices = Vec::with_capacity(beats.len());
    let mut index = 0_i64;
    indices.push(index as f64);
    for pair in beats.windows(2) {
        let steps = ((pair[1] - pair[0]) / seed).round().clamp(1.0, 16.0) as i64;
        index += steps;
        indices.push(index as f64);
    }

    let mut weights = vec![1.0; beats.len()];
    let (mut phase, mut period) = weighted_line(&indices, beats, &weights)?;
    for _ in 0..8 {
        let residuals: Vec<f64> = indices
            .iter()
            .zip(beats)
            .map(|(x, y)| y - (phase + period * x))
            .collect();
        let mut absolute: Vec<f64> = residuals.iter().map(|value| value.abs()).collect();
        let scale = (1.4826 * median(&mut absolute)).max(0.010);
        let huber = 1.5 * scale;
        for (slot, residual) in weights.iter_mut().zip(residuals) {
            let magnitude = residual.abs();
            *slot = if magnitude <= huber {
                1.0
            } else {
                huber / magnitude.max(1e-9)
            };
        }
        let fitted = weighted_line(&indices, beats, &weights)?;
        phase = fitted.0;
        period = fitted.1;
    }
    (period.is_finite() && (0.15..=1.5).contains(&period)).then_some(BeatLine { period })
}

fn weighted_line(x: &[f64], y: &[f64], weights: &[f64]) -> Option<(f64, f64)> {
    let sum_w = weights.iter().sum::<f64>();
    if sum_w <= 0.0 || x.len() != y.len() || x.len() != weights.len() {
        return None;
    }
    let mean_x = x.iter().zip(weights).map(|(v, w)| v * w).sum::<f64>() / sum_w;
    let mean_y = y.iter().zip(weights).map(|(v, w)| v * w).sum::<f64>() / sum_w;
    let numerator = x
        .iter()
        .zip(y)
        .zip(weights)
        .map(|((x, y), w)| w * (x - mean_x) * (y - mean_y))
        .sum::<f64>();
    let denominator = x
        .iter()
        .zip(weights)
        .map(|(x, w)| w * (x - mean_x).powi(2))
        .sum::<f64>();
    if denominator <= 0.0 {
        return None;
    }
    let slope = numerator / denominator;
    Some((mean_y - slope * mean_x, slope))
}

fn score_candidate(
    beats: &[f64],
    downbeats: &[f64],
    ratio: f64,
    bpm: f64,
    dsp_bpm: Option<f64>,
) -> ScoredCandidate {
    let period = 60.0 / bpm;
    let sample_step = beats.len().div_ceil(128).max(1);
    let mut best_phase = beats[0].rem_euclid(period);
    let mut best_median = f64::INFINITY;
    for time in beats.iter().step_by(sample_step) {
        let phase = time.rem_euclid(period);
        let mut errors: Vec<f64> = beats
            .iter()
            .map(|beat| signed_grid_error(*beat, phase, period).abs())
            .collect();
        let error = median(&mut errors);
        if error < best_median {
            best_median = error;
            best_phase = phase;
        }
    }
    let mut signed_errors: Vec<f64> = beats
        .iter()
        .map(|beat| signed_grid_error(*beat, best_phase, period))
        .collect();
    let mut correction = signed_errors.clone();
    best_phase = (best_phase + median(&mut correction)).rem_euclid(period);
    signed_errors = beats
        .iter()
        .map(|beat| signed_grid_error(*beat, best_phase, period))
        .collect();

    let tolerance = MIR_TOLERANCE_SECONDS.min(0.22 * period).max(0.025);
    let absolute: Vec<f64> = signed_errors.iter().map(|value| value.abs()).collect();
    let covered = absolute.iter().filter(|error| **error <= tolerance).count();
    let beat_coverage = covered as f64 / beats.len() as f64;

    let matched_indices: BTreeSet<i64> = beats
        .iter()
        .zip(&absolute)
        .filter(|(_, error)| **error <= tolerance)
        .map(|(beat, _)| ((*beat - best_phase) / period).round() as i64)
        .collect();
    let expected = matched_indices
        .first()
        .zip(matched_indices.last())
        .map(|(first, last)| (last - first + 1).max(1) as usize)
        .unwrap_or(1);
    let grid_occupancy = (matched_indices.len() as f64 / expected as f64).clamp(0.0, 1.0);

    let mut sorted = absolute.clone();
    sorted.sort_by(f64::total_cmp);
    let median_error = percentile(&sorted, 50.0);
    let p95_error = percentile(&sorted, 95.0);
    let residual_score =
        (1.0 - p95_error / (0.25 * period).max(MIR_TOLERANCE_SECONDS)).clamp(0.0, 1.0);
    let downbeat_consistency = downbeat_score(downbeats, best_phase, period, tolerance);
    let analyzer_agreement = dsp_bpm.map(|dsp| bpm_agreement(bpm, dsp)).unwrap_or(0.5);

    // 第二分析器只作弱判据：它可以拆平局、给出 disagreement，但不能把 beat 覆盖率
    // 更差的层级硬抬成第一。真实 swing 样本里旧 DSP=172、模型 beat=230，0.75× 恰好
    // 对上 DSP；agreement 权重过大会无视模型实际检测到的 4 拍 downbeat 结构。
    let score = 0.38 * beat_coverage
        + 0.22 * grid_occupancy
        + 0.22 * residual_score
        + 0.15 * downbeat_consistency
        + 0.03 * analyzer_agreement;
    ScoredCandidate {
        public: TempoCandidate {
            ratio: round_to(ratio, 6),
            bpm: round_to(bpm, 3),
            score: round_to(score, 4),
            beat_coverage: round_to(beat_coverage, 4),
            grid_occupancy: round_to(grid_occupancy, 4),
            median_phase_error_seconds: round_to(median_error, 5),
            phase_error_p95_seconds: round_to(p95_error, 5),
            downbeat_consistency: round_to(downbeat_consistency, 4),
            analyzer_agreement: round_to(analyzer_agreement, 4),
        },
        phase: best_phase,
        signed_errors,
    }
}

fn signed_grid_error(time: f64, phase: f64, period: f64) -> f64 {
    let index = ((time - phase) / period).round();
    time - (phase + index * period)
}

fn downbeat_score(downbeats: &[f64], phase: f64, period: f64, tolerance: f64) -> f64 {
    if downbeats.is_empty() {
        return 0.5;
    }
    let aligned = downbeats
        .iter()
        .filter(|time| signed_grid_error(**time, phase, period).abs() <= tolerance)
        .count() as f64
        / downbeats.len() as f64;
    if downbeats.len() < 2 {
        return aligned;
    }

    let mut bar_lengths: Vec<i64> = downbeats
        .windows(2)
        .map(|pair| ((pair[1] - pair[0]) / period).round() as i64)
        .filter(|steps| (1..=16).contains(steps))
        .collect();
    if bar_lengths.is_empty() {
        return 0.5 * aligned;
    }
    bar_lengths.sort_unstable();
    let (mode, mode_count) = bar_lengths
        .iter()
        .map(|candidate| {
            let count = bar_lengths
                .iter()
                .filter(|value| *value == candidate)
                .count();
            (*candidate, count)
        })
        .max_by_key(|(_, count)| *count)
        .unwrap();
    let regularity = mode_count as f64 / bar_lengths.len() as f64;
    let meter_preference = match mode {
        3 | 4 => 1.0,
        6 => 0.80,
        2 => 0.65,
        8 => 0.55,
        _ => 0.35,
    };
    (0.5 * aligned + 0.5 * regularity * meter_preference).clamp(0.0, 1.0)
}

fn bpm_agreement(candidate: f64, dsp: f64) -> f64 {
    if !dsp.is_finite() || dsp <= 0.0 {
        return 0.0;
    }
    let log_distance = (candidate / dsp).ln().abs();
    (-0.5 * (log_distance / 0.05).powi(2)).exp().clamp(0.0, 1.0)
}

fn sustained_phase_drift(errors: &[f64]) -> f64 {
    if errors.len() < 16 {
        return 0.0;
    }
    let window = 8;
    let mut local = Vec::new();
    for chunk in errors.chunks(window) {
        let mut values = chunk.to_vec();
        local.push(median(&mut values));
    }
    let min = local.iter().copied().fold(f64::INFINITY, f64::min);
    let max = local.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (max - min).max(0.0)
}

fn build_tempo_segments(beats: &[f64], seed: f64) -> Vec<TempoSegment> {
    if beats.len() < 3 {
        return Vec::new();
    }
    let mut raw = Vec::new();
    let mut start = 0usize;
    while start + 2 < beats.len() {
        let end = (start + 16).min(beats.len() - 1);
        let mut normalized_intervals: Vec<f64> = beats[start..=end]
            .windows(2)
            .map(|pair| {
                let gap = pair[1] - pair[0];
                let steps = (gap / seed).round().clamp(1.0, 16.0);
                gap / steps
            })
            .collect();
        let period = median(&mut normalized_intervals);
        if period > 0.0 {
            raw.push(TempoSegment {
                start_seconds: beats[start],
                end_seconds: beats[end],
                bpm: 60.0 / period,
                beat_count: end - start + 1,
            });
        }
        start = end;
    }

    let mut merged: Vec<TempoSegment> = Vec::new();
    for segment in raw {
        if let Some(previous) = merged.last_mut() {
            let relative = (segment.bpm - previous.bpm).abs() / previous.bpm.max(1e-9);
            if relative <= 0.025 {
                let previous_weight = previous.beat_count as f64;
                let segment_weight = segment.beat_count as f64;
                previous.bpm = (previous.bpm * previous_weight + segment.bpm * segment_weight)
                    / (previous_weight + segment_weight);
                previous.end_seconds = segment.end_seconds;
                previous.beat_count += segment.beat_count.saturating_sub(1);
                continue;
            }
        }
        merged.push(segment);
    }
    for segment in &mut merged {
        segment.start_seconds = round_to(segment.start_seconds, 4);
        segment.end_seconds = round_to(segment.end_seconds, 4);
        segment.bpm = round_to(segment.bpm, 3);
    }
    merged
}

fn segment_variation(segments: &[TempoSegment]) -> f64 {
    if segments.len() < 2 {
        return 0.0;
    }
    let min = segments
        .iter()
        .map(|item| item.bpm)
        .fold(f64::INFINITY, f64::min);
    let max = segments
        .iter()
        .map(|item| item.bpm)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut bpms: Vec<f64> = segments.iter().map(|item| item.bpm).collect();
    (max - min) / median(&mut bpms).max(1e-9)
}

fn generate_grid(phase: f64, period: f64, start: f64, end: f64) -> Vec<f64> {
    let first_index = ((start - phase) / period).floor() as i64;
    let last_index = ((end - phase) / period).ceil() as i64;
    (first_index..=last_index)
        .map(|index| phase + index as f64 * period)
        .filter(|time| *time >= 0.0 && *time <= end + period)
        .map(|time| round_to(time, 4))
        .collect()
}

fn overall_confidence(
    detection: f64,
    grid: f64,
    metrical: f64,
    downbeat: Option<f64>,
    agreement: Option<f64>,
) -> f64 {
    let mut weighted = 0.25 * detection + 0.30 * grid + 0.25 * metrical;
    let mut total = 0.80;
    if let Some(value) = downbeat {
        weighted += 0.10 * value;
        total += 0.10;
    }
    if let Some(value) = agreement {
        weighted += 0.10 * value;
        total += 0.10;
    }
    round_to((weighted / total).clamp(0.0, 1.0), 4)
}

/// 把模型 logits 提供的检测证据合并进只基于时间点拟合得到的置信度。
#[cfg(all(
    feature = "beat-this",
    not(any(target_os = "android", target_os = "ios"))
))]
pub(crate) fn apply_detector_confidence(
    result: &mut BeatAnalysisResult,
    detection_evidence: f64,
    downbeat_evidence: Option<f64>,
    has_agreement: bool,
) {
    result.confidence.detection = round_to(
        0.5 * result.confidence.detection + 0.5 * detection_evidence.clamp(0.0, 1.0),
        4,
    );
    if let Some(evidence) = downbeat_evidence {
        result.confidence.downbeat = round_to(
            0.5 * result.confidence.downbeat + 0.5 * evidence.clamp(0.0, 1.0),
            4,
        );
    }
    result.confidence.overall = overall_confidence(
        result.confidence.detection,
        result.confidence.grid_regularity,
        result.confidence.metrical_level,
        downbeat_evidence.map(|_| result.confidence.downbeat),
        has_agreement.then_some(result.confidence.agreement),
    );
}

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beat_series(bpm: f64, count: usize, phase: f64) -> Vec<f64> {
        let period = 60.0 / bpm;
        (0..count)
            .map(|index| phase + index as f64 * period)
            .collect()
    }

    #[test]
    fn constant_four_four_track_produces_a_fixed_grid() {
        let mut beats = beat_series(128.0, 256, 0.137);
        for (index, beat) in beats.iter_mut().enumerate() {
            *beat += ((index % 5) as f64 - 2.0) * 0.002;
        }
        let downbeats: Vec<f64> = beats.iter().step_by(4).copied().collect();
        let result = fit_dj_grid(&beats, &downbeats, Some(128.1));

        assert_eq!(result.grid_mode, GridMode::Constant);
        assert!((result.predominant_bpm - 128.0).abs() < 0.1);
        assert_eq!(result.bpm_candidates[0].ratio, 1.0);
        assert!(result.bpm_candidates[0].beat_coverage > 0.99);
        assert!(result.bpm_candidates[0].downbeat_consistency > 0.95);
        assert!(result.grid_beats.len() >= beats.len());
        assert!(result.confidence.overall > 0.70);
    }

    #[test]
    fn double_tempo_candidate_is_penalized_for_empty_grid_slots() {
        let beats = beat_series(120.0, 128, 0.0);
        let downbeats: Vec<f64> = beats.iter().step_by(4).copied().collect();
        let result = fit_dj_grid(&beats, &downbeats, None);
        let normal = result
            .bpm_candidates
            .iter()
            .find(|candidate| candidate.ratio == 1.0)
            .unwrap();
        let double = result
            .bpm_candidates
            .iter()
            .find(|candidate| candidate.ratio == 2.0)
            .unwrap();
        assert_eq!(normal.grid_occupancy, 1.0);
        assert!((double.grid_occupancy - 0.5).abs() < 0.02);
        assert!(normal.score > double.score);
    }

    #[test]
    fn dsp_second_opinion_cannot_override_stronger_detected_beat_structure() {
        let mut beats = Vec::new();
        let mut time = 0.1;
        for index in 0..256 {
            beats.push(time);
            // 模拟现场鼓手从 220 缓慢漂到 235；传统 DSP 恰好落在约 0.75×。
            let bpm = 220.0 + 15.0 * index as f64 / 255.0;
            time += 60.0 / bpm;
        }
        let downbeats: Vec<f64> = beats.iter().step_by(4).copied().collect();
        let result = fit_dj_grid(&beats, &downbeats, Some(171.0));

        assert_eq!(result.bpm_candidates[0].ratio, 1.0, "{result:#?}");
        assert!(result
            .warnings
            .contains(&AnalysisWarning::AnalyzerDisagreement));
    }

    #[test]
    fn tempo_transition_is_not_flattened_into_a_fake_constant_grid() {
        let mut beats = beat_series(120.0, 96, 0.0);
        let start = *beats.last().unwrap() + 60.0 / 140.0;
        beats.extend(beat_series(140.0, 96, start));
        let downbeats: Vec<f64> = beats.iter().step_by(4).copied().collect();
        let result = fit_dj_grid(&beats, &downbeats, None);

        assert_eq!(result.grid_mode, GridMode::Variable);
        assert!(result.grid_beats.is_empty());
        assert!(result.tempo_segments.len() >= 2);
        assert!(result.warnings.contains(&AnalysisWarning::VariableTempo));
    }

    #[test]
    fn invalid_and_duplicate_events_are_removed() {
        let mut beats = beat_series(100.0, 32, 0.2);
        beats.extend([f64::NAN, -1.0, 0.2, 0.205]);
        let result = fit_dj_grid(&beats, &[], Some(100.0));
        assert_eq!(result.beats.len(), 32);
        assert_eq!(result.grid_mode, GridMode::Constant);
        assert!(result.warnings.contains(&AnalysisWarning::DownbeatWeak));
    }

    #[test]
    fn too_few_beats_are_reported_as_ambiguous() {
        let result = fit_dj_grid(&[0.2, 0.7], &[], None);
        assert_eq!(result.grid_mode, GridMode::Ambiguous);
        assert_eq!(result.predominant_bpm, 0.0);
        assert!(result
            .warnings
            .contains(&AnalysisWarning::InsufficientBeats));
    }
}
