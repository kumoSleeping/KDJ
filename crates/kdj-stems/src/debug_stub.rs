//! Normal-build boundary for the optional ONNX research workstation.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StemDebugModel {
    ScnetTran,
    BsPolarformer,
}

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
        configured: false,
        root: String::new(),
        models: Vec::new(),
    }
}

pub fn render_stem_debug(
    _model: StemDebugModel,
    _source: &Path,
    _output_dir: &Path,
    _max_duration: Option<f64>,
) -> Result<StemDebugRender> {
    bail!("此构建未启用隔离 ONNX STEM 调试台（stem-debug-onnx）")
}
