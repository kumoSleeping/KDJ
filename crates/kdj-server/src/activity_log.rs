//! 面向用户的操作审计日志。
//!
//! 与开发期 `tracing` 不同，这里的内容会显示在设置页：只记录用户能理解的动作、
//! 真实平台请求，以及分析的警告/错误。前端先做短时去重并批量提交；这里再通过
//! 有界通道顺序落盘，业务请求永远不会等待日志磁盘 I/O。

use std::collections::{HashSet, VecDeque};
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
/// 前端把 ID 当作 JavaScript number；超过 2^53 - 1 后将失去整数精度。
const MAX_SAFE_ENTRY_ID: u64 = (1_u64 << 53) - 1;

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
        let loaded = load_recent_entries(&data_dir);
        let loaded_entries = loaded.len();
        let entries = Arc::new(Mutex::new(loaded.into()));
        let settings = Arc::new(RwLock::new(initial_settings));
        let (writer, receiver) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let writer_data_dir = data_dir.clone();
        std::thread::Builder::new()
            .name("kdj-activity-log".into())
            .spawn(move || writer_loop(&writer_data_dir, initial_settings, receiver))
            .context("启动日志写入线程失败")?;
        tracing::debug!(
            loaded_entries,
            retention_days = initial_settings.retention_days,
            queue_capacity = WRITER_QUEUE_CAPACITY,
            "用户活动日志已就绪"
        );
        Ok(Self {
            data_dir: Arc::new(data_dir),
            entries,
            settings,
            next_id: Arc::new(AtomicU64::new(random_entry_id())),
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
            let action = redact_sensitive(clean_text(&draft.action, MAX_ACTION_CHARS));
            if action.is_empty() {
                continue;
            }
            let entry = ActivityLogEntry {
                // 从随机种子开始的 53-bit 序列避免两个 KDJ 实例或热重启从同一个
                // 磁盘最大值续写；同一进程内保持严格递增，前端也能精确表示。
                id: next_entry_id(&self.next_id),
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
                let dropped = batch.len() as u64;
                let previous = self.dropped.fetch_add(dropped, Ordering::Relaxed);
                let total = previous.saturating_add(dropped);
                let next_report = previous
                    .saturating_add(1)
                    .checked_next_power_of_two()
                    .unwrap_or(u64::MAX);
                if previous == 0 || total >= next_report {
                    tracing::warn!(
                        dropped,
                        dropped_total = total,
                        queue_capacity = WRITER_QUEUE_CAPACITY,
                        "用户活动日志写入队列已满，记录只保留在本次运行的内存中"
                    );
                }
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

fn random_entry_id() -> u64 {
    (rand::random::<u64>() & MAX_SAFE_ENTRY_ID).max(1)
}

fn next_entry_id(counter: &AtomicU64) -> u64 {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(if current >= MAX_SAFE_ENTRY_ID {
                1
            } else {
                current + 1
            })
        })
        .unwrap_or_else(|current| current)
}

fn redact_sensitive(value: String) -> String {
    let lower = value.to_ascii_lowercase();
    if [
        "http://",
        "https://",
        "authorization",
        "bearer ",
        "cookie",
        "password",
        "passwd",
        "access_token",
        "refresh_token",
        "auth_token",
        "media_token",
        "control_token",
        "client_secret",
        "token=",
        "token:",
        "token\"",
        "secret=",
        "secret:",
        "secret\"",
        "refresh_key",
        "musickey",
        "sapisid",
        "po_token",
        "visitor_data",
        "file://",
        "/users/",
        "/home/",
        "/volumes/",
        "/tmp/",
        "/private/var/",
        "\\users\\",
    ]
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

fn regular_file_len(path: &Path) -> Result<Option<u64>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(Some(metadata.len())),
        Ok(_) => bail!("拒绝使用非普通活动日志文件"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn current_log_path(data_dir: &Path) -> Result<PathBuf> {
    let directory = data_dir.join(LOG_DIR_NAME);
    let date = Local::now().format("%Y-%m-%d");
    // 一个进程一份文件：Dev 热重启或误开两个 KDJ 实例时，不能让两个 writer
    // 同时 append 同一份 JSONL，否则即使 ID 不重复，半行交错也会破坏记录。
    let process = std::process::id();
    let base = directory.join(format!("activity-{date}-{process}.jsonl"));
    if regular_file_len(&base)?.is_some_and(|length| length >= MAX_LOG_FILE_BYTES) {
        for index in 1..10_000 {
            let candidate = directory.join(format!("activity-{date}-{process}-{index}.jsonl"));
            match regular_file_len(&candidate)? {
                None => return Ok(candidate),
                Some(length) if length < MAX_LOG_FILE_BYTES => return Ok(candidate),
                Some(_) => {}
            }
        }
    }
    Ok(base)
}

fn ensure_log_directory(data_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(data_dir)?;
    let directory = data_dir.join(LOG_DIR_NAME);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => bail!("拒绝使用非普通活动日志目录"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    protect_directory(&directory);
    Ok(directory)
}

fn append_entries(data_dir: &Path, entries: &[ActivityLogEntry]) -> Result<u64> {
    ensure_log_directory(data_dir)?;
    let path = current_log_path(data_dir)?;
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

fn protect_directory(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
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
    let directory = data_dir.join(LOG_DIR_NAME);
    let Ok(metadata) = fs::symlink_metadata(&directory) else {
        return Vec::new();
    };
    if !metadata.file_type().is_dir() {
        tracing::warn!("活动日志目录不是普通目录，已拒绝读取");
        return Vec::new();
    }
    protect_directory(&directory);
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| is_activity_file(path))
        .collect::<Vec<_>>();
    // 文件名中包含 PID，不能再依赖字典序判断新旧；读取最近窗口时按真实修改时间。
    paths.sort_by(|left, right| {
        let modified = |path: &PathBuf| {
            fs::symlink_metadata(path)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        };
        modified(left)
            .cmp(&modified(right))
            .then_with(|| left.cmp(right))
    });
    paths
}

fn cleanup_files(data_dir: &Path, settings: ActivityLogSettings) -> Result<()> {
    let now = SystemTime::now();
    let mut files = activity_files(data_dir)
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() {
                return None;
            }
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

fn load_recent_entries(data_dir: &Path) -> Vec<ActivityLogEntry> {
    let mut loaded = Vec::new();
    for path in activity_files(data_dir).into_iter().rev() {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("activity-unknown.jsonl");
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(file = name, %error, "活动日志文件无法打开，已跳过");
                continue;
            }
        };
        let length = match file.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                tracing::warn!(file = name, %error, "活动日志元数据无法读取，已跳过");
                continue;
            }
        };
        let start = length.saturating_sub(LOAD_TAIL_BYTES);
        let mut reader = BufReader::new(file);
        if start > 0 {
            if let Err(error) = reader.seek(SeekFrom::Start(start)) {
                tracing::warn!(file = name, %error, "活动日志尾部无法定位，已跳过");
                continue;
            }
            let mut partial = String::new();
            if let Err(error) = reader.read_line(&mut partial) {
                tracing::warn!(file = name, %error, "活动日志尾部无法读取，已跳过");
                continue;
            }
        }
        let mut invalid_lines = 0_u64;
        let mut unreadable_lines = 0_u64;
        let mut file_entries = Vec::new();
        for line in reader.lines() {
            match line {
                Ok(line) => match serde_json::from_str::<ActivityLogEntry>(&line) {
                    Ok(entry) => file_entries.push(entry),
                    Err(_) => invalid_lines = invalid_lines.saturating_add(1),
                },
                Err(_) => unreadable_lines = unreadable_lines.saturating_add(1),
            }
        }
        if invalid_lines > 0 || unreadable_lines > 0 {
            tracing::warn!(
                file = name,
                invalid_lines,
                unreadable_lines,
                "活动日志包含损坏记录，已跳过"
            );
        }
        loaded.append(&mut file_entries);
        if loaded.len() >= MEMORY_ENTRY_LIMIT {
            break;
        }
    }
    // ID 为跨进程随机值，只承担稳定身份；展示顺序必须由真实时间决定。
    loaded.sort_by(|left, right| {
        let timestamp = |entry: &ActivityLogEntry| {
            DateTime::parse_from_rfc3339(&entry.timestamp)
                .map(|value| value.timestamp_millis())
                .unwrap_or(i64::MIN)
        };
        timestamp(left)
            .cmp(&timestamp(right))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut seen = HashSet::with_capacity(loaded.len());
    let mut repaired_ids = 0_u64;
    for entry in &mut loaded {
        if entry.id == 0 || entry.id > MAX_SAFE_ENTRY_ID || !seen.insert(entry.id) {
            let mut replacement = random_entry_id();
            while !seen.insert(replacement) {
                replacement = random_entry_id();
            }
            entry.id = replacement;
            repaired_ids = repaired_ids.saturating_add(1);
        }
    }
    if repaired_ids > 0 {
        tracing::warn!(repaired_ids, "活动日志存在重复或越界 ID，已在内存中修复");
    }
    if loaded.len() > MEMORY_ENTRY_LIMIT {
        loaded.drain(..loaded.len() - MEMORY_ENTRY_LIMIT);
    }
    loaded
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
        log.flush().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(log.log_dir()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
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
    fn sensitive_markers_are_redacted_from_all_free_text_fields() {
        let root = scratch("redaction");
        let log = ActivityLog::new(root.clone()).unwrap();
        assert!(log.record(ActivityLogDraft {
            category: ActivityCategory::Network,
            level: ActivityLevel::Error,
            action: "Bearer should-not-survive".into(),
            detail: r#"{"access_token":"should-not-survive"}"#.into(),
            target: "SAPISID=should-not-survive".into(),
            status: Some(401),
            duration_ms: Some(5),
            count: 1,
        }));
        let entry = log.overview(None, 1).entries.pop().unwrap();
        assert_eq!(entry.action, "[敏感信息已隐藏]");
        assert_eq!(entry.detail, "[敏感信息已隐藏]");
        assert_eq!(entry.target, "[敏感信息已隐藏]");

        assert!(log.record(ActivityLogDraft {
            category: ActivityCategory::Network,
            level: ActivityLevel::Error,
            action: "媒体请求失败".into(),
            detail: "https://media.example/audio?sig=should-not-survive".into(),
            target: "https://user:password@example.com/private?token=hidden".into(),
            status: Some(502),
            duration_ms: Some(10),
            count: 1,
        }));
        let entry = log.overview(None, 1).entries.pop().unwrap();
        assert_eq!(entry.detail, "[敏感信息已隐藏]");
        assert_eq!(entry.target, "example.com");

        assert!(log.record(ActivityLogDraft {
            category: ActivityCategory::User,
            level: ActivityLevel::Error,
            action: "本地文件操作失败".into(),
            detail: "/Users/private/Music/secret.flac 写入失败".into(),
            target: String::new(),
            status: None,
            duration_ms: None,
            count: 1,
        }));
        let entry = log.overview(None, 1).entries.pop().unwrap();
        assert_eq!(entry.detail, "[敏感信息已隐藏]");
        log.clear().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_lines_do_not_prevent_activity_log_startup() {
        let root = scratch("corrupt-lines");
        let directory = root.join(LOG_DIR_NAME);
        fs::create_dir_all(&directory).unwrap();
        let valid = ActivityLogEntry {
            id: 7,
            timestamp: "2026-09-01T00:00:00+08:00".into(),
            category: ActivityCategory::User,
            level: ActivityLevel::Warn,
            action: "可恢复记录".into(),
            detail: String::new(),
            target: String::new(),
            status: None,
            duration_ms: None,
            count: 1,
        };
        let duplicate = ActivityLogEntry {
            timestamp: "2026-09-01T00:00:01+08:00".into(),
            action: "较新的重复 ID 记录".into(),
            ..valid.clone()
        };
        let body = format!(
            "not-json\n{}\n{}\n",
            serde_json::to_string(&duplicate).unwrap(),
            serde_json::to_string(&valid).unwrap()
        );
        fs::write(directory.join("activity-corrupt.jsonl"), body).unwrap();

        let log = ActivityLog::new(root.clone()).unwrap();
        let entries = log.overview(None, 20).entries;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].action, "较新的重复 ID 记录");
        assert_ne!(entries[0].id, entries[1].id);
        assert!(entries.iter().all(|entry| entry.id <= MAX_SAFE_ENTRY_ID));
        log.clear().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn entry_id_sequence_stays_within_javascript_integer_range() {
        let counter = AtomicU64::new(MAX_SAFE_ENTRY_ID);
        assert_eq!(next_entry_id(&counter), MAX_SAFE_ENTRY_ID);
        assert_eq!(next_entry_id(&counter), 1);
        assert_eq!(next_entry_id(&counter), 2);
        assert!((1..=MAX_SAFE_ENTRY_ID).contains(&random_entry_id()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_log_targets_are_never_followed() {
        use std::os::unix::fs::symlink;

        let root = scratch("symlink-file");
        let directory = root.join(LOG_DIR_NAME);
        fs::create_dir_all(&directory).unwrap();
        let victim = root.join("victim.txt");
        fs::write(&victim, b"unchanged").unwrap();
        let log_path = current_log_path(&root).unwrap();
        symlink(&victim, &log_path).unwrap();
        let entry = ActivityLogEntry {
            id: 1,
            timestamp: Local::now().to_rfc3339(),
            category: ActivityCategory::User,
            level: ActivityLevel::Warn,
            action: "测试".into(),
            detail: String::new(),
            target: String::new(),
            status: None,
            duration_ms: None,
            count: 1,
        };
        assert!(append_entries(&root, &[entry]).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"unchanged");
        assert!(activity_files(&root).is_empty());
        let _ = fs::remove_dir_all(root);

        let root = scratch("symlink-directory");
        let outside = scratch("symlink-directory-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(LOG_DIR_NAME)).unwrap();
        assert!(ensure_log_directory(&root).is_err());
        assert!(activity_files(&root).is_empty());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
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
