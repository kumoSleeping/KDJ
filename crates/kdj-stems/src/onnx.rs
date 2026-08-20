//! Spleeter FP16/INT8 ONNX runtime for macOS, Windows and ARM64 Android.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use kdj_core::{StemCompute, StemMode};
use ort::{session::Session, value::Tensor};

use crate::dsp::{
    MOBILENET_INPUT_ELEMENTS, MOBILENET_OUTPUT_ELEMENTS, MODEL_INPUT_ELEMENTS,
    MODEL_OUTPUT_ELEMENTS, SPLEETER_BINS, SPLEETER_FRAMES,
};
use crate::model::{ModelArtifact, ModelFile, ModelPrecision};
use crate::runtime::RuntimeInfo;

#[cfg(any(target_os = "windows", target_os = "android"))]
use ort::ep;

const CHANNELS: usize = 2;
/// FP16 exports can overflow on a hot spectral tile even though their float32 I/O is finite.
/// Ratio masks are scale-invariant, so a failed attempt may safely retry with lower model-only
/// magnitude without changing the untouched complex mixture used for reconstruction.
const FP16_RETRY_GAINS: [f32; 3] = [1.0, 0.25, 0.0625];

pub(crate) struct OnnxEngine {
    sessions: Vec<Session>,
    files: Vec<&'static ModelFile>,
    mode: StemMode,
    precision: ModelPrecision,
    provider: String,
}

impl OnnxEngine {
    pub(crate) fn load(
        path: &Path,
        artifact: &'static ModelArtifact,
        mode: StemMode,
        compute: StemCompute,
    ) -> Result<Self> {
        if !path.is_dir() {
            bail!("STEM ONNX 模型目录不存在：{}", path.display());
        }
        for file in artifact.files {
            if !path.join(file.filename).is_file() {
                bail!(
                    "STEM ONNX 模型文件不存在：{}",
                    path.join(file.filename).display()
                );
            }
        }

        // ORT CoreML session compilation is not a recoverable Result on the tested macOS 26.5
        // stack. The production crash report records EXC_BAD_ACCESS in the live STEM worker, and
        // HS-TasNet independently crashes during session creation. A process cannot catch SIGSEGV
        // and then perform the advertised Auto fallback, so macOS must not enter this call path
        // until GPU inference is isolated outside the audio application's process.
        #[cfg(target_os = "macos")]
        {
            return match compute {
                StemCompute::Gpu => bail!(
                    "macOS CoreML STEM 已禁用：当前 ORT/CoreML 会在模型会话创建时崩溃；请选择 Auto 或 CPU"
                ),
                StemCompute::Cpu => Self::cpu(path, artifact, mode)?.warm_and_return(),
                StemCompute::Auto => {
                    let mut cpu = Self::cpu(path, artifact, mode)?;
                    cpu.provider = format!("{} · safe auto", cpu.provider);
                    cpu.warm_and_return()
                }
            };
        }

        #[cfg(not(target_os = "macos"))]
        match compute {
            StemCompute::Cpu => Self::cpu(path, artifact, mode)?.warm_and_return(),
            StemCompute::Gpu => Self::accelerated(path, artifact, mode)?.warm_and_return(),
            StemCompute::Auto => match Self::accelerated(path, artifact, mode)
                .and_then(Self::warm_and_return)
            {
                Ok(engine) => Ok(engine),
                Err(accelerator_error) => {
                    tracing::warn!(
                        error = %accelerator_error,
                        "STEM 平台加速器不可用，自动回退 ONNX Runtime CPU"
                    );
                    let mut cpu = Self::cpu(path, artifact, mode).with_context(|| {
                        format!("平台加速器初始化失败（{accelerator_error:#}），CPU 回退也无法创建")
                    })?;
                    cpu.provider = format!("{} · auto fallback", cpu.provider);
                    cpu.warm_and_return()
                }
            },
        }
    }

    fn cpu(path: &Path, artifact: &'static ModelArtifact, mode: StemMode) -> Result<Self> {
        let precision = selected_precision(mode);
        let files = artifact.runtime_files(precision).collect::<Vec<_>>();
        if files.is_empty() {
            bail!("STEM 模型没有 {} 权重", precision_label(precision));
        }
        let sessions = cpu_sessions(path, &files)?;
        Ok(Self {
            sessions,
            files,
            mode,
            precision,
            provider: format!(
                "ONNX Runtime CPU · {} · {} threads",
                precision_label(precision),
                cpu_threads()
            ),
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn accelerated(path: &Path, artifact: &'static ModelArtifact, mode: StemMode) -> Result<Self> {
        let precision = selected_precision(mode);
        let files = artifact.runtime_files(precision).collect::<Vec<_>>();
        if files.is_empty() {
            bail!("STEM 模型没有 {} 权重", precision_label(precision));
        }
        let sessions = accelerator_sessions(path, &files)?;
        Ok(Self {
            sessions,
            files,
            mode,
            precision,
            provider: accelerator_name(mode),
        })
    }

    /// Always return KDJ's stable four-slot spectral layout. Two-stem estimates occupy
    /// Other/Instrumental and Vocals; Drums/Bass remain exactly zero and never reach the UI.
    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if self.mode == StemMode::MobileNetTwo {
            return self.predict_mobilenet(input);
        }
        if input.len() != MODEL_INPUT_ELEMENTS {
            bail!(
                "STEM ONNX input elements {} != {MODEL_INPUT_ELEMENTS}",
                input.len()
            );
        }
        if self.sessions.len() != self.files.len() || self.sessions.is_empty() {
            bail!("STEM ONNX session set is incomplete");
        }
        let retry_gains: &[f32] = if self.precision == ModelPrecision::Fp16 {
            &FP16_RETRY_GAINS
        } else {
            &[1.0]
        };
        let mut failed_stem = None;
        for (attempt, gain) in retry_gains.iter().copied().enumerate() {
            let attempt_input = if gain == 1.0 {
                input.to_vec()
            } else {
                input.iter().map(|value| value * gain).collect()
            };
            let mut combined = vec![0.0f32; MODEL_OUTPUT_ELEMENTS];
            failed_stem = None;
            for (session, file) in self.sessions.iter_mut().zip(&self.files) {
                let tensor = ort_result(
                    Tensor::from_array((
                        [CHANNELS, 1_usize, SPLEETER_FRAMES, SPLEETER_BINS],
                        attempt_input.clone(),
                    )),
                    &format!("创建 Spleeter {} 输入 tensor", file.stem),
                )?;
                let outputs = ort_result(
                    session.run(ort::inputs!["x" => tensor]),
                    &format!("ONNX Runtime 执行 Spleeter {}", file.stem),
                )?;
                let output = outputs
                    .get("y")
                    .or_else(|| (outputs.len() > 0).then(|| &outputs[0]))
                    .with_context(|| format!("Spleeter {} 缺少 y 输出", file.stem))?;
                let (shape, data) = ort_result(
                    output.try_extract_tensor::<f32>(),
                    &format!("读取 Spleeter {} 输出 tensor", file.stem),
                )?;
                let expected = [
                    CHANNELS as i64,
                    1_i64,
                    SPLEETER_FRAMES as i64,
                    SPLEETER_BINS as i64,
                ];
                if &**shape != expected.as_slice() || data.len() != MODEL_INPUT_ELEMENTS {
                    bail!(
                        "Spleeter {} shape {:?} / elements {} 不符合部署契约 {:?} / {MODEL_INPUT_ELEMENTS}",
                        file.stem,
                        &**shape,
                        data.len(),
                        expected
                    );
                }
                if data.iter().any(|value| !value.is_finite()) {
                    failed_stem = Some(file.stem);
                    break;
                }
                let slot = output_slot(self.mode, file.stem)?;
                combined[slot * MODEL_INPUT_ELEMENTS..(slot + 1) * MODEL_INPUT_ELEMENTS]
                    .copy_from_slice(data);
            }
            if failed_stem.is_none() {
                if attempt > 0 {
                    tracing::warn!(
                        attempt = attempt + 1,
                        gain,
                        "Spleeter FP16 tile recovered after attenuated retry"
                    );
                }
                return Ok(combined);
            }
            tracing::warn!(
                stem = failed_stem.expect("non-finite attempt has a stem"),
                attempt = attempt + 1,
                gain,
                "Spleeter FP16 output was non-finite; retrying this tile"
            );
        }
        bail!(
            "Spleeter {} 输出含非有限数值（已重试 {} 次）",
            failed_stem.unwrap_or("unknown"),
            retry_gains.len()
        )
    }

    fn predict_mobilenet(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.len() != MOBILENET_INPUT_ELEMENTS {
            bail!(
                "ByteDance MobileNet input elements {} != {MOBILENET_INPUT_ELEMENTS}",
                input.len()
            );
        }
        if self.sessions.len() != 1 {
            bail!("ByteDance MobileNet session set is incomplete");
        }
        let tensor = ort_result(
            Tensor::from_array((
                [1_usize, CHANNELS, crate::MOBILENET_SEGMENT_SAMPLES],
                input.to_vec(),
            )),
            "创建 ByteDance MobileNet 输入 tensor",
        )?;
        let outputs = ort_result(
            self.sessions[0].run(ort::inputs!["waveform.1" => tensor]),
            "ONNX Runtime 执行 ByteDance MobileNet",
        )?;
        let output = outputs
            .get("waveform")
            .or_else(|| (outputs.len() > 0).then(|| &outputs[0]))
            .context("ByteDance MobileNet 缺少 waveform 输出")?;
        let (shape, data) = ort_result(
            output.try_extract_tensor::<f32>(),
            "读取 ByteDance MobileNet 输出 tensor",
        )?;
        let expected = [
            1_i64,
            CHANNELS as i64,
            crate::MOBILENET_SEGMENT_SAMPLES as i64,
        ];
        if &**shape != expected.as_slice() || data.len() != MOBILENET_OUTPUT_ELEMENTS {
            bail!(
                "ByteDance MobileNet shape {:?} / elements {} 不符合部署契约 {:?} / {MOBILENET_OUTPUT_ELEMENTS}",
                &**shape,
                data.len(),
                expected
            );
        }
        if data.iter().any(|value| !value.is_finite()) {
            bail!("ByteDance MobileNet 输出含非有限数值");
        }
        Ok(data.to_vec())
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        RuntimeInfo {
            runtime: "ONNX Runtime".into(),
            provider: self.provider.clone(),
        }
    }

    fn warm_and_return(mut self) -> Result<Self> {
        let silence_len = if self.mode == StemMode::MobileNetTwo {
            MOBILENET_INPUT_ELEMENTS
        } else {
            MODEL_INPUT_ELEMENTS
        };
        let silence = vec![0.0f32; silence_len];
        let _ = self.predict(&silence).context("STEM ONNX 预热推理失败")?;
        Ok(self)
    }
}

fn output_slot(mode: StemMode, stem: &str) -> Result<usize> {
    match (mode, stem) {
        (StemMode::Four, "drums") => Ok(0),
        (StemMode::Four, "bass") => Ok(1),
        (StemMode::Four, "other") | (StemMode::MobileNetTwo, "instrumental") => Ok(2),
        (StemMode::Four | StemMode::MobileNetTwo, "vocals") => Ok(3),
        _ => bail!("STEM lane {stem} 不属于 {mode:?} 模型"),
    }
}

fn selected_precision(mode: StemMode) -> ModelPrecision {
    match mode {
        StemMode::Four => ModelPrecision::Fp16,
        StemMode::MobileNetTwo => ModelPrecision::Fp32,
        StemMode::None => ModelPrecision::Fp16,
    }
}

fn precision_label(precision: ModelPrecision) -> &'static str {
    match precision {
        ModelPrecision::Fp16 => "FP16",
        ModelPrecision::Fp32 => "FP32",
    }
}

#[cfg(target_os = "windows")]
fn accelerator_sessions(path: &Path, files: &[&ModelFile]) -> Result<Vec<Session>> {
    files
        .iter()
        .map(|file| {
            let builder = ort_result(Session::builder(), "创建 DirectML session builder")?;
            let builder = ort_result(
                builder.with_execution_providers([ep::DirectML::default().build()]),
                "注册 DirectML execution provider",
            )?;
            let mut builder = ort_result(builder.with_intra_threads(1), "配置 DirectML 线程")?;
            ort_result(
                builder.commit_from_file(path.join(file.filename)),
                &format!("加载 Spleeter {} DirectML session", file.stem),
            )
        })
        .collect()
}

#[cfg(target_os = "android")]
fn accelerator_sessions(path: &Path, files: &[&ModelFile]) -> Result<Vec<Session>> {
    files
        .iter()
        .map(|file| {
            let builder = ort_result(Session::builder(), "创建 NNAPI session builder")?;
            let provider = ep::NNAPI::default()
                .with_fp16(true)
                .with_disable_cpu(true)
                .build();
            let builder = ort_result(
                builder.with_execution_providers([provider]),
                "注册 NNAPI execution provider",
            )?;
            let mut builder = ort_result(builder.with_intra_threads(1), "配置 NNAPI 线程")?;
            ort_result(
                builder.commit_from_file(path.join(file.filename)),
                &format!("加载 Spleeter {} NNAPI session", file.stem),
            )
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn accelerator_name(mode: StemMode) -> String {
    let precision = precision_label(selected_precision(mode));
    #[cfg(target_os = "windows")]
    return format!("DirectML GPU · {precision}");
    #[cfg(target_os = "android")]
    return format!("NNAPI GPU / NPU · {precision}");
}

fn cpu_sessions(path: &Path, files: &[&ModelFile]) -> Result<Vec<Session>> {
    files
        .iter()
        .map(|file| {
            let builder = ort_result(Session::builder(), "创建 ONNX Runtime CPU session builder")?;
            let builder = ort_result(
                builder.with_intra_threads(cpu_threads()),
                "配置 ONNX Runtime CPU 线程",
            )?;
            let mut builder = ort_result(
                builder.with_inter_threads(1),
                "配置 ONNX Runtime inter-op 线程",
            )?;
            ort_result(
                builder.commit_from_file(path.join(file.filename)),
                &format!("加载 Spleeter {} CPU session", file.stem),
            )
        })
        .collect()
}

/// `ort::Error<T>` carries the failed builder and is neither Send nor Sync. Convert it at the
/// runtime boundary before it enters anyhow's thread-safe trait object.
fn ort_result<T, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
    action: &str,
) -> Result<T> {
    result.map_err(|error| anyhow!("{action}: {error}"))
}

fn cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| (parallelism.get() / 2).clamp(2, 4))
        .unwrap_or(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::platform_model_artifact;

    #[test]
    fn mobilenet_outputs_map_to_other_and_vocals() {
        assert_eq!(
            output_slot(StemMode::MobileNetTwo, "instrumental").unwrap(),
            2
        );
        assert_eq!(output_slot(StemMode::MobileNetTwo, "vocals").unwrap(), 3);
        assert!(output_slot(StemMode::MobileNetTwo, "drums").is_err());
    }

    #[test]
    #[ignore = "requires an external locked Spleeter model directory"]
    fn configured_real_model_warms_up_and_returns_the_stable_four_slot_contract() {
        let path = std::env::var("KDJ_STEM_TEST_MODEL_DIR").expect("set KDJ_STEM_TEST_MODEL_DIR");
        let mode = match std::env::var("KDJ_STEM_TEST_MODE").as_deref() {
            Ok("four") => StemMode::Four,
            Ok("mobile") => StemMode::MobileNetTwo,
            _ => panic!("set KDJ_STEM_TEST_MODE=four|mobile"),
        };
        let compute = match std::env::var("KDJ_STEM_TEST_COMPUTE").as_deref() {
            Ok("auto") => StemCompute::Auto,
            Ok("gpu") => StemCompute::Gpu,
            Ok("cpu") => StemCompute::Cpu,
            _ => panic!("set KDJ_STEM_TEST_COMPUTE=auto|gpu|cpu"),
        };
        let artifact = platform_model_artifact(mode).expect("model supported on test platform");
        let mut engine = OnnxEngine::load(Path::new(&path), artifact, mode, compute).unwrap();
        let input_elements = if mode == StemMode::MobileNetTwo {
            MOBILENET_INPUT_ELEMENTS
        } else {
            MODEL_INPUT_ELEMENTS
        };
        let output = engine.predict(&vec![0.0; input_elements]).unwrap();
        let expected_output = if mode == StemMode::MobileNetTwo {
            MOBILENET_OUTPUT_ELEMENTS
        } else {
            MODEL_OUTPUT_ELEMENTS
        };
        assert_eq!(output.len(), expected_output);
    }
}
