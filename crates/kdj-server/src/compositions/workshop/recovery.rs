use super::*;

fn empty() -> Journal {
    Journal { version: 1, revision: 0, projects: vec![], jobs: vec![], migrated: vec![], checked_video_geometry: HashSet::new(),
        position_bases: HashMap::new(), pending_positions: HashMap::new(), stopped_positions: HashSet::new(), recovery_error: String::new() }
}

pub(super) fn read_journal(path: &Path) -> (Journal, bool) {
    let loaded = (|| -> Result<Journal> {
        match std::fs::read(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty()),
            value => {
                let journal: Journal = serde_json::from_slice(&value?)?;
                if journal.version != 1 { bail!("工程版本不支持：{}", journal.version) }
                Ok(journal)
            }
        }
    })();
    match loaded {
        Ok(journal) => (journal, true),
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
