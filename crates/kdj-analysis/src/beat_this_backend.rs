//! Beat This 的桌面实验后端。
//!
//! 模型检测与 DJ 网格拟合刻意分层：这里保留逐帧概率与原始 beat/downbeat，最终固定
//! 网格由 `dj_grid` 生成。默认构建不启用本模块；使用 `--features beat-this` 编译。

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use beat_this::{BeatThis, RtenRuntime, Runtime};
use serde::{Deserialize, Serialize};

use crate::decode::{decode_audio, DEFAULT_SR};
use crate::dj_grid::{apply_detector_confidence, fit_dj_grid_with_metadata, BeatAnalysisResult};
use crate::tempo::analyze_tempo;

type RtenBeatThis = BeatThis<<RtenRuntime as Runtime>::Model>;

pub const BEAT_THIS_FRAME_RATE: f64 = 50.0;
pub const BEAT_THIS_BACKEND_VERSION: &str = "beat-this-rs-1.0.0+kdj-grid-v1";

/// Beat This 原始感知输出 + DJ 后处理结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatThisGridAnalysis {
    pub grid: BeatAnalysisResult,
    /// sigmoid 后的逐帧 beat 概率，50 fps。
    pub beat_probabilities: Vec<f32>,
    /// sigmoid 后的逐帧 downbeat 概率，50 fps。
    pub downbeat_probabilities: Vec<f32>,
    pub probability_frame_rate: f64,
    pub model_name: String,
}

/// 模型在 analyzer 生命周期内只加载一次；批量分析时必须复用实例。
pub struct BeatThisAnalyzer {
    tracker: RtenBeatThis,
    model_name: String,
}

impl BeatThisAnalyzer {
    pub fn new(mel_model_path: &Path, beat_model_path: &Path) -> Result<Self> {
        let tracker =
            BeatThis::new(&RtenRuntime, mel_model_path, beat_model_path).with_context(|| {
                format!(
                    "加载 Beat This 模型失败：mel={} beat={}",
                    mel_model_path.display(),
                    beat_model_path.display()
                )
            })?;
        let model_name = beat_model_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("beat_this")
            .to_string();
        Ok(Self {
            tracker,
            model_name,
        })
    }

    /// 运行模型并用调用方已有的传统 DSP BPM 作为第二意见。
    pub fn analyze_audio(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        dsp_bpm: Option<f64>,
    ) -> Result<BeatThisGridAnalysis> {
        let detected = self
            .tracker
            .analyze_audio(samples, sample_rate)
            .context("Beat This 推理失败")?;
        let beats: Vec<f64> = detected
            .beats
            .iter()
            .map(|value| f64::from(*value))
            .collect();
        let downbeats: Vec<f64> = detected
            .downbeats
            .iter()
            .map(|value| f64::from(*value))
            .collect();
        let mut grid = fit_dj_grid_with_metadata(
            &beats,
            &downbeats,
            dsp_bpm,
            "beat-this-rs-rten",
            BEAT_THIS_BACKEND_VERSION,
        );

        let beat_probabilities: Vec<f32> = detected
            .beat_logits
            .iter()
            .map(|value| sigmoid(*value))
            .collect();
        let downbeat_probabilities: Vec<f32> = detected
            .downbeat_logits
            .iter()
            .map(|value| sigmoid(*value))
            .collect();
        let beat_evidence = mean_event_probability(&beats, &beat_probabilities);
        let downbeat_evidence = (!downbeats.is_empty())
            .then(|| mean_event_probability(&downbeats, &downbeat_probabilities));
        apply_detector_confidence(
            &mut grid,
            beat_evidence,
            downbeat_evidence,
            dsp_bpm.is_some(),
        );

        Ok(BeatThisGridAnalysis {
            grid,
            beat_probabilities,
            downbeat_probabilities,
            probability_frame_rate: BEAT_THIS_FRAME_RATE,
            model_name: self.model_name.clone(),
        })
    }

    /// 全曲解码，并现场运行当前传统 DSP 作为第二意见。
    pub fn analyze_file(&mut self, path: &Path) -> Result<BeatThisGridAnalysis> {
        let decoded = decode_audio(path, DEFAULT_SR, None)
            .with_context(|| format!("解码 Beat This 输入失败：{}", path.display()))?;
        let tempo = analyze_tempo(&decoded.samples, f64::from(decoded.sample_rate));
        let dsp_bpm = (tempo.bpm > 0.0).then_some(tempo.bpm);
        self.analyze_audio(&decoded.samples, decoded.sample_rate, dsp_bpm)
    }
}

/// 两个模型资源应由 Tauri 解析后把绝对路径传进来；这个结构方便启动时一次校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeatThisModelPaths {
    pub mel: PathBuf,
    pub beat: PathBuf,
}

impl BeatThisModelPaths {
    pub fn validate(&self) -> Result<()> {
        for path in [&self.mel, &self.beat] {
            anyhow::ensure!(path.is_file(), "Beat This 模型不存在：{}", path.display());
        }
        Ok(())
    }
}

fn sigmoid(value: f32) -> f32 {
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let exp = value.exp();
        exp / (1.0 + exp)
    }
}

fn mean_event_probability(events: &[f64], probabilities: &[f32]) -> f64 {
    if events.is_empty() || probabilities.is_empty() {
        return 0.0;
    }
    let sum = events
        .iter()
        .map(|time| {
            let frame = (time * BEAT_THIS_FRAME_RATE).round().max(0.0) as usize;
            probabilities
                .get(frame.min(probabilities.len() - 1))
                .copied()
                .unwrap_or(0.0) as f64
        })
        .sum::<f64>();
    (sum / events.len() as f64).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_is_stable_at_extreme_logits() {
        assert!(sigmoid(100.0).is_finite());
        assert!(sigmoid(-100.0).is_finite());
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn event_evidence_samples_the_fifty_fps_probability_track() {
        let mut probabilities = vec![0.0; 101];
        probabilities[25] = 0.8;
        probabilities[50] = 1.0;
        let evidence = mean_event_probability(&[0.5, 1.0], &probabilities);
        assert!((evidence - 0.9).abs() < 1e-6);
    }
}
