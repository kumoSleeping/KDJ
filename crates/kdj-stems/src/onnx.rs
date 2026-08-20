//! ByteDance MobileNet_Subbandtime ONNX runtime.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use kdj_core::{StemCompute, StemMode};
use ort::{session::Session, value::Tensor};

use crate::dsp::{MOBILENET_INPUT_ELEMENTS, MOBILENET_OUTPUT_ELEMENTS};
use crate::model::{ModelArtifact, ModelFile, ModelPrecision};
use crate::runtime::RuntimeInfo;

#[cfg(any(target_os = "windows", target_os = "android"))]
use ort::ep;

const CHANNELS: usize = 2;

pub(crate) struct OnnxEngine {
    session: Session,
    provider: String,
}

impl OnnxEngine {
    pub(crate) fn load(
        path: &Path,
        artifact: &'static ModelArtifact,
        mode: StemMode,
        compute: StemCompute,
    ) -> Result<Self> {
        if mode != StemMode::MobileNetTwo {
            bail!("仅支持 ByteDance MobileNet STEM runtime");
        }
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

        #[cfg(target_os = "macos")]
        {
            return match compute {
                StemCompute::Gpu => bail!(
                    "macOS CoreML STEM 已禁用：当前 ORT/CoreML 会在模型会话创建时崩溃；请选择 Auto 或 CPU"
                ),
                StemCompute::Cpu => Self::cpu(path, artifact)?.warm_and_return(),
                StemCompute::Auto => {
                    let mut cpu = Self::cpu(path, artifact)?;
                    cpu.provider.push_str(" · safe auto");
                    cpu.warm_and_return()
                }
            };
        }

        #[cfg(not(target_os = "macos"))]
        match compute {
            StemCompute::Cpu => Self::cpu(path, artifact)?.warm_and_return(),
            StemCompute::Gpu => Self::accelerated(path, artifact)?.warm_and_return(),
            StemCompute::Auto => match Self::accelerated(path, artifact)
                .and_then(Self::warm_and_return)
            {
                Ok(engine) => Ok(engine),
                Err(accelerator_error) => {
                    tracing::warn!(
                        error = %accelerator_error,
                        "STEM 平台加速器不可用，自动回退 ONNX Runtime CPU"
                    );
                    let mut cpu = Self::cpu(path, artifact).with_context(|| {
                        format!("平台加速器初始化失败（{accelerator_error:#}），CPU 回退也无法创建")
                    })?;
                    cpu.provider.push_str(" · auto fallback");
                    cpu.warm_and_return()
                }
            },
        }
    }

    fn cpu(path: &Path, artifact: &'static ModelArtifact) -> Result<Self> {
        let files = artifact
            .runtime_files(ModelPrecision::Fp32)
            .collect::<Vec<_>>();
        let session = cpu_sessions(path, &files)?
            .into_iter()
            .next()
            .context("ByteDance MobileNet session set is empty")?;
        Ok(Self {
            session,
            provider: format!("ONNX Runtime CPU · FP32 · {} threads", cpu_threads()),
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn accelerated(path: &Path, artifact: &'static ModelArtifact) -> Result<Self> {
        let files = artifact
            .runtime_files(ModelPrecision::Fp32)
            .collect::<Vec<_>>();
        let session = accelerator_sessions(path, &files)?
            .into_iter()
            .next()
            .context("ByteDance MobileNet session set is empty")?;
        Ok(Self {
            session,
            provider: accelerator_name(),
        })
    }

    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.len() != MOBILENET_INPUT_ELEMENTS {
            bail!(
                "ByteDance MobileNet input elements {} != {MOBILENET_INPUT_ELEMENTS}",
                input.len()
            );
        }
        let tensor = ort_result(
            Tensor::from_array((
                [1_usize, CHANNELS, crate::MOBILENET_SEGMENT_SAMPLES],
                input.to_vec(),
            )),
            "创建 ByteDance MobileNet 输入 tensor",
        )?;
        let outputs = ort_result(
            self.session.run(ort::inputs!["waveform.1" => tensor]),
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
        let _ = self
            .predict(&vec![0.0; MOBILENET_INPUT_ELEMENTS])
            .context("STEM ONNX 预热推理失败")?;
        Ok(self)
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
            let builder = ort_result(builder.with_intra_threads(1), "配置 DirectML 线程")?;
            ort_result(
                builder.commit_from_file(path.join(file.filename)),
                "加载 ByteDance MobileNet DirectML session",
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
            let builder = ort_result(builder.with_intra_threads(1), "配置 NNAPI 线程")?;
            ort_result(
                builder.commit_from_file(path.join(file.filename)),
                "加载 ByteDance MobileNet NNAPI session",
            )
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn accelerator_name() -> String {
    #[cfg(target_os = "windows")]
    return "DirectML GPU · FP32".into();
    #[cfg(target_os = "android")]
    return "NNAPI GPU / NPU · FP32".into();
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
                "加载 ByteDance MobileNet CPU session",
            )
        })
        .collect()
}

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

    #[test]
    fn production_engine_contract_is_byte_dance_fp32() {
        assert_eq!(MOBILENET_INPUT_ELEMENTS, 264_600);
        assert_eq!(MOBILENET_OUTPUT_ELEMENTS, 264_600);
    }
}
