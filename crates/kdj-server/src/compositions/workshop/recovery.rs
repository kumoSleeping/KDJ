use super::*;

fn empty() -> Journal {
    Journal { version: 1, revision: 0, projects: vec![], jobs: vec![], migrated: vec![], checked_video_geometry: HashSet::new(),
        position_bases: HashMap::new(), pending_positions: HashMap::new(), stopped_positions: HashSet::new(), recovery_error: String::new() }
}

/// 记录里存在、但本次序列化写不出来的键路径。只比较结构与键名，
/// 因此数字写法（`0` / `0.0`）和键序都不会误报。
fn dropped_keys(raw: &serde_json::Value, written: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    match (raw, written) {
        (serde_json::Value::Object(found), serde_json::Value::Object(kept)) => {
            for (key, value) in found {
                let child = format!("{path}.{key}");
                match kept.get(key) {
                    Some(other) => dropped_keys(value, other, &child, out),
                    None => out.push(child),
                }
            }
        }
        (serde_json::Value::Array(found), serde_json::Value::Array(kept)) => {
            for (index, (value, other)) in found.iter().zip(kept).enumerate() {
                dropped_keys(value, other, &format!("{path}[{index}]"), out);
            }
            if found.len() > kept.len() {
                out.push(format!("{path}[{}..]", kept.len()));
            }
        }
        _ => {}
    }
}

/// 这份记录原样读进来，再用当前结构写出去，会不会丢掉别的版本写进去的字段？
/// 会的话就必须停写：旧版本没有 `crop_auto_fit` 时每次打开都会把它从整份记录里抹掉。
fn write_back_loss(bytes: &[u8], journal: &Journal) -> Vec<String> {
    let (Ok(raw), Ok(written)) = (
        serde_json::from_slice::<serde_json::Value>(bytes),
        serde_json::to_value(journal),
    ) else {
        return Vec::new();
    };
    let mut dropped = Vec::new();
    dropped_keys(&raw, &written, "", &mut dropped);
    dropped.truncate(8);
    dropped
}

pub(super) fn read_journal(path: &Path) -> (Journal, bool) {
    let loaded = (|| -> Result<(Journal, Vec<String>)> {
        match std::fs::read(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((empty(), Vec::new())),
            value => {
                let bytes = value?;
                let journal: Journal = serde_json::from_slice(&bytes)?;
                if journal.version != 1 { bail!("工程版本不支持：{}", journal.version) }
                let dropped = write_back_loss(&bytes, &journal);
                Ok((journal, dropped))
            }
        }
    })();
    match loaded {
        Ok((journal, dropped)) if dropped.is_empty() => (journal, true),
        Ok((mut journal, dropped)) => {
            journal.recovery_error = format!(
                "这份剪辑工程记录里有当前版本不认识的字段（{}），已停止写回，原文件 {} 未被改动；请用写入它的那个版本打开",
                dropped.join("、"),
                path.display()
            );
            (journal, false)
        }
        Err(error) => {
            let mut journal = empty();
            let backup = path.with_extension(format!("corrupt-{}", id()));
            match std::fs::rename(path, &backup) {
                Ok(()) => {
                    journal.recovery_error = format!("剪辑工程记录无法读取，已保留在 {}：{error:#}", backup.display());
                    (journal, true)
                }
                Err(backup_error) => {
                    journal.recovery_error = format!("剪辑工程记录无法读取，原文件 {} 已保留；请检查目录权限后重启：{error:#}；{backup_error}", path.display());
                    (journal, false)
                }
            }
        }
    }
}

/// 工程记录是用户的长期资产，覆盖前必须先留副本。
/// `auto/` 保留最近若干份十分钟粒度的快照，`daily/` 每天留一份，避免一次误写就永久丢稿。
/// 只写新文件、不删别人的备份；返回是否真的落了一份新快照。
pub(super) fn auto_snapshot(
    path: &Path,
    min_gap: std::time::Duration,
    keep: usize,
) -> Result<bool> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => return Ok(false),
    };
    let base = path.parent().context("工程记录缺少数据目录")?.join("workshop-backups");
    let auto = base.join("auto");
    std::fs::create_dir_all(&auto)?;
    let snapshots = |directory: &Path| -> Vec<(String, PathBuf)> {
        let Ok(entries) = std::fs::read_dir(directory) else { return Vec::new() };
        let mut found = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                (name.starts_with("vj-projects-") && name.ends_with(".json"))
                    .then(|| (name, entry.path()))
            })
            .collect::<Vec<_>>();
        found.sort();
        found
    };
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();
    let write = |target: &Path| -> Result<()> {
        let temp = target.with_extension("json.tmp");
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)?;
        Ok(())
    };
    let mut wrote = false;
    let existing = snapshots(&auto);
    let newest = existing.last().map(|(_, path)| path.clone());
    let current = match newest.as_ref().map(|path| std::fs::read(path)) {
        Some(Ok(previous)) => previous == bytes,
        _ => false,
    };
    let recent = newest
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .is_some_and(|modified| {
            std::time::SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age < min_gap)
        });
    if !current && !recent {
        write(&auto.join(format!("vj-projects-{stamp}.json")))?;
        wrote = true;
    }
    for (_, stale) in snapshots(&auto).into_iter().rev().skip(keep) {
        let _ = std::fs::remove_file(stale);
    }
    let daily = base.join("daily");
    std::fs::create_dir_all(&daily)?;
    let today = daily.join(format!("vj-projects-{}.json", chrono::Local::now().format("%Y%m%d")));
    if !today.exists() {
        write(&today)?;
        wrote = true;
    }
    for (_, stale) in snapshots(&daily).into_iter().rev().skip(60) {
        let _ = std::fs::remove_file(stale);
    }
    Ok(wrote)
}

/** Only remove an explicitly registered, nonsymlink directory with this job's marker. */
pub(super) fn clean_staging(job: &mut Job) -> Result<()> {
    let Some(raw) = &job.staging else { return Ok(()) };
    let path = Path::new(raw);
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { job.staging = None; return Ok(()) },
        metadata => {
            let metadata = metadata?;
            if !metadata.is_dir() || metadata.file_type().is_symlink()
                || path.file_name().and_then(|n| n.to_str()) != Some(format!(".kdj-composition-vj-{}", job.id).as_str()) {
                bail!("暂存目录归属无法确认：{}", path.display())
            }
        }
    }
    let owner = path.join(".owner");
    let metadata = std::fs::symlink_metadata(&owner)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != job.id.len() as u64
        || std::fs::read_to_string(&owner)? != job.id {
        bail!("暂存目录归属无法确认：{}", path.display())
    }
    std::fs::remove_dir_all(path)?;
    job.staging = None;
    Ok(())
}

impl Workshop {
    pub fn acknowledge_recovery(&self) -> Result<Snapshot> {
        self.change(|journal| { journal.recovery_error.clear(); Ok(()) })
    }

    pub fn discard_receipt(&self, jid: &str) -> Result<Snapshot> {
        if self.jobs.lock().unwrap().contains_key(jid) { bail!("请等待导出结束") }
        self.change(|journal| {
            let job = journal.jobs.iter_mut().find(|j| j.id == jid).context("导出记录不存在")?;
            if job.phase != "import_failed" { bail!("只有入库失败的成品可以放弃回执") }
            // Never delete a published file. This only releases the old receipt's export lock.
            job.phase = "canceled".into(); job.signature = None; job.path.clear();
            job.error.clear(); job.detail.clear(); job.progress = 0.;
            Ok(())
        })
    }
}
