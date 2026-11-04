//! What `.kdjv` projects play from (kdjv.rs): mixes a project's sound into
//! `<data>/cache/vj-workshop`; the window composes the picture live and encodes it for an export
//! (export.rs). It keeps no records of its own — the project is the file, and the cache can be
//! thrown away. Nothing here runs FFmpeg.
mod export;
mod frames;
pub mod kdjv;
pub mod lanes;
mod render;
pub mod routes;
pub mod tracks;
use super::media;
use crate::state::AppState;
use anyhow::{bail, Context, Result};
use kdj_core::workshop::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

fn id() -> String {
    super::entry_id()
}
pub struct Workshop {
    state: Arc<AppState>,
    cache: PathBuf,
    cache_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    cache_trim_at: Mutex<Option<std::time::Instant>>,
    preview_slots: tokio::sync::Semaphore,
    frame_slots: tokio::sync::Semaphore,
}
impl Workshop {
    /// Prepares the render cache only. No user file is read or written here: the old editing
    /// workshop's `vj-projects.json` and its backups stay exactly as they are on disk.
    pub fn new(state: Arc<AppState>) -> Result<Arc<Self>> {
        let cache = state.config.data_dir.join("cache").join("vj-workshop");
        std::fs::create_dir_all(&cache)?;
        let _ = kdjv::INDEX.set(cache.join("kdjv-index"));
        for entry in std::fs::read_dir(&cache)?.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_file())
                && path.extension().is_some_and(|e| e == "part")
            {
                let _ = std::fs::remove_file(path);
            }
        }
        // The staging an earlier run left: its exports', and the FFmpeg renders' of builds
        // before 1.1.0-rc20.
        for entry in std::fs::read_dir(&cache)?.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if [export::STAGE_PREFIX, ".kdj-composition-", ".kdjv-"].iter().any(|p| name.starts_with(p))
                && entry.file_type().is_ok_and(|t| t.is_dir())
            {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        Ok(Arc::new(Self {
            state,
            cache,
            cache_locks: Mutex::new(HashMap::new()),
            cache_trim_at: Mutex::new(None),
            // Sound chunks are mixed one per blocking thread: a project's sound uses half the
            // cores, at most four.
            preview_slots: tokio::sync::Semaphore::new(
                std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(2, 4)),
            ),
            frame_slots: tokio::sync::Semaphore::new(2),
        }))
    }
}
pub fn signature(path: &Path) -> Result<String> {
    let signature = media::signature(path).map_err(|error| {
        #[cfg(target_os = "macos")]
        if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::PermissionDenied)) {
            return anyhow::anyhow!(
                "素材访问被系统拒绝：{}。请点击“授权文件夹”并选择 {}",
                path.display(),
                path.parent().unwrap_or(path).display()
            );
        }
        error
    })?;
    Ok(serde_json::to_string(&signature)?)
}
fn shape(p: &media::Probe) -> (u32, u32, f64) {
    p.picture.as_ref().map_or((1920, 1080, 30.), |s| {
        (s.width.max(2), s.height.max(2), if s.fps.is_finite() && s.fps >= 1. { s.fps.min(120.) } else { 30. })
    })
}
