//! SCNet Small spectral ONNX runtime for Windows.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use ort::{session::Session, value::Tensor};

use crate::dsp::{MODEL_CHANNELS, MODEL_STEMS, SCNET_BINS, SCNET_FRAMES};
use crate::dsp::{MODEL_INPUT_ELEMENTS, MODEL_OUTPUT_ELEMENTS};
use crate::runtime::RuntimeInfo;

#[cfg(target_os = "windows")]
use ort::ep;

pub(crate) struct OnnxEngine {
    session: Session,
    provider: String,
}

impl OnnxEngine {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        if !path.is_file() {
            bail!("ONNX 模型文件不存在：{}", path.display());
        }
        if std::env::var("KDJ_SCNET_PROVIDER").is_ok_and(|value| value.eq_ignore_ascii_case("cpu"))
        {
            let mut engine = Self {
                session: cpu_session(path)?,
                provider: "CPU (forced by KDJ_SCNET_PROVIDER)".into(),
            };
            engine.warmup()?;
            return Ok(engine);
        }
        let mut engine = preferred_session(path)?;
        engine.warmup()?;
        Ok(engine)
    }

    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.len() != MODEL_INPUT_ELEMENTS {
            bail!(
                "ONNX input elements {} != {MODEL_INPUT_ELEMENTS}",
                input.len()
            );
        }
        let tensor = ort_result(
            Tensor::from_array((
                [1_usize, MODEL_CHANNELS, SCNET_BINS, SCNET_FRAMES],
                input.to_vec(),
            )),
            "创建 ONNX SCNet 输入 tensor",
        )?;
        let outputs = ort_result(
            self.session.run(ort::inputs!["mix_spec" => tensor]),
            "ONNX Runtime 执行 SCNet Small",
        )?;
        let output = if let Some(output) = outputs.get("stems_spec") {
            output
        } else if outputs.len() > 0 {
            &outputs[0]
        } else {
            bail!("ONNX SCNet 缺少 stems_spec 输出");
        };
        let (shape, data) = ort_result(
            output.try_extract_tensor::<f32>(),
            "读取 ONNX SCNet 输出 tensor",
        )?;
        let expected = [
            1_i64,
            MODEL_STEMS as i64,
            MODEL_CHANNELS as i64,
            SCNET_BINS as i64,
            SCNET_FRAMES as i64,
        ];
        if &**shape != expected.as_slice() || data.len() != MODEL_OUTPUT_ELEMENTS {
            bail!(
                "ONNX separated shape {:?} / elements {} 不符合部署契约 {:?} / {MODEL_OUTPUT_ELEMENTS}",
                &**shape,
                data.len(),
                expected
            );
        }
        if data.iter().any(|value| !value.is_finite()) {
            bail!("ONNX SCNet 输出含非有限数值");
        }
        Ok(data.to_vec())
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        RuntimeInfo {
            runtime: "ONNX Runtime".into(),
            provider: self.provider.clone(),
        }
    }

    fn warmup(&mut self) -> Result<()> {
        let silence = vec![0.0f32; MODEL_INPUT_ELEMENTS];
        let _ = self.predict(&silence).context("SCNet ONNX 预热推理失败")?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn preferred_session(path: &Path) -> Result<OnnxEngine> {
    match directml_session(path) {
        Ok(session) => Ok(OnnxEngine {
            session,
            provider: "DirectML GPU".into(),
        }),
        Err(directml_error) => {
            let session = cpu_session(path).with_context(|| {
                format!(
                    "DirectML 初始化失败（{directml_error:#}），ONNX Runtime CPU 回退也无法创建"
                )
            })?;
            tracing::warn!(error = %directml_error, "SCNet DirectML 不可用，回退 ONNX Runtime CPU");
            Ok(OnnxEngine {
                session,
                provider: "ONNX Runtime CPU fallback".into(),
            })
        }
    }
}

#[cfg(target_os = "macos")]
fn preferred_session(path: &Path) -> Result<OnnxEngine> {
    Ok(OnnxEngine {
        session: cpu_session(path)?,
        provider: "CPU".into(),
    })
}

#[cfg(target_os = "windows")]
fn directml_session(path: &Path) -> Result<Session> {
    let builder = ort_result(
        Session::builder(),
        "创建 ONNX Runtime DirectML session builder",
    )?;
    let builder = ort_result(
        builder.with_execution_providers([ep::DirectML::default().build()]),
        "注册 ONNX Runtime DirectML execution provider",
    )?;
    let mut builder = ort_result(
        builder.with_intra_threads(1),
        "配置 ONNX Runtime DirectML 线程",
    )?;
    ort_result(
        builder.commit_from_file(path),
        "加载 ONNX SCNet DirectML session",
    )
}

fn cpu_session(path: &Path) -> Result<Session> {
    let builder = ort_result(Session::builder(), "创建 ONNX Runtime CPU session builder")?;
    let mut builder = ort_result(
        builder.with_intra_threads(cpu_threads()),
        "配置 ONNX Runtime CPU 线程",
    )?;
    ort_result(
        builder.commit_from_file(path),
        "加载 ONNX SCNet CPU session",
    )
}

/// `ort::Error<T>` intentionally carries the failed builder and is neither Send nor Sync. Convert
/// it at the runtime boundary before it enters `anyhow`, whose error trait object is thread-safe.
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
