//! Platform-specific SCNet Small deployment artifacts.
//!
//! The Core ML and ONNX exports use tensors byte-identical to ZFTurbo v1.0.6
//! `scnet_checkpoint_musdb18.ckpt`. Packaging comes from the reproducible MIT-licensed
//! `demixr/scnet-executorch` v0.1.2 release and is verified independently per platform.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelInstall {
    /// A ZIP whose root contains a compiled model directory.
    ZipDirectory {
        directory: &'static str,
        required_file: &'static str,
    },
    /// A single model file downloaded directly into the version directory.
    File { path: &'static str },
    /// ONNX graph plus an external `.onnx.data` weight file that must sit beside it.
    OnnxExternal {
        model: &'static str,
        data: &'static str,
        data_url: &'static str,
        data_bytes: u64,
        data_sha256: &'static str,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ModelArtifact {
    pub id: &'static str,
    pub runtime: &'static str,
    pub preferred_provider: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub install: ModelInstall,
}

const COREML_URL: &str = "https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/scnet_coreml.mlpackage.zip";
const COREML_SHA256: &str = "d15357c0abc901defb76282178966b0c41cc3e7b9ad34a8a0fd4598b11043c2f";
const COREML_BYTES: u64 = 34_543_230;
#[cfg(target_os = "windows")]
const ONNX_URL: &str =
    "https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/scnet_cpu.onnx";
#[cfg(target_os = "windows")]
const ONNX_SHA256: &str = "f2c050b7264d2b2401497beb712c26a50e6162dfb951041060f23f84929d600e";
#[cfg(target_os = "windows")]
const ONNX_BYTES: u64 = 52_271_228;

#[cfg(target_os = "macos")]
const ARTIFACT: ModelArtifact = ModelArtifact {
    id: "scnet-small-coreml",
    runtime: "Core ML",
    preferred_provider: "Apple GPU",
    filename: "scnet_coreml.mlpackage.zip",
    url: COREML_URL,
    bytes: COREML_BYTES,
    sha256: COREML_SHA256,
    install: ModelInstall::ZipDirectory {
        directory: "scnet_coreml.mlpackage",
        required_file: "Manifest.json",
    },
};

#[cfg(target_os = "windows")]
const ARTIFACT: ModelArtifact = ModelArtifact {
    id: "scnet-small-onnx",
    runtime: "ONNX Runtime",
    preferred_provider: "DirectML GPU (CPU fallback)",
    filename: "scnet_cpu.onnx",
    url: ONNX_URL,
    bytes: ONNX_BYTES,
    sha256: ONNX_SHA256,
    install: ModelInstall::File {
        path: "scnet_cpu.onnx",
    },
};

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn platform_model_artifact() -> Option<&'static ModelArtifact> {
    Some(&ARTIFACT)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn platform_model_artifact() -> Option<&'static ModelArtifact> {
    None
}
