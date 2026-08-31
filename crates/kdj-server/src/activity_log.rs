//! 面向用户的操作审计日志。
//!
//! 与开发期 `tracing` 不同，这里的内容会显示在设置页：只记录用户能理解的动作、
//! 真实平台请求，以及分析的警告/错误。前端先做短时去重并批量提交；这里再通过
//! 有界通道顺序落盘，业务请求永远不会等待日志磁盘 I/O。

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

const LOG_DIR_NAME: &str = "activity-logs";
const SETTINGS_FILE_NAME: &str = "activity-log-settings.json";
const MEMORY_ENTRY_LIMIT: usize = 2_000;
const QUERY_LIMIT_MAX: usize = 500;
const INGEST_BATCH_MAX: usize = 100;
const MAX_ACTION_CHARS: usize = 80;
const MAX_DETAIL_CHARS: usize = 240;
const MAX_TARGET_CHARS: usize = 160;
const MAX_LOG_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES: u64 = 128 * 1024 * 1024;
const LOAD_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const WRITER_QUEUE_CAPACITY: usize = 256;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(15 * 60);
const CLEANUP_AFTER_WRITTEN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityCategory {
    Network,
    Analysis,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityLogEntry {
    pub id: u64,
    pub timestamp: String,
    pub category: ActivityCategory,
    pub level: ActivityLevel,
    pub action: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default = "one")]
    pub count: u32,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityLogDraft {
    pub category: ActivityCategory,
    #[serde(default = "info_level")]
    pub level: ActivityLevel,
    pub action: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default = "one")]
    pub count: u32,
}

fn info_level() -> ActivityLevel {
    ActivityLevel::Info
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityLogBatch {
    pub entries: Vec<ActivityLogDraft>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityLogSettings {
    /// 0 表示不按日期自动清理；仍受 128 MiB 的安全上限保护。
    pub retention_days: u32,
}

impl Default for ActivityLogSettings {
    fn default() -> Self {
        Self { retention_days: 30 }
    }
}

impl ActivityLogSettings {
    fn validate(self) -> Result<Self> {
        if matches!(self.retention_days, 0 | 1 | 7 | 14 | 30 | 90) {
            Ok(self)
        } else {
            bail!("日志自动清理周期无效")
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityLogOverview {
    pub entries: Vec<ActivityLogEntry>,
    pub network_last_minute: u64,
    pub network_last_hour: u64,
    pub excessive: bool,
    pub dropped: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ActivityDiskStats {
    pub files: u64,
    pub bytes: u64,
    pub recent_entries: u64,
}

enum WriterCommand {
    Append(Vec<ActivityLogEntry>),
    Flush(mpsc::Sender<()>),
    Clear(mpsc::Sender<std::result::Result<(), String>>),
    Settings(
        ActivityLogSettings,
        mpsc::Sender<std::result::Result<(), String>>,
    ),
}

#[derive(Clone)]
pub struct ActivityLog {
    data_dir: Arc<PathBuf>,
    entries: Arc<Mutex<VecDeque<ActivityLogEntry>>>,
    settings: Arc<RwLock<ActivityLogSettings>>,
    next_id: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    writer: mpsc::SyncSender<WriterCommand>,
}

impl ActivityLog {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let initial_settings = load_settings(&data_dir);
        cleanup_files(&data_dir, initial_settings)?;
        let loaded = load_recent_entries(&data_dir)?;
        let next_id = loaded
            .iter()
            .map(|entry| entry.id)
            .max()
            .unwrap_or_default()
            .saturating_add(1);
        let entries = Arc::new(Mutex::new(loaded.into()));
        let settings = Arc::new(RwLock::new(initial_settings));
        let (writer, receiver) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let writer_data_dir = data_dir.clone();
        std::thread::Builder::new()
            .name("kdj-activity-log".into())
            .spawn(move || writer_loop(&writer_data_dir, initial_settings, receiver))
            .context("启动日志写入线程失败")?;
        Ok(Self {
            data_dir: Arc::new(data_dir),
            entries,
            settings,
            next_id: Arc::new(AtomicU64::new(next_id)),
            dropped: Arc::new(AtomicU64::new(0)),
            writer,
        })
    }

    pub fn settings(&self) -> ActivityLogSettings {
        *self
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_settings(&self, settings: ActivityLogSettings) -> Result<ActivityLogSettings> {
        let settings = settings.validate()?;
        let (done, completed) = mpsc::channel();
        self.writer
            .send(WriterCommand::Settings(settings, done))
            .context("日志写入线程已停止")?;
        completed
            .recv_timeout(Duration::from_secs(5))
            .context("保存日志设置超时")?
            .map_err(anyhow::Error::msg)?;
        *self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
        Ok(settings)
    }

    /// 业务线程只做定长字符串清洗、内存入队和 `try_send`；磁盘慢时宁可丢日志，
    /// 也绝不反压搜索、下载或播放器。
    pub fn record(&self, draft: ActivityLogDraft) -> bool {
        self.record_batch(vec![draft]) > 0
    }

    pub fn record_batch(&self, drafts: Vec<ActivityLogDraft>) -> usize {
        let now = Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut batch = Vec::with_capacity(drafts.len().min(INGEST_BATCH_MAX));
        for draft in drafts.into_iter().take(INGEST_BATCH_MAX) {
            // 双层保险：即使未来某个前端钩子误把逐曲成功事件送来，后端也拒绝
            // 保存分析 info，避免大曲库把日志写成另一份分析数据库。
            if draft.category == ActivityCategory::Analysis && draft.level == ActivityLevel::Info {
                continue;
            }
            let action = clean_text(&draft.action, MAX_ACTION_CHARS);
            if action.is_empty() {
                continue;
            }
            let entry = ActivityLogEntry {
                id: self.next_id.fetch_add(1, Ordering::Relaxed),
                timestamp: now.clone(),
                category: draft.category,
                level: draft.level,
                action,
                detail: redact_sensitive(clean_text(&draft.detail, MAX_DETAIL_CHARS)),
                target: clean_target(&draft.target),
                status: draft.status,
                duration_ms: draft
                    .duration_ms
                    .map(|value| value.min(24 * 60 * 60 * 1_000)),
                count: draft.count.clamp(1, 10_000),
            };
            batch.push(entry);
        }
        if batch.is_empty() {
            return 0;
        }
        {
            // 内存窗口和写入命令在同一把锁内排定先后；这样“清理”不会与一条
            // 刚入内存、尚未入通道的记录交错，造成界面已空但磁盘稍后又冒出旧行。
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            entries.extend(batch.iter().cloned());
            while entries.len() > MEMORY_ENTRY_LIMIT {
                entries.pop_front();
            }
            if self
                .writer
                .try_send(WriterCommand::Append(batch.clone()))
                .is_err()
            {
                self.dropped
                    .fetch_add(batch.len() as u64, Ordering::Relaxed);
            }
        }
        batch.len()
    }

    pub fn record_analysis_warning(&self, action: impl Into<String>, detail: impl Into<String>) {
        self.record_level(
            ActivityCategory::Analysis,
            ActivityLevel::Warn,
            action,
            detail,
        );
    }

    pub fn record_level(
        &self,
        category: ActivityCategory,
        level: ActivityLevel,
        action: impl Into<String>,
        detail: impl Into<String>,
    ) {
        self.record(ActivityLogDraft {
            category,
            level,
            action: action.into(),
            detail: detail.into(),
            target: String::new(),
            status: None,
            duration_ms: None,
            count: 1,
        });
    }

    pub fn overview(
        &self,
        category: Option<ActivityCategory>,
        limit: usize,
    ) -> ActivityLogOverview {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Utc::now();
        let minute_ago = now - chrono::Duration::minutes(1);
        let hour_ago = now - chrono::Duration::hours(1);
        let mut last_minute = 0_u64;
        let mut last_hour = 0_u64;
        for entry in entries
            .iter()
            .filter(|entry| entry.category == ActivityCategory::Network)
        {
            let Ok(stamp) = DateTime::parse_from_rfc3339(&entry.timestamp) else {
                continue;
            };
            let stamp = stamp.with_timezone(&Utc);
            if stamp >= hour_ago {
                last_hour = last_hour.saturating_add(u64::from(entry.count));
            }
            if stamp >= minute_ago {
                last_minute = last_minute.saturating_add(u64::from(entry.count));
            }
        }
        let entries = entries
            .iter()
            .rev()
            .filter(|entry| category.is_none_or(|value| entry.category == value))
            .take(limit.clamp(1, QUERY_LIMIT_MAX))
            .cloned()
            .collect();
        ActivityLogOverview {
            entries,
            network_last_minute: last_minute,
            network_last_hour: last_hour,
            excessive: last_minute > 120 || last_hour > 1_000,
            dropped: self.dropped.load(Ordering::Relaxed),
        }
    }

    pub fn clear(&self) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (done, completed) = mpsc::channel();
        self.writer
            .send(WriterCommand::Clear(done))
            .context("日志写入线程已停止")?;
        completed
            .recv_timeout(Duration::from_secs(5))
            .context("清理日志超时")?
            .map_err(anyhow::Error::msg)?;
        entries.clear();
        self.dropped.store(0, Ordering::Relaxed);
        Ok(())
    }

    /// 仅供应用即将重启等极少数边界使用；普通业务记录始终保持非阻塞。
    pub fn flush(&self) -> Result<()> {
        let (done, completed) = mpsc::channel();
        self.writer
            .send(WriterCommand::Flush(done))
            .context("日志写入线程已停止")?;
        completed
            .recv_timeout(Duration::from_secs(5))
            .context("等待日志写盘超时")?;
        Ok(())
    }

    pub fn disk_stats(&self) -> ActivityDiskStats {
        let mut stats = scan_log_files(&self.data_dir);
        stats.recent_entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len() as u64;
        stats
    }

    pub fn log_dir(&self) -> PathBuf {
        self.data_dir.join(LOG_DIR_NAME)
    }

    pub fn owned_paths(&self) -> [PathBuf; 3] {
        [
            self.log_dir(),
            self.data_dir.join("kdj.log"),
            self.data_dir.join("kdj.log.1"),
        ]
    }
}

fn clean_text(raw: &str, max_chars: usize) -> String {
    raw.chars()
        .filter(|ch| !ch.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn redact_sensitive(value: String) -> String {
    let lower = value.to_ascii_lowercase();
    if ["authorization", "cookie", "password", "token=", "secret="]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        "[敏感信息已隐藏]".into()
    } else {
        value
    }
}

fn clean_target(raw: &str) -> String {
    let value = clean_text(raw, MAX_TARGET_CHARS);
    // 日志只需要站点/平台，不保留 URL 查询串、片段或用户信息。
    if let Ok(url) = reqwest::Url::parse(&value) {
        return url.host_str().unwrap_or_default().to_string();
    }
    let value = value
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();
    redact_sensitive(value)
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE_NAME)
}

fn load_settings(data_dir: &Path) -> ActivityLogSettings {
    fs::read(settings_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ActivityLogSettings>(&bytes).ok())
        .and_then(|settings| settings.validate().ok())
        .unwrap_or_default()
}

fn save_settings(data_dir: &Path, settings: ActivityLogSettings) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = settings_path(data_dir);
    let temporary = data_dir.join(format!(
        ".{SETTINGS_FILE_NAME}.{:016x}.tmp",
        rand::random::<u64>()
    ));
    let bytes = serde_json::to_vec_pretty(&settings)?;
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &path)?;
    protect_file(&path);
    Ok(())
}

fn writer_loop(
    data_dir: &Path,
    mut settings: ActivityLogSettings,
    receiver: mpsc::Receiver<WriterCommand>,
) {
    let mut last_cleanup = std::time::Instant::now();
    let mut bytes_since_cleanup = 0_u64;
    loop {
        let timeout = CLEANUP_INTERVAL.saturating_sub(last_cleanup.elapsed());
        let command = match receiver.recv_timeout(timeout) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(error) = cleanup_files(data_dir, settings) {
                    tracing::warn!("自动清理用户日志失败：{error:#}");
                }
                last_cleanup = std::time::Instant::now();
                bytes_since_cleanup = 0;
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match command {
            WriterCommand::Append(entries) => match append_entries(data_dir, &entries) {
                Ok(bytes) => {
                    bytes_since_cleanup = bytes_since_cleanup.saturating_add(bytes);
                }
                Err(error) => tracing::warn!("写入用户日志失败：{error:#}"),
            },
            WriterCommand::Flush(done) => {
                // Append 每批都已 flush；通道顺序保证走到这里时此前记录已经落盘。
                let _ = done.send(());
            }
            WriterCommand::Clear(done) => {
                let result = clear_files(data_dir).map_err(|error| error.to_string());
                if result.is_ok() {
                    bytes_since_cleanup = 0;
                    last_cleanup = std::time::Instant::now();
                }
                let _ = done.send(result);
            }
            WriterCommand::Settings(next_settings, done) => {
                let result = save_settings(data_dir, next_settings)
                    .and_then(|()| cleanup_files(data_dir, next_settings))
                    .map_err(|error| error.to_string());
                if result.is_ok() {
                    settings = next_settings;
                    bytes_since_cleanup = 0;
                    last_cleanup = std::time::Instant::now();
                }
                let _ = done.send(result);
            }
        }
        if bytes_since_cleanup >= CLEANUP_AFTER_WRITTEN_BYTES
            || last_cleanup.elapsed() >= CLEANUP_INTERVAL
        {
            if let Err(error) = cleanup_files(data_dir, settings) {
                tracing::warn!("自动清理用户日志失败：{error:#}");
            }
            bytes_since_cleanup = 0;
            last_cleanup = std::time::Instant::now();
        }
    }
}

fn current_log_path(data_dir: &Path) -> PathBuf {
    let directory = data_dir.join(LOG_DIR_NAME);
    let date = Local::now().format("%Y-%m-%d");
    let base = directory.join(format!("activity-{date}.jsonl"));
    if fs::metadata(&base).is_ok_and(|metadata| metadata.len() >= MAX_LOG_FILE_BYTES) {
        for index in 1..10_000 {
            let candidate = directory.join(format!("activity-{date}-{index}.jsonl"));
            if !candidate.exists()
                || fs::metadata(&candidate)
                    .is_ok_and(|metadata| metadata.len() < MAX_LOG_FILE_BYTES)
            {
                return candidate;
            }
        }
    }
    base
}

fn append_entries(data_dir: &Path, entries: &[ActivityLogEntry]) -> Result<u64> {
    let directory = data_dir.join(LOG_DIR_NAME);
    fs::create_dir_all(&directory)?;
    let path = current_log_path(data_dir);
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    protect_file(&path);
    let mut buffer = Vec::with_capacity(entries.len().saturating_mul(192));
    for entry in entries {
        serde_json::to_writer(&mut buffer, entry)?;
        buffer.push(b'\n');
    }
    file.write_all(&buffer)?;
    file.flush()?;
    Ok(buffer.len() as u64)
}

fn protect_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

fn is_activity_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "jsonl")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("activity-"))
}

fn activity_files(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(data_dir.join(LOG_DIR_NAME)) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_activity_file(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn cleanup_files(data_dir: &Path, settings: ActivityLogSettings) -> Result<()> {
    let now = SystemTime::now();
    let mut files = activity_files(data_dir)
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            Some((
                path,
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified, _)| *modified);
    if settings.retention_days > 0 {
        let age = Duration::from_secs(u64::from(settings.retention_days) * 24 * 60 * 60);
        for (path, modified, _) in &files {
            if now
                .duration_since(*modified)
                .is_ok_and(|elapsed| elapsed > age)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    files.retain(|(path, _, _)| path.exists());
    let mut total = files.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
    for (path, _, bytes) in files {
        if total <= MAX_TOTAL_LOG_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
    Ok(())
}

fn clear_files(data_dir: &Path) -> Result<()> {
    let log_dir = data_dir.join(LOG_DIR_NAME);
    match fs::symlink_metadata(&log_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            fs::remove_file(&log_dir)?;
        }
        Ok(_) => fs::remove_dir_all(&log_dir)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for legacy in [data_dir.join("kdj.log"), data_dir.join("kdj.log.1")] {
        if fs::symlink_metadata(&legacy).is_ok_and(|metadata| metadata.is_file()) {
            let _ = fs::remove_file(legacy);
        }
    }
    Ok(())
}

fn load_recent_entries(data_dir: &Path) -> Result<Vec<ActivityLogEntry>> {
    let mut loaded = Vec::new();
    for path in activity_files(data_dir).into_iter().rev() {
        let file = File::open(&path)?;
        let length = file.metadata()?.len();
        let start = length.saturating_sub(LOAD_TAIL_BYTES);
        let mut reader = BufReader::new(file);
        if start > 0 {
            reader.seek(SeekFrom::Start(start))?;
            let mut partial = String::new();
            reader.read_line(&mut partial)?;
        }
        let mut file_entries = reader
            .lines()
            .map_while(std::result::Result::ok)
            .filter_map(|line| serde_json::from_str::<ActivityLogEntry>(&line).ok())
            .collect::<Vec<_>>();
        loaded.append(&mut file_entries);
        if loaded.len() >= MEMORY_ENTRY_LIMIT {
            break;
        }
    }
    loaded.sort_by_key(|entry| entry.id);
    if loaded.len() > MEMORY_ENTRY_LIMIT {
        loaded.drain(..loaded.len() - MEMORY_ENTRY_LIMIT);
    }
    Ok(loaded)
}

fn scan_log_files(data_dir: &Path) -> ActivityDiskStats {
    let mut stats = ActivityDiskStats::default();
    for path in activity_files(data_dir)
        .into_iter()
        .chain([data_dir.join("kdj.log"), data_dir.join("kdj.log.1")])
    {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                stats.files = stats.files.saturating_add(1);
                stats.bytes = stats.bytes.saturating_add(metadata.len());
            }
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kdj-activity-log-{name}-{:016x}",
            rand::random::<u64>()
        ))
    }

    #[test]
    fn records_filters_and_clears_without_logging_secrets() {
        let root = scratch("roundtrip");
        let log = ActivityLog::new(root.clone()).unwrap();
        assert!(log.record(ActivityLogDraft {
            category: ActivityCategory::Network,
            level: ActivityLevel::Info,
            action: "搜索 API".into(),
            detail: "token=should-not-survive".into(),
            target: "music.163.com?token=hidden".into(),
            status: Some(200),
            duration_ms: Some(18),
            count: 2,
        }));
        let overview = log.overview(Some(ActivityCategory::Network), 20);
        assert_eq!(overview.entries.len(), 1);
        assert_eq!(overview.entries[0].detail, "[敏感信息已隐藏]");
        assert_eq!(overview.entries[0].target, "music.163.com");
        assert_eq!(overview.network_last_minute, 2);
        log.clear().unwrap();
        assert!(log.overview(None, 20).entries.is_empty());
        assert_eq!(log.disk_stats().bytes, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn target_keeps_only_a_site_when_given_a_full_url() {
        assert_eq!(
            clean_target("https://user:password@example.com/private?q=secret#part"),
            "example.com"
        );
    }

    #[test]
    fn retention_values_are_bounded() {
        assert!(ActivityLogSettings { retention_days: 30 }
            .validate()
            .is_ok());
        assert!(ActivityLogSettings {
            retention_days: 365
        }
        .validate()
        .is_err());
    }

    #[test]
    fn successful_analysis_entries_are_rejected_at_the_storage_boundary() {
        let root = scratch("analysis-info");
        let log = ActivityLog::new(root.clone()).unwrap();
        assert!(!log.record(ActivityLogDraft {
            category: ActivityCategory::Analysis,
            level: ActivityLevel::Info,
            action: "逐曲分析完成".into(),
            detail: "不应保存".into(),
            target: String::new(),
            status: None,
            duration_ms: None,
            count: 10_000,
        }));
        assert!(log
            .overview(Some(ActivityCategory::Analysis), 20)
            .entries
            .is_empty());
        log.clear().unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
