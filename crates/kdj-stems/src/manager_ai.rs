use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::cache::{StemKind, StemWaveform};
use crate::live::{live_stem_waveform, stem_runtime_diagnostics, StemRuntimeDiagnostics};
use crate::model::{platform_model_artifact, ModelArtifact, ModelInstall};
use crate::scan::{StemScanScheduler, StemScanStatus};
use crate::{MODEL_ID, MODEL_VERSION};

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
    /// can be ready while its first real GPU/CPU inference has not happened yet.
    pub diagnostics: StemRuntimeDiagnostics,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStemStatus {
    pub track_id: i64,
    pub state: String,
    pub progress: f32,
    /// This is the selected native model path, not a whole-track audio cache.
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
    model_status: Arc<Mutex<ModelStatus>>,
    sender: SyncSender<Job>,
    scan: StemScanScheduler,
}

enum Job {
    Model,
}

impl StemCoordinator {
    pub fn new(data_dir: &Path) -> Self {
        let root = data_dir.join("stems");
        let artifact = platform_model_artifact();
        let installed = model_is_installed(&root);
        let diagnostics = StemRuntimeDiagnostics::planned();
        let model_status = Arc::new(Mutex::new(ModelStatus {
            id: artifact.map_or_else(|| MODEL_ID.into(), |artifact| artifact.id.into()),
            version: MODEL_VERSION.into(),
            supported: artifact.is_some(),
            state: if artifact.is_none() {
                "unsupported"
            } else if installed {
                "ready"
            } else {
                "missing"
            }
            .into(),
            progress: if installed { 1.0 } else { 0.0 },
            downloaded_bytes: if installed {
                artifact.map_or(0, |artifact| artifact.bytes)
            } else {
                0
            },
            total_bytes: artifact.map_or(0, |artifact| artifact.bytes),
            error: String::new(),
            diagnostics,
        }));
        let (sender, receiver) = mpsc::sync_channel(8);
        let receiver = Arc::new(Mutex::new(receiver));
        // Model installation remains outside request handling and is serialized by this gate.
        let model_gate = Arc::new(Mutex::new(()));
        for worker_index in 0..2 {
            let worker_root = root.clone();
            let worker_model_status = Arc::clone(&model_status);
            let worker_receiver = Arc::clone(&receiver);
            let worker_model_gate = Arc::clone(&model_gate);
            std::thread::Builder::new()
                .name(format!("kdj-scnet-model-{worker_index}"))
                .spawn(move || {
                    kdj_core::thread_qos::prefer_background();
                    run_worker(
                        worker_root,
                        worker_model_status,
                        worker_receiver,
                        worker_model_gate,
                    );
                })
                .expect("spawn SCNet model worker");
        }
        Self {
            root,
            model_status,
            sender,
            scan: StemScanScheduler::new(),
        }
    }

    pub fn model_status(&self) -> ModelStatus {
        let mut status = self.model_status.lock().unwrap().clone();
        status.diagnostics = stem_runtime_diagnostics();
        status
    }

    pub fn request_model(&self) -> Result<ModelStatus> {
        if platform_model_artifact().is_none() {
            bail!("当前平台尚未接入 SCNet Small runtime");
        }
        let current = self.model_status();
        if matches!(current.state.as_str(), "ready" | "queued" | "downloading") {
            return Ok(current);
        }
        {
            let mut status = self.model_status.lock().unwrap();
            status.state = "queued".into();
            status.error.clear();
        }
        if let Err(error) = self.sender.try_send(Job::Model) {
            let mut status = self.model_status.lock().unwrap();
            status.state = "error".into();
            status.error = "SCNet Small 下载队列已满".into();
            return Err(error).context("SCNet Small 下载队列已满");
        }
        Ok(self.model_status())
    }

    pub fn track_status(&self, track_id: i64, source_mtime: i64) -> TrackStemStatus {
        let installed = model_is_installed(&self.root);
        let model = self.model_status();
        let scan = self.scan.status(track_id);
        let (state, progress, error) = if !installed && model.state == "error" {
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
                model_path(&self.root)
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
        if platform_model_artifact().is_none() {
            bail!("当前平台尚未接入 SCNet Small runtime");
        }
        if !model_is_installed(&self.root) {
            bail!("SCNet Small 模型尚未安装");
        }
        if !path.is_file() {
            bail!("STEM 输入文件不存在");
        }
        let model = model_path(&self.root).context("SCNet Small 平台模型路径不可用")?;
        self.scan.mount(
            track_id,
            path,
            &model,
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
        return 0.0;
    }
    (scan.window_covered_seconds / span).clamp(0.0, 1.0) as f32
}

fn run_worker(
    worker_root: PathBuf,
    worker_model_status: Arc<Mutex<ModelStatus>>,
    receiver: Arc<Mutex<mpsc::Receiver<Job>>>,
    model_gate: Arc<Mutex<()>>,
) {
    loop {
        let job = {
            let receiver = receiver.lock().unwrap();
            receiver.recv()
        };
        let Ok(Job::Model) = job else {
            return;
        };
        let model = {
            let _gate = model_gate.lock().unwrap();
            ensure_model(&worker_root, &worker_model_status)
        };
        if let Err(error) = model {
            let mut status = worker_model_status.lock().unwrap();
            status.state = "error".into();
            status.error = error.to_string();
        }
    }
}

fn version_directory(root: &Path) -> PathBuf {
    root.join("models").join(MODEL_VERSION)
}

fn model_path(root: &Path) -> Option<PathBuf> {
    let artifact = platform_model_artifact()?;
    let version = version_directory(root);
    Some(match artifact.install {
        ModelInstall::ZipDirectory { directory, .. } => version.join(directory),
        ModelInstall::File { path } => version.join(path),
        ModelInstall::OnnxExternal { model, .. } => version.join(model),
    })
}

fn model_marker(root: &Path) -> PathBuf {
    version_directory(root).join("verified.sha256")
}

fn model_is_installed(root: &Path) -> bool {
    let Some(artifact) = platform_model_artifact() else {
        return false;
    };
    let Some(path) = model_path(root) else {
        return false;
    };
    artifact_path_is_valid(artifact, &path)
        && fs::read_to_string(model_marker(root)).is_ok_and(|value| value.trim() == artifact.sha256)
}

fn artifact_path_is_valid(artifact: &ModelArtifact, path: &Path) -> bool {
    match artifact.install {
        ModelInstall::ZipDirectory { required_file, .. } => path.join(required_file).is_file(),
        ModelInstall::File { .. } => path.is_file(),
        ModelInstall::OnnxExternal { data, .. } => {
            path.is_file() && path.with_file_name(data).is_file()
        }
    }
}

fn ensure_model(root: &Path, status: &Arc<Mutex<ModelStatus>>) -> Result<()> {
    let artifact = platform_model_artifact().context("当前平台尚未接入 SCNet Small runtime")?;
    if model_is_installed(root) {
        let mut state = status.lock().unwrap();
        state.state = "ready".into();
        state.progress = 1.0;
        state.downloaded_bytes = artifact.bytes;
        state.error.clear();
        return Ok(());
    }
    {
        let mut state = status.lock().unwrap();
        state.state = "downloading".into();
        state.progress = 0.0;
        state.downloaded_bytes = 0;
        state.error.clear();
    }
    if install_from_local_cache(root, artifact)? {
        mark_ready(status, artifact);
        return Ok(());
    }
    match artifact.install {
        ModelInstall::OnnxExternal {
            model,
            data,
            data_url,
            data_bytes,
            data_sha256,
        } => {
            let version_dir = version_directory(root);
            fs::create_dir_all(&version_dir)?;
            download_verified_file(
                root,
                artifact.url,
                artifact.sha256,
                artifact.filename,
                0,
                artifact.bytes,
                status,
            )?;
            download_verified_file(
                root,
                data_url,
                data_sha256,
                data,
                artifact.bytes.saturating_sub(data_bytes),
                artifact.bytes,
                status,
            )?;
            let model_partial = version_dir.join(format!("{}.partial", artifact.filename));
            let data_partial = version_dir.join(format!("{data}.partial"));
            let model_path = version_dir.join(model);
            let data_path = version_dir.join(data);
            let _ = fs::remove_file(&model_path);
            let _ = fs::remove_file(&data_path);
            fs::rename(&model_partial, &model_path)?;
            fs::rename(&data_partial, &data_path)?;
        }
        _ => {
            let version_dir = version_directory(root);
            fs::create_dir_all(&version_dir)?;
            download_verified_file(
                root,
                artifact.url,
                artifact.sha256,
                artifact.filename,
                0,
                artifact.bytes,
                status,
            )?;
            let archive = version_dir.join(format!("{}.partial", artifact.filename));
            install_verified_artifact(root, artifact, &archive)?;
        }
    }
    fs::write(model_marker(root), format!("{}\n", artifact.sha256))?;
    mark_ready(status, artifact);
    Ok(())
}

fn mark_ready(status: &Arc<Mutex<ModelStatus>>, artifact: &ModelArtifact) {
    let mut state = status.lock().unwrap();
    state.state = "ready".into();
    state.progress = 1.0;
    state.downloaded_bytes = artifact.bytes;
    state.error.clear();
}

fn local_model_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("KDJ_SCNET_MODEL_DIR") {
        if !dir.trim().is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(
            PathBuf::from(home)
                .join("Frameworks")
                .join("scnet-executorch")
                .join("dist"),
        );
    }
    dirs.push(std::env::temp_dir().join("kdj-scnet-coreml"));
    dirs
}

fn install_from_local_cache(root: &Path, artifact: &ModelArtifact) -> Result<bool> {
    for dir in local_model_dirs() {
        match artifact.install {
            ModelInstall::ZipDirectory { .. } | ModelInstall::File { .. } => {
                let source = dir.join(artifact.filename);
                if !source.is_file() || file_sha256(&source)? != artifact.sha256 {
                    continue;
                }
                let version_dir = version_directory(root);
                fs::create_dir_all(&version_dir)?;
                let staging = version_dir.join(format!("{}.partial", artifact.filename));
                fs::copy(&source, &staging)?;
                install_verified_artifact(root, artifact, &staging)?;
                fs::write(model_marker(root), format!("{}\n", artifact.sha256))?;
                return Ok(true);
            }
            ModelInstall::OnnxExternal {
                model,
                data,
                data_sha256,
                ..
            } => {
                let source_model = dir.join(model);
                let source_data = dir.join(data);
                if !source_model.is_file()
                    || !source_data.is_file()
                    || file_sha256(&source_model)? != artifact.sha256
                    || file_sha256(&source_data)? != data_sha256
                {
                    continue;
                }
                let version_dir = version_directory(root);
                fs::create_dir_all(&version_dir)?;
                fs::copy(&source_model, version_dir.join(model))?;
                fs::copy(&source_data, version_dir.join(data))?;
                fs::write(model_marker(root), format!("{}\n", artifact.sha256))?;
                return Ok(true);
            }
        }
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

fn download_verified_file(
    root: &Path,
    url: &str,
    sha256: &str,
    filename: &str,
    progress_base: u64,
    progress_total: u64,
    status: &Arc<Mutex<ModelStatus>>,
) -> Result<()> {
    let version_dir = version_directory(root);
    let archive = version_dir.join(format!("{filename}.partial"));
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("KDJ/SCNet-Small")
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
        let mut state = status.lock().unwrap();
        state.downloaded_bytes = downloaded.min(progress_total);
        state.progress = (downloaded as f64 / progress_total.max(1) as f64).min(1.0) as f32;
    }
    file.sync_all()?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if digest != sha256 {
        let _ = fs::remove_file(&archive);
        bail!("SCNet Small 模型 SHA-256 校验失败");
    }
    Ok(())
}

fn install_verified_artifact(root: &Path, artifact: &ModelArtifact, archive: &Path) -> Result<()> {
    let final_path = model_path(root).context("SCNet Small 平台模型路径不可用")?;
    match artifact.install {
        ModelInstall::File { .. } => {
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ = fs::remove_file(&final_path);
            fs::rename(archive, &final_path)?;
        }
        ModelInstall::OnnxExternal { .. } => {
            bail!("SCNet external ONNX 安装不应走 ZIP/单文件路径");
        }
        ModelInstall::ZipDirectory {
            directory,
            required_file,
        } => {
            let version_dir = version_directory(root);
            let extract_root = version_dir.join("extract.partial");
            let _ = fs::remove_dir_all(&extract_root);
            fs::create_dir_all(&extract_root)?;
            let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
            for index in 0..zip.len() {
                let mut entry = zip.by_index(index)?;
                let relative = entry.enclosed_name().context("SCNet ZIP 路径越界")?;
                let output = extract_root.join(relative);
                if entry.is_dir() {
                    fs::create_dir_all(&output)?;
                } else {
                    if let Some(parent) = output.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let mut target = File::create(&output)?;
                    std::io::copy(&mut entry, &mut target)?;
                }
            }
            let extracted = extract_root.join(directory);
            if !extracted.join(required_file).is_file() {
                bail!("SCNet ZIP 缺少模型 package");
            }
            let _ = fs::remove_dir_all(&final_path);
            fs::rename(&extracted, &final_path)?;
            let _ = fs::remove_dir_all(&extract_root);
            let _ = fs::remove_file(archive);
        }
    }
    if !artifact_path_is_valid(artifact, &final_path) {
        bail!("SCNet 已安装模型不符合运行时契约");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparing_a_track_exposes_model_path_without_creating_audio_cache() {
        let Some(model) = platform_model_artifact() else {
            return;
        };
        let data = std::env::temp_dir().join(format!(
            "kdj-live-stem-manager-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&data);
        let root = data.join("stems");
        let path = model_path(&root).unwrap();
        match model.install {
            ModelInstall::ZipDirectory { required_file, .. } => {
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join(required_file), b"fixture").unwrap();
            }
            ModelInstall::File { .. } | ModelInstall::OnnxExternal { .. } => {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, b"fixture").unwrap();
                if let ModelInstall::OnnxExternal { data, .. } = model.install {
                    fs::write(path.with_file_name(data), b"fixture").unwrap();
                }
            }
        }
        fs::write(model_marker(&root), format!("{}\n", model.sha256)).unwrap();
        let audio = data.join("fixture.wav");
        fs::write(&audio, b"fixture").unwrap();

        let coordinator = StemCoordinator::new(&data);
        let status = coordinator
            .request_track(42, &audio, 7, 12.0, 180.0, 0, false)
            .unwrap();
        assert_eq!(status.cache_path, path.to_string_lossy());
        assert!(!root.join("cache").exists());
        coordinator.release_track(42);
        assert!(live_stem_waveform(42, StemKind::Vocals, 64).is_none());

        drop(coordinator);
        let _ = fs::remove_dir_all(data);
    }
}
