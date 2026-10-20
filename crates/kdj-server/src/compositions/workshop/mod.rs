//! The renderer `.kdjv` projects play from (kdjv.rs): mixes a project's sound and composes its
//! picture into `<data>/cache/vj-workshop`. It keeps no records of its own — the project is the
//! file, and the cache can be thrown away.
mod frames;
pub mod kdjv;
mod render;
pub mod routes;
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
    export_slots: tokio::sync::Semaphore,
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
        Ok(Arc::new(Self {
            state,
            cache,
            cache_locks: Mutex::new(HashMap::new()),
            cache_trim_at: Mutex::new(None),
            // Sound chunks are mixed one FFmpeg each, on one thread: a project's sound uses
            // half the cores, at most four.
            preview_slots: tokio::sync::Semaphore::new(
                std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(2, 4)),
            ),
            frame_slots: tokio::sync::Semaphore::new(2),
            export_slots: tokio::sync::Semaphore::new(1),
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
    p.video().map_or((1920, 1080, 30.), |s| {
        let (width, height) = media::workshop_video_size(s).unwrap_or((s.width, s.height));
        let parts: Vec<_> = s.avg_frame_rate.split('/').collect();
        let fps = if parts.len() == 2 {
            parts[0].parse::<f64>().unwrap_or(30.) / parts[1].parse::<f64>().unwrap_or(1.)
        } else {
            30.
        };
        (
            width.max(2),
            height.max(2),
            if fps.is_finite() && fps >= 1. {
                fps.min(120.)
            } else {
                30.
            },
        )
    })
}
