//! Isolated offline audition for externally supplied source-separation candidates.
//!
//! Candidate artifacts are never installed or packaged by KDJ. The debug page reads a local
//! directory selected through `KDJ_STEM_DEBUG_MODEL_DIR`, verifies each exact artifact hash, and
//! writes disposable float WAVs without sharing the live Deck Stem coordinator.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use rustfft::num_complex::Complex32;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::audio::decode_stereo;
use crate::debug_dsp::{istft, reflect_pad, stft, DebugSpectrum, DebugWindow};
use crate::SAMPLE_RATE;

const WAVE_COLUMNS_PER_SECOND: usize = 100;
const MAX_WAVE_COLUMNS: usize = 24_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StemDebugModel {
    ScnetTran,
    BsPolarformer,
}

#[derive(Clone, Copy)]
struct DebugModelSpec {
    id: StemDebugModel,
    name: &'static str,
    relative_path: &'static str,
    sha256: &'static str,
    bytes: u64,
    license: &'static str,
    lane_labels: &'static [(&'static str, &'static str)],
}

const FOUR_LANES: &[(&str, &str)] = &[
    ("drums", "DRUMS"),
    ("bass", "BASS"),
    ("other", "OTHER"),
    ("vocals", "VOCALS"),
];
const TWO_LANES: &[(&str, &str)] = &[("vocals", "VOCALS"), ("instrumental", "INSTRUMENTAL")];
const MODEL_SPECS: &[DebugModelSpec] = &[
    DebugModelSpec {
        id: StemDebugModel::ScnetTran,
        name: "SCNet Tran ONNX 2.75s",
        relative_path: "scnet-tran/scnet-tran-core-2.75s-v1.onnx",
        sha256: "e2c6e2807e1deb937150c2c2d21db57b597388a67460706242e6f23a2d8f9c56",
        bytes: 47_200_340,
        license: "WEIGHTS LICENSE UNVERIFIED · SOURCE MIT",
        lane_labels: FOUR_LANES,
    },
    DebugModelSpec {
        id: StemDebugModel::BsPolarformer,
        name: "BS PolarFormer FP16 ONNX",
        relative_path: "bs-polarformer/bs_polarformer_fp16.onnx",
        sha256: "76424289ea586bae4bbdb289383b0269b099416471e2b05068d02aa0b0c01467",
        bytes: 108_325_429,
        license: "WEIGHTS LICENSE UNVERIFIED · CODE MIT",
        lane_labels: TWO_LANES,
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

struct Separation {
    lanes: Vec<(&'static str, Vec<f32>)>,
    timings_ms: Vec<f64>,
}

pub fn stem_debug_model_root() -> Option<PathBuf> {
    std::env::var_os("KDJ_STEM_DEBUG_MODEL_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn stem_debug_model_catalog() -> StemDebugModelCatalog {
    let root = stem_debug_model_root();
    let models = MODEL_SPECS
        .iter()
        .map(|spec| model_status(root.as_deref(), *spec))
        .collect();
    StemDebugModelCatalog {
        configured: root.is_some(),
        root: root
            .as_deref()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        models,
    }
}

fn model_status(root: Option<&Path>, spec: DebugModelSpec) -> StemDebugModelStatus {
    let path = root
        .map(|root| root.join(spec.relative_path))
        .unwrap_or_else(|| PathBuf::from(spec.relative_path));
    let (ready, error) = if root.is_none() {
        (false, "KDJ_STEM_DEBUG_MODEL_DIR 未配置".into())
    } else {
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() == spec.bytes => {
                (true, String::new())
            }
            Ok(metadata) if metadata.is_file() => (
                false,
                format!("文件大小 {} != {}", metadata.len(), spec.bytes),
            ),
            Ok(_) => (false, "模型路径不是文件".into()),
            Err(error) => (false, format!("模型不可读：{error}")),
        }
    };
    StemDebugModelStatus {
        id: spec.id,
        name: spec.name.into(),
        ready,
        sha256: spec.sha256.into(),
        bytes: spec.bytes,
        path: if root.is_some() {
            path.to_string_lossy().into_owned()
        } else {
            String::new()
        },
        license: spec.license.into(),
        lanes: spec
            .lane_labels
            .iter()
            .map(|(id, label)| StemDebugLane {
                id: (*id).into(),
                label: (*label).into(),
            })
            .collect(),
        error,
    }
}

pub fn render_stem_debug(
    model: StemDebugModel,
    source: &Path,
    output_dir: &Path,
    max_duration: Option<f64>,
) -> Result<StemDebugRender> {
    let spec = model_spec(model);
    let root = stem_debug_model_root().context("KDJ_STEM_DEBUG_MODEL_DIR 未配置")?;
    let model_path = root.join(spec.relative_path);
    verify_model(&model_path, spec)?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("建立 Stem 调试目录失败：{}", output_dir.display()))?;

    let decoded = decode_stereo(source)?;
    let available_frames = decoded.left.len().min(decoded.right.len());
    let frame_limit = max_duration
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .map(|duration| (duration * f64::from(SAMPLE_RATE)).round() as usize)
        .unwrap_or(available_frames);
    let frames = available_frames.min(frame_limit);
    if frames == 0 {
        bail!("Stem 调试音频为空");
    }
    let left = &decoded.left[..frames];
    let right = &decoded.right[..frames];
    let analysis_started = Instant::now();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let separation = match model {
        StemDebugModel::ScnetTran => ScnetTranEngine::load(&model_path)?.separate(left, right)?,
        StemDebugModel::BsPolarformer => {
            PolarformerEngine::load(&model_path)?.separate(left, right)?
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let separation: Separation = {
        let _ = (model_path, left, right);
        bail!("当前平台没有候选模型调试 runtime")
    };
    let analysis_total_ms = analysis_started.elapsed().as_secs_f64() * 1_000.0;

    let original = interleave(left, right);
    let sum = sum_lanes(&separation.lanes);
    let (rms_error, peak_error) = reconstruction_error(&original, &sum);
    write_float_wav(&output_dir.join("original.wav"), &original)?;
    for (id, samples) in &separation.lanes {
        write_float_wav(&output_dir.join(format!("{id}.wav")), samples)?;
    }

    let duration = frames as f64 / f64::from(SAMPLE_RATE);
    let columns =
        ((duration * WAVE_COLUMNS_PER_SECOND as f64).ceil() as usize).clamp(1, MAX_WAVE_COLUMNS);
    let mut lane_waves = BTreeMap::new();
    for (id, samples) in &separation.lanes {
        lane_waves.insert((*id).into(), peak_waveform(samples, columns));
    }
    let (inference_total_ms, mean, p95, maximum) = timing_summary(&separation.timings_ms);

    Ok(StemDebugRender {
        model_id: model,
        model_name: spec.name.into(),
        model_sha256: spec.sha256.into(),
        model_license: spec.license.into(),
        lanes: spec
            .lane_labels
            .iter()
            .map(|(id, label)| StemDebugLane {
                id: (*id).into(),
                label: (*label).into(),
            })
            .collect(),
        sample_rate: SAMPLE_RATE,
        frames,
        duration,
        analysis_total_ms,
        realtime_factor: analysis_total_ms / (duration * 1_000.0),
        inference_chunks: separation.timings_ms.len(),
        inference_total_ms,
        inference_mean_ms: mean,
        inference_p95_ms: p95,
        inference_max_ms: maximum,
        reconstruction_rms_error: rms_error,
        reconstruction_peak_error: peak_error,
        waveforms: StemDebugWaveforms {
            original: peak_waveform(&original, columns),
            sum: peak_waveform(&sum, columns),
            lanes: lane_waves,
        },
    })
}

fn model_spec(model: StemDebugModel) -> DebugModelSpec {
    *MODEL_SPECS
        .iter()
        .find(|spec| spec.id == model)
        .expect("all debug model IDs have a spec")
}

fn verify_model(path: &Path, spec: DebugModelSpec) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("读取候选模型失败：{}", path.display()))?;
    if metadata.len() != spec.bytes {
        bail!(
            "{} 文件大小 {} != {}",
            spec.name,
            metadata.len(),
            spec.bytes
        );
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = hex::encode(digest.finalize());
    if actual != spec.sha256 {
        bail!("{} SHA-256 不匹配：{actual}", spec.name);
    }
    Ok(())
}

fn interleave(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter()
        .zip(right)
        .flat_map(|(&left, &right)| [finite(left), finite(right)])
        .collect()
}

fn sum_lanes(lanes: &[(&str, Vec<f32>)]) -> Vec<f32> {
    let len = lanes
        .iter()
        .map(|(_, samples)| samples.len())
        .min()
        .unwrap_or(0);
    (0..len)
        .map(|index| lanes.iter().map(|(_, samples)| samples[index]).sum())
        .collect()
}

fn reconstruction_error(original: &[f32], sum: &[f32]) -> (f64, f64) {
    let mut squared = 0.0_f64;
    let mut peak = 0.0_f64;
    let count = original.len().min(sum.len());
    for index in 0..count {
        let error = f64::from(sum[index]) - f64::from(original[index]);
        squared += error * error;
        peak = peak.max(error.abs());
    }
    ((squared / count.max(1) as f64).sqrt(), peak)
}

fn timing_summary(timings: &[f64]) -> (f64, f64, f64, f64) {
    let total = timings.iter().sum::<f64>();
    let mean = total / timings.len().max(1) as f64;
    let mut sorted = timings.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len().saturating_sub(1)) as f64 * 0.95).round() as usize;
    let p95 = sorted.get(index).copied().unwrap_or(0.0);
    let maximum = timings.iter().copied().fold(0.0, f64::max);
    (total, mean, p95, maximum)
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_debug_session(path: &Path, name: &str) -> Result<ort::session::Session> {
    let builder = ort_debug_result(ort::session::Session::builder(), "创建候选模型 ORT session")?;
    let builder = ort_debug_result(builder.with_intra_threads(4), "配置候选模型 ORT 线程")?;
    let mut builder = ort_debug_result(builder.with_inter_threads(1), "配置候选模型 inter-op")?;
    ort_debug_result(builder.commit_from_file(path), &format!("加载 {name}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn extract_tensor(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Result<(Vec<i64>, Vec<f32>)> {
    let value = outputs
        .get(name)
        .with_context(|| format!("候选模型缺少输出 {name}"))?;
    let (shape, data) = ort_debug_result(value.try_extract_tensor::<f32>(), name)?;
    if data.iter().any(|value| !value.is_finite()) {
        bail!("候选模型输出 {name} 含非有限数值");
    }
    Ok((shape.to_vec(), data.to_vec()))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn ort_debug_result<T, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
    action: &str,
) -> Result<T> {
    result.map_err(|error| anyhow::anyhow!("{action}: {error}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct ScnetTranEngine {
    session: ort::session::Session,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl ScnetTranEngine {
    const CHUNK: usize = 121_275;
    const STEP: usize = 60_637;
    const MODEL_SAMPLES: usize = 121_856;
    const FADE: usize = 12_127;
    const N_FFT: usize = 4_096;
    const HOP: usize = 1_024;

    fn load(path: &Path) -> Result<Self> {
        Ok(Self {
            session: load_debug_session(path, "SCNet Tran")?,
        })
    }

    fn separate(mut self, left: &[f32], right: &[f32]) -> Result<Separation> {
        let padding = Self::CHUNK - Self::STEP;
        let padded_left = reflect_pad(left, padding);
        let padded_right = reflect_pad(right, padding);
        let starts = chunk_starts(padded_left.len(), Self::CHUNK, Self::STEP);
        let mut outputs = vec![vec![0.0_f32; padded_left.len() * 2]; 4];
        let mut weights = vec![0.0_f32; padded_left.len()];
        let mut timings = Vec::with_capacity(starts.len());
        for (chunk_index, &start) in starts.iter().enumerate() {
            let mut chunk_left = vec![0.0_f32; Self::MODEL_SAMPLES];
            let mut chunk_right = vec![0.0_f32; Self::MODEL_SAMPLES];
            let copied = Self::CHUNK.min(padded_left.len().saturating_sub(start));
            chunk_left[..copied].copy_from_slice(&padded_left[start..start + copied]);
            chunk_right[..copied].copy_from_slice(&padded_right[start..start + copied]);
            let left_spec = stft(
                &chunk_left,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Rectangular,
                true,
                true,
            );
            let right_spec = stft(
                &chunk_right,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Rectangular,
                true,
                true,
            );
            if left_spec.bins != 2_049 || left_spec.frames != 120 {
                bail!(
                    "SCNet Tran STFT shape [{}, {}] != [2049, 120]",
                    left_spec.bins,
                    left_spec.frames
                );
            }
            let input = pack_channel_complex(&left_spec, &right_spec, left_spec.bins);
            let started = Instant::now();
            let ort_outputs = ort_debug_result(
                self.session.run(ort::inputs![
                    "spec" => ort_debug_result(
                        ort::value::Tensor::from_array(([1_usize, 4, 2_049, 120], input)),
                        "SCNet Tran spec tensor",
                    )?
                ]),
                "执行 SCNet Tran",
            )?;
            timings.push(started.elapsed().as_secs_f64() * 1_000.0);
            let (shape, predicted) = extract_tensor(&ort_outputs, "out")?;
            if shape != [8, 2_049, 120, 2] {
                bail!("SCNet Tran out shape {shape:?} != [8, 2049, 120, 2]");
            }

            let available = Self::CHUNK.min(padded_left.len().saturating_sub(start));
            for frame in 0..available {
                let fade_in = if chunk_index > 0 && frame < Self::FADE {
                    frame as f32 / Self::FADE as f32
                } else {
                    1.0
                };
                let remaining = available - 1 - frame;
                let fade_out = if chunk_index + 1 < starts.len() && remaining < Self::FADE {
                    remaining as f32 / Self::FADE as f32
                } else {
                    1.0
                };
                weights[start + frame] += fade_in.min(fade_out);
            }
            for stem in 0..4 {
                let mut channels = [Vec::new(), Vec::new()];
                for channel in 0..2 {
                    let mut spectrum = vec![Complex32::default(); 2_049 * 120];
                    let source_index = stem * 2 + channel;
                    for frequency in 0..2_049 {
                        for time in 0..120 {
                            let index =
                                (((source_index * 2_049 + frequency) * 120 + time) * 2) as usize;
                            spectrum[frequency * 120 + time] =
                                Complex32::new(predicted[index], predicted[index + 1]);
                        }
                    }
                    channels[channel] = istft(
                        &spectrum,
                        2_049,
                        120,
                        Self::N_FFT,
                        Self::HOP,
                        DebugWindow::Rectangular,
                        true,
                        true,
                        Self::MODEL_SAMPLES,
                    );
                }
                for frame in 0..available {
                    let fade_in = if chunk_index > 0 && frame < Self::FADE {
                        frame as f32 / Self::FADE as f32
                    } else {
                        1.0
                    };
                    let remaining = available - 1 - frame;
                    let fade_out = if chunk_index + 1 < starts.len() && remaining < Self::FADE {
                        remaining as f32 / Self::FADE as f32
                    } else {
                        1.0
                    };
                    let weight = fade_in.min(fade_out);
                    outputs[stem][(start + frame) * 2] += channels[0][frame] * weight;
                    outputs[stem][(start + frame) * 2 + 1] += channels[1][frame] * weight;
                }
            }
        }
        for stem in &mut outputs {
            for frame in 0..weights.len() {
                if weights[frame] > 1e-8 {
                    stem[frame * 2] /= weights[frame];
                    stem[frame * 2 + 1] /= weights[frame];
                }
            }
            *stem = stem[padding * 2..(padding + left.len()) * 2].to_vec();
        }
        Ok(Separation {
            lanes: vec![
                ("drums", outputs.remove(0)),
                ("bass", outputs.remove(0)),
                ("other", outputs.remove(0)),
                ("vocals", outputs.remove(0)),
            ],
            timings_ms: timings,
        })
    }
}

fn pack_channel_complex(left: &DebugSpectrum, right: &DebugSpectrum, bins: usize) -> Vec<f32> {
    let frames = left.frames.min(right.frames);
    let mut input = vec![0.0_f32; 4 * bins * frames];
    for frequency in 0..bins {
        for time in 0..frames {
            let source = frequency * frames + time;
            for (channel, value) in [left.values[source], right.values[source]]
                .into_iter()
                .enumerate()
            {
                input[((channel * 2) * bins + frequency) * frames + time] = value.re;
                input[((channel * 2 + 1) * bins + frequency) * frames + time] = value.im;
            }
        }
    }
    input
}

fn chunk_starts(total: usize, chunk: usize, step: usize) -> Vec<usize> {
    if total <= chunk {
        return vec![0];
    }
    let mut starts = Vec::new();
    let mut start = 0;
    while start + chunk <= total {
        starts.push(start);
        start += step;
    }
    let last = total - chunk;
    if starts.last().copied() != Some(last) {
        starts.push(last);
    }
    starts
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PolarformerEngine {
    session: ort::session::Session,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl PolarformerEngine {
    const CHUNK: usize = 131_072;
    const STEP: usize = Self::CHUNK / 2;
    const N_FFT: usize = 2_048;
    const HOP: usize = 512;
    const BINS: usize = 1_025;
    const FRAMES: usize = 253;

    fn load(path: &Path) -> Result<Self> {
        Ok(Self {
            session: load_debug_session(path, "BS PolarFormer FP16")?,
        })
    }

    fn separate(mut self, left: &[f32], right: &[f32]) -> Result<Separation> {
        let starts = (0..left.len()).step_by(Self::STEP).collect::<Vec<_>>();
        let mut vocals_left = vec![0.0_f32; left.len()];
        let mut vocals_right = vec![0.0_f32; left.len()];
        let mut weights = vec![0.0_f32; left.len()];
        let mut timings = Vec::with_capacity(starts.len());
        for &start in &starts {
            let copied = Self::CHUNK.min(left.len() - start);
            let mut chunk_left = vec![0.0_f32; Self::CHUNK];
            let mut chunk_right = vec![0.0_f32; Self::CHUNK];
            chunk_left[..copied].copy_from_slice(&left[start..start + copied]);
            chunk_right[..copied].copy_from_slice(&right[start..start + copied]);
            let left_spec = stft(
                &chunk_left,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Hann,
                false,
                false,
            );
            let right_spec = stft(
                &chunk_right,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Hann,
                false,
                false,
            );
            if left_spec.frames != Self::FRAMES || left_spec.bins != Self::BINS {
                bail!(
                    "BS PolarFormer STFT shape [{}, {}] != [1025, 253]",
                    left_spec.bins,
                    left_spec.frames
                );
            }
            let mut input = vec![0.0_f32; Self::FRAMES * Self::BINS * 4];
            for time in 0..Self::FRAMES {
                for frequency in 0..Self::BINS {
                    let source = frequency * Self::FRAMES + time;
                    let base = time * Self::BINS * 4 + frequency * 4;
                    input[base] = left_spec.values[source].re;
                    input[base + 1] = left_spec.values[source].im;
                    input[base + 2] = right_spec.values[source].re;
                    input[base + 3] = right_spec.values[source].im;
                }
            }
            let started = Instant::now();
            let ort_outputs = ort_debug_result(
                self.session.run(ort::inputs![
                    "stft_features" => ort_debug_result(
                        ort::value::Tensor::from_array(
                            ([1_usize, Self::FRAMES, Self::BINS * 4], input),
                        ),
                        "BS PolarFormer input tensor",
                    )?
                ]),
                "执行 BS PolarFormer",
            )?;
            timings.push(started.elapsed().as_secs_f64() * 1_000.0);
            let (shape, mask) = extract_tensor(&ort_outputs, "mask")?;
            if shape != [1, 1, 2_050, Self::FRAMES as i64, 2] {
                bail!(
                    "BS PolarFormer mask shape {shape:?} != [1, 1, 2050, {}, 2]",
                    Self::FRAMES
                );
            }
            let mut masked_left = vec![Complex32::default(); Self::BINS * Self::FRAMES];
            let mut masked_right = vec![Complex32::default(); Self::BINS * Self::FRAMES];
            for frequency in 0..Self::BINS {
                for time in 0..Self::FRAMES {
                    let source = frequency * Self::FRAMES + time;
                    let left_mask_index = ((frequency * 2) * Self::FRAMES + time) * 2;
                    let right_mask_index = ((frequency * 2 + 1) * Self::FRAMES + time) * 2;
                    let left_mask =
                        Complex32::new(mask[left_mask_index], mask[left_mask_index + 1]);
                    let right_mask =
                        Complex32::new(mask[right_mask_index], mask[right_mask_index + 1]);
                    masked_left[source] = left_spec.values[source] * left_mask;
                    masked_right[source] = right_spec.values[source] * right_mask;
                }
            }
            for time in 0..Self::FRAMES {
                masked_left[time] = Complex32::default();
                masked_right[time] = Complex32::default();
            }
            let separated_left = istft(
                &masked_left,
                Self::BINS,
                Self::FRAMES,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Hann,
                false,
                false,
                Self::CHUNK,
            );
            let separated_right = istft(
                &masked_right,
                Self::BINS,
                Self::FRAMES,
                Self::N_FFT,
                Self::HOP,
                DebugWindow::Hann,
                false,
                false,
                Self::CHUNK,
            );
            for frame in 0..copied {
                vocals_left[start + frame] += separated_left[frame];
                vocals_right[start + frame] += separated_right[frame];
                weights[start + frame] += 1.0;
            }
        }
        for frame in 0..left.len() {
            if weights[frame] > 0.0 {
                vocals_left[frame] /= weights[frame];
                vocals_right[frame] /= weights[frame];
            }
        }
        let vocals = interleave(&vocals_left, &vocals_right);
        let original = interleave(left, right);
        let instrumental = original
            .iter()
            .zip(&vocals)
            .map(|(mix, vocal)| mix - vocal)
            .collect();
        Ok(Separation {
            lanes: vec![("vocals", vocals), ("instrumental", instrumental)],
            timings_ms: timings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn residual_pair_reconstructs_source() {
        let original = vec![0.4_f32, -0.2, 0.1, 0.3];
        let vocals = vec![0.1_f32, -0.05, 0.02, 0.08];
        let instrumental = original
            .iter()
            .zip(&vocals)
            .map(|(mix, vocal)| mix - vocal)
            .collect::<Vec<_>>();
        let lanes = vec![("instrumental", instrumental), ("vocals", vocals)];
        let (_, peak) = reconstruction_error(&original, &sum_lanes(&lanes));
        assert!(peak <= 1e-7, "peak={peak}");
    }

    #[test]
    fn float_wav_keeps_samples_outside_pcm16_range() {
        let path = std::env::temp_dir().join(format!(
            "kdj-stem-debug-float-{}-{}.wav",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        write_float_wav(&path, &[1.25, -1.5]).unwrap();
        let bytes = fs::read(&path).unwrap();
        let _ = fs::remove_file(path);
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 3);
        assert_eq!(f32::from_le_bytes(bytes[44..48].try_into().unwrap()), 1.25);
        assert_eq!(f32::from_le_bytes(bytes[48..52].try_into().unwrap()), -1.5);
    }

    #[test]
    fn configured_candidate_renders_audition_fixture() {
        let Some(source) = std::env::var_os("KDJ_STEM_TEST_AUDIO").map(PathBuf::from) else {
            return;
        };
        if stem_debug_model_root().is_none() {
            return;
        }
        let model = match std::env::var("KDJ_STEM_TEST_MODEL").as_deref() {
            Ok("bs-polarformer") => StemDebugModel::BsPolarformer,
            _ => StemDebugModel::ScnetTran,
        };
        let output = std::env::temp_dir().join(format!(
            "kdj-candidate-stem-debug-{}-{model:?}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&output);
        let seconds = std::env::var("KDJ_STEM_TEST_SECONDS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(8.0);
        let result = render_stem_debug(model, &source, &output, Some(seconds)).unwrap();
        eprintln!(
            "candidate={:?} duration={:.3}s analysis_ms={:.1} rtf={:.3} chunks={} ort_ms={:.1} mean_ms={:.1} p95_ms={:.1} recon_rms={:.9} recon_peak={:.9}",
            result.model_id,
            result.duration,
            result.analysis_total_ms,
            result.realtime_factor,
            result.inference_chunks,
            result.inference_total_ms,
            result.inference_mean_ms,
            result.inference_p95_ms,
            result.reconstruction_rms_error,
            result.reconstruction_peak_error,
        );
        assert!(result.inference_chunks > 0);
        assert!(fs::metadata(output.join("original.wav")).is_ok());
        for lane in &result.lanes {
            let peak = result.waveforms.lanes[&lane.id]
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            eprintln!("lane={} peak={peak:.6}", lane.id);
            assert!(peak > 1e-5, "{} output is silent", lane.id);
            assert!(fs::metadata(output.join(format!("{}.wav", lane.id)))
                .is_ok_and(|metadata| metadata.len() > 44));
        }
        let _ = fs::remove_dir_all(output);
    }

    #[test]
    fn configured_scnet_concurrency_benchmark() {
        if std::env::var_os("KDJ_STEM_BENCH_CONCURRENCY").is_none() {
            return;
        }
        let source = PathBuf::from(
            std::env::var_os("KDJ_STEM_TEST_AUDIO")
                .expect("KDJ_STEM_TEST_AUDIO is required for the concurrency benchmark"),
        );
        let seconds = std::env::var("KDJ_STEM_TEST_SECONDS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(30.0);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let wall_started = Instant::now();
        let workers = (0..2)
            .map(|worker| {
                let source = source.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let output = std::env::temp_dir().join(format!(
                        "kdj-scnet-concurrency-{}-{worker}",
                        std::process::id()
                    ));
                    let _ = fs::remove_dir_all(&output);
                    barrier.wait();
                    let result = render_stem_debug(
                        StemDebugModel::ScnetTran,
                        &source,
                        &output,
                        Some(seconds),
                    )
                    .unwrap();
                    let _ = fs::remove_dir_all(output);
                    result
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        let wall_ms = wall_started.elapsed().as_secs_f64() * 1_000.0;
        eprintln!(
            "scnet_concurrency wall_ms={wall_ms:.1} audio_each_s={seconds:.3} aggregate_rtf={:.3}",
            wall_ms / (seconds * 2.0 * 1_000.0)
        );
        for (worker, result) in results.iter().enumerate() {
            eprintln!(
                "worker={worker} analysis_ms={:.1} rtf={:.3} chunks={} ort_total_ms={:.1} mean_ms={:.1} p95_ms={:.1}",
                result.analysis_total_ms,
                result.realtime_factor,
                result.inference_chunks,
                result.inference_total_ms,
                result.inference_mean_ms,
                result.inference_p95_ms,
            );
        }
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn configured_scnet_session_load_probe() {
        if std::env::var_os("KDJ_STEM_BENCH_LOAD").is_none() {
            return;
        }
        let spec = model_spec(StemDebugModel::ScnetTran);
        let path = stem_debug_model_root()
            .expect("KDJ_STEM_DEBUG_MODEL_DIR is required")
            .join(spec.relative_path);
        verify_model(&path, spec).unwrap();
        let started = Instant::now();
        let engine = ScnetTranEngine::load(&path).unwrap();
        eprintln!(
            "scnet_session_loaded pid={} load_ms={:.1}",
            std::process::id(),
            started.elapsed().as_secs_f64() * 1_000.0
        );
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::hint::black_box(engine);
    }
}
