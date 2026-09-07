//! Revisioned, persistent projects. Export receipts remain separate from editable drafts.
mod frames;
mod intake;
mod naming;
mod positions;
mod render;
pub mod routes;
#[cfg(test)]
mod tests;
use super::{media, CompositionManager};
use crate::state::AppState;
use anyhow::{bail, Context, Result};
use kdj_core::{
    composition::{AudioMixMode, CompositionTask, OverlayAudio},
    workshop::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

fn id() -> String {
    super::entry_id()
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub revision: u64,
    pub phase: String,
    pub progress: f64,
    #[serde(default)]
    pub detail: String,
    pub error: String,
    pub path: String,
    pub signature: Option<media::Signature>,
    pub track_id: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    version: u32,
    revision: u64,
    projects: Vec<CompositionProject>,
    jobs: Vec<Job>,
    #[serde(default)]
    migrated: Vec<String>,
    #[serde(default)]
    position_bases: HashMap<String, Layer>,
    // Only newly imported, untouched video rows opt into automatic placement.
    // Persist this so reopening a project cannot reapply over manual edits.
    #[serde(default)]
    pending_positions: HashMap<String, String>,
    #[serde(default)]
    stopped_positions: HashSet<String>,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    session: String,
    revision: u64,
    projects: Vec<CompositionProject>,
    jobs: Vec<Job>,
}
#[derive(Clone)]
pub struct Preview {
    pub project: CompositionProject,
    pub cancel: CancellationToken,
}
#[derive(Clone)]
struct ExportControl {
    cancel: CancellationToken,
    finished: CancellationToken,
}
pub struct Workshop {
    state: Arc<AppState>,
    path: PathBuf,
    cache: PathBuf,
    session: String,
    journal: Mutex<Journal>,
    jobs: Mutex<HashMap<String, ExportControl>>,
    previews: Mutex<HashMap<String, Preview>>,
    cache_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    cache_trim_at: Mutex<Option<std::time::Instant>>,
    preview_slots: tokio::sync::Semaphore,
    frame_slots: tokio::sync::Semaphore,
    analysis_slots: tokio::sync::Semaphore,
    positions: Mutex<HashMap<String, positions::PositionTask>>,
    export_slots: tokio::sync::Semaphore,
}
impl Workshop {
    pub fn open(state: Arc<AppState>, legacy: &Arc<CompositionManager>) -> Result<Arc<Self>> {
        let path = state.config.data_dir.join("vj-projects.json");
        let mut journal = if path.exists() {
            serde_json::from_slice::<Journal>(&std::fs::read(&path)?)
                .context("剪辑工程记录无法读取，原文件已保留")?
        } else {
            Journal {
                version: 1,
                revision: 0,
                projects: vec![],
                jobs: vec![],
                migrated: vec![],
                position_bases: HashMap::new(),
                pending_positions: HashMap::new(),
                stopped_positions: HashSet::new(),
            }
        };
        if journal.version != 1 {
            bail!("剪辑工程版本不支持")
        }
        for p in &mut journal.projects {
            for source in &mut p.sources { if source.kind.is_empty() { source.kind = if source.video { "video" } else { "audio" }.into(); } }
        }
        for job in &mut journal.jobs {
            if !["complete", "failed", "canceled", "import_failed"].contains(&job.phase.as_str()) {
                if job.signature.is_some() && !Path::new(&job.path).exists() {
                    job.signature = None;
                    job.path.clear();
                }
                job.phase = if job.signature.is_some() {
                    "import_failed"
                } else {
                    "canceled"
                }
                .into();
                job.error = "上次处理已中断".into();
            }
        }
        let cache = state.config.data_dir.join("cache").join("vj-workshop");
        std::fs::create_dir_all(&cache)?;
        for entry in std::fs::read_dir(&cache)?.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_file())
                && path.extension().is_some_and(|e| e == "part")
            {
                let _ = std::fs::remove_file(path);
            }
        }
        // Imported receipts stay owned by the old queue; never re-render committed output.
        let old = legacy.inner.lock().unwrap().journal.records.clone();
        for record in old {
            if record.receipt.is_some()
                || journal.migrated.contains(&record.task.id)
                || journal
                    .projects
                    .iter()
                    .any(|p| p.migrated_from.as_deref() == Some(&record.task.id))
            {
                continue;
            }
            if record.task.video.is_none() && record.task.audio.is_none() {
                continue;
            }
            journal.migrated.push(record.task.id.clone());
            journal.projects.push(migrate(
                &record.task,
                record.video_probe.as_ref(),
                record.audio_probe.as_ref(),
                &state.config.download_dir().to_string_lossy(),
            ));
        }
        for project in &mut journal.projects {
            let previous = project.clone();
            naming::sync_music_names(project, &previous);
            if project.name != previous.name || project.output.name != previous.output.name {
                project.revision += 1;
                journal.revision += 1;
            }
        }
        let manager = Arc::new(Self {
            state,
            path,
            cache,
            session: id(),
            journal: Mutex::new(journal),
            jobs: Mutex::new(HashMap::new()),
            previews: Mutex::new(HashMap::new()),
            cache_locks: Mutex::new(HashMap::new()),
            cache_trim_at: Mutex::new(None),
            preview_slots: tokio::sync::Semaphore::new(2),
            frame_slots: tokio::sync::Semaphore::new(2),
            analysis_slots: tokio::sync::Semaphore::new(1),
            positions: Mutex::new(HashMap::new()),
            export_slots: tokio::sync::Semaphore::new(1),
        });
        manager.save(&manager.journal.lock().unwrap())?;
        Ok(manager)
    }
    fn save(&self, j: &Journal) -> Result<()> {
        let temp = self.path.with_extension("json.tmp");
        let mut f = std::fs::File::create(&temp)?;
        f.write_all(&serde_json::to_vec(j)?)?;
        f.sync_all()?;
        drop(f);
        media::replace_file(&temp, &self.path)?;
        #[cfg(unix)]
        std::fs::File::open(self.path.parent().unwrap())?.sync_all()?;
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        let j = self.journal.lock().unwrap();
        Snapshot {
            session: self.session.clone(),
            revision: j.revision,
            projects: j.projects.clone(),
            jobs: j.jobs.clone(),
        }
    }
    fn change(&self, edit: impl FnOnce(&mut Journal) -> Result<()>) -> Result<Snapshot> {
        {
            let mut current = self.journal.lock().unwrap();
            let mut next = current.clone();
            edit(&mut next)?;
            next.revision += 1;
            self.save(&next)?;
            *current = next;
        }
        let s = self.snapshot();
        self.state.hub.publish("workshop.updated", &s);
        Ok(s)
    }
    pub fn project(&self, pid: &str, revision: u64) -> Result<CompositionProject> {
        let j = self.journal.lock().unwrap();
        let p = j
            .projects
            .iter()
            .find(|p| p.id == pid)
            .context("作品不存在")?;
        if p.revision != revision {
            bail!("作品已更新，请重试当前操作")
        }
        Ok(p.clone())
    }
    pub fn create(&self) -> Result<Snapshot> {
        let directory = self
            .state
            .config
            .download_dir()
            .to_string_lossy()
            .into_owned();
        self.change(|j| {
            let mut number = 1;
            while j
                .projects
                .iter()
                .any(|p| p.name == format!("任务 {number}"))
            {
                number += 1;
            }
            j.projects
                .push(empty_project(&format!("任务 {number}"), &directory));
            Ok(())
        })
    }
    pub fn patch(self: &Arc<Self>, pid: &str, revision: u64, update: Edit) -> Result<Snapshot> {
        let mut media_changed = false;
        let result = self.change(|j| {
            let p = j
                .projects
                .iter_mut()
                .find(|p| p.id == pid)
                .context("作品不存在")?;
            if p.revision != revision {
                bail!("作品已更新，请重试当前操作")
            }
            let previous = p.clone();
            media_changed = p.name != update.name || p.layers != update.layers
                || p.canvas != update.canvas || p.output != update.output;
            if let Some(markers) = update.markers { p.markers = markers; }
            p.name = update.name;
            p.layers = update.layers;
            p.canvas = update.canvas;
            p.output = update.output;
            p.sync_output_format(&previous);
            naming::sync_music_names(p, &previous);
            p.validate().map_err(anyhow::Error::msg)?;
            positions::retain_pending_after_edit(&mut j.pending_positions, &previous, p)?;
            p.revision += 1;
            Ok(())
        })?;
        if media_changed {
            self.cancel_previews(pid, revision);
            let _ = self.prepare_positions(pid);
        }
        Ok(result)
    }
    pub fn delete(&self, pid: &str, revision: u64) -> Result<Snapshot> {
        self.project(pid, revision)?;
        let s = self.change(|j| {
            j.projects.retain(|p| p.id != pid);
            j.pending_positions.retain(|key, _| !key.starts_with(&format!("{pid}:")));
            j.stopped_positions.retain(|key| !key.starts_with(&format!("{pid}:")));
            Ok(())
        })?;
        self.cancel_previews(pid, u64::MAX);
        self.cancel_positions(pid);
        Ok(s)
    }
    pub async fn add(
        self: &Arc<Self>,
        pid: &str,
        revision: u64,
        ids: &[i64],
        at: f64,
    ) -> Result<Snapshot> {
        if ids.is_empty() || ids.len() > 500 || !at.is_finite() || at < 0. {
            bail!("素材或放入位置无效")
        }
        let mut p = self.project(pid, revision)?;
        let cancel = CancellationToken::new();
        let previous = p.clone();
        for tid in ids {
            let track = self.state.library.get(*tid)?.context("本地曲目不存在")?;
            let path = std::fs::canonicalize(&track.path).context("素材文件已丢失")?;
            let image = if kdj_providers::workshop_images::is_image_path(&path) {
                let path = path.clone();
                Some(tokio::task::spawn_blocking(move || kdj_providers::workshop_images::inspect(&path)).await??)
            } else { None };
            let probe = if image.is_none() { media::probe(&path, &cancel).await? } else { media::Probe::default() };
            let video = probe.video().is_some();
            let duration = if let Some(image) = &image { image.frame_ends_ms.last().copied().unwrap_or(5000.) } else { probe.check(video)? as f64 };
            let signature = signature(&path)?;
            let source = if let Some(s) = p
                .sources
                .iter()
                .find(|s| s.path == path.to_string_lossy() && s.signature == signature)
            {
                s.clone()
            } else {
                let (width, height, fps) = shape(&probe);
                let s = Source {
                    kind: if let Some(image) = &image { if image.frame_ends_ms.is_empty() { "image" } else { "gif" } } else if video { "video" } else { "audio" }.into(),
                    frame_ends_ms: image.as_ref().map(|i| i.frame_ends_ms.clone()).unwrap_or_default(),
                    id: id(),
                    track_id: *tid,
                    path: path.to_string_lossy().into_owned(),
                    title: track.title,
                    duration_ms: duration,
                    video,
                    audio: probe.audio().is_some(),
                    width: image.as_ref().map_or(width, |i| i.width),
                    height: image.as_ref().map_or(height, |i| i.height),
                    fps: if image.is_some() { 30. } else { fps },
                    signature,
                };
                p.sources.push(s.clone());
                s
            };
            let has_video = p
                .layers
                .iter()
                .any(|l| p.source(&l.source_id).is_some_and(|s| s.video));
            let has_audio = p
                .layers
                .iter()
                .any(|l| p.source(&l.source_id).is_some_and(|s| s.audio && !s.video));
            if image.is_none() && !video && !has_audio {
                let video_ids: Vec<_> = p
                    .sources
                    .iter()
                    .filter(|s| s.video)
                    .map(|s| s.id.clone())
                    .collect();
                for c in p.layers.iter_mut().flat_map(|l| &mut l.clips) {
                    if video_ids.contains(&c.source_id) && !c.sound.manual {
                        c.sound.muted = true;
                    }
                }
            }
            if video && !p.canvas.initialized {
                p.canvas = Canvas {
                    width: source.width / 2 * 2,
                    height: source.height / 2 * 2,
                    fps: source.fps,
                    initialized: true,
                    import_picture: p.canvas.import_picture.clone(),
                };
            }
            let mut clip = new_clip(&source, at);
            if source.visual() {
                if let Some(layout) = &p.canvas.import_picture {
                    layout.apply(&mut clip.picture);
                }
            }
            clip.sound.muted = !source.audio || (video && (has_video || has_audio));
            clip.fades = Fades::new(clip.duration(), source.visual() && p.layers.iter().any(|l| p.source(&l.source_id).is_some_and(Source::visual)));
            p.layers.push(
                Layer {
                    grid: None,
                    id: id(),
                    source_id: source.id.clone(),
                    clips: vec![clip],
                },
            );
        }
        p.sync_output_format(&previous);
        if previous.layers.is_empty() && !p.has_picture() {
            p.output.format = "wav".into();
        }
        naming::sync_music_names(&mut p, &previous);
        p.validate().map_err(anyhow::Error::msg)?;
        let result = self.change(|j| {
            let old = j
                .projects
                .iter_mut()
                .find(|p| p.id == pid)
                .context("作品不存在")?;
            if old.revision != revision {
                bail!("作品已更新，素材尚未添加，请重试")
            }
            p.revision += 1;
            for layer in &p.layers {
                if !previous.layers.iter().any(|old| old.id == layer.id)
                    && p.source(&layer.source_id).is_some_and(|s| s.video && s.audio)
                {
                    j.pending_positions.insert(
                        format!("{pid}:{}", layer.id),
                        positions::layout_key(layer)?,
                    );
                }
            }
            *old = p;
            Ok(())
        })?;
        self.cancel_previews(pid, revision);
        let _ = self.prepare_positions(pid);
        Ok(result)
    }
    fn cancel_previews(&self, pid: &str, through_revision: u64) {
        let mut previews = self.previews.lock().unwrap();
        previews.retain(|_, p| {
            // Publication can race the next preview request. Invalidate only
            // the edited snapshot, never a lease created for the new revision.
            if p.project.id == pid && p.project.revision <= through_revision {
                p.cancel.cancel();
                false
            } else {
                true
            }
        });
    }
    pub fn preview(&self, pid: &str, revision: u64, audition_after_layer: Option<&str>) -> Result<String> {
        let mut p = self.project(pid, revision)?;
        p.validate().map_err(anyhow::Error::msg)?;
        if let Some(layer) = audition_after_layer {
            audition_next_layer(&mut p, layer);
        }
        if p.duration() <= 0. {
            bail!("作品没有可播放的片段")
        }
        for source in p.sources.iter().filter(|s| {
            p.layers
                .iter()
                .any(|l| l.source_id == s.id && !l.clips.is_empty())
        }) {
            if !source.signature.is_empty()
                && signature(Path::new(&source.path))? != source.signature
            {
                bail!("素材已变化：{}，请重新添加", source.title)
            }
        }
        let mut previews = self.previews.lock().unwrap();
        // Each editor mount owns its lease. A late DELETE from an old mount
        // must never revoke a new preview of the same project revision.
        // A sound-only audition keeps the original picture lease and audio
        // producer alive until the native replacement is ready. Each editor
        // releases its leases when its project/revision changes or it unmounts.
        // Do not collect leases here: a marker-only save advances the revision
        // without changing media. A later audition must not revoke the still
        // playing original mix or picture. Edits and explicit release own expiry.
        let ticket = id();
        previews.insert(
            ticket.clone(),
            Preview {
                project: p,
                cancel: CancellationToken::new(),
            },
        );
        Ok(ticket)
    }
    pub fn ticket(&self, ticket: &str) -> Result<Preview> {
        self.previews
            .lock()
            .unwrap()
            .get(ticket)
            .cloned()
            .context("预览已过期")
    }
    pub fn release(&self, ticket: &str) {
        if let Some(p) = self.previews.lock().unwrap().remove(ticket) {
            p.cancel.cancel();
        }
    }
    pub async fn align(
        &self,
        pid: &str,
        revision: u64,
        clip_id: &str,
        reference: &str,
    ) -> Result<f64> {
        let p = self.project(pid, revision)?;
        let clip = p.clip(clip_id).context("片段不存在")?;
        let reference = p
            .clip(reference)
            .filter(|c| c.id != clip_id)
            .context("请选择另一片段作为参考")?;
        if let Some(music) = p.music_reference() {
            if !p.source(&clip.source_id).is_some_and(|s| s.video) || reference.id != music.id {
                bail!("请以音乐为参考，对视频进行适配")
            }
        }
        let cancel = CancellationToken::new();
        let a = render::alignment_pcm(&p, clip, &cancel).await?;
        let b = render::alignment_pcm(&p, reference, &cancel).await?;
        let result = tokio::task::spawn_blocking(move || {
            kdj_analysis::alignment::align_segment(&a, &b, || false)
        })
        .await??;
        self.project(pid, revision)?;
        if !result.matched {
            bail!("{}", result.reason)
        }
        let position = reference.start_ms + result.offset_ms as f64;
        if position < 0. {
            bail!("匹配位置在作品起点之前，请调整参考片段")
        }
        Ok(position)
    }
    pub fn export(self: &Arc<Self>, pid: &str, revision: u64) -> Result<Snapshot> {
        let p = self.project(pid, revision)?;
        p.validate().map_err(anyhow::Error::msg)?;
        if p.duration() <= 0. {
            bail!("没有可导出的片段")
        }
        let job_id = id();
        let token = CancellationToken::new();
        let finished = CancellationToken::new();
        // Register cancellation before publishing the queued receipt.
        self.jobs.lock().unwrap().insert(job_id.clone(), ExportControl {
            cancel: token.clone(), finished: finished.clone(),
        });
        let queued = self.change(|j| {
            if j.jobs
                .iter()
                .any(|j| j.project_id == pid && j.phase == "import_failed" && j.signature.is_some())
            {
                bail!("已有成品等待入库，请先重试入库")
            }
            if j.jobs.iter().any(|j| {
                j.project_id == pid
                    && [
                        "queued",
                        "rendering",
                        "validating",
                        "committing",
                        "importing",
                    ]
                    .contains(&j.phase.as_str())
            }) {
                bail!("作品正在导出")
            }
            j.jobs.push(Job {
                id: job_id.clone(),
                project_id: pid.into(),
                revision,
                phase: "queued".into(),
                progress: 0.,
                detail: String::new(),
                error: String::new(),
                path: String::new(),
                signature: None,
                track_id: None,
            });
            Ok(())
        });
        let s = match queued {
            Ok(s) => s,
            Err(e) => {
                self.jobs.lock().unwrap().remove(&job_id);
                finished.cancel();
                return Err(e);
            }
        };
        let m = self.clone();
        tokio::spawn(async move {
            let _finished = finished.drop_guard();
            let result = m.render_export(&p, &job_id, &token).await;
            if let Err(e) = result {
                let _ = m.job(&job_id, |j| {
                    j.phase = if j.signature.is_some() {
                        "import_failed"
                    } else if token.is_cancelled() {
                        "canceled"
                    } else {
                        "failed"
                    }
                    .into();
                    if j.phase == "canceled" {
                        j.progress = 0.;
                        j.detail.clear();
                        j.error.clear();
                    } else {
                        j.error = format!("{e:#}");
                    }
                });
            }
            m.jobs.lock().unwrap().remove(&job_id);
        });
        Ok(s)
    }
    pub async fn cancel(&self, jid: &str) -> Result<Snapshot> {
        let control = self.jobs.lock().unwrap().get(jid).cloned();
        if let Some(control) = control {
            control.cancel.cancel();
            // Acknowledgement means the worker has exited and its terminal
            // state is saved; exporting again cannot race the old worker.
            control.finished.cancelled().await;
        }
        Ok(self.snapshot())
    }
    fn job(&self, jid: &str, f: impl FnOnce(&mut Job)) -> Result<Snapshot> {
        self.change(|j| {
            f(j.jobs
                .iter_mut()
                .find(|j| j.id == jid)
                .context("导出记录不存在")?);
            Ok(())
        })
    }
    pub async fn retry_import(&self, jid: &str) -> Result<Snapshot> {
        let job = self
            .journal
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|j| j.id == jid)
            .cloned()
            .context("导出记录不存在")?;
        let sig = job.signature.as_ref().context("成品尚未提交")?;
        if &media::signature(Path::new(&job.path))? != sig {
            bail!("成品已变化，请检查输出文件")
        }
        let tid = self.import(Path::new(&job.path)).await?;
        self.job(jid, |j| {
            j.phase = "complete".into();
            j.progress = 1.;
            j.error.clear();
            j.track_id = Some(tid);
        })
    }
    async fn import(&self, path: &Path) -> Result<i64> {
        let state = self.state.clone();
        let path = path.to_owned();
        let tid = tokio::task::spawn_blocking(move || {
            let _guard = state.folder_operations.lock().unwrap();
            state.library.upsert_file(&path, "local", "")
        })
        .await??;
        self.state.hub.publish_library_updated(&[tid]);
        Ok(tid)
    }
}
#[derive(Deserialize)]
pub struct Edit {
    #[serde(default)]
    pub markers: Option<Vec<Marker>>,
    pub name: String,
    pub layers: Vec<Layer>,
    pub canvas: Canvas,
    pub output: Output,
}
pub fn signature(path: &Path) -> Result<String> {
    Ok(serde_json::to_string(&media::signature(path)?)?)
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
/// Audition only the next audible source, using its existing cuts, speed and fades.
/// This operates on the preview lease's copy, never the saved/exported project.
fn audition_next_layer(p: &mut CompositionProject, after: &str) {
    let Some(index) = p.layers.iter().position(|l| l.id == after) else { return };
    let next = p.layers.iter().skip(index + 1).find(|l| {
        !l.clips.is_empty() && p.source(&l.source_id).is_some_and(|s| s.audio)
    }).map(|l| l.id.clone());
    for layer in &mut p.layers {
        for clip in &mut layer.clips {
            clip.sound.muted = Some(&layer.id) != next.as_ref();
        }
    }
}
fn empty_project(name: &str, directory: &str) -> CompositionProject {
    CompositionProject {
        markers: vec![],
        id: id(),
        revision: 0,
        name: name.into(),
        sources: vec![],
        layers: vec![],
        canvas: Canvas::default(),
        output: Output {
            format: "mp4".into(),
            name: name.into(),
            directory: directory.into(),
            in_ms: 0.,
            out_ms: None,
            quality: 20,
            acceleration: Default::default(),
        },
        migrated_from: None,
    }
}
fn new_clip(s: &Source, start_ms: f64) -> Clip {
    Clip {
        video_transition: None,
        display_duration_ms: s.image().then_some(5000.), animation_offset_ms: 0.,
        id: id(),
        source_id: s.id.clone(),
        start_ms,
        source_in_ms: 0.,
        source_out_ms: s.duration_ms,
        speed: Speed::normal(s.duration_ms),
        picture: Picture::default(),
        sound: Sound {
            muted: !s.audio,
            gain: 1.,
            manual: false,
        },
        fades: Fades::new(if s.image() { 5000. } else { s.duration_ms }, false),
    }
}
fn migrate(
    t: &CompositionTask,
    vp: Option<&media::Probe>,
    ap: Option<&media::Probe>,
    directory: &str,
) -> CompositionProject {
    let mut p = empty_project(
        t.video
            .as_ref()
            .or(t.audio.as_ref())
            .map_or("作品", |e| &e.title),
        directory,
    );
    p.migrated_from = Some(t.id.clone());
    for (entry, probe) in [(t.video.as_ref(), vp), (t.audio.as_ref(), ap)] {
        if let Some(e) = entry {
            let (width, height, fps) = probe.map_or((1920, 1080, 30.), shape);
            let s = Source {
                    kind: String::new(), frame_ends_ms: vec![],
                id: e.id.clone(),
                track_id: e.track_id,
                path: e.path.clone(),
                title: e.title.clone(),
                duration_ms: probe
                    .and_then(|p| p.check(e.is_video).ok())
                    .unwrap_or(e.duration_ms)
                    .max(1) as f64,
                video: e.is_video,
                audio: probe.is_none_or(|p| p.audio().is_some()),
                width,
                height,
                fps,
                signature: signature(Path::new(&e.path)).unwrap_or_default(),
            };
            p.sources.push(s);
        }
    }
    let Some(v) = t.video.as_ref() else {
        if let Some(s) = p.sources.first() {
            p.layers.push(Layer {
                grid: None,
                id: id(),
                source_id: s.id.clone(),
                clips: vec![new_clip(s, 0.)],
            });
        }
        return p;
    };
    let s = &p.sources[0];
    p.canvas = Canvas {
        width: s.width / 2 * 2,
        height: s.height / 2 * 2,
        fps: s.fps,
        initialized: true,
        ..Canvas::default()
    };
    p.output.directory = if v.options.output_dir.is_empty() {
        directory.into()
    } else {
        v.options.output_dir.clone()
    };
    p.output.acceleration = v.options.acceleration;
    let timeline = t.timeline;
    let mut base = new_clip(s, timeline.map_or(0, |t| t.video_start_ms) as f64);
    let opt = &v.options;
    let overlay = t.audio.as_ref().is_some_and(|a| a.is_video);
    base.sound.gain = opt.audio.main_gain;
    base.sound.muted = t.audio.is_some() && !overlay && opt.audio.mode == AudioMixMode::Replace;
    let mut clips = vec![base.clone()];
    if t.uses_video_sections() {
        clips = t
            .video_sections
            .iter()
            .filter_map(|sec| {
                let lo = (sec.audio_start_ms).max(opt.segment.source_start_ms);
                let hi = (sec.audio_start_ms + sec.duration_ms).min(
                    opt.segment
                        .source_end_ms
                        .unwrap_or(t.audio_duration_ms.unwrap_or(0)),
                );
                if hi <= lo {
                    return None;
                }
                let mut c = base.clone();
                c.id = id();
                c.start_ms = (lo - opt.segment.source_start_ms) as f64;
                c.source_in_ms = (sec.video_start_ms + lo - sec.audio_start_ms) as f64;
                c.source_out_ms = c.source_in_ms + (hi - lo) as f64;
                c.fades = Fades::new(c.duration(), false);
                Some(c)
            })
            .collect();
    }
    p.layers.push(Layer {
        grid: None,
        id: id(),
        source_id: s.id.clone(),
        clips,
    });
    if let Some(a) = p.sources.get(1) {
        let mut c = new_clip(a, 0.);
        c.source_in_ms = opt.segment.source_start_ms as f64;
        c.source_out_ms = opt.segment.source_end_ms.unwrap_or(a.duration_ms as i64) as f64;
        let start = timeline.map_or(
            t.offset_ms.unwrap_or(0) + opt.segment.source_start_ms,
            |t| t.audio_start_ms,
        ) as f64;
        c.start_ms = start.max(0.);
        c.source_in_ms += (-start).max(0.);
        if overlay || opt.length_policy == kdj_core::composition::LengthPolicy::KeepVideo {
            let end = timeline.map_or(base.duration(), |t| t.duration_ms as f64);
            c.source_out_ms = c
                .source_out_ms
                .min(c.source_in_ms + (end - c.start_ms).max(0.));
        }
        c.sound.gain = opt.audio.gain;
        c.sound.muted = overlay && opt.overlay.audio == OverlayAudio::Main;
        c.sound.manual = true;
        c.fades = Fades::new(c.duration(), false);
        c.fades.linear = true;
        c.fades.audio_in_ms = (opt.audio.fade_in_ms as f64).min(c.duration() / 2.);
        c.fades.audio_out_ms = (opt.audio.fade_out_ms as f64).min(c.duration() / 2.);
        if overlay {
            c.picture = Picture {
                rotation: 0., flip_x: false, flip_y: false, crop: [0.; 4],
                x: opt.overlay.x,
                y: opt.overlay.y,
                scale: opt.overlay.scale,
                opacity: opt.overlay.opacity,
            };
            c.fades.video_in_ms = (opt.overlay.fade_ms as f64).min(c.duration() / 2.);
            c.fades.video_out_ms = c.fades.video_in_ms;
            if opt.overlay.audio == OverlayAudio::ReplaceSegment {
                let end = c.start_ms + c.duration();
                let mut split = vec![];
                for original in &p.layers[0].clips {
                    let mut points =
                        vec![original.start_ms, (original.start_ms + original.duration())];
                    for point in [c.start_ms, end] {
                        if point > points[0] && point < points[1] {
                            points.push(point);
                        }
                    }
                    points.sort_by(f64::total_cmp);
                    for pair in points.windows(2) {
                        let mut part = original.clone();
                        part.id = id();
                        part.start_ms = pair[0];
                        part.source_in_ms = original.source_at(pair[0] - original.start_ms);
                        part.source_out_ms = original.source_at(pair[1] - original.start_ms);
                        part.sound.muted = pair[0] >= c.start_ms && pair[0] < end;
                        part.fades = Fades::new(part.duration(), false);
                        split.push(part);
                    }
                }
                p.layers[0].clips = split;
            }
        }
        if c.source_out_ms > c.source_in_ms {
            p.layers.push(
                Layer {
                    grid: None,
                    id: id(),
                    source_id: a.id.clone(),
                    clips: vec![c],
                },
            );
        }
    }
    // New editable projects never inherit an overwrite destination.
    p
}
