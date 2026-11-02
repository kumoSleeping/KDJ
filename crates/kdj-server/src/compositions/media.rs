//! What the editor knows of a source file without decoding it: a signature that says whether it
//! is still the same file, and what its container says it holds (kdj_media::probe).
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub use kdj_media::probe::Probe;

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

/// What `path` holds, read on a blocking thread.
pub async fn probe(path: &Path) -> Result<Probe> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || kdj_media::probe::probe(&path)).await?
}

/// A source's length in milliseconds: its picture's when it has one, else its sound's.
pub fn duration_ms(probe: &Probe) -> Result<f64> {
    let secs = match &probe.picture {
        Some(picture) => picture.secs,
        None => probe.sound_secs.context("文件没有可用的音频流")?,
    };
    if !(secs.is_finite() && secs > 0.) {
        bail!("无法确定媒体时长");
    }
    Ok(secs * 1000.)
}
