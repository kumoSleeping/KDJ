//! Locked deployment artifact for the one supported ByteDance separator.
//!
//! The production runtime deliberately has no model selector. Legacy model names are handled at
//! the settings boundary and cannot resolve to a retired artifact here.

use kdj_core::StemMode;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelPrecision {
    Fp32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModelFile {
    pub stem: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub precision: ModelPrecision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModelArtifact {
    pub mode: StemMode,
    pub id: &'static str,
    pub version: &'static str,
    pub identity_sha256: &'static str,
    pub runtime: &'static str,
    pub directory: &'static str,
    pub local_env: &'static str,
    pub files: &'static [ModelFile],
}

impl ModelArtifact {
    pub(crate) fn bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }

    pub(crate) fn runtime_files(
        &self,
        precision: ModelPrecision,
    ) -> impl Iterator<Item = &'static ModelFile> {
        self.files
            .iter()
            .filter(move |file| file.precision == precision)
    }
}

pub(crate) const MOBILENET_MODEL_FILES: &[ModelFile] = &[ModelFile {
    stem: "instrumental",
    filename: "bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx",
    url: concat!(
        "https://raw.githubusercontent.com/kumoSleeping/KDJ/main/",
        "model-artifacts/bytedance-mobilenet-subbandtime/",
        "bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx"
    ),
    bytes: 6_414_644,
    sha256: "999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991",
    precision: ModelPrecision::Fp32,
}];

pub(crate) const MOBILENET_ARTIFACT: ModelArtifact = ModelArtifact {
    mode: StemMode::MobileNetTwo,
    id: "bytedance-mobilenet-subbandtime-2-fp32-onnx",
    version: "zenodo-5804160-kdj-3s-v1",
    identity_sha256: "999ba99f306f09c9a35a18fe0007b53f8ad2c3cb5bb9d638128bf7257cd8e991",
    runtime: "ONNX Runtime",
    directory: "bytedance-mobilenet-subbandtime-2-fp32-onnx",
    local_env: "KDJ_BYTEDANCE_MOBILENET_MODEL_DIR",
    files: MOBILENET_MODEL_FILES,
};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "android"))]
pub(crate) fn platform_model_artifact(mode: StemMode) -> Option<&'static ModelArtifact> {
    (mode == StemMode::MobileNetTwo).then_some(&MOBILENET_ARTIFACT)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
pub(crate) fn platform_model_artifact(_mode: StemMode) -> Option<&'static ModelArtifact> {
    None
}

pub(crate) fn artifact_for_directory(path: &std::path::Path) -> Option<&'static ModelArtifact> {
    let name = path.file_name()?.to_str()?;
    (name == MOBILENET_ARTIFACT.directory).then_some(&MOBILENET_ARTIFACT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_set_is_the_locked_bytedance_model() {
        assert_eq!(MOBILENET_ARTIFACT.bytes(), 6_414_644);
        assert_eq!(
            MOBILENET_MODEL_FILES[0].filename,
            "bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx"
        );
        assert_eq!(MOBILENET_ARTIFACT.mode, StemMode::MobileNetTwo);
    }
}
