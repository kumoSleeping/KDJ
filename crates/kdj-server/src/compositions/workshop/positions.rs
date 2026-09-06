use super::*;
use kdj_core::work_scheduler::{work_scheduler, WorkClass, WorkRequest};
#[derive(Clone, Serialize, Deserialize)]
pub struct Placement {
    pub clip_id: String,
    pub source_in_ms: f64,
    pub source_out_ms: f64,
    pub start_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_multiplier: Option<f64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PositionPreset {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerequisite: Option<String>,
    pub placements: Vec<Placement>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PositionAnalysis {
    pub id: String,
    pub layer_id: String,
    pub phase: String,
    pub progress: f64,
    pub reference_id: String,
    pub reference_title: String,
    pub reason: String,
    pub presets: Vec<PositionPreset>,
    pub applied: Option<String>,
}
#[derive(Clone)]
pub(super) struct PositionTask {
    view: PositionAnalysis,
    base: Layer,
    reference: Option<Clip>,
    reference_key: String,
    layouts: Vec<String>,
    origins: HashMap<String, String>,
    cancel: CancellationToken,
}
pub(super) fn layout_key(layer: &Layer) -> Result<String> {
    render::key(
        &layer
            .clips
            .iter()
            .map(|c| {
                (
                    &c.id,
                    &c.source_id,
                    c.start_ms,
                    c.source_in_ms,
                    c.source_out_ms,
                    &c.speed,
                )
            })
            .collect::<Vec<_>>(),
    )
}
pub(super) fn retain_pending_after_edit(
    pending: &mut HashMap<String, String>,
    previous: &CompositionProject,
    current: &CompositionProject,
) -> Result<()> {
    for old in &previous.layers {
        let key = format!("{}:{}", current.id, old.id);
        if !pending.contains_key(&key) {
            continue;
        }
        let keep = if let Some(layer) = current.layers.iter().find(|l| l.id == old.id) {
            layout_key(old)? == layout_key(layer)?
                && reference_key(previous, old, &reference(previous, old))?
                    == reference_key(current, layer, &reference(current, layer))?
        } else {
            false
        };
        if !keep {
            pending.remove(&key);
        }
    }
    Ok(())
}
fn reference(p: &CompositionProject, layer: &Layer) -> Option<Clip> {
    if let Some(music) = p.music_reference() {
        // Music is the authority, never a target of video-driven correction.
        return (p.source(&layer.source_id).is_some_and(|s| s.video) && music.duration() >= 6000.)
            .then(|| music.clone());
    }
    p.layers
        .iter()
        .filter(|l| l.id != layer.id)
        .flat_map(|l| &l.clips)
        .filter(|c| p.source(&c.source_id).is_some_and(|s| s.audio) && c.duration() >= 6000.)
        .max_by(|a, b| {
            let score = |c: &Clip| (!p.source(&c.source_id).unwrap().video, !c.sound.muted);
            score(a)
                .cmp(&score(b))
                .then_with(|| a.duration().total_cmp(&b.duration()))
        })
        .cloned()
}
fn reference_key(
    p: &CompositionProject,
    layer: &Layer,
    reference: &Option<Clip>,
) -> Result<String> {
    render::key(&(
        p.source(&layer.source_id).map(|s| (&s.path, &s.signature)),
        reference.as_ref().map(|c| {
            (
                &c.id,
                c.start_ms,
                c.source_in_ms,
                c.source_out_ms,
                &c.speed,
                p.source(&c.source_id).map(|s| (&s.path, &s.signature)),
            )
        }),
    ))
}
// Suggestions belong to the material slot, not to the latest cropped result.
// Retain its source domain across moves, cuts, preset switches and restarts.
fn source_basis(p: &CompositionProject, layer: &Layer) -> Layer {
    let mut base = layer.clone();
    if let Some(first) = layer.clips.first() {
        if layer.clips.iter().all(|c| c.speed == first.speed) {
            let mut c = first.clone();
            let source = p.source(&layer.source_id).unwrap();
            let lo = c.speed.domain_start_ms.max(0.);
            let hi = c.speed.domain_end_ms.min(source.duration_ms);
            c.fades.offset_ms = 0.;
            c.source_in_ms = lo;
            c.source_out_ms = hi;
            c.start_ms = 0.;
            c.fades.span_ms = c.duration();
            base.clips = vec![c];
        }
    }
    base
}
fn basis_clip<'a>(base: &'a Layer, clip: &Clip) -> Option<&'a Clip> {
    base.clips
        .iter()
        .filter(|b| {
            b.source_id == clip.source_id
                && b.source_in_ms <= clip.source_in_ms + 0.01
                && b.source_out_ms >= clip.source_out_ms - 0.01
                && (b.speed == clip.speed
                    // A suggested constant rate changes presentation, not the
                    // source domain. Keep the full basis across persisted cuts
                    // with different rates instead of analyzing only leftovers.
                    || (b.speed.preset == "constant"
                        && clip.speed.preset == "constant"
                        && b.speed.domain_start_ms == clip.speed.domain_start_ms
                        && b.speed.domain_end_ms == clip.speed.domain_end_ms))
        })
        .min_by_key(|b| (b.id != clip.id, b.speed != clip.speed))
}
impl Workshop {
    pub fn position_views(&self, pid: &str) -> Vec<PositionAnalysis> {
        let prefix = format!("{pid}:");
        self.positions
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, v)| v.view.clone())
            .collect()
    }
    fn publish_positions(&self, pid: &str) {
        let revision = self
            .journal
            .lock()
            .unwrap()
            .projects
            .iter()
            .find(|p| p.id == pid)
            .map(|p| p.revision);
        if let Some(revision) = revision {
            self.state.hub.publish("workshop.positions",&serde_json::json!({"session":self.session,"project_id":pid,"revision":revision,"items":self.position_views(pid)}));
        }
    }
    fn position_progress(&self, pid: &str, key: &str, request: &str, progress: f64) {
        if let Some(task) = self
            .positions
            .lock()
            .unwrap()
            .get_mut(key)
            .filter(|t| t.view.id == request && !t.cancel.is_cancelled())
        {
            task.view.progress = progress;
        }
        self.publish_positions(pid);
    }
    pub fn cancel_positions(&self, pid: &str) {
        let prefix = format!("{pid}:");
        self.positions.lock().unwrap().retain(|key, task| {
            if key.starts_with(&prefix) {
                task.cancel.cancel();
                false
            } else {
                true
            }
        });
    }
    /// Persist the user's stop before releasing workers or allowing auto placement.
    pub fn control_positions(
        self: &Arc<Self>,
        pid: &str,
        layer_id: Option<&str>,
        stopped: bool,
    ) -> Result<()> {
        let mut journal = self.journal.lock().unwrap();
        let p = journal.projects.iter().find(|p| p.id == pid).context("作品不存在")?;
        if layer_id.is_some_and(|id| !p.layers.iter().any(|l| l.id == id)) {
            bail!("素材行不存在")
        }
        let mut tasks = self.positions.lock().unwrap();
        let keys: Vec<_> = p.layers.iter()
            .filter(|l| layer_id.is_none_or(|id| l.id == id))
            .map(|l| format!("{pid}:{}", l.id))
            .filter(|key| layer_id.is_some() || journal.pending_positions.contains_key(key)
                || tasks.get(key).is_some_and(|t| matches!(t.view.phase.as_str(), "analyzing" | "waiting")))
            .collect();
        let mut next = journal.clone();
        for key in &keys {
            if stopped {
                next.stopped_positions.insert(key.clone());
                next.pending_positions.remove(key);
            } else {
                next.stopped_positions.remove(key);
            }
        }
        self.save(&next)?;
        *journal = next;
        for key in keys {
            if let Some(task) = tasks.get_mut(&key) {
                task.cancel.cancel();
                if stopped {
                    task.view.phase = "stopped".into();
                    task.view.progress = 1.;
                    task.view.reason = "已停止".into();
                    task.view.presets.clear();
                    task.view.applied = None;
                } else {
                    tasks.remove(&key);
                }
            }
        }
        drop(tasks);
        drop(journal);
        if stopped {
            self.publish_positions(pid);
        } else {
            self.prepare_positions(pid)?;
        }
        Ok(())
    }
    /// Imports start immediately; subsequent committed edits only restart affected matching contexts.
    pub fn prepare_positions(self: &Arc<Self>, pid: &str) -> Result<Vec<PositionAnalysis>> {
        let mut journal = self.journal.lock().unwrap();
        let (p, bases) = {
            let p = journal
                .projects
                .iter()
                .find(|p| p.id == pid)
                .cloned()
                .context("作品不存在")?;
            let mut next = journal.clone();
            next.position_bases.retain(|key, _| {
                next.projects.iter().any(|p| {
                    p.layers
                        .iter()
                        .any(|l| *key == format!("{}:{}", p.id, l.id))
                })
            });
            for layer in &p.layers {
                let key = format!("{pid}:{}", layer.id);
                let valid = next
                    .position_bases
                    .get(&key)
                    .is_some_and(|base| layer.clips.iter().all(|c| basis_clip(base, c).is_some()));
                if !valid {
                    next.position_bases.insert(key, source_basis(&p, layer));
                }
            }
            if serde_json::to_vec(&next.position_bases)?
                != serde_json::to_vec(&journal.position_bases)?
            {
                self.save(&next)?;
                *journal = next;
            }
            (p, journal.position_bases.clone())
        };
        let mut pending = vec![];
        {
            let mut tasks = self.positions.lock().unwrap();
            let prefix = format!("{pid}:");
            tasks.retain(|key, task| {
                if key.starts_with(&prefix) && !p.layers.iter().any(|l| l.id == task.base.id) {
                    task.cancel.cancel();
                    false
                } else {
                    true
                }
            });
            for layer in &p.layers {
                let key = format!("{pid}:{}", layer.id);
                let reference = reference(&p, layer);
                let ref_key = reference_key(&p, layer, &reference)?;
                let layout = layout_key(layer)?;
                let stopped = journal.stopped_positions.contains(&key);
                if tasks.get(&key).is_some_and(|t| {
                    (stopped && t.view.phase == "stopped") || (!stopped && t.reference_key == ref_key
                        && t.layouts.contains(&layout)
                        && t.view.phase != "failed")
                }) {
                    continue;
                }
                if let Some(old) = tasks.remove(&key) {
                    old.cancel.cancel();
                }
                let source = p.source(&layer.source_id).context("素材不存在")?;
                let music_basis = !source.video && p.music_reference().is_some();
                let reason = if stopped {
                    "已停止"
                } else if music_basis {
                    ""
                } else if !source.audio {
                    "素材没有声音，无法自动匹配"
                } else if layer.clips.is_empty() {
                    ""
                } else if reference.is_none() {
                    "等待参考音频"
                } else {
                    ""
                };
                let phase = if stopped {
                    "stopped"
                } else if music_basis {
                    "ready"
                } else if !source.audio || layer.clips.is_empty() {
                    "unmatched"
                } else if reference.is_none() {
                    "waiting"
                } else {
                    "analyzing"
                };
                let view = PositionAnalysis {
                    id: id(),
                    layer_id: layer.id.clone(),
                    phase: phase.into(),
                    progress: 0.,
                    reference_id: reference.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                    reference_title: reference
                        .as_ref()
                        .and_then(|c| p.source(&c.source_id))
                        .map(|s| s.title.clone())
                        .unwrap_or_default(),
                    reason: reason.into(),
                    presets: vec![],
                    applied: None,
                };
                let task = PositionTask {
                    view,
                    base: bases[&key].clone(),
                    reference,
                    reference_key: ref_key,
                    layouts: vec![layout],
                    origins: layer
                        .clips
                        .iter()
                        .map(|c| {
                            (
                                c.id.clone(),
                                basis_clip(&bases[&key], c)
                                    .map(|b| b.id.clone())
                                    .unwrap_or_else(|| c.id.clone()),
                            )
                        })
                        .collect(),
                    cancel: CancellationToken::new(),
                };
                if phase == "analyzing" {
                    pending.push((key.clone(), task.clone()));
                }
                tasks.insert(key, task);
            }
        }
        drop(journal);
        self.publish_positions(pid);
        let p = Arc::new(p);
        for (key, task) in pending {
            let m = self.clone();
            let p = p.clone();
            tokio::spawn(async move {
                let result = m.analyze_positions(&p, &key, &task).await;
                if task.cancel.is_cancelled() {
                    return;
                }
                // A task only owns its original context; late completion never replaces another analysis.
                let current = m
                    .journal
                    .lock()
                    .unwrap()
                    .projects
                    .iter()
                    .find(|v| v.id == p.id)
                    .cloned();
                let Some(current) = current else { return };
                let Some(layer) = current.layers.iter().find(|l| l.id == task.base.id) else {
                    return;
                };
                if layout_key(layer).ok().as_ref() != task.layouts.first()
                    || reference_key(&current, layer, &reference(&current, layer))
                        .ok()
                        .as_ref()
                        != Some(&task.reference_key)
                {
                    return;
                }
                {
                    let mut tasks = m.positions.lock().unwrap();
                    let Some(record) = tasks.get_mut(&key).filter(|t| t.view.id == task.view.id && !t.cancel.is_cancelled())
                    else {
                        return;
                    };
                    match result {
                        Ok((presets, reason)) => {
                            record.view.phase = if presets.is_empty() {
                                "unmatched"
                            } else {
                                "ready"
                            }
                            .into();
                            record.view.presets = presets;
                            record.view.reason = reason;
                            record.view.progress = 1.;
                        }
                        Err(e) => {
                            record.view.phase = "failed".into();
                            record.view.reason = format!("{e:#}");
                            record.view.progress = 1.;
                        }
                    }
                }
                if let Err(error) =
                    m.apply_position_choice(&p.id, None, &task.base.id, &task.view.id, None)
                {
                    tracing::warn!(project = %p.id, layer = %task.base.id, %error, "automatic workshop placement failed");
                }
                m.publish_positions(&p.id);
            });
        }
        Ok(self.position_views(pid))
    }
    async fn analyze_positions(
        &self,
        p: &CompositionProject,
        key: &str,
        task: &PositionTask,
    ) -> Result<(Vec<PositionPreset>, String)> {
        let _slot = tokio::select! {_=task.cancel.cancelled()=>bail!("匹配已取消"),slot=self.analysis_slots.acquire()=>slot?};
        let cancel = task.cancel.clone();
        let _work = tokio::task::spawn_blocking(move || {
            work_scheduler()
                .acquire(WorkRequest::new(WorkClass::LibraryAnalysisLight), || {
                    cancel.is_cancelled()
                })
                .map_err(|_| anyhow::anyhow!("匹配已取消"))
        })
        .await??;
        let reference = task.reference.as_ref().context("缺少参考音频")?;
        let cache_key = render::key(&(
            "positions-v6-remix-assembly",
            layout_key(&task.base)?,
            &task.reference_key,
        ))?;
        let cache = self.cache.join(format!("{cache_key}.positions.json"));
        for source in [&task.base.source_id, &reference.source_id] {
            let s = p.source(source).context("素材不存在")?;
            if !s.signature.is_empty() && signature(Path::new(&s.path))? != s.signature {
                bail!("素材已变化：{}，请重新添加", s.title)
            }
        }
        if let Ok(bytes) = tokio::fs::read(&cache).await {
            if let Ok(value) = serde_json::from_slice::<(Vec<PositionPreset>, String)>(&bytes) {
                return Ok(value);
            }
        }
        self.position_progress(&p.id, key, &task.view.id, 0.05);
        let reference_pcm = Arc::new(render::alignment_pcm(p, reference, &task.cancel).await?);
        self.position_progress(&p.id, key, &task.view.id, 0.2);
        let mut placements = vec![];
        let mut remix_placements = vec![];
        let mut reason = String::new();
        for (index, clip) in task.base.clips.iter().enumerate() {
            if task.cancel.is_cancelled() {
                bail!("匹配已取消")
            }
            if clip.duration() < 6000. {
                reason = "可用于匹配的片段不足 6 秒".into();
                continue;
            }
            let pcm = render::alignment_pcm(p, clip, &task.cancel).await?;
            let a = reference_pcm.clone();
            let cancel = task.cancel.clone();
            let constant = clip.speed.preset == "constant" && reference.speed.preset == "constant";
            let (offset, sections, fuzzy, message) =
                tokio::task::spawn_blocking(move || -> Result<_> {
                    kdj_core::thread_qos::prefer_background();
                    let (result, sections) =
                        kdj_analysis::alignment::align_sections(&a, &pcm, || {
                            cancel.is_cancelled()
                        })?;
                    if result.matched {
                        return Ok((
                            Some(-result.offset_ms as f64),
                            sections,
                            vec![],
                            String::new(),
                        ));
                    }
                    let result =
                        kdj_analysis::alignment::align_segment(&pcm, &a, || cancel.is_cancelled())?;
                    let fuzzy = if !result.matched && constant {
                        kdj_analysis::alignment::suggest_constant_speed(&pcm, &a, || {
                            cancel.is_cancelled()
                        })?
                    } else {
                        vec![]
                    };
                    Ok((
                        result.matched.then_some(result.offset_ms as f64),
                        vec![],
                        fuzzy,
                        result.reason,
                    ))
                })
                .await??;
            for candidate in &fuzzy {
                let speed = clip.speed.start * candidate.speed;
                if !(0.5..=2.).contains(&speed) {
                    continue;
                }
                remix_placements.push(Placement {
                    clip_id: clip.id.clone(),
                    source_in_ms: clip.source_at(candidate.source_start_ms),
                    source_out_ms: clip.source_at(candidate.source_end_ms),
                    start_ms: reference.start_ms + candidate.reference_start_ms,
                    speed_multiplier: Some(candidate.speed),
                });
            }
            if !sections.is_empty() {
                for section in sections {
                    if let Some(value) = placement(
                        clip,
                        section.video_start_ms as f64,
                        section.video_start_ms as f64 + section.duration_ms as f64,
                        reference.start_ms + section.audio_start_ms as f64,
                    ) {
                        placements.push(value)
                    }
                }
            } else if let Some(offset) = offset {
                let lo = (-offset).max(0.);
                let hi = clip.duration().min(reference.duration() - offset);
                if let Some(value) = placement(clip, lo, hi, reference.start_ms + offset + lo) {
                    placements.push(value)
                }
            } else {
                reason = message;
            }
            self.position_progress(
                &p.id,
                key,
                &task.view.id,
                0.2 + 0.75 * (index + 1) as f64 / task.base.clips.len().max(1) as f64,
            );
        }
        let presets = if remix_placements.is_empty() {
            make_presets(&task.base, &placements)
        } else {
            placements.extend(remix_placements);
            make_remix_presets(&task.base, placements)
        };
        if !presets.is_empty() {
            reason.clear()
        } else if reason.is_empty() {
            reason = "没有可靠的匹配位置".into()
        }
        let result = (presets, reason);
        if !task.cancel.is_cancelled() {
            let temp = cache.with_extension("part");
            tokio::fs::write(&temp, serde_json::to_vec(&result)?).await?;
            tokio::fs::rename(temp, cache).await?;
            self.trim_cache();
        }
        Ok(result)
    }
    pub fn apply_positions(
        self: &Arc<Self>,
        pid: &str,
        revision: u64,
        layer_id: &str,
        analysis_id: &str,
        preset_id: &str,
    ) -> Result<Snapshot> {
        self.apply_position_choice(pid, Some(revision), layer_id, analysis_id, Some(preset_id))?
            .context("位置方案未应用")
    }
    // Resolve the current revision and commit under one lock. Concurrent analyses
    // for different rows must not lose their first choice to a revision race.
    fn apply_position_choice(
        self: &Arc<Self>,
        pid: &str,
        revision: Option<u64>,
        layer_id: &str,
        analysis_id: &str,
        preset_id: Option<&str>,
    ) -> Result<Option<Snapshot>> {
        let key = format!("{pid}:{layer_id}");
        let mut journal = self.journal.lock().unwrap();
        let automatic = preset_id.is_none();
        if automatic && !journal.pending_positions.contains_key(&key) {
            return Ok(None);
        }
        let mut next = journal.clone();
        let p = next
            .projects
            .iter_mut()
            .find(|p| p.id == pid)
            .context("作品不存在")?;
        if revision.is_some_and(|revision| revision != p.revision) {
            bail!("作品已更新，请重试当前操作")
        }
        if p.music_reference().is_some()
            && p.layers
                .iter()
                .find(|l| l.id == layer_id)
                .and_then(|l| p.source(&l.source_id))
                .is_some_and(|s| !s.video)
        {
            bail!("音乐是对齐基准，请在视频素材上应用适配")
        }
        let mut tasks = self.positions.lock().unwrap();
        let mut task = tasks.get(&key).cloned().context("位置分析已过期")?;
        if automatic
            && (task.view.id != analysis_id
                || task.view.phase != "ready"
                || task.view.presets.is_empty())
        {
            return Ok(None);
        }
        if task.view.id != analysis_id || task.view.phase != "ready" {
            bail!("位置分析已更新，请重新选择")
        }
        let layer = p
            .layers
            .iter()
            .find(|l| l.id == layer_id)
            .context("素材行不存在")?;
        if automatic && journal.pending_positions.get(&key) != Some(&layout_key(layer)?) {
            return Ok(None);
        }
        if !task.layouts.contains(&layout_key(layer)?)
            || task.reference_key != reference_key(&p, layer, &reference(&p, layer))?
        {
            bail!("片段或参考位置已变化，请等待重新分析")
        }
        let preset = match preset_id {
            Some(id) => task.view.presets.iter().find(|v| v.id == id),
            None => task.view.presets.first(),
        }
        .context("位置方案不存在")?;
        // Local remix suggestions are explicit cuts, not a safe automatic
        // placement of newly imported full material.
        if automatic && preset.id.starts_with("fuzzy-speed-") {
            return Ok(None);
        }
        let preset_id = preset.id.clone();
        let (clips, origins) = apply_preset(&task.base, layer, preset, &task.origins)?;
        let layer = p.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
        layer.clips = clips;
        // A full video can begin before the music. Add leading project time,
        // preserving every source frame and all existing relative positions.
        let shift = retain_leading_material(p);
        let layer = p.layers.iter().find(|l| l.id == layer_id).unwrap();
        let next_key = layout_key(layer)?;
        let next_reference = reference(&p, layer);
        let next_reference_key = reference_key(&p, layer, &next_reference)?;
        p.validate().map_err(anyhow::Error::msg)?;
        // Retain both alternatives after applying a preset; ordinary manual timing edits invalidate them.
        task.layouts.push(next_key);
        task.origins = origins;
        task.view.applied = Some(preset_id);
        task.reference = next_reference;
        task.reference_key = next_reference_key;
        for choice in &mut task.view.presets {
            for placement in &mut choice.placements {
                placement.start_ms += shift;
            }
        }
        next.pending_positions.remove(&key);
        // Leading time is an automatic project shift, not a manual edit of the
        // remaining rows. Keep those eligible for their own first suggestion.
        for layer in &p.layers {
            if let Some(layout) = next
                .pending_positions
                .get_mut(&format!("{pid}:{}", layer.id))
            {
                *layout = layout_key(layer)?;
            }
        }
        p.revision += 1;
        next.revision += 1;
        self.save(&next)?;
        *journal = next;
        tasks.insert(key, task);
        drop(tasks);
        drop(journal);
        let snapshot = self.snapshot();
        self.state.hub.publish("workshop.updated", &snapshot);
        self.cancel_previews(pid);
        let _ = self.prepare_positions(pid);
        Ok(Some(snapshot))
    }
}
fn placement(c: &Clip, lo: f64, hi: f64, start: f64) -> Option<Placement> {
    let adjusted = lo + (-start).max(0.);
    (hi - adjusted >= 100.).then(|| Placement {
        clip_id: c.id.clone(),
        source_in_ms: c.source_at(adjusted),
        source_out_ms: c.source_at(hi),
        start_ms: start.max(0.),
        speed_multiplier: None,
    })
}
fn make_remix_presets(layer: &Layer, mut placements: Vec<Placement>) -> Vec<PositionPreset> {
    placements.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let duration = |p: &Placement| {
        layer.clips.iter().find(|c| c.id == p.clip_id).map(|c| {
            (c.output_at(p.source_out_ms) - c.output_at(p.source_in_ms))
                / p.speed_multiplier.unwrap_or(1.)
        })
    };
    if placements.is_empty()
        || placements.iter().any(|p| duration(p).is_none())
        || placements
            .windows(2)
            .any(|p| p[0].start_ms + duration(&p[0]).unwrap() > p[1].start_ms + 0.01)
    {
        return vec![];
    }
    vec![PositionPreset {
        id: "fuzzy-speed-sections".into(),
        label: "分段匹配".into(),
        prerequisite: Some("按音乐编排 · 分段变速适配".into()),
        placements,
    }]
}

fn make_presets(layer: &Layer, placements: &[Placement]) -> Vec<PositionPreset> {
    let duration = |p: &Placement| {
        layer
            .clips
            .iter()
            .find(|c| c.id == p.clip_id)
            .map_or(0., |c| {
                (c.output_at(p.source_out_ms) - c.output_at(p.source_in_ms))
                    / p.speed_multiplier.unwrap_or(1.)
            })
    };
    let Some(longest) = placements
        .iter()
        .max_by(|a, b| duration(a).total_cmp(&duration(b)))
    else {
        return vec![];
    };
    let anchor = layer
        .clips
        .iter()
        .find(|c| c.id == longest.clip_id)
        .unwrap();
    let multiplier = longest.speed_multiplier.unwrap_or(1.);
    let offset =
        longest.start_ms - (anchor.start_ms + anchor.output_at(longest.source_in_ms)) / multiplier;
    let mut result = vec![PositionPreset {
        id: "longest".into(),
        label: "最大匹配 · 保留完整".into(),
        prerequisite: None,
        placements: layer
            .clips
            .iter()
            .map(|c| Placement {
                clip_id: c.id.clone(),
                source_in_ms: c.source_in_ms,
                source_out_ms: c.source_out_ms,
                start_ms: c.start_ms / multiplier + offset,
                speed_multiplier: longest.speed_multiplier,
            })
            .collect(),
    }];
    let mut sections = placements.to_vec();
    sections.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    if !sections
        .windows(2)
        .all(|v| v[0].start_ms + duration(&v[0]) <= v[1].start_ms + 0.01)
    {
        sections = vec![longest.clone()];
    }
    result.push(PositionPreset {
        id: "sections".into(),
        label: "裁切匹配段".into(),
        prerequisite: None,
        placements: sections,
    });
    result
}
fn retain_leading_material(project: &mut CompositionProject) -> f64 {
    let shift = -project
        .layers
        .iter()
        .flat_map(|l| &l.clips)
        .map(|c| c.start_ms)
        .fold(0., f64::min);
    if shift > 0. {
        for c in project.layers.iter_mut().flat_map(|l| &mut l.clips) {
            c.start_ms += shift;
        }
        // Explicit export bounds continue to identify the same material.
        if project.output.out_ms.is_some() || project.output.in_ms > 0. {
            project.output.in_ms += shift;
            project.output.out_ms = project.output.out_ms.map(|end| end + shift);
        }
    }
    shift
}
fn apply_preset(
    base: &Layer,
    current: &Layer,
    preset: &PositionPreset,
    origins: &HashMap<String, String>,
) -> Result<(Vec<Clip>, HashMap<String, String>)> {
    let mut clips = vec![];
    let mut used = std::collections::HashSet::new();
    let mut next_origins = HashMap::new();
    for placement in &preset.placements {
        let original = base
            .clips
            .iter()
            .find(|c| c.id == placement.clip_id)
            .context("原片段不存在")?;
        let multiplier = placement.speed_multiplier.unwrap_or(1.);
        if !multiplier.is_finite()
            || multiplier <= 0.
            || (placement.speed_multiplier.is_some() && original.speed.preset != "constant")
        {
            bail!("变速适配方案无效")
        }
        let related: Vec<_> = current
            .clips
            .iter()
            .filter(|c| origins.get(&c.id) == Some(&original.id))
            .collect();
        // Preserve independently edited picture/sound/fade settings on every surviving source span.
        let mut boundaries = vec![placement.source_in_ms, placement.source_out_ms];
        for clip in &related {
            boundaries.extend(
                [clip.source_in_ms, clip.source_out_ms]
                    .into_iter()
                    .filter(|t| *t > placement.source_in_ms && *t < placement.source_out_ms),
            );
        }
        boundaries.sort_by(f64::total_cmp);
        boundaries.dedup_by(|a, b| (*a - *b).abs() < 0.001);
        for pair in boundaries.windows(2) {
            if pair[1] - pair[0] < 0.001 {
                continue;
            }
            let midpoint = (pair[0] + pair[1]) / 2.;
            let template = related
                .iter()
                .copied()
                .filter(|c| c.source_in_ms <= midpoint && c.source_out_ms > midpoint)
                .min_by(|a, b| {
                    let expected = placement.start_ms
                        + (original.output_at(midpoint)
                            - original.output_at(placement.source_in_ms))
                            / multiplier;
                    let distance = |c: &Clip| (c.start_ms + c.output_at(midpoint) - expected).abs();
                    distance(a).total_cmp(&distance(b))
                })
                // Newly restored material needs the source basis envelope;
                // a trimmed sibling's envelope may end before this span starts.
                .unwrap_or(original);
            let mut clip = template.clone();
            if used.insert(original.id.clone()) {
                clip.id = original.id.clone()
            } else if !used.insert(clip.id.clone()) {
                clip.id = id();
                used.insert(clip.id.clone());
            }
            clip.fades.offset_ms +=
                template.output_at(pair[0]) - template.output_at(template.source_in_ms);
            // Always derive speed from the retained source basis. Reapplying or
            // switching a suggestion must not compound its speed multiplier.
            clip.speed = original.speed.clone();
            clip.speed.start *= multiplier;
            clip.speed.middle *= multiplier;
            clip.speed.end *= multiplier;
            if clip.speed.preset == "constant" && template.speed.preset == "constant" {
                let scale = template.speed.start / clip.speed.start;
                clip.fades.offset_ms *= scale;
                clip.fades.span_ms *= scale;
                clip.fades.video_in_ms *= scale;
                clip.fades.video_out_ms *= scale;
                clip.fades.audio_in_ms *= scale;
                clip.fades.audio_out_ms *= scale;
            }
            clip.source_in_ms = pair[0];
            clip.source_out_ms = pair[1];
            clip.start_ms = placement.start_ms
                + (original.output_at(pair[0]) - original.output_at(placement.source_in_ms))
                    / multiplier;
            next_origins.insert(clip.id.clone(), original.id.clone());
            clips.push(clip);
        }
    }
    Ok((clips, next_origins))
}

#[cfg(test)]
mod speed_tests {
    use super::*;
    #[tokio::test]
    async fn stopping_position_analysis_is_selective_persistent_and_blocks_late_results() {
        let f = super::super::super::media_tests::Fixture::new();
        let config = Arc::new(kdj_core::AppConfig::create(f.path("data"), f.path("outputs"), 0));
        let state = AppState::new(config).unwrap();
        let legacy = CompositionManager::open(state.clone()).unwrap();
        let m = Workshop::open(state.clone(), &legacy).unwrap();
        // Keep analysis queued so cancellation is deterministic and needs no media files.
        let _slots = m.analysis_slots.acquire_many(m.analysis_slots.available_permits() as u32).await.unwrap();
        let mut p = super::super::naming::music_project();
        let mut second = p.layers[0].clone();
        second.id = "v2".into();
        second.clips[0].id = "clip-v2".into();
        p.layers.push(second);
        m.change(|j| {
            j.projects.push(p.clone());
            for layer in [&p.layers[0], &p.layers[2]] {
                j.pending_positions.insert(format!("{}:{}", p.id, layer.id), layout_key(layer)?);
            }
            Ok(())
        }).unwrap();
        m.prepare_positions(&p.id).unwrap();
        let key = format!("{}:v", p.id);
        let old = m.positions.lock().unwrap()[&key].clone();
        m.control_positions(&p.id, Some("v"), true).unwrap();
        assert!(old.cancel.is_cancelled());
        assert_eq!(m.positions.lock().unwrap()[&key].view.phase, "stopped");
        assert_eq!(m.positions.lock().unwrap()[&format!("{}:v2", p.id)].view.phase, "analyzing");
        assert!(!m.journal.lock().unwrap().pending_positions.contains_key(&key));
        m.position_progress(&p.id, &key, &old.view.id, 0.6);
        assert_eq!(m.positions.lock().unwrap()[&key].view.progress, 1.);
        assert!(m.apply_position_choice(&p.id, None, "v", &old.view.id, None).unwrap().is_none());
        let mut edited = p.clone();
        edited.layers[0].clips[0].start_ms += 100.;
        m.patch(&p.id, p.revision, super::super::Edit {
            name: edited.name.clone(), layers: edited.layers.clone(),
            canvas: edited.canvas.clone(), output: edited.output.clone(),
        }).unwrap();
        assert_eq!(m.positions.lock().unwrap()[&key].view.phase, "stopped");
        m.control_positions(&p.id, None, true).unwrap();
        assert_eq!(m.positions.lock().unwrap()[&format!("{}:v2", p.id)].view.phase, "stopped");
        assert_eq!(m.snapshot().projects[0].layers[0].clips[0].start_ms, edited.layers[0].clips[0].start_ms);
        let restored = Workshop::open(state, &legacy).unwrap();
        restored.prepare_positions(&p.id).unwrap();
        assert_eq!(restored.positions.lock().unwrap()[&key].view.phase, "stopped");
        let _slots2 = restored.analysis_slots.acquire_many(restored.analysis_slots.available_permits() as u32).await.unwrap();
        restored.control_positions(&p.id, Some("v"), false).unwrap();
        assert_eq!(restored.positions.lock().unwrap()[&key].view.phase, "analyzing");
        assert_eq!(restored.positions.lock().unwrap()[&format!("{}:v2", p.id)].view.phase, "stopped");
        assert!(!restored.journal.lock().unwrap().pending_positions.contains_key(&key));
        use tower::ServiceExt;
        let response = super::super::routes::router(restored.clone())
            .with_state(restored.state.clone())
            .oneshot(axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/workshop/{}/positions/control", p.id))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"stopped":true}"#)).unwrap())
            .await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["items"].as_array().unwrap().iter()
            .filter(|v| v["layer_id"] != "a").all(|v| v["phase"] == "stopped"));
        m.cancel_positions(&p.id);
        restored.cancel_positions(&p.id);
        tokio::task::yield_now().await;
    }
    #[test]
    fn manual_timing_edits_cancel_auto_placement_but_effects_and_output_do_not() {
        let p = super::super::naming::music_project();
        let key = format!("{}:v", p.id);
        let pending = HashMap::from([(key.clone(), layout_key(&p.layers[0]).unwrap())]);
        let mut changed = p.clone();
        changed.layers[0].clips[0].picture.opacity = 0.4;
        changed.layers[0].clips[0].sound.gain = 0.6;
        changed.output.name = "批量成片".into();
        let mut retained = pending.clone();
        retain_pending_after_edit(&mut retained, &p, &changed).unwrap();
        assert!(retained.contains_key(&key));
        for target in 0..2 {
            let mut changed = p.clone();
            changed.layers[target].clips[0].start_ms += 100.;
            let mut retained = pending.clone();
            retain_pending_after_edit(&mut retained, &p, &changed).unwrap();
            assert!(
                retained.is_empty(),
                "editing either video or reference cancels automatic placement"
            );
        }
        let mut changed = p.clone();
        changed.layers.remove(0);
        let mut retained = pending;
        retain_pending_after_edit(&mut retained, &p, &changed).unwrap();
        assert!(retained.is_empty());
    }
    #[test]
    fn music_is_only_the_reference_regardless_of_visual_layer_order() {
        let mut p = super::super::naming::music_project();
        assert!(reference(&p, &p.layers[1]).is_none());
        assert_eq!(reference(&p, &p.layers[0]).unwrap().id, "clip-a");
        p.layers.reverse();
        assert!(reference(&p, &p.layers[0]).is_none());
        assert_eq!(reference(&p, &p.layers[1]).unwrap().id, "clip-a");
        // Even a very short music clip must not make another video the authority.
        p.layers[0].clips[0].source_out_ms = 3000.;
        assert!(reference(&p, &p.layers[1]).is_none());
    }

    fn layer() -> Layer {
        Layer {
            id: "row".into(),
            source_id: "source".into(),
            clips: vec![Clip {
                display_duration_ms: None,
                animation_offset_ms: 0.,
                id: "clip".into(),
                source_id: "source".into(),
                start_ms: 0.,
                source_in_ms: 0.,
                source_out_ms: 100000.,
                speed: Speed::normal(100000.),
                picture: Picture::default(),
                sound: Sound {
                    muted: true,
                    gain: 0.7,
                    manual: true,
                },
                fades: Fades::new(100000., true),
            }],
        }
    }
    #[test]
    fn remix_choice_applies_all_cuts_and_preserves_repeated_occurrence_edits() {
        let base = layer();
        let parts: Vec<_> = [
            (60000., 80000., 0.),
            (10000., 25000., 22000.),
            (60000., 80000., 40000.),
        ]
        .into_iter()
        .map(|(lo, hi, start)| Placement {
            clip_id: "clip".into(),
            source_in_ms: lo,
            source_out_ms: hi,
            start_ms: start,
            speed_multiplier: Some(if start == 40000. { 1.10 } else { 1.05 }),
        })
        .collect();
        let presets = make_remix_presets(&base, parts);
        assert_eq!(
            presets.len(),
            1,
            "one complete plan, not mutually replacing single sections"
        );
        assert_eq!(presets[0].placements.len(), 3);
        let origins = HashMap::from([("clip".into(), "clip".into())]);
        let (clips, origins) = apply_preset(&base, &base, &presets[0], &origins).unwrap();
        assert_eq!(clips.len(), 3);
        assert_eq!(
            clips.iter().map(|c| c.start_ms).collect::<Vec<_>>(),
            vec![0., 22000., 40000.]
        );
        let mut edited = Layer {
            clips,
            ..base.clone()
        };
        edited.clips[2].picture.opacity = 0.3;
        let (again, _) = apply_preset(&base, &edited, &presets[0], &origins).unwrap();
        assert_eq!(
            again, edited.clips,
            "reapplying keeps each repeated occurrence and its effects"
        );
        let restored_base: Layer =
            serde_json::from_slice(&serde_json::to_vec(&base).unwrap()).unwrap();
        let restored: Layer =
            serde_json::from_slice(&serde_json::to_vec(&edited).unwrap()).unwrap();
        let restored_origins = restored
            .clips
            .iter()
            .map(|c| {
                let original =
                    basis_clip(&restored_base, c).expect("keep full source after restarting");
                assert_eq!(
                    (original.source_in_ms, original.source_out_ms),
                    (0., 100000.)
                );
                (c.id.clone(), original.id.clone())
            })
            .collect();
        let (again, _) =
            apply_preset(&restored_base, &restored, &presets[0], &restored_origins).unwrap();
        assert_eq!(again, restored.clips);
    }
    #[test]
    fn maximum_match_retains_all_source_material_after_switching_from_cut() {
        for original_speed in [0.75, 1., 1.25] {
            let mut base = layer();
            let c = &mut base.clips[0];
            c.speed.start = original_speed;
            c.speed.middle = original_speed;
            c.speed.end = original_speed;
            c.fades = Fades::new(c.duration(), true);
            let match_span = Placement {
                clip_id: "clip".into(),
                source_in_ms: 20000.,
                source_out_ms: 80000.,
                start_ms: 30000.,
                speed_multiplier: Some(0.985),
            };
            let choices = make_presets(&base, &[match_span.clone()]);
            assert_eq!(choices.len(), 2, "even one match offers keep and cut");
            assert_eq!(choices[0].placements[0].source_in_ms, 0.);
            assert_eq!(choices[0].placements[0].source_out_ms, 100000.);
            let origins = HashMap::from([("clip".into(), "clip".into())]);
            let (cut, origins) = apply_preset(&base, &base, &choices[1], &origins).unwrap();
            assert_eq!(cut[0].source_in_ms, 20000.);
            assert_eq!(cut[0].source_out_ms, 80000.);
            let current = Layer {
                clips: cut,
                ..base.clone()
            };
            let (full, origins) = apply_preset(&base, &current, &choices[0], &origins).unwrap();
            assert_eq!(full.first().unwrap().source_in_ms, 0.);
            assert_eq!(full.last().unwrap().source_out_ms, 100000.);
            let rate = original_speed * 0.985;
            assert!((full.iter().map(Clip::duration).sum::<f64>() - 100000. / rate).abs() < 0.001);
            for c in &full {
                assert_eq!(c.speed.start, rate);
                assert!(c.fades.offset_ms + c.duration() <= c.fades.span_ms + 0.01);
            }
            for pair in full.windows(2) {
                assert_eq!(pair[0].source_out_ms, pair[1].source_in_ms);
                assert!((pair[0].start_ms + pair[0].duration() - pair[1].start_ms).abs() < 0.001);
            }
            assert!((full[0].start_ms + 20000. / rate - match_span.start_ms).abs() < 0.001);
            let current = Layer {
                clips: full.clone(),
                ..base.clone()
            };
            let (again, _) = apply_preset(&base, &current, &choices[0], &origins).unwrap();
            assert_eq!(
                again, full,
                "reapplying must not compound speed or split again"
            );
        }
    }
    #[test]
    fn full_video_before_music_adds_leading_time_without_trimming_or_losing_alignment() {
        let mut p = super::super::naming::music_project();
        let base = p.layers[0].clone();
        let mut choices = make_presets(
            &base,
            &[Placement {
                clip_id: "clip-v".into(),
                source_in_ms: 20000.,
                source_out_ms: 80000.,
                start_ms: 5000.,
                speed_multiplier: Some(0.985),
            }],
        );
        p.output.in_ms = 1000.;
        p.output.out_ms = Some(20000.);
        let origins = HashMap::from([("clip-v".into(), "clip-v".into())]);
        let (full, origins) = apply_preset(&base, &base, &choices[0], &origins).unwrap();
        p.layers[0].clips = full;
        let shift = retain_leading_material(&mut p);
        assert!(shift > 0.);
        assert_eq!(p.layers[0].clips[0].source_in_ms, 0.);
        assert_eq!(p.layers[0].clips[0].source_out_ms, 90000.);
        assert_eq!(p.layers[0].clips[0].start_ms, 0.);
        assert_eq!(p.layers[1].clips[0].start_ms, shift);
        assert!((p.layers[0].clips[0].output_at(20000.) - shift - 5000.).abs() < 0.001);
        assert_eq!(p.output.in_ms, 1000. + shift);
        assert_eq!(p.output.out_ms, Some(20000. + shift));
        assert_eq!(p.validate(), Ok(()));
        for choice in &mut choices {
            for placement in &mut choice.placements {
                placement.start_ms += shift;
            }
        }
        let (cut, origins) = apply_preset(&base, &p.layers[0], &choices[1], &origins).unwrap();
        p.layers[0].clips = cut;
        assert!(
            (p.layers[0].clips[0].start_ms - p.layers[1].clips[0].start_ms - 5000.).abs() < 0.001
        );
        let (full, _) = apply_preset(&base, &p.layers[0], &choices[0], &origins).unwrap();
        p.layers[0].clips = full;
        assert_eq!(retain_leading_material(&mut p), 0.);
        assert_eq!(p.validate(), Ok(()));
    }
    #[test]
    fn switching_to_a_longer_match_restores_the_source_envelope() {
        let mut p = super::super::naming::music_project();
        let base = layer();
        p.sources.truncate(1);
        p.sources[0].id = base.source_id.clone();
        p.sources[0].duration_ms = 100000.;
        let mut current = base.clone();
        current.clips[0].source_out_ms = 78000.;
        current.clips[0].fades = Fades::new(78000., true);
        current.clips[0].fades.video_out_ms = 1200.;
        p.layers = vec![current.clone()];
        assert_eq!(p.validate(), Ok(()));

        // A fresh matching basis may be reconstructed from an already trimmed clip.
        let restored_base = source_basis(&p, &current);
        assert_eq!(restored_base.clips[0].fades.span_ms, 100000.);
        let origins = HashMap::from([("clip".into(), "clip".into())]);
        let preset = PositionPreset {
            id: "longer".into(),
            label: "longer".into(),
            prerequisite: None,
            placements: vec![Placement {
                clip_id: "clip".into(),
                source_in_ms: 0.,
                source_out_ms: 90000.,
                start_ms: 1000.,
                speed_multiplier: Some(0.985),
            }],
        };
        let (clips, origins) = apply_preset(&restored_base, &current, &preset, &origins).unwrap();
        assert_eq!(clips.len(), 2);
        assert!((clips[0].fades.video_out_ms - 1200. / 0.985).abs() < 0.001);
        assert!((clips[1].fades.span_ms - 100000. / 0.985).abs() < 0.001);
        assert!((clips[0].start_ms + clips[0].duration() - clips[1].start_ms).abs() < 0.001);
        p.layers[0].clips = clips;
        assert_eq!(p.validate(), Ok(()));
        let (again, _) = apply_preset(&restored_base, &p.layers[0], &preset, &origins).unwrap();
        p.layers[0].clips = again;
        assert_eq!(p.validate(), Ok(()), "reapplying preserves valid envelopes");
    }
    #[test]
    fn speed_suggestion_scales_time_and_effects_without_compounding_on_reapply() {
        let base = layer();
        let preset = PositionPreset {
            id: "speed".into(),
            label: "speed".into(),
            prerequisite: None,
            placements: vec![Placement {
                clip_id: "clip".into(),
                source_in_ms: 20000.,
                source_out_ms: 80000.,
                start_ms: 30000.,
                speed_multiplier: Some(0.985),
            }],
        };
        let origins = HashMap::from([("clip".into(), "clip".into())]);
        let (first, origins) = apply_preset(&base, &base, &preset, &origins).unwrap();
        assert_eq!(first[0].speed.start, 0.985);
        assert!((first[0].duration() - 60000. / 0.985).abs() < 0.001);
        assert_eq!(first[0].start_ms, 30000.);
        assert_eq!(first[0].sound, base.clips[0].sound);
        assert!((first[0].fades.offset_ms - 20000. / 0.985).abs() < 0.001);
        let current = Layer {
            clips: first.clone(),
            ..base.clone()
        };
        let (second, origins) = apply_preset(&base, &current, &preset, &origins).unwrap();
        assert_eq!(first, second);
        let normal = PositionPreset {
            placements: vec![Placement {
                speed_multiplier: None,
                ..preset.placements[0].clone()
            }],
            ..preset.clone()
        };
        let (restored, _) = apply_preset(&base, &current, &normal, &origins).unwrap();
        assert_eq!(restored[0].speed.start, 1.);
        assert!((restored[0].fades.offset_ms - 20000.).abs() < 0.001);
    }
    #[test]
    fn split_effect_edits_survive_speed_adaptation_with_contiguous_timing() {
        let base = layer();
        let mut current = base.clone();
        current.clips[0].source_out_ms = 50000.;
        let mut second = base.clips[0].clone();
        second.id = "split".into();
        second.source_in_ms = 50000.;
        second.picture.opacity = 0.4;
        second.fades.offset_ms = 50000.;
        current.clips.push(second);
        let origins = HashMap::from([
            ("clip".into(), "clip".into()),
            ("split".into(), "clip".into()),
        ]);
        let preset = PositionPreset {
            id: "speed".into(),
            label: "speed".into(),
            prerequisite: None,
            placements: vec![Placement {
                clip_id: "clip".into(),
                source_in_ms: 20000.,
                source_out_ms: 80000.,
                start_ms: 30000.,
                speed_multiplier: Some(0.985),
            }],
        };
        let (clips, _) = apply_preset(&base, &current, &preset, &origins).unwrap();
        assert_eq!(clips.len(), 2);
        assert!((clips[0].start_ms + clips[0].duration() - clips[1].start_ms).abs() < 0.001);
        assert_eq!(clips[1].picture.opacity, 0.4);
        assert!((clips[1].fades.offset_ms - 50000. / 0.985).abs() < 0.001);
    }
}
