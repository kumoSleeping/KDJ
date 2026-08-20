//! Runtime-neutral entry point for one fixed-shape Spleeter worker.

use std::path::Path;
use std::sync::{OnceLock, RwLock};

use anyhow::{bail, Context, Result};
use kdj_core::{StemCompute, StemMode};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
use crate::onnx::OnnxEngine;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StemRuntimePreference {
    pub mode: StemMode,
    pub compute: StemCompute,
}

impl Default for StemRuntimePreference {
    fn default() -> Self {
        Self {
            mode: StemMode::None,
            compute: StemCompute::Auto,
        }
    }
}

fn runtime_preference() -> &'static RwLock<StemRuntimePreference> {
    static PREFERENCE: OnceLock<RwLock<StemRuntimePreference>> = OnceLock::new();
    PREFERENCE.get_or_init(|| RwLock::new(StemRuntimePreference::default()))
}

pub(crate) fn configure_stem_runtime(mode: StemMode, compute: StemCompute) -> bool {
    let mut current = runtime_preference().write().unwrap();
    let next = StemRuntimePreference { mode, compute };
    let changed = *current != next;
    *current = next;
    changed
}

pub(crate) fn stem_runtime_preference() -> StemRuntimePreference {
    *runtime_preference().read().unwrap()
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeInfo {
    pub runtime: String,
    pub provider: String,
}

impl RuntimeInfo {
    pub(crate) fn planned() -> Self {
        let preference = stem_runtime_preference();
        if let Some(artifact) = crate::model::platform_model_artifact(preference.mode) {
            Self {
                runtime: artifact.runtime.into(),
                provider: planned_provider(preference.compute),
            }
        } else {
            Self {
                runtime: "disabled".into(),
                provider: String::new(),
            }
        }
    }
}

fn planned_provider(compute: StemCompute) -> String {
    #[cfg(target_os = "macos")]
    {
        return match compute {
            StemCompute::Auto => "Auto · safe ORT CPU".into(),
            StemCompute::Gpu => "GPU unavailable · CoreML disabled".into(),
            StemCompute::Cpu => "CPU requested".into(),
        };
    }
    #[cfg(not(target_os = "macos"))]
    match compute {
        StemCompute::Auto => "Auto · accelerator first".into(),
        StemCompute::Gpu => "GPU requested".into(),
        StemCompute::Cpu => "CPU requested".into(),
    }
}

pub(crate) enum PlatformEngine {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    Onnx(OnnxEngine),
}

impl PlatformEngine {
    pub(crate) fn load(path: &Path, preference: StemRuntimePreference) -> Result<Self> {
        let artifact =
            crate::model::artifact_for_directory(path).context("无法从模型目录识别 STEM 模型")?;
        if !artifact.mode.shares_artifact_with(preference.mode) {
            bail!(
                "STEM 模型模式 {:?} 与当前设置 {:?} 不一致",
                artifact.mode,
                preference.mode
            );
        }
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
        {
            return Ok(Self::Onnx(OnnxEngine::load(
                path,
                artifact,
                preference.mode,
                preference.compute,
            )?));
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
        {
            let _ = (path, preference, artifact);
            bail!("当前平台尚未接入 STEM ONNX runtime");
        }
    }

    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        match self {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
            Self::Onnx(engine) => engine.predict(input),
        }
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        match self {
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
            Self::Onnx(engine) => engine.info(),
        }
    }
}

/// Two persistent engines keep a Deck's next tile and one extra future slice in flight. Audio
/// still overtakes look-ahead inside each worker, so dual-Deck playback can share the accelerator
/// instead of finishing one song's future before the other starts.
pub(crate) fn recommended_worker_count() -> usize {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
    {
        2
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
    {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_runtime_keeps_two_inference_workers() {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
        assert_eq!(recommended_worker_count(), 2);
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
        assert_eq!(recommended_worker_count(), 0);
    }

    #[test]
    fn runtime_preference_round_trips() {
        let _ = configure_stem_runtime(StemMode::MobileNetTwo, StemCompute::Cpu);
        assert_eq!(
            stem_runtime_preference(),
            StemRuntimePreference {
                mode: StemMode::MobileNetTwo,
                compute: StemCompute::Cpu,
            }
        );
    }

    #[test]
    fn planned_provider_does_not_promise_crashing_coreml_on_macos() {
        #[cfg(target_os = "macos")]
        {
            assert_eq!(planned_provider(StemCompute::Auto), "Auto · safe ORT CPU");
            assert_eq!(
                planned_provider(StemCompute::Gpu),
                "GPU unavailable · CoreML disabled"
            );
        }
    }
}
