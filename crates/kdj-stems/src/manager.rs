use std::path::Path;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::cache::{StemKind, StemWaveform};
use crate::live::{
    live_stem_waveform, reset_current_stem_runtime, reset_stem_runtime_diagnostics,
    stem_runtime_diagnostics, StemRuntimeDiagnostics,
};
use crate::scan::{StemScanScheduler, StemScanStatus};
use crate::{RUNTIME_ID, RUNTIME_VERSION};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemRuntimeStatus {
    pub id: String,
    pub version: String,
    pub state: String,
    pub diagnostics: StemRuntimeDiagnostics,
}

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
    pub phase: String,
    pub covered_seconds: f64,
    pub window_start: f64,
    pub window_end: f64,
    pub window_covered_seconds: f64,
    pub waiting_for_deck: Option<u8>,
    #[serde(skip)]
    pub source_mtime: i64,
}

pub struct StemCoordinator {
    scan: StemScanScheduler,
    runtime_transition: Mutex<()>,
}

impl StemCoordinator {
    pub fn new(_data_dir: &Path) -> Self {
        Self {
            scan: StemScanScheduler::new(),
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
        let scan = self.scan.status(track_id).unwrap_or_default();
        let progress = scan_progress(&scan);
        TrackStemStatus {
            track_id,
            state: "ready".into(),
            progress,
            cache_path: RUNTIME_ID.into(),
            duration: scan.duration,
            error: if scan.phase == "error" {
                scan.error.clone()
            } else {
                String::new()
            },
            phase: scan.phase,
            covered_seconds: scan.covered_seconds,
            window_start: scan.window_start,
            window_end: scan.window_end,
            window_covered_seconds: scan.window_covered_seconds,
            waiting_for_deck: scan.waiting_for_deck,
            source_mtime,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_track(
        &self,
        track_id: i64,
        path: &Path,
        source_mtime: i64,
        anchor_seconds: f64,
        duration: f64,
        deck: u8,
        playing: bool,
    ) -> Result<TrackStemStatus> {
        let _transition = self.runtime_transition.lock().unwrap();
        if !path.is_file() {
            bail!("STEM 输入文件不存在");
        }
        self.scan.mount(
            track_id,
            path,
            Path::new(RUNTIME_ID),
            anchor_seconds,
            duration,
            deck,
            playing,
        )?;
        Ok(self.track_status(track_id, source_mtime))
    }

    pub fn retarget_track(
        &self,
        track_id: i64,
        position: f64,
        source_mtime: i64,
        playing: bool,
    ) -> TrackStemStatus {
        let _transition = self.runtime_transition.lock().unwrap();
        self.scan.retarget(track_id, position, playing);
        self.track_status(track_id, source_mtime)
    }

    pub fn release_track(&self, track_id: i64) {
        self.scan.unmount(track_id);
    }

    pub fn reset_runtime(&self) -> StemRuntimeStatus {
        let _transition = self.runtime_transition.lock().unwrap();
        self.scan.cancel_all("classical_runtime_reset");
        let _ = reset_current_stem_runtime("classical_runtime_reset");
        reset_stem_runtime_diagnostics();
        self.runtime_status()
    }

    pub fn track_waveform(
        &self,
        track_id: i64,
        _source_mtime: i64,
        stem: StemKind,
        columns: usize,
    ) -> Result<StemWaveform> {
        live_stem_waveform(track_id, stem, columns).context("实时 STEM 波形尚未生成")
    }
}

fn scan_progress(scan: &StemScanStatus) -> f32 {
    if scan.phase == "done" {
        return 1.0;
    }
    let span = (scan.window_end - scan.window_start).max(0.0);
    if span <= 0.0 {
        0.0
    } else {
        (scan.window_covered_seconds / span).clamp(0.0, 1.0) as f32
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
    }
}
