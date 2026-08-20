use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use kdj_core::{StemCompute, StemMode};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::cache::{StemKind, StemWaveform};
use crate::live::{
    live_stem_waveform, reset_stem_runtime_diagnostics, stem_runtime_diagnostics,
    switch_current_stem_runtime, StemRuntimeDiagnostics,
};
use crate::model::{platform_model_artifact, ModelArtifact};
use crate::runtime::{stem_runtime_preference, StemRuntimePreference};
use crate::scan::{StemScanScheduler, StemScanStatus};

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
    /// Runtime observations are intentionally separate from installation state. A verified model
    /// can be ready while its first real accelerator/CPU inference has not happened yet.
    pub diagnostics: StemRuntimeDiagnostics,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStemStatus {
    pub track_id: i64,
    pub state: String,
    pub progress: f32,
    /// Selected native model directory, not a whole-track audio cache.
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
    root: PathBuf,
    model_statuses: Arc<Mutex<HashMap<StemMode, ModelStatus>>>,
    sender: SyncSender<Job>,
    scan: StemScanScheduler,
    /// Serializes selection checks, scan mounting, and complete runtime replacement.
    runtime_transition: Mutex<()>,
}

enum Job {
    Model(StemMode),
}

impl StemCoordinator {
    pub fn new(data_dir: &Path) -> Self {
        let root = data_dir.join("stems");
        let model_statuses = Arc::new(Mutex::new(
            [StemMode::MobileNetTwo]
                .into_iter()
                .map(|mode| (mode, initial_model_status(&root, mode)))
                .collect(),
        ));
        let (sender, receiver) = mpsc::sync_channel(8);
        let receiver = Arc::new(Mutex::new(receiver));
        // Model installation stays outside request handling and is serialized across model sets.
        let model_gate = Arc::new(Mutex::new(()));
        for worker_index in 0..2 {
            let worker_root = root.clone();
            let worker_model_statuses = Arc::clone(&model_statuses);
            let worker_receiver = Arc::clone(&receiver);
            let worker_model_gate = Arc::clone(&model_gate);
            std::thread::Builder::new()
                .name(format!("kdj-stem-model-{worker_index}"))
                .spawn(move || {
                    kdj_core::thread_qos::prefer_background();
                    run_worker(
                        worker_root,
                        worker_model_statuses,
                        worker_receiver,
                        worker_model_gate,
                    );
                })
                .expect("spawn STEM model worker");
        }
        Self {
            root,
            model_statuses,
            sender,
            scan: StemScanScheduler::new(),
            runtime_transition: Mutex::new(()),
        }
    }

    pub fn model_status(&self, mode: StemMode, _compute: StemCompute) -> ModelStatus {
        let Some(artifact) = platform_model_artifact(mode) else {
            return ModelStatus {
                id: if mode == StemMode::None {
                    "stem-disabled".into()
                } else {
                    "stem-unsupported".into()
                },
                version: String::new(),
                supported: false,
                state: "unsupported".into(),
                progress: 0.0,
                downloaded_bytes: 0,
                total_bytes: 0,
                error: String::new(),
                diagnostics: stem_runtime_diagnostics(),
            };
        };
        let mut statuses = self.model_statuses.lock().unwrap();
        let status = statuses
            .entry(mode)
            .or_insert_with(|| status_for_artifact(&self.root, artifact));
        // Installation can be copied into place while KDJ is running in a development session.
        if status.state == "missing" && model_is_installed(&self.root, artifact) {
            status.state = "ready".into();
            status.progress = 1.0;
            status.downloaded_bytes = artifact.bytes();
        }
        let mut result = status.clone();
        result.diagnostics = stem_runtime_diagnostics();
        result
    }

    pub fn request_model(&self, mode: StemMode, compute: StemCompute) -> Result<ModelStatus> {
        if mode == StemMode::None {
            bail!("STEM 已关闭");
        }
        let artifact = platform_model_artifact(mode).context("当前平台尚未接入 STEM runtime")?;
        let current = self.model_status(mode, compute);
        if matches!(current.state.as_str(), "ready" | "queued" | "downloading") {
            return Ok(current);
        }
        {
            let mut statuses = self.model_statuses.lock().unwrap();
            let status = statuses
                .entry(mode)
                .or_insert_with(|| status_for_artifact(&self.root, artifact));
            status.state = "queued".into();
            status.error.clear();
        }
        if let Err(error) = self.sender.try_send(Job::Model(mode)) {
            let mut statuses = self.model_statuses.lock().unwrap();
            if let Some(status) = statuses.get_mut(&mode) {
                status.state = "error".into();
                status.error = "STEM 模型下载队列已满".into();
            }
            return Err(error).context("STEM 模型下载队列已满");
        }
        Ok(self.model_status(mode, compute))
    }

    pub fn track_status(
        &self,
        mode: StemMode,
        compute: StemCompute,
        track_id: i64,
        source_mtime: i64,
    ) -> TrackStemStatus {
        let artifact = platform_model_artifact(mode);
        let installed = artifact.is_some_and(|artifact| model_is_installed(&self.root, artifact));
        let model = self.model_status(mode, compute);
        let scan = self.scan.status(track_id);
        let (state, progress, error) = if mode == StemMode::None {
            ("missing", 0.0, String::new())
        } else if !installed && model.state == "error" {
            ("error", 0.0, model.error)
        } else if installed {
            (
                "ready",
                scan.as_ref().map(scan_progress).unwrap_or(1.0),
                scan.as_ref()
                    .filter(|scan| scan.phase == "error")
                    .map(|scan| scan.error.clone())
                    .unwrap_or_default(),
            )
        } else {
            ("missing", 0.0, String::new())
        };
        let scan = scan.unwrap_or_default();
        TrackStemStatus {
            track_id,
            state: state.into(),
            progress,
            cache_path: if installed {
                artifact
                    .map(|artifact| model_path(&self.root, artifact))
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default()
            } else {
                String::new()
            },
            duration: scan.duration,
            error,
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
        mode: StemMode,
        compute: StemCompute,
        track_id: i64,
        path: &Path,
        source_mtime: i64,
        anchor_seconds: f64,
        duration: f64,
        deck: u8,
        playing: bool,
    ) -> Result<TrackStemStatus> {
        let _transition = self.runtime_transition.lock().unwrap();
        let requested = StemRuntimePreference { mode, compute };
        let active = stem_runtime_preference();
        if active != requested {
            bail!(
                "STEM runtime selection is stale: requested {:?}/{:?}, active {:?}/{:?}",
                mode,
                compute,
                active.mode,
                active.compute
            );
        }
        let artifact = platform_model_artifact(mode).context("STEM 已关闭或当前平台不受支持")?;
        if !model_is_installed(&self.root, artifact) {
            bail!("{} 模型尚未安装", artifact.id);
        }
        if !path.is_file() {
            bail!("STEM 输入文件不存在");
        }
        let model = model_path(&self.root, artifact);
        self.scan.mount(
            track_id,
            path,
            &model,
            anchor_seconds,
            duration,
            deck,
            playing,
        )?;
        Ok(self.track_status(mode, compute, track_id, source_mtime))
    }

    pub fn retarget_track(
        &self,
        mode: StemMode,
        compute: StemCompute,
        track_id: i64,
        position: f64,
        source_mtime: i64,
        playing: bool,
    ) -> TrackStemStatus {
        let _transition = self.runtime_transition.lock().unwrap();
        let requested = StemRuntimePreference { mode, compute };
        if stem_runtime_preference() != requested {
            tracing::debug!(
                target: "kdj_stem_lifecycle",
                event = "stale_retarget_ignored",
                track_id,
                requested_mode = ?mode,
                requested_compute = ?compute,
                active_mode = ?stem_runtime_preference().mode,
                active_compute = ?stem_runtime_preference().compute,
                "stale STEM status poll cannot change the active runtime"
            );
            return self.track_status(mode, compute, track_id, source_mtime);
        }
        if mode == StemMode::None {
            self.scan.unmount(track_id);
        } else {
            self.scan.retarget(track_id, position, playing);
        }
        self.track_status(mode, compute, track_id, source_mtime)
    }

    pub fn release_track(&self, track_id: i64) {
        self.scan.unmount(track_id);
    }

    pub fn activate_runtime(&self, mode: StemMode, compute: StemCompute) -> ModelStatus {
        let _transition = self.runtime_transition.lock().unwrap();
        let previous = stem_runtime_preference();
        let next = StemRuntimePreference { mode, compute };
        if previous != next {
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "runtime_switch_begin",
                old_mode = ?previous.mode,
                old_compute = ?previous.compute,
                new_mode = ?mode,
                new_compute = ?compute,
                "STEM runtime switch begins"
            );
            self.scan.cancel_all("runtime_switch");
            let _ = switch_current_stem_runtime(mode, compute, "runtime_switch");
            reset_stem_runtime_diagnostics();
            tracing::info!(
                target: "kdj_stem_lifecycle",
                event = "runtime_switch_complete",
                mode = ?mode,
                compute = ?compute,
                "previous STEM sessions unloaded; new runtime is active"
            );
        }
        self.model_status(mode, compute)
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

fn initial_model_status(root: &Path, mode: StemMode) -> ModelStatus {
    platform_model_artifact(mode).map_or_else(
        || ModelStatus {
            id: "stem-unsupported".into(),
            version: String::new(),
            supported: false,
            state: "unsupported".into(),
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            error: String::new(),
            diagnostics: StemRuntimeDiagnostics::planned(),
        },
        |artifact| status_for_artifact(root, artifact),
    )
}

fn status_for_artifact(root: &Path, artifact: &ModelArtifact) -> ModelStatus {
    let installed = model_is_installed(root, artifact);
    ModelStatus {
        id: artifact.id.into(),
        version: artifact.version.into(),
        supported: true,
        state: if installed { "ready" } else { "missing" }.into(),
        progress: if installed { 1.0 } else { 0.0 },
        downloaded_bytes: if installed { artifact.bytes() } else { 0 },
        total_bytes: artifact.bytes(),
        error: String::new(),
        diagnostics: StemRuntimeDiagnostics::planned(),
    }
}

fn scan_progress(scan: &StemScanStatus) -> f32 {
    if scan.phase == "done" {
        return 1.0;
    }
    let span = (scan.window_end - scan.window_start).max(0.0);
    if span <= 0.0 {
        return 0.0;
    }
    (scan.window_covered_seconds / span).clamp(0.0, 1.0) as f32
}

fn run_worker(
    worker_root: PathBuf,
    worker_model_statuses: Arc<Mutex<HashMap<StemMode, ModelStatus>>>,
    receiver: Arc<Mutex<mpsc::Receiver<Job>>>,
    model_gate: Arc<Mutex<()>>,
) {
    loop {
        let job = {
            let receiver = receiver.lock().unwrap();
            receiver.recv()
        };
        let Ok(Job::Model(mode)) = job else {
            return;
        };
        let result = {
            let _gate = model_gate.lock().unwrap();
            ensure_model(&worker_root, mode, &worker_model_statuses)
        };
        if let Err(error) = result {
            let mut statuses = worker_model_statuses.lock().unwrap();
            if let Some(status) = statuses.get_mut(&mode) {
                status.state = "error".into();
                status.error = error.to_string();
            }
        }
    }
}

fn version_directory(root: &Path, artifact: &ModelArtifact) -> PathBuf {
    root.join("models").join(artifact.version)
}

fn model_path(root: &Path, artifact: &ModelArtifact) -> PathBuf {
    version_directory(root, artifact).join(artifact.directory)
}

fn model_marker(root: &Path, artifact: &ModelArtifact) -> PathBuf {
    version_directory(root, artifact).join("verified.sha256")
}

fn model_is_installed(root: &Path, artifact: &ModelArtifact) -> bool {
    artifact_path_is_valid(artifact, &model_path(root, artifact))
        && fs::read_to_string(model_marker(root, artifact))
            .is_ok_and(|value| value.trim() == artifact.identity_sha256)
}

fn artifact_path_is_valid(artifact: &ModelArtifact, path: &Path) -> bool {
    path.is_dir()
        && artifact
            .files
            .iter()
            .all(|file| path.join(file.filename).is_file())
}

fn ensure_model(
    root: &Path,
    mode: StemMode,
    statuses: &Arc<Mutex<HashMap<StemMode, ModelStatus>>>,
) -> Result<()> {
    let artifact = platform_model_artifact(mode).context("当前平台尚未接入 STEM runtime")?;
    if model_is_installed(root, artifact) {
        mark_ready(statuses, artifact);
        return Ok(());
    }
    update_status(statuses, mode, |status| {
        status.state = "downloading".into();
        status.progress = 0.0;
        status.downloaded_bytes = 0;
        status.error.clear();
    });
    if install_from_local_cache(root, artifact)? {
        mark_ready(statuses, artifact);
        return Ok(());
    }
    let version_dir = version_directory(root, artifact);
    fs::create_dir_all(&version_dir)?;
    let total = artifact.bytes();
    let mut progress_base = 0;
    for file in artifact.files {
        download_verified_file(
            root,
            artifact,
            file.url,
            file.sha256,
            file.filename,
            progress_base,
            total,
            statuses,
        )?;
        progress_base += file.bytes;
    }
    install_verified_artifact_set(root, artifact)?;
    fs::write(
        model_marker(root, artifact),
        format!("{}\n", artifact.identity_sha256),
    )?;
    mark_ready(statuses, artifact);
    Ok(())
}

fn update_status(
    statuses: &Arc<Mutex<HashMap<StemMode, ModelStatus>>>,
    mode: StemMode,
    update: impl FnOnce(&mut ModelStatus),
) {
    if let Some(status) = statuses.lock().unwrap().get_mut(&mode) {
        update(status);
    }
}

fn mark_ready(statuses: &Arc<Mutex<HashMap<StemMode, ModelStatus>>>, artifact: &ModelArtifact) {
    update_status(statuses, StemMode::MobileNetTwo, |status| {
        status.state = "ready".into();
        status.progress = 1.0;
        status.downloaded_bytes = artifact.bytes();
        status.error.clear();
    });
}

fn local_model_dirs(artifact: &ModelArtifact) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var(artifact.local_env) {
        if !dir.trim().is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(
            PathBuf::from(home)
                .join("Frameworks")
                .join("kdj-stem-model-eval")
                .join(artifact.directory),
        );
    }
    dirs.push(std::env::temp_dir().join(artifact.directory));
    dirs
}

fn install_from_local_cache(root: &Path, artifact: &ModelArtifact) -> Result<bool> {
    for dir in local_model_dirs(artifact) {
        let source = if artifact_path_is_valid(artifact, &dir) {
            dir.clone()
        } else {
            dir.join(artifact.directory)
        };
        if !artifact_path_is_valid(artifact, &source) {
            continue;
        }
        let mut valid = true;
        for file in artifact.files {
            if file_sha256(&source.join(file.filename))? != file.sha256 {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }
        let version_dir = version_directory(root, artifact);
        let staging = version_dir.join("model.install.partial");
        fs::create_dir_all(&version_dir)?;
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;
        for file in artifact.files {
            fs::copy(source.join(file.filename), staging.join(file.filename))?;
        }
        activate_staging_directory(root, artifact, &staging)?;
        fs::write(
            model_marker(root, artifact),
            format!("{}\n", artifact.identity_sha256),
        )?;
        return Ok(true);
    }
    Ok(false)
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[allow(clippy::too_many_arguments)]
fn download_verified_file(
    root: &Path,
    artifact: &ModelArtifact,
    url: &str,
    sha256: &str,
    filename: &str,
    progress_base: u64,
    progress_total: u64,
    statuses: &Arc<Mutex<HashMap<StemMode, ModelStatus>>>,
) -> Result<()> {
    let version_dir = version_directory(root, artifact);
    let archive = version_dir.join(format!("{filename}.partial"));
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("KDJ/STEM-ONNX")
        .build()?
        .get(url)
        .send()?
        .error_for_status()?;
    let mut file = File::create(&archive)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    let mut downloaded = progress_base;
    loop {
        let count = response.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        update_status(statuses, artifact.mode, |status| {
            status.downloaded_bytes = downloaded.min(progress_total);
            status.progress = (downloaded as f64 / progress_total.max(1) as f64).min(1.0) as f32;
        });
    }
    file.sync_all()?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if digest != sha256 {
        let _ = fs::remove_file(&archive);
        bail!("STEM 模型 {filename} SHA-256 校验失败");
    }
    Ok(())
}

fn install_verified_artifact_set(root: &Path, artifact: &ModelArtifact) -> Result<()> {
    let version_dir = version_directory(root, artifact);
    let staging = version_dir.join("model.install.partial");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    for file in artifact.files {
        fs::rename(
            version_dir.join(format!("{}.partial", file.filename)),
            staging.join(file.filename),
        )?;
    }
    activate_staging_directory(root, artifact, &staging)
}

fn activate_staging_directory(root: &Path, artifact: &ModelArtifact, staging: &Path) -> Result<()> {
    let final_path = model_path(root, artifact);
    if !artifact_path_is_valid(artifact, staging) {
        bail!("STEM 已下载模型不符合运行时文件契约");
    }
    let _ = fs::remove_dir_all(&final_path);
    fs::rename(staging, &final_path)?;
    if !artifact_path_is_valid(artifact, &final_path) {
        bail!("STEM 已安装模型不符合运行时契约");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_and_marker_use_the_locked_bytedance_artifact() {
        let root = Path::new("/tmp/kdj-stem-manager-contract");
        let model = platform_model_artifact(StemMode::MobileNetTwo).unwrap();
        assert!(model_path(root, model).ends_with(model.directory));
        assert!(model_marker(root, model).ends_with("verified.sha256"));
    }
}
