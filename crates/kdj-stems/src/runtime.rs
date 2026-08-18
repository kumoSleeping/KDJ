//! Runtime-neutral entry point for one fixed-shape SCNet Small worker.

use std::path::Path;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use anyhow::bail;
use anyhow::Result;

#[cfg(target_os = "macos")]
use crate::coreml::CoreMlEngine;
#[cfg(target_os = "windows")]
use crate::onnx::OnnxEngine;

#[derive(Clone, Debug)]
pub(crate) struct RuntimeInfo {
    pub runtime: String,
    pub provider: String,
}

impl RuntimeInfo {
    pub(crate) fn planned() -> Self {
        if let Some(artifact) = crate::model::platform_model_artifact() {
            Self {
                runtime: artifact.runtime.into(),
                provider: "pending".into(),
            }
        } else {
            Self {
                runtime: "unsupported".into(),
                provider: String::new(),
            }
        }
    }
}

pub(crate) enum PlatformEngine {
    #[cfg(target_os = "macos")]
    CoreMl(CoreMlEngine),
    #[cfg(target_os = "windows")]
    Onnx(OnnxEngine),
}

impl PlatformEngine {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            return Ok(Self::CoreMl(CoreMlEngine::load(path)?));
        }
        #[cfg(target_os = "windows")]
        {
            return Ok(Self::Onnx(OnnxEngine::load(path)?));
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = path;
            bail!("当前平台尚未接入 SCNet Small runtime");
        }
    }

    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        match self {
            #[cfg(target_os = "macos")]
            Self::CoreMl(engine) => engine.predict(input),
            #[cfg(target_os = "windows")]
            Self::Onnx(engine) => engine.predict(input),
        }
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        match self {
            #[cfg(target_os = "macos")]
            Self::CoreMl(engine) => engine.info(),
            #[cfg(target_os = "windows")]
            Self::Onnx(engine) => engine.info(),
        }
    }
}

/// Native accelerator queues are device-global. One owner shares immutable weights and serializes
/// fixed tiles while per-Deck generations/rings remain independent.
pub(crate) fn recommended_worker_count() -> usize {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        1
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerator_inference_has_one_owner() {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert_eq!(recommended_worker_count(), 1);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(recommended_worker_count(), 0);
    }
}
