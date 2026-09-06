use super::*;
use std::collections::HashSet;
#[derive(Deserialize)]
pub struct Intake {
    pub project_id: Option<String>,
    pub revision: Option<u64>,
    #[serde(default)]
    pub track_ids: Vec<i64>,
    #[serde(default)]
    pub paths: Vec<String>,
    pub at_ms: f64,
}
#[derive(Serialize)]
pub struct IntakeResult {
    pub snapshot: Snapshot,
    pub before: Option<CompositionProject>,
    pub project_id: Option<String>,
    pub errors: Vec<String>,
}
impl Workshop {
    pub async fn intake(self: &Arc<Self>, input: Intake) -> Result<IntakeResult> {
        if input.paths.len() + input.track_ids.len() > 500
            || !input.at_ms.is_finite()
            || input.at_ms < 0.
        {
            bail!("素材或落点无效")
        }
        let mut before = input
            .project_id
            .as_ref()
            .map(|id| self.project(id, input.revision.unwrap_or(0)))
            .transpose()?;
        let mut errors = vec![];
        let mut ids = vec![];
        let mut seen = HashSet::new();
        let mut entries: Vec<(String, Option<i64>)> = vec![];
        for id in input.track_ids {
            match self.state.library.get(id)? {
                Some(t) => entries.push((t.path, Some(id))),
                None => errors.push(format!("素材 {id} 不存在")),
            }
        }
        entries.extend(input.paths.into_iter().map(|p| (p, None)));
        for (raw, tid) in entries {
            let prepared: Result<(PathBuf, i64)> = async {
                let path = std::fs::canonicalize(&raw).context("文件不存在或无法读取")?;
                if !path.is_file() {
                    bail!("请拖入本地文件")
                }
                if !seen.insert(path.clone()) {
                    return Ok((path, -1));
                }
                let duration = if kdj_providers::workshop_images::is_image_path(&path) {
                    let p = path.clone();
                    tokio::task::spawn_blocking(move || {
                        kdj_providers::workshop_images::inspect(&p)
                    })
                    .await??;
                    5000.
                } else {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if !kdj_providers::tags::is_media_extension(ext) {
                        bail!("不支持此素材格式")
                    }
                    let probe = media::probe(&path, &CancellationToken::new()).await?;
                    probe.check(probe.video().is_some())? as f64
                };
                if duration <= 0. || input.at_ms + duration > 21_600_000. {
                    bail!("素材放入后超过作品六小时上限")
                }
                let existing_layers = before.as_ref().map_or(0, |p| p.layers.len());
                let existing_clips = before
                    .as_ref()
                    .map_or(0, |p| p.layers.iter().map(|l| l.clips.len()).sum::<usize>());
                if existing_layers + ids.len() >= 1000 || existing_clips + ids.len() >= 5000 {
                    bail!("作品素材数量超出范围")
                }
                let id = if let Some(id) = tid {
                    id
                } else {
                    let library = self.state.library.clone();
                    let p = path.clone();
                    tokio::task::spawn_blocking(move || library.upsert_file(&p, "local", ""))
                        .await??
                };
                Ok((path, id))
            }
            .await;
            match prepared {
                Ok((_, id)) if id >= 0 => ids.push(id),
                Ok(_) => {}
                Err(e) => errors.push(format!("{raw}：{e:#}")),
            }
        }
        if ids.is_empty() {
            return Ok(IntakeResult {
                snapshot: self.snapshot(),
                before: None,
                project_id: input.project_id,
                errors,
            });
        }
        self.state
            .hub
            .publish("library.updated", &serde_json::json!({"track_ids": ids}));
        let created = before.is_none();
        if created {
            before = self.create()?.projects.last().cloned();
        }
        let p = before.as_ref().context("无法创建任务")?;
        match self.add(&p.id, p.revision, &ids, input.at_ms).await {
            Ok(snapshot) => Ok(IntakeResult {
                snapshot,
                project_id: Some(p.id.clone()),
                before,
                errors,
            }),
            Err(error) => {
                if created {
                    let _ = self.delete(&p.id, p.revision);
                }
                Err(error)
            }
        }
    }
}
