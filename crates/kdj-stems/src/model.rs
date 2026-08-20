//! Locked deployment artifacts for the selectable four-lane Spleeter and two-lane MobileNet
//! runtimes. Files are downloaded at runtime and individually SHA-256 verified.

use kdj_core::StemMode;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelPrecision {
    Fp16,
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

const FOUR_REVISION: &str = "87c5b6d2874aeb8377b3dca27c9223aa252a6cdb";

macro_rules! four_url {
    ($filename:literal) => {
        concat!(
            "https://huggingface.co/Best-Practice/spleeter-4stems-onnx/resolve/",
            "87c5b6d2874aeb8377b3dca27c9223aa252a6cdb/",
            $filename
        )
    };
}

pub(crate) const FOUR_MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        stem: "drums",
        filename: "drums.fp16.onnx",
        url: four_url!("drums.fp16.onnx"),
        bytes: 19_714_140,
        sha256: "7ae4002e5633634674f74dc3356d5875b0da894d59ce0f60e844bb8f9cb8aa92",
        precision: ModelPrecision::Fp16,
    },
    ModelFile {
        stem: "bass",
        filename: "bass.fp16.onnx",
        url: four_url!("bass.fp16.onnx"),
        bytes: 19_714_139,
        sha256: "ba4c4949a27222492cca49859901a873b4b71461dc48c7c5a51f93d31eb11f55",
        precision: ModelPrecision::Fp16,
    },
    ModelFile {
        stem: "other",
        filename: "other.fp16.onnx",
        url: four_url!("other.fp16.onnx"),
        bytes: 19_714_140,
        sha256: "3cc59116cb7195946ab9596d8ca25984d09c0f8a70db8cf85d063132f97bc61d",
        precision: ModelPrecision::Fp16,
    },
    ModelFile {
        stem: "vocals",
        filename: "vocals.fp16.onnx",
        url: four_url!("vocals.fp16.onnx"),
        bytes: 19_714_141,
        sha256: "db47148ab1c52709ce694893f532c91abfe3edc4d46238939570e036a22878ca",
        precision: ModelPrecision::Fp16,
    },
];

pub(crate) const FOUR_ARTIFACT: ModelArtifact = ModelArtifact {
    mode: StemMode::Four,
    id: "spleeter4-fp16-onnx",
    version: "Best-Practice-87c5b6d",
    identity_sha256: "a9ef9575560b0d224dde174e886a09ee9b4e2b7fe537b040697446c5f8c8cf8f",
    runtime: "ONNX Runtime",
    directory: "spleeter4-fp16-onnx",
    local_env: "KDJ_SPLEETER4_MODEL_DIR",
    files: FOUR_MODEL_FILES,
};

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
    let _ = FOUR_REVISION;
    match mode {
        StemMode::Four => Some(&FOUR_ARTIFACT),
        StemMode::MobileNetTwo => Some(&MOBILENET_ARTIFACT),
        StemMode::None => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
pub(crate) fn platform_model_artifact(_mode: StemMode) -> Option<&'static ModelArtifact> {
    None
}

pub(crate) fn artifact_for_directory(path: &std::path::Path) -> Option<&'static ModelArtifact> {
    let name = path.file_name()?.to_str()?;
    if name == MOBILENET_ARTIFACT.directory {
        Some(&MOBILENET_ARTIFACT)
    } else if name == FOUR_ARTIFACT.directory {
        Some(&FOUR_ARTIFACT)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_sets_are_complete_and_stably_ordered() {
        assert_eq!(
            FOUR_MODEL_FILES
                .iter()
                .map(|file| file.stem)
                .collect::<Vec<_>>(),
            ["drums", "bass", "other", "vocals"]
        );
        assert_eq!(FOUR_ARTIFACT.bytes(), 78_856_560);
        assert_eq!(MOBILENET_ARTIFACT.bytes(), 6_414_644);
        assert_eq!(
            MOBILENET_MODEL_FILES[0].filename,
            "bytedance-mobilenet-subbandtime-accompaniment-3s-fp32.onnx"
        );
        assert!(FOUR_MODEL_FILES
            .iter()
            .all(|file| file.url.contains(FOUR_REVISION)));
    }
}
