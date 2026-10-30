//! The song visualizer's export. A KDJ window draws every frame and encodes it with its
//! WebView's own H.264 encoder (WebCodecs); `studio` checks the GOPs it uploads and puts them
//! with the song's AAC (copied, or encoded by the system encoder) into an MP4 through
//! `kdj-media`. No FFmpeg: a system without a video encoder in its WebView cannot export.
pub mod studio;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

/// Staging directories are named so (the library scan skips them, kdj-library `scan.rs`).
const STAGE_PREFIX: &str = ".kdj-composition-";

/// An export's own staging directory beside its output; what it made there goes with it.
struct Stage(PathBuf);
impl Stage {
    fn new(directory: &Path) -> Result<Self> {
        let path = directory.join(format!("{STAGE_PREFIX}visualizer-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&path).context("无法建立可视化临时目录")?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        // Exact owned paths only; never recursively erase an unexpected file.
        for name in ["render.mp4", "video.h264s", "audio.aac"] {
            let _ = std::fs::remove_file(self.0.join(name));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}
fn check(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "可视化导出已取消");
    Ok(())
}
fn source(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(
        path.is_absolute() && path.is_file(),
        "素材必须是可读取的完整本地文件：{}",
        path.display()
    );
    path.canonicalize().context("无法解析素材路径")
}
fn destination(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    ensure!(
        path.is_absolute()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("mp4")),
        "输出必须是本地 MP4 的绝对路径"
    );
    let parent = path.parent().context("输出目录无效")?;
    ensure!(parent.is_dir(), "输出目录不存在");
    let output = parent
        .canonicalize()?
        .join(path.file_name().context("输出文件名无效")?);
    match std::fs::symlink_metadata(&output) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => bail!("输出文件已存在，未覆盖"),
    }
    Ok(output)
}

/// A song file as it is now: its size, its modification time and a hash of its two ends.
/// An export started for one signature does not commit if the file changed meanwhile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub size: u64,
    pub modified_ns: u128,
    pub edge_hash: u64,
}

pub fn signature(path: &Path) -> Result<Signature> {
    use std::hash::Hasher;
    let mut file = std::fs::File::open(path).context("源文件无法读取")?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        bail!("源路径不是普通文件");
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut buffer = vec![0; 65536];
    let count = file.read(&mut buffer)?;
    hash.write(&buffer[..count]);
    if meta.len() > 65536 {
        file.seek(SeekFrom::End(-65536))?;
        let count = file.read(&mut buffer)?;
        hash.write(&buffer[..count]);
    }
    Ok(Signature {
        size: meta.len(),
        modified_ns: meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        edge_hash: hash.finish(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_is_new_local_mp4_only() {
        let scratch = std::env::temp_dir().join(format!("kdj-visualizer-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&scratch).unwrap();
        let output = scratch.join("existing.mp4");
        std::fs::write(&output, b"original").unwrap();
        assert!(destination(output.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        assert!(destination("https://example.test/output.mp4").is_err());
        assert!(destination(scratch.join("wrong.mkv").to_str().unwrap()).is_err());
        assert!(destination(scratch.join("new.mp4").to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn a_stage_goes_with_what_it_made_and_nothing_else() {
        let scratch = std::env::temp_dir().join(format!("kdj-visualizer-stage-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&scratch).unwrap();
        let stage = Stage::new(&scratch).unwrap();
        assert!(stage.0.file_name().unwrap().to_string_lossy().starts_with(STAGE_PREFIX));
        std::fs::write(stage.0.join("render.mp4"), b"x").unwrap();
        let path = stage.0.clone();
        drop(stage);
        assert!(!path.exists());
        let kept = Stage::new(&scratch).unwrap();
        std::fs::write(kept.0.join("someone-else.txt"), b"x").unwrap();
        let path = kept.0.clone();
        drop(kept);
        assert!(path.join("someone-else.txt").exists(), "an unexpected file is never erased");
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
