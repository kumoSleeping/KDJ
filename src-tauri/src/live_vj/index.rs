//! Set preprocessing: immutable source signatures, reusable per-block spectra,
//! and one ordered retrieval index. Cache writes never touch the Set document.
use super::{
    diagnostics::{Level, Stage},
    document::{Entry, Set},
    runtime::{log, publish},
    LiveVj,
};
use anyhow::{bail, Context, Result};
use kdj_analysis::alignment::{LiveFeatures, LiveIndex, LIVE_FEATURE_REVISION};
use std::{
    fs,
    hash::{Hash, Hasher},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager};

pub struct Recording {
    pub entry: Entry,
    pub signature: String,
}
pub struct Target {
    pub recording: usize,
    pub start: f64,
    pub end: f64,
    pub path: PathBuf,
}
pub struct PreparedSet {
    pub key: String,
    pub recordings: Vec<Recording>,
    pub targets: Vec<Target>,
    pub index: Mutex<LiveIndex>,
}
pub fn signature(path: &Path) -> Result<String> {
    let m = fs::metadata(path)?;
    Ok(format!(
        "{}:{}",
        m.len(),
        m.modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ))
}
fn key(set: &Set) -> Result<String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (
        "live-set-landmarks-v6",
        LIVE_FEATURE_REVISION,
        serde_json::to_vec(set)?,
    )
        .hash(&mut h);
    for e in &set.entries {
        signature(Path::new(&e.path))?.hash(&mut h);
    }
    Ok(format!("{:016x}", h.finish()))
}
pub fn prepare(
    app: &AppHandle,
    session: &str,
    set: &Set,
    cache: &Path,
    cancel: &AtomicBool,
) -> Result<Arc<PreparedSet>> {
    let key = key(set)?;
    if let Some(ready) = app
        .state::<LiveVj>()
        .prepared
        .lock()
        .unwrap()
        .as_ref()
        .filter(|p| p.key == key)
        .cloned()
    {
        publish(app, session, |v| {
            v.indexed = set.entries.len();
            v.preparing = None;
        });
        log(
            app,
            session,
            Level::Info,
            Stage::Index,
            "复用整套短窗特征索引，无需重新解码".into(),
        );
        return Ok(ready);
    }
    // Sessions cannot overlap. Release a different Set before constructing its
    // replacement, rather than retaining two resident indexes at peak usage.
    app.state::<LiveVj>().prepared.lock().unwrap().take();
    fs::create_dir_all(cache)?;
    let mut recordings = Vec::new();
    let mut targets = Vec::new();
    for (i, entry) in set.entries.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            bail!("已停止")
        }
        let before = signature(Path::new(&entry.path))?;
        for core in (0..entry.duration.ceil() as usize).step_by(300) {
            let start = (core as f64 - 8.).max(0.);
            let end = (core as f64 + 308.).min(entry.duration);
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (
                "live-vj-landmarks-v6",
                LIVE_FEATURE_REVISION,
                &entry.path,
                &before,
                start.to_bits(),
                end.to_bits(),
            )
                .hash(&mut h);
            targets.push(Target {
                recording: i,
                start,
                end,
                path: cache.join(format!("{:016x}.afp", h.finish())),
            });
        }
        recordings.push(Recording {
            entry: entry.clone(),
            signature: before,
        });
    }
    let index_path = cache.join(format!("set-{key}.lvi"));
    let disk_index = fs::File::open(&index_path)
        .ok()
        .and_then(|f| LiveIndex::read_from(BufReader::new(f)).ok())
        .filter(|index| {
            index.targets() == (0..targets.len()).collect::<Vec<_>>()
                && targets.iter().all(|t| t.path.is_file())
        });
    let mut index = if let Some(index) = disk_index {
        log(
            app,
            session,
            Level::Info,
            Stage::Index,
            format!(
                "读取整套特征索引 · {} 个素材 / {} 个区块 · 顺序及素材签名一致",
                recordings.len(),
                targets.len()
            ),
        );
        index
    } else {
        let mut index = LiveIndex::default();
        for (id, target) in targets.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                bail!("已停止")
            }
            let recording = &recordings[target.recording];
            let entry = &recording.entry;
            publish(app, session, |v| {
                v.phase = "indexing".into();
                v.preparing = Some(entry.id.clone());
                v.indexed = target.recording;
            });
            let cached = fs::File::open(&target.path)
                .ok()
                .and_then(|f| LiveFeatures::read_from(BufReader::new(f)).ok());
            let summary = if let Some(summary) = cached {
                log(
                    app,
                    session,
                    Level::Info,
                    Stage::Index,
                    format!("{} · 复用指纹，加入整套索引", entry.title),
                );
                summary
            } else {
                log(
                    app,
                    session,
                    Level::Info,
                    Stage::Index,
                    format!(
                        "{} · {:.1}–{:.1} 秒 · 提取音频特征",
                        entry.title, target.start, target.end
                    ),
                );
                let audio = kdj_analysis::decode::decode_audio_from_cancellable(
                    Path::new(&entry.path),
                    8000,
                    Some(target.end - target.start),
                    target.start,
                    &|| cancel.load(Ordering::Relaxed),
                )?
                .context("已停止")?;
                let features =
                    LiveFeatures::prepare(&audio.samples, &|| cancel.load(Ordering::Relaxed))?;
                anyhow::ensure!(
                    signature(Path::new(&entry.path))? == recording.signature,
                    "素材已变化：{}",
                    entry.title
                );
                let temp = target.path.with_extension("part");
                let saved = (|| -> Result<()> {
                    let mut f = BufWriter::new(fs::File::create(&temp)?);
                    features.write_to(&mut f)?;
                    f.flush()?;
                    fs::rename(&temp, &target.path)?;
                    Ok(())
                })();
                if saved.is_err() {
                    let _ = fs::remove_file(&temp);
                }
                saved?;
                features
            };
            index.add(id, &summary)?;
            log(
                app,
                session,
                Level::Info,
                Stage::Index,
                format!(
                    "索引区块 {}/{} · {} 条地标 · {:.1} MiB",
                    id + 1,
                    targets.len(),
                    index.landmark_count(),
                    index.memory_bytes() as f64 / 1_048_576.
                ),
            );
        }
        let temp = index_path.with_extension("part");
        let saved = (|| -> Result<()> {
            let mut f = BufWriter::new(fs::File::create(&temp)?);
            index.write_to(&mut f)?;
            f.flush()?;
            fs::rename(&temp, &index_path)?;
            Ok(())
        })();
        if saved.is_err() {
            let _ = fs::remove_file(&temp);
        }
        saved?;
        index
    };
    anyhow::ensure!(self::key(set)? == key, "预处理期间素材已变化，请重试");
    index.warm(&|| cancel.load(Ordering::Relaxed))?;
    let landmark_count = index.landmark_count();
    let index_mib = index.memory_bytes() as f64 / 1_048_576.;
    let ready = Arc::new(PreparedSet {
        key,
        recordings,
        targets,
        index: Mutex::new(index),
    });
    *app.state::<LiveVj>().prepared.lock().unwrap() = Some(ready.clone());
    publish(app, session, |v| {
        v.indexed = set.entries.len();
        v.preparing = None;
    });
    log(
        app,
        session,
        Level::Info,
        Stage::Index,
        format!(
            "整套预处理完成 · {} 个素材 · {} 条地标 · {:.1} MiB · 常驻倒排索引已就绪",
            set.entries.len(),
            landmark_count,
            index_mib
        ),
    );
    Ok(ready)
}
