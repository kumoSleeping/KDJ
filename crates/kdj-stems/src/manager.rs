use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use crate::live::{
    reset_current_stem_runtime, reset_stem_runtime_diagnostics, stem_runtime_diagnostics,
    StemRuntimeDiagnostics,
};
use crate::{RUNTIME_ID, RUNTIME_VERSION};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemRuntimeStatus {
    pub id: String,
    pub version: String,
    pub state: String,
    pub diagnostics: StemRuntimeDiagnostics,
}

/// Stable audio-runtime descriptor consumed when a Deck enables STEM mixing.
/// There is no per-track display analysis or waveform progress state.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStemStatus {
    pub track_id: i64,
    pub state: String,
    pub progress: f32,
    /// Stable algorithm key consumed by the playback worker; it is not a file-system path.
    pub cache_path: String,
    pub duration: f64,
    pub error: String,
    #[serde(skip)]
    pub source_mtime: i64,
}

pub struct StemCoordinator {
    runtime_transition: Mutex<()>,
}

impl StemCoordinator {
    pub fn new(_data_dir: &Path) -> Self {
        Self {
            runtime_transition: Mutex::new(()),
        }
    }

    pub fn runtime_status(&self) -> StemRuntimeStatus {
        StemRuntimeStatus {
            id: RUNTIME_ID.into(),
            version: RUNTIME_VERSION.into(),
            state: "ready".into(),
            diagnostics: stem_runtime_diagnostics(),
        }
    }

    pub fn track_status(&self, track_id: i64, source_mtime: i64) -> TrackStemStatus {
        TrackStemStatus {
            track_id,
            state: "ready".into(),
            progress: 1.0,
            cache_path: RUNTIME_ID.into(),
            duration: 0.0,
            error: String::new(),
            source_mtime,
        }
    }

    pub fn reset_runtime(&self) -> StemRuntimeStatus {
        let _transition = self.runtime_transition.lock().unwrap();
        let _ = reset_current_stem_runtime("classical_runtime_reset");
        reset_stem_runtime_diagnostics();
        self.runtime_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_ready_without_download_or_external_assets() {
        let coordinator = StemCoordinator::new(Path::new("/unused"));
        let status = coordinator.runtime_status();
        assert_eq!(status.id, RUNTIME_ID);
        assert_eq!(status.state, "ready");
        let track = coordinator.track_status(7, 11);
        assert_eq!(track.cache_path, RUNTIME_ID);
        assert_eq!(track.state, "ready");
        assert_eq!(track.progress, 1.0);
    }
}
