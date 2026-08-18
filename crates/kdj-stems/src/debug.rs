//! Built-in audition workstation for model-free separation profiles.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::audio::decode_stereo;
use crate::classical::{
    separate_center, separate_hpss, separate_live, separate_mid_side, separate_transient_steady,
};
use crate::SAMPLE_RATE;

const WAVE_COLUMNS_PER_SECOND: usize = 100;
const MAX_WAVE_COLUMNS: usize = 24_000;
const BUILTIN_LICENSE: &str = "KDJ clean-room Rust DSP · GPL-3.0-or-later";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StemDebugModel {
    HybridCenterHpss,
    TransientSteady,
    MedianHpss,
    StereoCenter,
    MidSide,
}

#[derive(Clone, Copy)]
struct DebugProfile {
    id: StemDebugModel,
    name: &'static str,
    identity: &'static str,
    lanes: &'static [(&'static str, &'static str)],
}

const HYBRID_LANES: &[(&str, &str)] = &[
    ("transient", "TRANSIENT"),
    ("tonal", "TONAL"),
    ("vocal", "VOCAL"),
];
const TRANSIENT_LANES: &[(&str, &str)] = &[("transient", "TRANSIENT"), ("steady", "STEADY")];
const HPSS_LANES: &[(&str, &str)] = &[("harmonic", "HARMONIC"), ("percussive", "PERCUSSIVE")];
const CENTER_LANES: &[(&str, &str)] = &[("vocal", "VOCAL"), ("background", "BACKGROUND")];
const MID_SIDE_LANES: &[(&str, &str)] = &[("center", "MID"), ("sides", "SIDE")];

const PROFILES: &[DebugProfile] = &[
    DebugProfile {
        id: StemDebugModel::HybridCenterHpss,
        name: "Adobe-style Vocal Extractor + Median HPSS (Production)",
        identity: "dsp-v2.1-aggressive-adobe-vocal-hpss",
        lanes: HYBRID_LANES,
    },
    DebugProfile {
        id: StemDebugModel::TransientSteady,
        name: "Transient / Steady (Second Choice)",
        identity: "dsp-v1-transient-steady",
        lanes: TRANSIENT_LANES,
    },
    DebugProfile {
        id: StemDebugModel::MedianHpss,
        name: "Median HPSS",
        identity: "dsp-v1-median-hpss",
        lanes: HPSS_LANES,
    },
    DebugProfile {
        id: StemDebugModel::StereoCenter,
        name: "Adobe-style Vocal Extract / Remove",
        identity: "dsp-v2.1-aggressive-adobe-vocal-extract",
        lanes: CENTER_LANES,
    },
    DebugProfile {
        id: StemDebugModel::MidSide,
        name: "Classic Mid / Side",
        identity: "dsp-v1-mid-side",
        lanes: MID_SIDE_LANES,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugModelStatus {
    pub id: StemDebugModel,
    pub name: String,
    pub ready: bool,
    pub sha256: String,
    pub bytes: u64,
    pub path: String,
    pub license: String,
    pub lanes: Vec<StemDebugLane>,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugModelCatalog {
    pub configured: bool,
    pub root: String,
    pub models: Vec<StemDebugModelStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugLane {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugWaveforms {
    pub original: Vec<f32>,
    pub sum: Vec<f32>,
    pub lanes: BTreeMap<String, Vec<f32>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemDebugRender {
    pub model_id: StemDebugModel,
    pub model_name: String,
    pub model_sha256: String,
    pub model_license: String,
    pub lanes: Vec<StemDebugLane>,
    pub sample_rate: u32,
    pub frames: usize,
    pub duration: f64,
    pub analysis_total_ms: f64,
    pub realtime_factor: f64,
    pub inference_chunks: usize,
    pub inference_total_ms: f64,
    pub inference_mean_ms: f64,
    pub inference_p95_ms: f64,
    pub inference_max_ms: f64,
    pub reconstruction_rms_error: f64,
    pub reconstruction_peak_error: f64,
    pub waveforms: StemDebugWaveforms,
}

pub fn stem_debug_model_catalog() -> StemDebugModelCatalog {
    StemDebugModelCatalog {
        configured: true,
        root: "built-in://classical-dsp".into(),
        models: PROFILES
            .iter()
            .map(|profile| StemDebugModelStatus {
                id: profile.id,
                name: profile.name.into(),
                ready: true,
                sha256: profile.identity.into(),
                bytes: 0,
                path: String::new(),
                license: BUILTIN_LICENSE.into(),
                lanes: profile_lanes(*profile),
                error: String::new(),
            })
            .collect(),
    }
}

pub fn render_stem_debug(
    model: StemDebugModel,
    source: &Path,
    output_dir: &Path,
    max_duration: Option<f64>,
) -> Result<StemDebugRender> {
    let profile = profile(model);
    fs::create_dir_all(output_dir)
        .with_context(|| format!("建立 Stem 调试目录失败：{}", output_dir.display()))?;
    let decoded = decode_stereo(source)?;
    let available = decoded.left.len().min(decoded.right.len());
    let limit = max_duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| (duration * f64::from(SAMPLE_RATE)).round() as usize)
        .unwrap_or(available);
    let frames = available.min(limit);
    if frames == 0 {
        bail!("Stem 调试音频为空");
    }
    let left = &decoded.left[..frames];
    let right = &decoded.right[..frames];
    let started = Instant::now();
    let stereo_lanes = match model {
        StemDebugModel::HybridCenterHpss => {
            let [transient, _compatibility, tonal, vocal] = separate_live(left, right)?;
            vec![transient, tonal, vocal]
        }
        StemDebugModel::TransientSteady => separate_transient_steady(left, right)?,
        StemDebugModel::MedianHpss => separate_hpss(left, right)?,
        StemDebugModel::StereoCenter => separate_center(left, right)?,
        StemDebugModel::MidSide => separate_mid_side(left, right)?,
    };
    let analysis_total_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let lanes: Vec<(&str, Vec<f32>)> = profile
        .lanes
        .iter()
        .zip(stereo_lanes)
        .map(|((id, _), samples)| (*id, interleave_stereo(&samples)))
        .collect();
    let original = interleave(left, right);
    let sum = sum_lanes(&lanes);
    let (rms_error, peak_error) = reconstruction_error(&original, &sum);
    write_float_wav(&output_dir.join("original.wav"), &original)?;
    for (id, samples) in &lanes {
        write_float_wav(&output_dir.join(format!("{id}.wav")), samples)?;
    }
    let duration = frames as f64 / f64::from(SAMPLE_RATE);
    let columns =
        ((duration * WAVE_COLUMNS_PER_SECOND as f64).ceil() as usize).clamp(1, MAX_WAVE_COLUMNS);
    let lane_waves = lanes
        .iter()
        .map(|(id, samples)| ((*id).into(), peak_waveform(samples, columns)))
        .collect();
    // The workstation intentionally renders the selected excerpt in one offline pass. Production
    // chunk timing is measured separately by the live worker diagnostics and release benchmark.
    let chunks = 1;
    Ok(StemDebugRender {
        model_id: model,
        model_name: profile.name.into(),
        model_sha256: profile.identity.into(),
        model_license: BUILTIN_LICENSE.into(),
        lanes: profile_lanes(profile),
        sample_rate: SAMPLE_RATE,
        frames,
        duration,
        analysis_total_ms,
        realtime_factor: analysis_total_ms / (duration * 1_000.0),
        inference_chunks: chunks,
        inference_total_ms: analysis_total_ms,
        inference_mean_ms: analysis_total_ms / chunks.max(1) as f64,
        inference_p95_ms: analysis_total_ms / chunks.max(1) as f64,
        inference_max_ms: analysis_total_ms,
        reconstruction_rms_error: rms_error,
        reconstruction_peak_error: peak_error,
        waveforms: StemDebugWaveforms {
            original: peak_waveform(&original, columns),
            sum: peak_waveform(&sum, columns),
            lanes: lane_waves,
        },
    })
}

fn profile(model: StemDebugModel) -> DebugProfile {
    *PROFILES
        .iter()
        .find(|profile| profile.id == model)
        .expect("all debug profiles are catalogued")
}

fn profile_lanes(profile: DebugProfile) -> Vec<StemDebugLane> {
    profile
        .lanes
        .iter()
        .map(|(id, label)| StemDebugLane {
            id: (*id).into(),
            label: (*label).into(),
        })
        .collect()
}

fn interleave(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter()
        .zip(right)
        .flat_map(|(&left, &right)| [finite(left), finite(right)])
        .collect()
}

fn interleave_stereo(samples: &[[f32; 2]]) -> Vec<f32> {
    samples
        .iter()
        .flat_map(|sample| [finite(sample[0]), finite(sample[1])])
        .collect()
}

fn sum_lanes(lanes: &[(&str, Vec<f32>)]) -> Vec<f32> {
    let len = lanes.iter().map(|(_, lane)| lane.len()).min().unwrap_or(0);
    (0..len)
        .map(|index| lanes.iter().map(|(_, lane)| lane[index]).sum())
        .collect()
}

fn reconstruction_error(original: &[f32], sum: &[f32]) -> (f64, f64) {
    let count = original.len().min(sum.len());
    let mut squared = 0.0_f64;
    let mut peak = 0.0_f64;
    for index in 0..count {
        let error = f64::from(sum[index]) - f64::from(original[index]);
        squared += error * error;
        peak = peak.max(error.abs());
    }
    ((squared / count.max(1) as f64).sqrt(), peak)
}

fn peak_waveform(interleaved: &[f32], columns: usize) -> Vec<f32> {
    let frames = interleaved.len() / 2;
    if frames == 0 || columns == 0 {
        return Vec::new();
    }
    let width = frames.div_ceil(columns);
    (0..columns)
        .map(|column| {
            let start = column * width;
            let end = (start + width).min(frames);
            (start..end)
                .flat_map(|frame| [interleaved[frame * 2], interleaved[frame * 2 + 1]])
                .map(f32::abs)
                .fold(0.0_f32, f32::max)
        })
        .collect()
}

fn write_float_wav(path: &Path, samples: &[f32]) -> Result<()> {
    let data_bytes = u32::try_from(samples.len().saturating_mul(4))
        .context("Stem 调试 WAV 超过 RIFF 4 GB 上限")?;
    let mut writer = BufWriter::new(
        File::create(path).with_context(|| format!("建立 {} 失败", path.display()))?,
    );
    writer.write_all(b"RIFF")?;
    writer.write_all(&(36_u32.saturating_add(data_bytes)).to_le_bytes())?;
    writer.write_all(b"WAVEfmt ")?;
    writer.write_all(&16_u32.to_le_bytes())?;
    writer.write_all(&3_u16.to_le_bytes())?;
    writer.write_all(&2_u16.to_le_bytes())?;
    writer.write_all(&SAMPLE_RATE.to_le_bytes())?;
    writer.write_all(&(SAMPLE_RATE * 2 * 4).to_le_bytes())?;
    writer.write_all(&(2_u16 * 4).to_le_bytes())?;
    writer.write_all(&32_u16.to_le_bytes())?;
    writer.write_all(b"data")?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    for sample in samples {
        writer.write_all(&finite(*sample).to_le_bytes())?;
    }
    writer.flush()?;
    Ok(())
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_built_in_profiles_are_ready_without_model_directory() {
        let catalog = stem_debug_model_catalog();
        assert!(catalog.configured);
        assert_eq!(catalog.models.len(), 5);
        assert!(catalog
            .models
            .iter()
            .all(|profile| profile.ready && profile.bytes == 0));
    }
}
