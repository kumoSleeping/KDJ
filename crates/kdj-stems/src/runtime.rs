//! Runtime-neutral entry point for the model-free classical separator.

use anyhow::Result;

use crate::classical::{ClassicalMode, ClassicalSeparator};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct StemRuntimePreference;

pub(crate) fn stem_runtime_preference() -> StemRuntimePreference {
    StemRuntimePreference
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeInfo {
    pub runtime: String,
    pub provider: String,
}

impl RuntimeInfo {
    pub(crate) fn planned() -> Self {
        Self {
            runtime: "Classical Redress".into(),
            provider: "Rust FFT · CPU".into(),
        }
    }
}

pub(crate) struct PlatformEngine {
    separator: ClassicalSeparator,
}

impl PlatformEngine {
    pub(crate) fn load() -> Self {
        Self {
            separator: ClassicalSeparator::new(ClassicalMode::Redress),
        }
    }

    pub(crate) fn separate(&mut self, left: &[f32], right: &[f32]) -> Result<[Vec<[f32; 2]>; 4]> {
        let frames = left.len().min(right.len());
        let input: Vec<[f32; 2]> = left[..frames]
            .iter()
            .zip(&right[..frames])
            .map(|(&left, &right)| [left, right])
            .collect();
        let output = self.separator.process_stereo(&input)?;
        let mut stems: [Vec<[f32; 2]>; 4] = std::array::from_fn(|_| Vec::new());
        stems[crate::StemKind::Other.index()] = output.instrumental;
        stems[crate::StemKind::Vocals.index()] = output.vocals;
        stems[crate::StemKind::Drums.index()] = vec![[0.0, 0.0]; frames];
        stems[crate::StemKind::Bass.index()] = vec![[0.0, 0.0]; frames];
        Ok(stems)
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        RuntimeInfo::planned()
    }
}

pub(crate) fn recommended_worker_count() -> usize {
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_always_local_and_model_free() {
        let info = RuntimeInfo::planned();
        assert_eq!(info.runtime, "Classical Redress");
        assert_eq!(info.provider, "Rust FFT · CPU");
        let mut engine = PlatformEngine::load();
        let stems = engine.separate(&[0.0; 4_096], &[0.0; 4_096]).unwrap();
        assert_eq!(stems[crate::StemKind::Vocals.index()].len(), 4_096);
    }
}
