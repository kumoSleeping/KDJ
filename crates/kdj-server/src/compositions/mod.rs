//! Persistent local composition queue. The journal is the authority; workers own immutable
//! (id, generation) leases, and a durable commit receipt prevents duplicate overwrites.
mod acceleration;
pub mod workshop;
#[cfg(test)]
mod lifecycle_tests;
mod media;
#[cfg(test)]
mod media_tests;
pub mod routes;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use kdj_core::composition::*;
use kdj_core::work_scheduler::{WorkClass, WorkRequest, work_scheduler};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::state::AppState;
use media::{Probe, Signature};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommitReceipt {
    directory: PathBuf,
    temporary: PathBuf,
    output: PathBuf,
    signature: Signature,
    committed: bool,
    #[serde(default)]
    imported: bool,
    #[serde(default)]
    imported_track_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    task: CompositionTask,
    video_signature: Option<Signature>,
    audio_signature: Option<Signature>,
    video_probe: Option<Probe>,
    audio_probe: Option<Probe>,
    receipt: Option<CommitReceipt>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Journal {
    #[serde(skip)]
    session_id: String,
    version: u32,
    revision: u64,
    defaults: CompositionOptions,
    #[serde(default)]
    custom_output_dir: bool,
    records: Vec<Record>,
}

struct Run {
    cancel: CancellationToken,
    reads: Vec<String>,
    writes: Option<String>,
}

struct Inner {
    journal: Journal,
    runs: HashMap<(String, u64), Run>,
}

pub struct CompositionManager {
    state: Arc<AppState>,
    path: PathBuf,
    inner: Mutex<Inner>,
}

fn entry_id() -> String {
    format!(
        "{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    )
}
fn entry_key(entry: &Option<CompositionEntry>) -> Option<&str> {
    entry.as_ref().map(|e| e.id.as_str())
}
fn overlay(task: &CompositionTask) -> bool {
    task.audio.as_ref().is_some_and(|e| e.is_video)
}

fn new_record(
    mut video: Option<CompositionEntry>,
    audio: Option<CompositionEntry>,
    generation: u64,
) -> Record {
    if let Some(video) = video.as_mut() {
        video.options.segment = CompositionSegment::default();
    }
    let id = video
        .as_ref()
        .or(audio.as_ref())
        .expect("nonempty composition row")
        .id
        .clone();
    let phase = if video.is_some() && audio.is_some() {
        CompositionPhase::PendingAnalysis
    } else {
        CompositionPhase::WaitingPair
    };
    Record {
        task: CompositionTask {
            id,
            video,
            audio,
            phase,
            generation,
            released: false,
            busy: false,
            offset_ms: None,
            matched: false,
            force_confirmed: false,
            video_duration_ms: None,
            audio_duration_ms: None,
            timeline: None,
            video_sections: Vec::new(),
            progress: None,
            error: String::new(),
            output_path: String::new(),
        },
        video_signature: None,
        audio_signature: None,
        video_probe: None,
        audio_probe: None,
        receipt: None,
    }
}

fn recalculate(record: &mut Record) {
    let task = &mut record.task;
    if task.uses_video_sections() {
        task.timeline=task.video_duration_ms.zip(task.audio_duration_ms).and_then(|(v,a)|video_sections_timeline(&task.video_sections,v,a,&task.video.as_ref()?.options.segment));
        return;
    }
    task.timeline = task
        .video_duration_ms
        .zip(task.audio_duration_ms)
        .zip(task.offset_ms)
        .and_then(|((v, a), offset)| {
            let policy = if overlay(task) {
                LengthPolicy::KeepVideo
            } else {
                task.video.as_ref()?.options.length_policy
            };
            task.video
                .as_ref()?
                .options
                .segment
                .timeline(v, a, offset, policy)
        });
}

/// Rezip only editable lanes. Released rows are fixed anchors and never change partners.
fn repack(journal: &mut Journal, videos: Vec<CompositionEntry>, audios: Vec<CompositionEntry>) {
    let originals = journal.records.clone();
    let mut rows = Vec::new();
    for index in 0..videos.len().max(audios.len()) {
        let video = videos.get(index).cloned();
        let audio = audios.get(index).cloned();
        if let Some(previous) = originals.iter().find(|r| {
            r.task.editable()
                && entry_key(&r.task.video) == entry_key(&video)
                && entry_key(&r.task.audio) == entry_key(&audio)
        }) {
            let mut previous = previous.clone();
            previous.task.video = video;
            previous.task.audio = audio;
            rows.push(previous);
        } else {
            let generation = originals
                .iter()
                .map(|r| r.task.generation)
                .max()
                .unwrap_or(0)
                + 1;
            rows.push(new_record(video, audio, generation));
        }
    }
    let mut rows = rows.into_iter();
    journal.records = originals
        .into_iter()
        .filter_map(|record| {
            if record.task.editable() {
                rows.next()
            } else {
                Some(record)
            }
        })
        .collect();
    journal.records.extend(rows);
}

fn lanes(journal: &Journal) -> (Vec<CompositionEntry>, Vec<CompositionEntry>) {
    let editable = journal.records.iter().filter(|r| r.task.editable());
    (
        editable
            .clone()
            .filter_map(|r| r.task.video.clone())
            .collect(),
        editable.filter_map(|r| r.task.audio.clone()).collect(),
    )
}

fn snapshot(journal: &Journal) -> CompositionSnapshot {
    CompositionSnapshot {
        session_id: journal.session_id.clone(),
        revision: journal.revision,
        tasks: journal.records.iter().map(|r| r.task.clone()).collect(),
        defaults: journal.defaults.clone(),
    }
}

fn save(path: &Path, journal: &Journal) -> Result<()> {
    let parent = path.parent().context("队列目录无效")?;
    std::fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec(journal)?)?;
    file.sync_all()?;
    drop(file);
    media::replace_file(&temporary, path).context("保存合成队列失败")?;
    #[cfg(unix)]
    {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn cleanup(receipt: &CommitReceipt) {
    // Never trust arbitrary paths from a hand-edited journal for cleanup.
    if receipt.directory.parent() != receipt.output.parent()
        || receipt.temporary.parent() != Some(receipt.directory.as_path())
        || !receipt
            .directory
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".kdj-composition-"))
        || !receipt
            .temporary
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("render."))
    {
        return;
    }
    let _ = std::fs::remove_file(&receipt.temporary);
    let _ = std::fs::remove_file(receipt.directory.join("chapters.ffmeta"));
    let _ = std::fs::remove_dir(&receipt.directory);
}

impl CompositionManager {
    pub fn open(state: Arc<AppState>) -> Result<Arc<Self>> {
        let path = state.config.data_dir.join("composition-queue.json");
        let mut journal = if path.is_file() {
            let bytes = std::fs::read(&path)?;
            if bytes.len() > 16 * 1024 * 1024 {
                bail!("合成队列记录超过大小限制");
            }
            match serde_json::from_slice::<Journal>(&bytes) {
                Ok(journal) if journal.version == 1 => journal,
                _ => {
                    std::fs::rename(
                        &path,
                        path.with_extension(format!("corrupt-{}", entry_id())),
                    )?;
                    Journal::default()
                }
            }
        } else {
            Journal::default()
        };
        journal.version = 1;
        journal.session_id = entry_id();
        if !journal.custom_output_dir || journal.defaults.output_dir.is_empty() {
            journal.defaults.output_dir =
                state.config.download_dir().to_string_lossy().into_owned();
        }
        for record in &mut journal.records {
            let task = &mut record.task;
            task.busy = false;
            task.released = false;
            task.generation += 1;
            task.progress = None;
            if let Some(receipt) = &mut record.receipt {
                if media::signature(&receipt.output).ok().as_ref() == Some(&receipt.signature) {
                    receipt.committed = true;
                    task.output_path = receipt.output.to_string_lossy().into_owned();
                    task.phase = CompositionPhase::ImportFailed;
                    task.error = "已输出，等待完成入库".into();
                    cleanup(receipt);
                    continue;
                }
                if receipt.committed {
                    task.phase = CompositionPhase::ImportFailed;
                    task.error = "已输出文件已变化，不能重复合成；请定位检查".into();
                    continue;
                }
                cleanup(receipt);
            }
            state.library.release_composition(&task.id)?;
            record.receipt = None;
            task.phase = if task.complete_pair() {
                CompositionPhase::Canceled
            } else {
                CompositionPhase::WaitingPair
            };
        }
        journal
            .records
            .retain(|r| !r.receipt.as_ref().is_some_and(|receipt| receipt.imported));
        journal.revision += 1;
        save(&path, &journal)?;
        Ok(Arc::new(Self {
            state,
            path,
            inner: Mutex::new(Inner {
                journal,
                runs: HashMap::new(),
            }),
        }))
    }

    pub fn snapshot(&self) -> CompositionSnapshot {
        let inner = self.inner.lock().unwrap();
        let mut result = snapshot(&inner.journal);
        if !inner.journal.custom_output_dir {
            result.defaults.output_dir = self
                .state
                .config
                .download_dir()
                .to_string_lossy()
                .into_owned();
        }
        result
    }

    fn change(&self, edit: impl FnOnce(&mut Journal) -> Result<()>) -> Result<CompositionSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        let mut draft = inner.journal.clone();
        if !draft.custom_output_dir {
            draft.defaults.output_dir = self
                .state
                .config
                .download_dir()
                .to_string_lossy()
                .into_owned();
        }
        edit(&mut draft)?;
        draft.revision += 1;
        save(&self.path, &draft)?;
        inner.journal = draft;
        for ((id, generation), run) in &inner.runs {
            if !inner.journal.records.iter().any(|r| {
                r.task.id == *id
                    && r.task.generation == *generation
                    && r.task.phase != CompositionPhase::Canceled
            }) {
                run.cancel.cancel();
            }
        }
        let result = snapshot(&inner.journal);
        self.state.hub.publish("composition.list", &result);
        Ok(result)
    }

    pub fn enqueue(self: &Arc<Self>, ids: &[i64]) -> Result<CompositionSnapshot> {
        if ids.is_empty() || ids.len() > 500 {
            bail!("每次请选择 1–500 个本地文件");
        }
        let defaults = self.snapshot().defaults;
        let mut entries = Vec::new();
        for id in ids {
            if *id <= 0 {
                bail!("只支持本地曲库文件");
            }
            let track = self.state.library.get(*id)?.context("曲目不存在")?;
            let path = std::fs::canonicalize(&track.path).context("本地文件已丢失")?;
            if !path.is_file() {
                bail!("只支持本地文件");
            }
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let is_video = kdj_providers::tags::VIDEO_EXTENSIONS.contains(&ext.as_str());
            if !is_video && !kdj_providers::tags::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                bail!("不支持的本地媒体格式：{ext}");
            }
            entries.push(CompositionEntry {
                id: entry_id(),
                track_id: *id,
                path: path.to_string_lossy().into_owned(),
                title: track.title,
                artist: track.artist,
                format: ext,
                is_video,
                duration_ms: (track.duration.unwrap_or(0.) * 1000.) as i64,
                options: defaults.clone(),
            });
        }
        let result = self.change(|journal| {
            if journal.records.len() + entries.len() > 1000 {
                bail!("合成队列最多保留 1000 组");
            }
            let (mut videos, mut audios) = lanes(journal);
            for entry in entries {
                if entry.is_video {
                    videos.push(entry)
                } else {
                    audios.push(entry)
                }
            }
            repack(journal, videos, audios);
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    pub fn defaults(&self, options: CompositionOptions) -> Result<CompositionSnapshot> {
        validate_options(&options)?;
        self.change(|journal| {
            if options.output_dir != journal.defaults.output_dir {
                journal.custom_output_dir = true;
            }
            journal.defaults = options;
            Ok(())
        })
    }

    pub fn reorder(self: &Arc<Self>, lane: &str, ids: &[String]) -> Result<CompositionSnapshot> {
        let result = self.change(|journal| {
            let (mut videos, mut audios) = lanes(journal);
            let entries = match lane {
                "video" => &mut videos,
                "audio" => &mut audios,
                _ => bail!("排序列无效"),
            };
            let mut by_id: HashMap<_, _> = entries.drain(..).map(|e| (e.id.clone(), e)).collect();
            if by_id.len() != ids.len() {
                bail!("队列已变化，请重试拖动");
            }
            for id in ids {
                entries.push(by_id.remove(id).context("排序项目已变化")?);
            }
            repack(journal, videos, audios);
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    /// Video-to-video composition is possible only through this explicit drag operation.
    pub fn stack_video(
        self: &Arc<Self>,
        source: &str,
        target: &str,
    ) -> Result<CompositionSnapshot> {
        let result = self.change(|journal| {
            let target_index = journal
                .records
                .iter()
                .position(|r| r.task.id == target)
                .context("目标配对不存在")?;
            let target_row = &journal.records[target_index].task;
            if !target_row.editable() || target_row.video.is_none() || target_row.audio.is_some() {
                bail!("请拖到未开始视频右侧的空槽位");
            }
            if target_row.video.as_ref().is_some_and(|v| v.id == source) {
                bail!("不能将视频叠加到自己");
            }
            let source_index = journal
                .records
                .iter()
                .position(|r| {
                    r.task.editable() && r.task.video.as_ref().is_some_and(|v| v.id == source)
                })
                .context("叠加视频已开始或不存在")?;
            let entry = journal.records[source_index].task.video.take().unwrap();
            let video = journal.records[target_index].task.video.clone();
            let generation = journal
                .records
                .iter()
                .map(|r| r.task.generation)
                .max()
                .unwrap_or(0)
                + 1;
            journal.records[target_index] = new_record(video, Some(entry), generation);
            // Keep this manual pair anchored while compacting the remaining editable lanes.
            journal.records[target_index].task.released = true;
            let (videos, audios) = lanes(journal);
            repack(journal, videos, audios);
            let target = journal
                .records
                .iter_mut()
                .find(|r| r.task.id == target)
                .context("目标配对已变化")?;
            target.task.released = false;
            journal
                .records
                .retain(|r| r.task.video.is_some() || r.task.audio.is_some());
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    pub fn patch(
        self: &Arc<Self>,
        id: &str,
        generation: u64,
        options: Option<CompositionOptions>,
        offset: Option<i64>,
        force: Option<bool>,
    ) -> Result<CompositionSnapshot> {
        if let Some(options) = &options {
            validate_options(options)?;
        }
        let result = self.change(|journal| {
            let record = journal
                .records
                .iter_mut()
                .find(|r| r.task.id == id)
                .context("配对不存在")?;
            if !record.task.editable() || record.task.generation != generation {
                bail!("配对已开始或发生变化，请刷新后重试");
            }
            if record.task.busy {
                bail!("请等待当前校准完成后修改");
            }
            let options_changed = options.is_some();
            let mode_changed=options.as_ref().zip(record.task.video.as_ref()).is_some_and(|(o,v)|o.alignment_mode!=v.options.alignment_mode || o.length_policy!=v.options.length_policy);
            if let Some(options) = options {
                record.task.video.as_mut().context("缺少视频")?.options = options;
            }
            if offset.is_some() || force.is_some() {
                if record.video_probe.is_none() || record.audio_probe.is_none() {
                    bail!("媒体信息尚未就绪，不能手动确认");
                }
                if let Some(offset) = offset {
                    record.task.offset_ms = Some(offset);
                    record.task.force_confirmed = false;
                    record.task.matched = false;
                }
                if let Some(force) = force {
                    record.task.force_confirmed = force;
                }
                recalculate(record);
                if record.task.timeline.is_none() {
                    bail!("音视频没有有效重叠");
                }
                record.task.busy = false;
                record.task.phase = if record.task.force_confirmed || record.task.matched {
                    CompositionPhase::Ready
                } else {
                    CompositionPhase::NeedsReview
                };
                record.task.error = if record.task.phase == CompositionPhase::Ready {
                    String::new()
                } else {
                    "手动 Offset 尚未确认".into()
                };
            }
            recalculate(record);
            if record.task.video_duration_ms.is_some()
                && record.task.audio_duration_ms.is_some()
                && record.task.offset_ms.is_some()
                && record.task.timeline.is_none()
            {
                bail!("素材区间越界或与主视频没有有效重叠");
            }
            if options_changed || offset.is_some() || force.is_some() {
                record.task.generation += 1;
            }
            if mode_changed && record.task.complete_pair() {
                record.task.offset_ms=None;record.task.timeline=None;record.task.video_sections.clear();
                record.task.matched=false;record.task.force_confirmed=false;record.task.error.clear();
                record.task.phase=CompositionPhase::PendingAnalysis;
            }
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    pub fn reanalyze(self: &Arc<Self>, id: &str, generation: u64) -> Result<CompositionSnapshot> {
        let result = self.change(|journal| {
            let record = journal
                .records
                .iter_mut()
                .find(|r| r.task.id == id && r.task.generation == generation)
                .context("配对已变化")?;
            if !record.task.editable() || !record.task.complete_pair() {
                bail!("请先取消正在处理的配对");
            }
            *record = new_record(
                record.task.video.clone(),
                record.task.audio.clone(),
                generation + 1,
            );
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    pub fn start(self: &Arc<Self>, ids: Option<&[String]>) -> Result<CompositionSnapshot> {
        let result = self.change(|journal| {
            for record in &mut journal.records {
                let task = &mut record.task;
                if ids.is_some_and(|ids| !ids.contains(&task.id))
                    || !task.complete_pair()
                    || task.released
                {
                    continue;
                }
                if task.phase == CompositionPhase::NeedsReview && !task.force_confirmed {
                    continue;
                }
                if task.phase == CompositionPhase::ImportFailed {
                    task.released = true;
                    continue;
                }
                task.released = true;
                if !task.busy {
                    task.phase = CompositionPhase::Queued;
                    task.error.clear();
                    task.progress = None;
                }
            }
            Ok(())
        })?;
        self.kick();
        Ok(result)
    }

    pub fn cancel(&self, ids: Option<&[String]>) -> Result<CompositionSnapshot> {
        self.change(|journal| {
            for record in &mut journal.records {
                let task = &mut record.task;
                if ids.is_some_and(|ids| !ids.contains(&task.id))
                    || matches!(
                        task.phase,
                        CompositionPhase::Committing
                            | CompositionPhase::Importing
                            | CompositionPhase::ImportFailed
                    )
                {
                    continue;
                }
                if task.released || task.busy || task.phase == CompositionPhase::PendingAnalysis {
                    task.generation += 1;
                    task.released = false;
                    task.busy = false;
                    task.phase = CompositionPhase::Canceled;
                    task.progress = None;
                    task.error.clear();
                }
            }
            Ok(())
        })
    }

    pub fn remove(
        self: &Arc<Self>,
        id: Option<&str>,
        lane: Option<&str>,
    ) -> Result<CompositionSnapshot> {
        let before = self.snapshot();
        let result = self.change(|journal| {
            if let Some(id) = id {
                let record = journal
                    .records
                    .iter_mut()
                    .find(|r| r.task.id == id)
                    .context("配对不存在")?;
                if record.task.released || record.task.busy {
                    bail!("请先取消正在处理的任务");
                }
                if let Some(lane) = lane {
                    if !record.task.editable() {
                        bail!("已输出任务不能重新配对");
                    }
                    match lane {
                        "video" => record.task.video = None,
                        "audio" => record.task.audio = None,
                        _ => bail!("移除列无效"),
                    };
                    let (videos, audios) = lanes(journal);
                    repack(journal, videos, audios);
                } else {
                    journal.records.retain(|r| r.task.id != id);
                }
            } else {
                journal.records.retain(|r| r.task.released || r.task.busy);
            }
            Ok(())
        })?;
        for removed in before
            .tasks
            .iter()
            .filter(|old| !result.tasks.iter().any(|task| task.id == old.id))
        {
            self.state.library.release_composition(&removed.id)?;
        }
        self.kick();
        Ok(result)
    }

    fn get_record(&self, id: &str, generation: u64) -> Result<Record> {
        self.inner
            .lock()
            .unwrap()
            .journal
            .records
            .iter()
            .find(|r| {
                r.task.id == id
                    && r.task.generation == generation
                    && r.task.phase != CompositionPhase::Canceled
            })
            .cloned()
            .context("配对已取消或变化")
    }

    fn update(
        &self,
        id: &str,
        generation: u64,
        edit: impl FnOnce(&mut Record) -> Result<()>,
    ) -> Result<()> {
        self.change(|journal| {
            let record = journal
                .records
                .iter_mut()
                .find(|r| {
                    r.task.id == id
                        && r.task.generation == generation
                        && r.task.phase != CompositionPhase::Canceled
                })
                .context("配对已取消或变化")?;
            edit(record)
        })?;
        Ok(())
    }

    fn progress(&self, id: &str, generation: u64, value: f64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(record) = inner.journal.records.iter_mut().find(|r| {
            r.task.id == id
                && r.task.generation == generation
                && r.task.phase == CompositionPhase::Rendering
        }) else {
            return;
        };
        record.task.progress = Some(value);
        inner.journal.revision += 1;
        self.state
            .hub
            .publish("composition.updated", &snapshot(&inner.journal));
    }

    fn kick(self: &Arc<Self>) {
        let mut jobs = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            let mut order: (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
            for (i, r) in inner.journal.records.iter().enumerate() {
                if r.task.busy || !r.task.complete_pair() {
                    continue;
                }
                if r.task.released {
                    order.0.push(i);
                } else if r.task.phase == CompositionPhase::PendingAnalysis {
                    order.1.push(i);
                }
            }
            for index in order.0.into_iter().chain(order.1) {
                if inner.runs.len() >= 2 {
                    break;
                }
                let record = &inner.journal.records[index];
                if inner
                    .runs
                    .contains_key(&(record.task.id.clone(), record.task.generation))
                {
                    continue;
                }
                let reads = vec![
                    record.task.video.as_ref().unwrap().path.clone(),
                    record.task.audio.as_ref().unwrap().path.clone(),
                ];
                let writes = (record.task.released
                    && record.task.video.as_ref().unwrap().options.output_mode
                        == OutputMode::Overwrite)
                    .then(|| reads[0].clone());
                if inner.runs.values().any(|run| {
                    run.writes.as_ref().is_some_and(|p| reads.contains(p))
                        || writes.as_ref().is_some_and(|p| run.reads.contains(p))
                }) {
                    continue;
                }
                let task = &mut inner.journal.records[index].task;
                task.busy = true;
                let (id, generation) = (task.id.clone(), task.generation);
                let cancel = CancellationToken::new();
                inner.runs.insert(
                    (id.clone(), generation),
                    Run {
                        cancel: cancel.clone(),
                        reads,
                        writes,
                    },
                );
                jobs.push((id, generation, cancel));
            }
            if !jobs.is_empty() {
                inner.journal.revision += 1;
                self.state
                    .hub
                    .publish("composition.updated", &snapshot(&inner.journal));
            }
        }
        for (id, generation, cancel) in jobs {
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                let result = manager.work(&id, generation, &cancel).await;
                if let Err(error) = result {
                    let reported = manager.update(&id, generation, |r| {
                        r.task.released = false;
                        r.task.busy = false;
                        r.task.progress = None;
                        r.task.phase =
                            if r.receipt.as_ref().is_some_and(|receipt| receipt.committed) {
                                CompositionPhase::ImportFailed
                            } else {
                                CompositionPhase::Failed
                            };
                        r.task.error = format!("{error:#}");
                        Ok(())
                    });
                    if reported.is_ok() {
                        manager.state.activity_log.record_level(
                            crate::activity_log::ActivityCategory::User,
                            crate::activity_log::ActivityLevel::Error,
                            "合成队列处理失败",
                            format!("{error:#}"),
                        );
                    }
                }
                {
                    let mut inner = manager.inner.lock().unwrap();
                    inner.runs.remove(&(id.clone(), generation));
                    if let Some(record) = inner
                        .journal
                        .records
                        .iter_mut()
                        .find(|r| r.task.id == id && r.task.generation == generation)
                    {
                        record.task.busy = false;
                    }
                }
                let _ = manager.change(|_| Ok(()));
                manager.kick();
            });
        }
    }

    async fn work(
        self: &Arc<Self>,
        id: &str,
        generation: u64,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let permit_cancel = cancel.clone();
        let _permit = tokio::task::spawn_blocking(move || {
            kdj_core::thread_qos::prefer_background();
            work_scheduler()
                .acquire(WorkRequest::new(WorkClass::MediaComposition), || {
                    permit_cancel.is_cancelled()
                })
                .map_err(|_| anyhow::anyhow!("合成已取消"))
        })
        .await??;
        let mut record = self.get_record(id, generation)?;
        if record.receipt.as_ref().is_some_and(|r| r.committed) {
            return self.import(id, generation).await;
        }
        let video = record.task.video.clone().context("缺少视频")?;
        let audio = record.task.audio.clone().context("缺少音频")?;
        let video_path = PathBuf::from(&video.path);
        let audio_path = PathBuf::from(&audio.path);
        let (vs, asig) = (
            media::signature(&video_path)?,
            media::signature(&audio_path)?,
        );
        let cached = record.video_signature.as_ref() == Some(&vs)
            && record.audio_signature.as_ref() == Some(&asig)
            && record.task.offset_ms.is_some()
            && record.video_probe.is_some()
            && record.audio_probe.is_some();
        if !cached {
            let changed = record
                .video_signature
                .as_ref()
                .is_some_and(|old| old != &vs)
                || record
                    .audio_signature
                    .as_ref()
                    .is_some_and(|old| old != &asig);
            self.update(id, generation, |r| {
                r.task.phase = CompositionPhase::Analyzing;
                r.task.matched = false;
                r.task.force_confirmed = false;
                r.task.offset_ms = None;
                r.task.timeline = None;
                r.task.video_sections.clear();
                r.task.error.clear();
                if changed {
                    r.task.released = false;
                }
                Ok(())
            })?;
            let (vp, ap) = tokio::try_join!(
                media::probe(&video_path, cancel),
                media::probe(&audio_path, cancel)
            )?;
            let vd = vp.check(true)?;
            let ad = ap.check(audio.is_video)?;
            self.update(id, generation, |r| {
                r.video_probe = Some(vp.clone());
                r.audio_probe = Some(ap.clone());
                r.task.video_duration_ms = Some(vd);
                r.task.audio_duration_ms = Some(ad);
                Ok(())
            })?;
            let (alignment,mut sections) = if vp.audio().is_none() || ap.audio().is_none() {
                (kdj_analysis::alignment::Alignment {
                    offset_ms: 0,
                    matched: false,
                    reason: "视频没有可匹配的声音，请手动选择区间".into(),
                },Vec::new())
            } else if vd > 1_800_000 || ad > 1_800_000 {
                (kdj_analysis::alignment::Alignment {
                    offset_ms: 0,
                    matched: false,
                    reason: "超过 30 分钟的媒体请手动校准".into(),
                },Vec::new())
            } else {
                let (vpcm, apcm) = tokio::try_join!(
                    media::pcm(&video_path, vp.audio().unwrap().index, cancel),
                    media::pcm(&audio_path, ap.audio().unwrap().index, cancel)
                )?;
                let cancel = cancel.clone();
                let is_overlay = audio.is_video;
                let sections=video.options.alignment_mode==AlignmentMode::Sections && video.options.length_policy==LengthPolicy::FullAudio;
                tokio::task::spawn_blocking(move || {
                    kdj_core::thread_qos::prefer_background();
                    if is_overlay {
                        kdj_analysis::alignment::align_segment(&apcm, &vpcm, || {
                            cancel.is_cancelled()
                        }).map(|a|(a,Vec::new()))
                    } else if sections {
                        kdj_analysis::alignment::align_sections(&apcm,&vpcm,||cancel.is_cancelled())
                    } else {
                        kdj_analysis::alignment::align(&apcm, &vpcm, || cancel.is_cancelled())
                            .map(|a|(a,Vec::new()))
                    }
                })
                .await??
            };
            if media::signature(&video_path)? != vs || media::signature(&audio_path)? != asig {
                bail!("源文件在校准期间发生变化，请重新开始");
            }
            for section in &mut sections {
                section.video_start_ms+=vp.audio_shift();
                if section.video_start_ms<0 {section.audio_start_ms-=section.video_start_ms;section.duration_ms+=section.video_start_ms;section.video_start_ms=0;}
                section.duration_ms=section.duration_ms.min(vd-section.video_start_ms).min(ad-section.audio_start_ms);
            }
            sections.retain(|s|s.duration_ms>0);
            self.update(id, generation, |r| {
                r.video_signature = Some(vs.clone());
                r.audio_signature = Some(asig.clone());
                r.task.offset_ms = Some(
                    alignment.offset_ms + vp.audio_shift()
                        - if audio.is_video { ap.audio_shift() } else { 0 },
                );
                r.task.matched = alignment.matched;
                r.task.error = alignment.reason;
                r.task.video_sections=sections;
                recalculate(r);
                if r.task.timeline.is_none() {
                    r.task.matched = false;
                    r.task.error = "音视频没有有效重叠".into();
                }
                r.task.phase = if r.task.matched {
                    CompositionPhase::Ready
                } else {
                    CompositionPhase::NeedsReview
                };
                if !r.task.matched {
                    r.task.released = false;
                }
                Ok(())
            })?;
        }
        record = self.get_record(id, generation)?;
        if !record.task.released {
            return Ok(());
        }
        if !(record.task.matched || record.task.force_confirmed) || record.task.timeline.is_none() {
            bail!("配对尚未确认");
        }
        // An automatic analysis can be released while already running. Acquire the exclusive
        // write reservation before rendering, or defer to another worker holding the same path.
        if video.options.output_mode == OutputMode::Overwrite {
            let mut inner = self.inner.lock().unwrap();
            if inner.runs.iter().any(|(key, run)| {
                key != &(id.to_string(), generation) && run.reads.contains(&video.path)
            }) {
                let r = inner
                    .journal
                    .records
                    .iter_mut()
                    .find(|r| r.task.id == id)
                    .unwrap();
                r.task.phase = CompositionPhase::Queued;
                return Ok(());
            }
            if let Some(run) = inner.runs.get_mut(&(id.to_string(), generation)) {
                run.writes = Some(video.path.clone());
            }
        }
        self.render_and_commit(id, generation, record, cancel)
            .await?;
        self.import(id, generation).await
    }

    async fn render_and_commit(
        &self,
        id: &str,
        generation: u64,
        record: Record,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let video = record.task.video.as_ref().unwrap();
        let audio = record.task.audio.as_ref().unwrap();
        let options = &video.options;
        let directory = if options.output_mode == OutputMode::Overwrite {
            Path::new(&video.path)
                .parent()
                .context("视频目录无效")?
                .to_path_buf()
        } else {
            PathBuf::from(&options.output_dir)
        };
        if !directory.is_absolute() || !directory.is_dir() {
            bail!("输出目录不存在");
        }
        let output = if options.output_mode == OutputMode::Overwrite {
            PathBuf::from(&video.path)
        } else {
            media::unique_output(Path::new(&video.path), &directory)?
        };
        let staging = directory.join(format!(".kdj-composition-{id}-{generation}-{}", entry_id()));
        std::fs::create_dir(&staging).context("无法建立合成临时目录")?;
        let temporary = staging.join(format!("render.{}", video.format));
        let chapters = staging.join("chapters.ffmeta");
        let mut cleanup_receipt = CommitReceipt {
            directory: staging.clone(),
            temporary: temporary.clone(),
            output: output.clone(),
            signature: Signature {
                size: 0,
                modified_ns: 0,
                edge_hash: 0,
            },
            committed: false,
            imported: false,
            imported_track_id: None,
        };
        // Persist scratch ownership before invoking FFmpeg, so interrupted jobs are cleaned up
        // on restart even if they never reached the validated-commit checkpoint.
        let result = async {
            self.update(id, generation, |r| {
                r.receipt = Some(cleanup_receipt.clone());
                r.task.phase = CompositionPhase::Rendering;
                r.task.progress = Some(0.);
                Ok(())
            })?;
            let vp = record.video_probe.as_ref().context("缺少校准媒体信息")?;
            let ap = record.audio_probe.as_ref().context("缺少校准媒体信息")?;
            let timeline = record.task.timeline.context("缺少输出时间轴")?;
            let chapter_shift = vp.chapter_shift(timeline.black_head_ms);
            let shifted = chapter_shift != 0 && !vp.chapters.is_empty();
            if shifted {
                std::fs::write(&chapters, media::chapter_metadata(vp, chapter_shift))?;
            }
            let render = media::Render {
                video_path: Path::new(&video.path),
                secondary_path: Path::new(&audio.path),
                video: vp,
                secondary: ap,
                timeline,
                offset: record.task.offset_ms.unwrap(),
                options,
                overlay: overlay(&record.task),
                output: &temporary,
                chapters: shifted.then_some(chapters.as_path()),
            };
            let args = media::render_args(&render)?;
            acceleration::render(
                &args,
                timeline.duration_ms,
                cancel,
                options.acceleration,
                |value| self.progress(id, generation, value),
            )
            .await?;
            self.update(id, generation, |r| {
                r.task.phase = CompositionPhase::Validating;
                Ok(())
            })?;
            let output_probe = media::probe(&temporary, cancel).await?;
            media::validate(vp, &output_probe, timeline.duration_ms)?;
            media::validate_chapters(vp, &output_probe, chapter_shift)?;
            // Existing media caches use whole-second mtimes. A very fast remux may otherwise
            // reuse the original cache identity even though the bytes changed completely.
            if let Some(source) = &record.video_signature {
                let staged = media::signature(&temporary)?;
                if staged.modified_ns / 1_000_000_000 == source.modified_ns / 1_000_000_000 {
                    let modified = std::time::UNIX_EPOCH
                        + std::time::Duration::from_secs(
                            (source.modified_ns / 1_000_000_000 + 1) as u64,
                        );
                    std::fs::File::options()
                        .write(true)
                        .open(&temporary)?
                        .set_times(std::fs::FileTimes::new().set_modified(modified))?;
                }
            }
            let file = std::fs::File::open(&temporary)?;
            file.sync_all()?;
            drop(file);
            cleanup_receipt.signature = media::signature(&temporary)?;
            if cleanup_receipt.signature.size == 0 {
                bail!("合成成品为空");
            }
            // The short commit section shares the library watch lock and the queue lock.
            // Cancellation that wins before this section preserves the original; afterward
            // the committed receipt wins and only import may be retried.
            let _files = self.state.folder_operations.lock().unwrap();
            if cancel.is_cancelled() {
                bail!("合成已取消");
            }
            if media::signature(Path::new(&video.path))?
                .ne(record.video_signature.as_ref().context("源版本缺失")?)
                || media::signature(Path::new(&audio.path))?
                    .ne(record.audio_signature.as_ref().context("源版本缺失")?)
            {
                bail!("源文件已经变化，未覆盖，请重新校准");
            }
            let mut inner = self.inner.lock().unwrap();
            let index = inner
                .journal
                .records
                .iter()
                .position(|r| r.task.id == id && r.task.generation == generation && r.task.released)
                .context("合成已取消")?;
            inner.journal.records[index].task.phase = CompositionPhase::Committing;
            inner.journal.records[index].receipt = Some(cleanup_receipt.clone());
            inner.journal.revision += 1;
            save(&self.path, &inner.journal)?;
            if options.output_mode == OutputMode::Overwrite {
                self.state.library.reserve_composition(video.track_id, id)?;
                std::fs::set_permissions(
                    &temporary,
                    std::fs::metadata(&video.path)?.permissions(),
                )?;
                media::replace_file(&temporary, &output)?;
            } else {
                // Same-directory link is an atomic no-clobber publication. A collision after
                // name selection is an error, never permission to replace somebody else's file.
                std::fs::hard_link(&temporary, &output)
                    .context("提交成品失败（目标已存在或文件系统不支持安全提交）")?;
            }
            cleanup_receipt.committed = true;
            inner.journal.records[index].receipt = Some(cleanup_receipt.clone());
            inner.journal.records[index].task.output_path = output.to_string_lossy().into_owned();
            inner.journal.records[index].task.phase = CompositionPhase::Importing;
            inner.journal.revision += 1;
            save(&self.path, &inner.journal)?;
            #[cfg(unix)]
            std::fs::File::open(&directory)?.sync_all()?;
            // Do not let the directory watcher upsert the replacement before its original
            // library identity and user-authored fields have been preserved.
            let imported = import_record_file(&self.state, &inner.journal.records[index])?;
            let receipt = inner.journal.records[index].receipt.as_mut().unwrap();
            receipt.imported = true;
            receipt.imported_track_id = Some(imported);
            inner.journal.revision += 1;
            save(&self.path, &inner.journal)?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if !cleanup_receipt.committed {
            let _ = self.state.library.release_composition(id);
        }
        cleanup(&cleanup_receipt);
        result
    }

    async fn import(&self, id: &str, generation: u64) -> Result<()> {
        let record = self.get_record(id, generation)?;
        let receipt = record
            .receipt
            .as_ref()
            .filter(|r| r.committed)
            .context("缺少已提交成品")?;
        if media::signature(&receipt.output)? != receipt.signature {
            bail!("已输出文件已变化，不能重复合成；请定位检查");
        }
        self.update(id, generation, |r| {
            r.task.phase = CompositionPhase::Importing;
            r.task.error.clear();
            Ok(())
        })?;
        let overwrite = record
            .task
            .video
            .as_ref()
            .context("缺少原视频信息")?
            .options
            .output_mode
            == OutputMode::Overwrite;
        let imported =
            if let Some(track_id) = receipt.imported_track_id.filter(|_| receipt.imported) {
                track_id
            } else {
                let state = self.state.clone();
                let record = record.clone();
                tokio::task::spawn_blocking(move || {
                    let _guard = state.folder_operations.lock().unwrap();
                    import_record_file(&state, &record)
                })
                .await??
            };
        self.update(id, generation, |r| {
            let receipt = r.receipt.as_mut().unwrap();
            receipt.imported = true;
            receipt.imported_track_id = Some(imported);
            Ok(())
        })?;
        self.state.hub.publish_library_updated(&[imported]);
        self.state.activity_log.record_level(
            crate::activity_log::ActivityCategory::User,
            crate::activity_log::ActivityLevel::Info,
            "合成完成",
            receipt.output.to_string_lossy().into_owned(),
        );
        self.state.hub.publish(
            "composition.completed",
            &serde_json::json!({"track_id":imported,"path":receipt.output,"replaced":overwrite}),
        );
        self.change(|journal| {
            journal
                .records
                .retain(|r| !(r.task.id == id && r.task.generation == generation));
            Ok(())
        })?;
        Ok(())
    }
}

/// Caller holds folder_operations through file publication and this transaction.
fn import_record_file(state: &AppState, record: &Record) -> Result<i64> {
    let receipt = record
        .receipt
        .as_ref()
        .filter(|r| r.committed)
        .context("缺少已提交成品")?;
    if media::signature(&receipt.output)? != receipt.signature {
        bail!("已输出文件已变化，请定位检查");
    }
    let original = record.task.video.as_ref().context("缺少原视频信息")?;
    let overwrite = original.options.output_mode == OutputMode::Overwrite;
    if overwrite {
        let shift = record.task.timeline.map(|t| t.black_head_ms).unwrap_or(0);
        let receipt_key = format!(
            "{}-{}-{}",
            record.task.id, receipt.signature.modified_ns, receipt.signature.edge_hash
        );
        state.library.replace_media_content(
            original.track_id,
            &receipt.output,
            shift,
            &receipt_key,
        )?;
        invalidate_media_caches(state, original.track_id, &receipt.output)?;
        Ok(original.track_id)
    } else {
        state.library.upsert_file(&receipt.output, "local", "")
    }
}

fn validate_options(options: &CompositionOptions) -> Result<()> {
    if !options.overlay.valid() {
        bail!("叠加参数超出范围");
    }
    if !options.segment.valid() || !options.audio.valid() {
        bail!("素材区间或音频参数超出范围");
    }
    if !Path::new(&options.output_dir).is_absolute() {
        bail!("输出目录必须是绝对路径");
    }
    Ok(())
}

fn invalidate_media_caches(state: &AppState, track_id: i64, path: &Path) -> Result<()> {
    state.waveforms.invalidate_track(track_id);
    if let Some(track) = state.library.get(track_id)? {
        state
            .lyric_lookups
            .invalidate_song(&track.title, &track.artist);
        kdj_library::folders::invalidate_lyrics_cache(
            path,
            &track.source_platform,
            &track.source_key,
        )?;
        kdj_library::folders::invalidate_lyrics_cache(path, "local", "")?;
    }
    let prefix = format!("{track_id}-");
    for directory in [
        "audio-cache",
        "video-cache",
        "waveform",
        "covers",
        "covers/thumbs",
    ] {
        let directory = state.config.data_dir.join(directory);
        if let Ok(entries) = std::fs::read_dir(directory) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(&prefix)
                    && !name.contains(".partial.")
                    && entry.file_type().is_ok_and(|t| t.is_file())
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(id: &str, video: bool) -> CompositionEntry {
        CompositionEntry {
            id: id.into(),
            track_id: 1,
            path: format!("/{id}"),
            title: id.into(),
            artist: String::new(),
            format: if video { "mp4".into() } else { "mp3".into() },
            is_video: video,
            duration_ms: 100_000,
            options: CompositionOptions::default(),
        }
    }
    #[test]
    fn independent_lanes_pair_fifo_and_preserve_running_anchors() {
        let mut journal = Journal::default();
        repack(
            &mut journal,
            vec![entry("v1", true), entry("v2", true)],
            vec![],
        );
        let (mut v, mut a) = lanes(&journal);
        a.extend([entry("a1", false), entry("a2", false), entry("a3", false)]);
        v.push(entry("v3", true));
        repack(&mut journal, v, a);
        assert_eq!(
            journal
                .records
                .iter()
                .map(|r| (
                    r.task.video.as_ref().unwrap().id.as_str(),
                    r.task.audio.as_ref().unwrap().id.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![("v1", "a1"), ("v2", "a2"), ("v3", "a3")]
        );
        journal.records[1].task.released = true;
        let (v, mut a) = lanes(&journal);
        a.reverse();
        repack(&mut journal, v, a);
        assert_eq!(journal.records[1].task.audio.as_ref().unwrap().id, "a2");
        assert_eq!(journal.records[0].task.audio.as_ref().unwrap().id, "a3");
        journal.records.remove(1);
        assert_eq!(journal.records[1].task.video.as_ref().unwrap().id, "v3");
        assert_eq!(journal.records[1].task.audio.as_ref().unwrap().id, "a1");
    }
}
