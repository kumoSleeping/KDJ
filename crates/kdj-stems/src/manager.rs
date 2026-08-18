use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::cache::{StemKind, StemWaveform};
use crate::live::{live_stem_waveform, stem_runtime_diagnostics, StemRuntimeDiagnostics};
use crate::scan::{StemScanScheduler, StemScanStatus};
use crate::{MODEL_ID, MODEL_VERSION, RUNTIME_KEY};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub version: String,
    pub supported: bool,
    pub state: String,
    pub progress: f32,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: String,
    pub diagnostics: StemRuntimeDiagnostics,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStemStatus {
    pub track_id: i64,
    pub state: String,
    pub progress: f32,
    /// Kept for the existing transport schema. For classical DSP this is a stable runtime key,
    /// not a model or whole-track cache path.
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
}

impl StemCoordinator {
    pub fn new(_data_dir: &Path) -> Self {
        Self {
            scan: StemScanScheduler::new(),
        }
    }

    pub fn model_status(&self) -> ModelStatus {
        ModelStatus {
            id: MODEL_ID.into(),
            version: MODEL_VERSION.into(),
            supported: true,
            state: "ready".into(),
            progress: 1.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            error: String::new(),
            diagnostics: stem_runtime_diagnostics(),
        }
    }

    /// Compatibility endpoint: there is nothing to install, so requesting the separator is an
    /// idempotent status read and never starts network or model I/O.
    pub fn request_model(&self) -> Result<ModelStatus> {
        Ok(self.model_status())
    }

    pub fn track_status(&self, track_id: i64, source_mtime: i64) -> TrackStemStatus {
        let scan = self.scan.status(track_id);
        let scan = scan.unwrap_or_default();
        let progress = scan_progress(&scan);
        TrackStemStatus {
            track_id,
            state: "ready".into(),
            progress,
            // Performance playback still carries its runtime identity through the historical
            // `cachePath` field. An empty value means "not installable" to PlayerBar, so publish
            // the built-in DSP key even though the worker never opens a file at this location.
            cache_path: RUNTIME_KEY.into(),
            duration: scan.duration,
            error: scan.error.clone(),
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
        if !path.is_file() {
            bail!("STEM 输入文件不存在");
        }
        // The path parameter remains only to avoid a destructive server/player protocol change.
        // No file is read from it by the separator pool.
        self.scan.mount(
            track_id,
            path,
            Path::new("classical-dsp"),
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
        self.scan.retarget(track_id, position, playing);
        self.track_status(track_id, source_mtime)
    }

    pub fn release_track(&self, track_id: i64) {
        self.scan.unmount(track_id);
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
        return if scan.phase.is_empty() { 1.0 } else { 0.0 };
    }
    (scan.window_covered_seconds / span).clamp(0.0, 1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn classical_separator_is_ready_without_artifacts() {
        let data = PathBuf::from("/directory/that/does/not/need/to/exist");
        let coordinator = StemCoordinator::new(&data);
        let status = coordinator.model_status();
        assert!(status.supported);
        assert_eq!(status.state, "ready");
        assert_eq!(status.total_bytes, 0);
        assert!(status.diagnostics.runtime.contains("Classical"));
    }

    #[test]
    fn ready_track_exposes_the_builtin_runtime_to_the_playback_bridge() {
        let coordinator = StemCoordinator::new(Path::new("/unused"));
        let status = coordinator.track_status(42, 7);
        assert_eq!(status.state, "ready");
        assert_eq!(status.cache_path, RUNTIME_KEY);
    }
}
