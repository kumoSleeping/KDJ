//! 下载队列：并发控制、进度上报、取消。

use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use kdj_core::models::{
    DownloadTask, DownloadVideoPage, Platform, Quality, SongSource, TaskKind, TaskPhase, TaskState,
    VideoDownloadRequest, VideoInfo,
};
use kdj_core::EventHub;
use kdj_providers::DownloadJob;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

/// 队列只留这么多条，超出的从最老的**终态**任务开始丢（正在跑的不能丢）。
const MAX_HISTORY: usize = 200;

/// 进度节流：一次下载每秒能触发上百次 chunk 回调，若每次都广播，
/// WS 会被打爆（前端每收一条就 setState），而且 UI 上肉眼根本分不出 0.1% 的差别。
/// 规则：最多 4 次/秒，或进度前进 ≥1% 立刻发一次；状态变更永远立刻发。
const PROGRESS_MIN_INTERVAL: f64 = 0.25;
const PROGRESS_MIN_DELTA: f64 = 0.01;

/// 速度用滑动窗口算：瞬时值（本次 chunk / 本次耗时）抖得没法看，
/// 累计平均值又在网络变化时反应太慢。
const SPEED_WINDOW: f64 = 3.0;

/// 滑窗最多留这么多个采样点，够覆盖 3 秒还不至于无限涨。
const SPEED_SAMPLES: usize = 64;

const DOWNLOAD_JOURNAL_VERSION: u32 = 1;
const DOWNLOAD_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 单调秒。节流和测速只关心"过了多久"，用挂钟的话改系统时间会把速度算成天文数字。
fn monotonic() -> f64 {
    static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
}

fn new_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

fn is_terminal(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Done | TaskState::Failed | TaskState::Canceled
    )
}

/// 对当前 worker 而言已经不可再写的状态。Paused 不是历史终态，但暂停前的
/// 网络/FFmpeg future 可能晚到一拍，必须和取消一样挡住这些迟到回调。
fn stops_worker_updates(state: TaskState) -> bool {
    state == TaskState::Paused || is_terminal(state)
}

/// 滑动窗口测速：窗口两端的字节差 / 时间差。
fn window_speed(samples: &mut VecDeque<(f64, u64)>, now: f64) -> f64 {
    while samples.len() > 2 && now - samples[0].0 > SPEED_WINDOW {
        samples.pop_front();
    }
    if samples.len() < 2 {
        return 0.0;
    }
    let (t0, b0) = samples[0];
    let (t1, b1) = samples[samples.len() - 1];
    let dt = t1 - t0;
    // 两个采样挨得太近时分母趋零，算出来是几个 GB/s，不如报 0
    if dt <= 0.05 {
        return 0.0;
    }
    ((b1 as f64 - b0 as f64) / dt).max(0.0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioRetry {
    source: SongSource,
    quality: Quality,
    analyze: bool,
    dest_dir: String,
    external_preparation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VideoRetry {
    request: VideoDownloadRequest,
    /// 入队时冻结的实际成品目录；request.dest_dir 为空时它仍可能是默认下载目录。
    output_dir: String,
    /// 与音频任务相同：只声明“需要一次性来源”，平台挑战仍由外部适配器完成。
    #[serde(default)]
    external_preparation: bool,
}

struct Entry {
    task: DownloadTask,
    cancel: CancellationToken,
    audio_retry: Option<AudioRetry>,
    video_retry: Option<VideoRetry>,
    /// WebView 在“开始/重试”这一刻生成的短期播放流。消费一次即清空；失败重试
    /// 必须重新生成，绝不能拿过期 POT/GVS URL 再撞一次 403。
    prepared_source_url: Option<String>,
    /// 每次真正获得并发槽、开始外部准备时递增。所有回传都必须带同一代号，防止
    /// 暂停/重试边界上的旧异步响应污染新一轮任务。
    preparation_attempt: u64,
    /// 测速滑窗：(单调秒, 已下字节)
    samples: VecDeque<(f64, u64)>,
    /// 上一次真正广播出去的时刻 / 进度。`-1.0` = 还没广播过，第一次一定放行。
    last_emit: f64,
    last_progress: f64,
}

impl Entry {
    fn new(task: DownloadTask, cancel: CancellationToken) -> Self {
        Entry {
            task,
            cancel,
            audio_retry: None,
            video_retry: None,
            prepared_source_url: None,
            preparation_attempt: 0,
            samples: VecDeque::new(),
            last_emit: -1.0,
            last_progress: -1.0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedEntry {
    task: DownloadTask,
    #[serde(default)]
    audio_retry: Option<AudioRetry>,
    #[serde(default)]
    video_retry: Option<VideoRetry>,
}

impl PersistedEntry {
    fn snapshot(entry: &Entry) -> Self {
        Self {
            task: entry.task.clone(),
            audio_retry: entry.audio_retry.clone(),
            video_retry: entry.video_retry.clone(),
        }
    }

    fn restore(mut self) -> Option<(String, Entry)> {
        if self.task.id.trim().is_empty() {
            return None;
        }
        // v1 旧 journal 的 task 没有公开 source_key，但可恢复的请求里仍然保留着。
        // 启动时就地回填，已下完的 B 站视频不用重下也能复制分享。
        if self.task.source_key.trim().is_empty() {
            self.task.source_key = match self.task.kind {
                TaskKind::Audio => self
                    .audio_retry
                    .as_ref()
                    .map(|retry| retry.source.key.trim())
                    .unwrap_or_default(),
                TaskKind::Video => self
                    .video_retry
                    .as_ref()
                    .map(|retry| retry.request.bvid.trim())
                    .unwrap_or_default(),
            }
            .to_string();
        }
        match self.task.kind {
            TaskKind::Audio => self.video_retry = None,
            TaskKind::Video => self.audio_retry = None,
        }
        // v1 队列没有把分 P 放在公开任务字段里，但重试请求一直保存着 page_index。
        // 恢复时补回，避免应用重启后把原本的 P3 显示/重试成看不出的普通视频。
        if self.task.kind == TaskKind::Video
            && self.task.platform == Platform::Bilibili
            && self.task.video_page.is_none()
        {
            if let Some(request) = self.video_retry.as_ref().map(|retry| &retry.request) {
                self.task.video_page = Some(DownloadVideoPage {
                    index: request.page_index,
                    count: request.page_count,
                    title: request.page_title.clone(),
                });
            }
        }
        // 旧 journal 没有视频外部准备字段。普通 YouTube 的直接 HLS/DASH 已失效，
        // 恢复后的失败项也必须走当前受保护 HLS 路径，不能因升级而继续撞 403。
        if self.task.platform == Platform::Youtube {
            if let Some(retry) = &mut self.video_retry {
                retry.external_preparation = true;
            }
        }
        self.task.progress = if self.task.progress.is_finite() {
            self.task.progress.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.task.speed_bps = 0.0;
        if !self.task.created_at.is_finite() {
            self.task.created_at = now_secs();
        }
        if !self.task.updated_at.is_finite() {
            self.task.updated_at = self.task.created_at;
        }

        // 进程消失后没有任何旧 worker 还活着。所有未完成状态统一恢复为 Paused，
        // 用户点“开始”时用冻结的 retry 参数创建新 worker；绝不能恢复成一个永远
        // 没有执行者的 queued/running 假状态。
        if matches!(
            self.task.state,
            TaskState::Queued | TaskState::Running | TaskState::Processing
        ) {
            if self.audio_retry.is_some() || self.video_retry.is_some() {
                self.task.state = TaskState::Paused;
                self.task.phase = TaskPhase::Waiting;
                self.task.error.clear();
            } else {
                self.task.state = TaskState::Failed;
                self.task.phase = TaskPhase::Waiting;
                self.task.error = "任务缺少可恢复的下载参数".into();
            }
            self.task.updated_at = now_secs();
        }
        if self.task.state == TaskState::Done {
            self.task.phase = TaskPhase::Completed;
        }

        let id = self.task.id.clone();
        let mut entry = Entry::new(self.task, CancellationToken::new());
        entry.audio_retry = self.audio_retry;
        entry.video_retry = self.video_retry;
        Some((id, entry))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct DownloadJournal {
    version: u32,
    entries: Vec<PersistedEntry>,
}

fn quarantine_invalid_journal(path: &Path, error: &anyhow::Error) -> Result<()> {
    let name = path
        .file_name()
        .context("下载队列文件缺少文件名")?
        .to_string_lossy();
    let backup = path.with_file_name(format!(
        "{name}.corrupt-{}-{:08x}",
        now_secs() as u64,
        rand::random::<u32>()
    ));
    fs::rename(path, &backup).with_context(|| {
        format!(
            "下载队列损坏（{error:#}），且无法保留到 {}",
            backup.display()
        )
    })?;
    tracing::warn!(
        "下载队列文件损坏，已保留副本 {}：{error:#}",
        backup.display()
    );
    Ok(())
}

fn load_journal(path: &Path) -> Result<BTreeMap<String, Entry>> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.file_type().is_file()
                || metadata.len() == 0
                || metadata.len() > DOWNLOAD_JOURNAL_MAX_BYTES =>
        {
            let error = anyhow::anyhow!("下载队列文件类型或大小无效");
            quarantine_invalid_journal(path, &error)?;
            return Ok(BTreeMap::new());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("检查下载队列失败：{}", path.display()))
        }
    }
    let body = match fs::read(path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("读取下载队列失败：{}", path.display()))
        }
    };
    let journal = match serde_json::from_slice::<DownloadJournal>(&body) {
        Ok(journal) if journal.version == DOWNLOAD_JOURNAL_VERSION => journal,
        Ok(journal) => {
            let error = anyhow::anyhow!("不支持的下载队列版本：{}", journal.version);
            quarantine_invalid_journal(path, &error)?;
            return Ok(BTreeMap::new());
        }
        Err(parse_error) => {
            let error = anyhow::Error::new(parse_error).context("解析下载队列失败");
            quarantine_invalid_journal(path, &error)?;
            return Ok(BTreeMap::new());
        }
    };
    let mut entries = BTreeMap::new();
    for persisted in journal.entries {
        if let Some((id, entry)) = persisted.restore() {
            entries.insert(id, entry);
        }
    }
    trim_locked(&mut entries);
    Ok(entries)
}

#[cfg(not(windows))]
fn commit_journal_temp(tmp: &Path, path: &Path) -> Result<()> {
    fs::rename(tmp, path).with_context(|| format!("提交下载队列失败：{}", path.display()))
}

#[cfg(windows)]
fn commit_journal_temp(tmp: &Path, path: &Path) -> Result<()> {
    if !path.exists() {
        return fs::rename(tmp, path)
            .with_context(|| format!("提交下载队列失败：{}", path.display()));
    }
    let parent = path.parent().context("下载队列文件缺少父目录")?;
    let name = path
        .file_name()
        .context("下载队列文件缺少文件名")?
        .to_string_lossy();
    let backup = parent.join(format!(
        ".{name}.backup-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    fs::rename(path, &backup).with_context(|| format!("暂存旧下载队列失败：{}", path.display()))?;
    if let Err(commit_error) = fs::rename(tmp, path) {
        if let Err(restore_error) = fs::rename(&backup, path) {
            anyhow::bail!(
                "提交新下载队列失败：{commit_error}；恢复旧队列也失败：{restore_error}；旧队列保留在 {}",
                backup.display()
            );
        }
        return Err(commit_error).with_context(|| format!("提交下载队列失败：{}", path.display()));
    }
    if let Err(error) = fs::remove_file(&backup) {
        tracing::warn!("清理旧下载队列备份失败 {}：{error}", backup.display());
    }
    Ok(())
}

fn write_journal(path: &Path, entries: &BTreeMap<String, Entry>) -> Result<()> {
    let parent = path.parent().context("下载队列文件缺少父目录")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("创建下载队列目录失败：{}", parent.display()))?;
    let journal = DownloadJournal {
        version: DOWNLOAD_JOURNAL_VERSION,
        entries: entries.values().map(PersistedEntry::snapshot).collect(),
    };
    let mut body = serde_json::to_vec_pretty(&journal).context("序列化下载队列失败")?;
    body.push(b'\n');
    let name = path
        .file_name()
        .context("下载队列文件缺少文件名")?
        .to_string_lossy();
    let tmp = parent.join(format!(
        ".{name}.tmp-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .with_context(|| format!("创建下载队列临时文件失败：{}", tmp.display()))?;
    let write_result = file
        .write_all(&body)
        .and_then(|_| file.sync_all())
        .with_context(|| format!("写入下载队列临时文件失败：{}", tmp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = commit_journal_temp(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
            tracing::warn!("保护下载队列文件失败 {}：{error}", path.display());
        }
        if let Ok(directory) = fs::File::open(parent) {
            if let Err(error) = directory.sync_all() {
                tracing::warn!("同步下载队列目录失败 {}：{error}", parent.display());
            }
        }
    }
    Ok(())
}

/// 外部准备适配器为任务生成受保护媒体源所需的稳定输入。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PendingDownloadPreparation {
    Audio {
        id: String,
        attempt: u64,
        platform: Platform,
        source: SongSource,
        quality: Quality,
    },
    Video {
        id: String,
        attempt: u64,
        platform: Platform,
        request: VideoDownloadRequest,
    },
}

impl PendingDownloadPreparation {
    fn id(&self) -> &str {
        match self {
            Self::Audio { id, .. } | Self::Video { id, .. } => id,
        }
    }
}

pub struct DownloadManager {
    hub: EventHub,
    entries: Mutex<BTreeMap<String, Entry>>,
    /// None 只用于这一模块的纯内存单元测试；桌面服务始终传正式 journal 路径。
    journal_path: Option<PathBuf>,
    /// 并发闸门 + 它当前的额度。设置里的 `concurrent_downloads` 变了才重建。
    ///
    /// 额度要一起存着：换掉 `Semaphore` 意味着**正在下的那几条还攥着旧闸门的令牌**，
    /// 新闸门却是满额的，这一瞬间的实际并发是新旧之和。所以值没变就绝不能换——
    /// 而前端改任何一项设置都会 `PUT /api/settings`，不判等的话每改一次
    /// 「下载目录」都会把并发悄悄翻一倍。
    permits: Mutex<(u32, Arc<Semaphore>)>,
    /// 「自动下载」开关。关着时任务照样入队，但停在 `queued` 不动，
    /// 等开关拨开（`PUT /api/settings`）再一起放行——开关本身就是"现在开始下"。
    auto_start: watch::Sender<bool>,
    /// 一次性放行信号。每条任务记住入队时的序号，点击「开始下载」只放行
    /// 点击前已经在队列里的任务，之后新加入的任务不会偷偷跟着开始。
    start_generation: watch::Sender<u64>,
}

impl DownloadManager {
    pub fn new(hub: EventHub, concurrency: u32, auto_start: bool) -> Self {
        Self::from_entries(hub, concurrency, auto_start, BTreeMap::new(), None)
    }

    /// 打开持久下载队列。启动时会把上次未完成的 worker 状态规范成 Paused 并立即
    /// 回写，因此即使下一次又异常退出，journal 也不会长期停留在假的 Running。
    pub fn open(
        hub: EventHub,
        concurrency: u32,
        auto_start: bool,
        journal_path: PathBuf,
    ) -> Result<Self> {
        let entries = load_journal(&journal_path)?;
        let manager = Self::from_entries(hub, concurrency, auto_start, entries, Some(journal_path));
        manager.persist_now()?;
        Ok(manager)
    }

    fn from_entries(
        hub: EventHub,
        concurrency: u32,
        auto_start: bool,
        entries: BTreeMap<String, Entry>,
        journal_path: Option<PathBuf>,
    ) -> Self {
        let concurrency = concurrency.max(1);
        DownloadManager {
            hub,
            entries: Mutex::new(entries),
            journal_path,
            permits: Mutex::new((concurrency, Arc::new(Semaphore::new(concurrency as usize)))),
            auto_start: watch::channel(auto_start).0,
            start_generation: watch::channel(0).0,
        }
    }

    fn persist_locked(&self, entries: &BTreeMap<String, Entry>) -> Result<()> {
        let Some(path) = self.journal_path.as_deref() else {
            return Ok(());
        };
        write_journal(path, entries)
    }

    fn persist_locked_or_warn(&self, entries: &BTreeMap<String, Entry>) {
        if let Err(error) = self.persist_locked(entries) {
            tracing::error!("下载队列持久化失败：{error:#}");
        }
    }

    fn persist_now(&self) -> Result<()> {
        let entries = self.entries.lock().unwrap();
        self.persist_locked(&entries)
    }

    pub fn set_concurrency(&self, concurrency: u32) {
        // 0 会把闸门焊死，一条也下不动
        let concurrency = concurrency.max(1);
        let mut permits = self.permits.lock().unwrap();
        if permits.0 == concurrency {
            return;
        }
        *permits = (concurrency, Arc::new(Semaphore::new(concurrency as usize)));
    }

    /// 当前的闸门。取出来就放锁，别在 `.await` 期间攥着 `Mutex`。
    fn permits(&self) -> Arc<Semaphore> {
        self.permits.lock().unwrap().1.clone()
    }

    /// 拨动「自动下载」。拨开的那一刻攒着的任务会自己往下走。
    pub fn set_auto_start(&self, enabled: bool) {
        // send_replace 而不是 send：没有接收者（队列是空的）时 send 会报错
        self.auto_start.send_replace(enabled);
    }

    pub fn auto_start_enabled(&self) -> bool {
        *self.auto_start.borrow()
    }

    pub fn start_generation(&self) -> u64 {
        *self.start_generation.borrow()
    }

    pub fn release_queued(&self) {
        self.start_generation
            .send_modify(|generation| *generation += 1);
    }

    /// 按创建时间升序列出，前端队列面板要的就是这个顺序。
    pub fn list(&self) -> Vec<DownloadTask> {
        let entries = self.entries.lock().unwrap();
        let mut tasks: Vec<DownloadTask> =
            entries.values().map(|entry| entry.task.clone()).collect();
        tasks.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));
        tasks
    }

    pub fn get(&self, id: &str) -> Option<DownloadTask> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.task.clone())
    }

    pub fn pending_download_preparations(&self) -> Vec<PendingDownloadPreparation> {
        let entries = self.entries.lock().unwrap();
        let mut pending = entries
            .values()
            .filter(|entry| {
                entry.task.state == TaskState::Running
                    && entry.task.phase == TaskPhase::Authorizing
                    && entry.prepared_source_url.is_none()
            })
            .filter_map(|entry| {
                let item = match entry.task.kind {
                    TaskKind::Audio => {
                        let retry = entry
                            .audio_retry
                            .as_ref()
                            .filter(|retry| retry.external_preparation)?;
                        PendingDownloadPreparation::Audio {
                            id: entry.task.id.clone(),
                            attempt: entry.preparation_attempt,
                            platform: entry.task.platform,
                            source: retry.source.clone(),
                            quality: retry.quality,
                        }
                    }
                    TaskKind::Video => {
                        let retry = entry
                            .video_retry
                            .as_ref()
                            .filter(|retry| retry.external_preparation)?;
                        PendingDownloadPreparation::Video {
                            id: entry.task.id.clone(),
                            attempt: entry.preparation_attempt,
                            platform: entry.task.platform,
                            request: retry.request.clone(),
                        }
                    }
                };
                Some((entry.task.created_at, item))
            })
            .collect::<Vec<_>>();
        pending.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id().cmp(b.1.id())));
        pending.into_iter().map(|(_, item)| item).collect()
    }

    pub fn preparation_is_current(&self, id: &str, attempt: u64) -> bool {
        self.entries.lock().unwrap().get(id).is_some_and(|entry| {
            attempt > 0
                && entry.preparation_attempt == attempt
                && matches!(entry.task.state, TaskState::Running | TaskState::Processing)
                && !matches!(entry.task.phase, TaskPhase::Waiting | TaskPhase::Resolving)
                && entry.prepared_source_url.is_none()
                && (entry
                    .audio_retry
                    .as_ref()
                    .is_some_and(|retry| retry.external_preparation)
                    || entry
                        .video_retry
                        .as_ref()
                        .is_some_and(|retry| retry.external_preparation))
        })
    }

    pub fn video_preparation_request(
        &self,
        id: &str,
        attempt: u64,
    ) -> Option<VideoDownloadRequest> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|entry| entry.preparation_attempt == attempt)
            .and_then(|entry| entry.video_retry.as_ref())
            .filter(|retry| retry.external_preparation)
            .map(|retry| retry.request.clone())
    }

    pub fn attach_prepared_source(&self, id: &str, attempt: u64, url: String) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.get_mut(id).context("任务不存在")?;
        anyhow::ensure!(
            entry
                .audio_retry
                .as_ref()
                .is_some_and(|retry| retry.external_preparation)
                || entry
                    .video_retry
                    .as_ref()
                    .is_some_and(|retry| retry.external_preparation),
            "这条任务不接受外部准备的媒体源"
        );
        anyhow::ensure!(
            attempt > 0
                && entry.preparation_attempt == attempt
                && matches!(entry.task.state, TaskState::Running | TaskState::Processing)
                && entry.prepared_source_url.is_none(),
            "下载准备已经过期，不能替换当前来源"
        );
        entry.prepared_source_url = Some(url);
        Ok(())
    }

    /// 外部挑战失败必须立即落在原任务上，不能只写前端控制台后让任务等满超时。
    pub fn fail_preparation(&self, id: &str, attempt: u64, error: &str) -> Result<DownloadTask> {
        let (task, changed) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).context("任务不存在")?;
            anyhow::ensure!(
                entry
                    .audio_retry
                    .as_ref()
                    .is_some_and(|retry| retry.external_preparation)
                    || entry
                        .video_retry
                        .as_ref()
                        .is_some_and(|retry| retry.external_preparation),
                "这条任务不需要外部媒体准备"
            );
            if attempt == 0
                || entry.preparation_attempt != attempt
                || stops_worker_updates(entry.task.state)
            {
                (entry.task.clone(), false)
            } else {
                entry.cancel.cancel();
                entry.task.state = TaskState::Failed;
                entry.task.phase = TaskPhase::Authorizing;
                entry.task.error = error.to_string();
                entry.task.speed_bps = 0.0;
                entry.task.updated_at = now_secs();
                entry.last_emit = monotonic();
                entry.last_progress = entry.task.progress;
                let task = entry.task.clone();
                self.persist_locked_or_warn(&entries);
                (task, true)
            }
        };
        if changed {
            self.hub.publish("download.updated", &task);
        }
        Ok(task)
    }

    fn peek_prepared_source_url(&self, id: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .and_then(|entry| entry.prepared_source_url.clone())
    }

    fn take_prepared_source_url(&self, id: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get_mut(id)
            .and_then(|entry| entry.prepared_source_url.take())
    }

    /// 整份队列快照。入队/清理之后广播一次，前端才能知道有条目被裁掉了。
    pub fn broadcast_list(&self) {
        self.hub.publish("download.list", &self.list());
    }

    #[cfg(test)]
    fn insert(&self, task: DownloadTask, cancel: CancellationToken) {
        self.insert_with_retry(task, cancel, None, None);
    }

    fn insert_with_retry(
        &self,
        task: DownloadTask,
        cancel: CancellationToken,
        audio_retry: Option<AudioRetry>,
        video_retry: Option<VideoRetry>,
    ) {
        {
            let mut entries = self.entries.lock().unwrap();
            let mut entry = Entry::new(task.clone(), cancel);
            entry.audio_retry = audio_retry;
            entry.video_retry = video_retry;
            entries.insert(task.id.clone(), entry);
            trim_locked(&mut entries);
            self.persist_locked_or_warn(&entries);
        }
        self.hub.publish("download.updated", &task);
    }

    #[cfg(test)]
    fn attach_audio_retry(&self, id: &str, retry: AudioRetry) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get_mut(id) {
            entry.audio_retry = Some(retry);
            self.persist_locked_or_warn(&entries);
        }
    }

    #[cfg(test)]
    fn attach_video_retry(&self, id: &str, retry: VideoRetry) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get_mut(id) {
            entry.video_retry = Some(retry);
            self.persist_locked_or_warn(&entries);
        }
    }

    fn prepare_audio_retry(
        &self,
        id: &str,
    ) -> Result<(DownloadTask, AudioRetry, CancellationToken)> {
        let (task, retry, cancel) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).context("任务不存在")?;
            anyhow::ensure!(entry.task.kind == TaskKind::Audio, "只有歌曲下载支持重试");
            anyhow::ensure!(
                matches!(entry.task.state, TaskState::Paused | TaskState::Failed),
                "只有暂停或失败的任务可以重新开始"
            );
            let retry = entry
                .audio_retry
                .clone()
                .context("这条旧任务没有可用的重试参数")?;
            let cancel = CancellationToken::new();
            entry.cancel = cancel.clone();
            entry.samples.clear();
            entry.last_emit = monotonic();
            entry.last_progress = 0.0;
            entry.prepared_source_url = None;
            entry.task.state = TaskState::Queued;
            entry.task.phase = TaskPhase::Waiting;
            entry.task.progress = 0.0;
            entry.task.downloaded_bytes = 0;
            entry.task.total_bytes = 0;
            entry.task.speed_bps = 0.0;
            entry.task.path.clear();
            entry.task.error.clear();
            entry.task.track_id = None;
            entry.task.updated_at = now_secs();
            let prepared = (entry.task.clone(), retry, cancel);
            self.persist_locked(&entries)?;
            prepared
        };
        self.hub.publish("download.updated", &task);
        Ok((task, retry, cancel))
    }

    /// 排队期间改单曲音质：任务 worker 真正开跑时才从这里读取冻结参数，
    /// 因此不会出现 UI 已改成 FLAC、后台仍拿旧 320K 下载的假设置。
    pub fn set_queued_audio_quality(&self, id: &str, quality: Quality) -> Result<DownloadTask> {
        let task = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).context("任务不存在")?;
            anyhow::ensure!(entry.task.kind == TaskKind::Audio, "这条任务不是歌曲下载");
            anyhow::ensure!(
                matches!(
                    entry.task.state,
                    TaskState::Queued | TaskState::Paused | TaskState::Failed
                ),
                "只有待开始、已暂停或上次失败的歌曲可以改音质"
            );
            let retry = entry
                .audio_retry
                .as_mut()
                .context("这条旧任务没有可用的下载参数")?;
            retry.quality = quality;
            entry.prepared_source_url = None;
            entry.task.quality = quality.as_str().to_string();
            entry.task.updated_at = now_secs();
            let task = entry.task.clone();
            self.persist_locked(&entries)?;
            task
        };
        self.hub.publish("download.updated", &task);
        Ok(task)
    }

    /// 取最新的单曲参数并把 queued → running 放在同一把锁里。
    /// 这样“改单曲音质”和 worker 启动不会互相穿透。
    fn start_audio(&self, id: &str) -> Option<AudioRetry> {
        let (task, retry) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            if entry.task.state != TaskState::Queued {
                return None;
            }
            let retry = entry.audio_retry.clone()?;
            if retry.external_preparation {
                entry.preparation_attempt = entry.preparation_attempt.saturating_add(1).max(1);
            }
            entry.samples.push_back((monotonic(), 0));
            entry.task.state = TaskState::Running;
            entry.task.phase = if retry.external_preparation {
                TaskPhase::Authorizing
            } else {
                TaskPhase::Resolving
            };
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            let started = (entry.task.clone(), retry);
            self.persist_locked_or_warn(&entries);
            started
        };
        self.hub.publish("download.updated", &task);
        Some(retry)
    }

    fn prepare_video_retry(
        &self,
        id: &str,
    ) -> Result<(DownloadTask, VideoRetry, CancellationToken)> {
        let (task, retry, cancel) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).context("任务不存在")?;
            anyhow::ensure!(entry.task.kind == TaskKind::Video, "这条任务不是视频下载");
            anyhow::ensure!(
                matches!(entry.task.state, TaskState::Paused | TaskState::Failed),
                "只有暂停或失败的任务可以重新开始"
            );
            let retry = entry
                .video_retry
                .clone()
                .context("这条旧任务没有可用的重试参数")?;
            let cancel = CancellationToken::new();
            entry.cancel = cancel.clone();
            entry.samples.clear();
            entry.last_emit = monotonic();
            entry.last_progress = 0.0;
            entry.prepared_source_url = None;
            entry.task.state = TaskState::Queued;
            entry.task.phase = TaskPhase::Waiting;
            entry.task.progress = 0.0;
            entry.task.downloaded_bytes = 0;
            entry.task.total_bytes = 0;
            entry.task.speed_bps = 0.0;
            entry.task.path.clear();
            entry.task.error.clear();
            entry.task.track_id = None;
            entry.task.updated_at = now_secs();
            let prepared = (entry.task.clone(), retry, cancel);
            self.persist_locked(&entries)?;
            prepared
        };
        self.hub.publish("download.updated", &task);
        Ok((task, retry, cancel))
    }

    pub fn set_pending_video_height(&self, id: &str, max_height: i64) -> Result<DownloadTask> {
        anyhow::ensure!((144..=4320).contains(&max_height), "视频画质超出支持范围");
        let task = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).context("任务不存在")?;
            anyhow::ensure!(entry.task.kind == TaskKind::Video, "这条任务不是视频下载");
            anyhow::ensure!(
                matches!(
                    entry.task.state,
                    TaskState::Queued | TaskState::Paused | TaskState::Failed
                ),
                "只有待开始、已暂停或上次失败的视频可以改画质"
            );
            let retry = entry
                .video_retry
                .as_mut()
                .context("这条旧任务没有可用的下载参数")?;
            anyhow::ensure!(!retry.request.audio_only, "纯音频任务没有视频画质");
            retry.request.max_height = max_height;
            entry.prepared_source_url = None;
            entry.task.quality = format!("{max_height}p");
            entry.task.updated_at = now_secs();
            let task = entry.task.clone();
            self.persist_locked(&entries)?;
            task
        };
        self.hub.publish("download.updated", &task);
        Ok(task)
    }

    fn start_video(&self, id: &str) -> Option<VideoRetry> {
        let (task, retry) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            if entry.task.state != TaskState::Queued {
                return None;
            }
            let retry = entry.video_retry.clone()?;
            if retry.external_preparation {
                entry.preparation_attempt = entry.preparation_attempt.saturating_add(1).max(1);
            }
            entry.samples.push_back((monotonic(), 0));
            entry.task.state = TaskState::Running;
            // 视频都先解析元数据。YouTube 分享链接可能只带 url、没有 bvid；等解析
            // 回填出稳定 video id 后再进入 Authorizing，外部 HLS 票据才能与任务严格匹配。
            entry.task.phase = TaskPhase::Resolving;
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            let started = (entry.task.clone(), retry);
            self.persist_locked_or_warn(&entries);
            started
        };
        self.hub.publish("download.updated", &task);
        Some(retry)
    }

    /// 把解析得到的视频身份、展示字段和可重试请求一次性写回。外部准备随后读取
    /// `video_retry.request`，因此 URL-only 入队也能获得与任务绑定的 YouTube HLS 票据。
    fn apply_video_resolution(&self, id: &str, info: &VideoInfo) {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            let placeholder = entry
                .video_retry
                .as_ref()
                .map(|retry| video_placeholder_title(&retry.request));
            let source_key = info.bvid.trim();
            if !source_key.is_empty() {
                entry.task.source_key = source_key.to_string();
                if let Some(retry) = entry.video_retry.as_mut() {
                    retry.request.bvid = source_key.to_string();
                }
            }
            // 入队时搜索结果可能已经盖过标题/封面；解析结果只补空缺，别把好的冲掉。
            if !info.title.is_empty()
                && (entry.task.title.is_empty()
                    || entry.task.title == "未命名"
                    || entry.task.title.starts_with("BV")
                    || placeholder.as_deref() == Some(entry.task.title.as_str()))
            {
                entry.task.title = info.title.clone();
            }
            if entry.task.artist.trim().is_empty() {
                entry.task.artist = info.author.clone();
            }
            if entry.task.cover.trim().is_empty() && !info.cover.trim().is_empty() {
                entry.task.cover = info.cover.clone();
            }
            if entry.task.platform == Platform::Bilibili {
                let page_index = entry
                    .video_retry
                    .as_ref()
                    .map(|retry| retry.request.page_index)
                    .unwrap_or_default();
                let resolved_page = info.pages.get(page_index);
                entry.task.video_page = Some(DownloadVideoPage {
                    index: page_index,
                    count: info.pages.len(),
                    title: resolved_page
                        .map(|page| page.title.clone())
                        .unwrap_or_default(),
                });
                if let Some(retry) = entry.video_retry.as_mut() {
                    retry.request.page_count = info.pages.len();
                    retry.request.page_title = resolved_page
                        .map(|page| page.title.clone())
                        .unwrap_or_default();
                }
            }
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            let task = entry.task.clone();
            self.persist_locked_or_warn(&entries);
            task
        };
        self.hub.publish("download.updated", &updated);
    }

    /// 「开始」除了放行 queued，也要把暂停和能重试的失败媒体一并带上。
    /// 先拍快照再逐条重试，避免在持有 entries 锁时启动异步任务。
    pub fn restartable_ids(&self) -> Vec<String> {
        let entries = self.entries.lock().unwrap();
        let mut ids: Vec<(f64, String)> = entries
            .iter()
            .filter(|(_, entry)| {
                matches!(entry.task.state, TaskState::Paused | TaskState::Failed)
                    && (entry.audio_retry.is_some() || entry.video_retry.is_some())
            })
            .map(|(id, entry)| (entry.task.created_at, id.clone()))
            .collect();
        ids.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        ids.into_iter().map(|(_, id)| id).collect()
    }

    /// 只改仍在活动中的任务，并把“检查状态 + 修改”放在同一把锁里。
    /// 取消、完成与异步 worker 回调互相竞速时，先落下的终态必须永久胜出。
    fn update_active(
        &self,
        id: &str,
        mutate: impl FnOnce(&mut DownloadTask),
    ) -> Option<DownloadTask> {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            if stops_worker_updates(entry.task.state) {
                return None;
            }
            mutate(&mut entry.task);
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            let task = entry.task.clone();
            self.persist_locked_or_warn(&entries);
            task
        };
        self.hub.publish("download.updated", &updated);
        Some(updated)
    }

    /// 落到终态。已经是终态的不再改——否则下载完成的那一瞬间收到取消
    /// 会把"完成"覆盖成"已取消"。
    fn settle(&self, id: &str, state: TaskState, error: &str) -> Option<DownloadTask> {
        self.update_active(id, |task| {
            task.state = state;
            if state == TaskState::Done {
                task.phase = TaskPhase::Completed;
            }
            task.error = error.to_string();
            task.speed_bps = 0.0;
        })
    }

    /// 任务开跑：记一个零点采样，滑窗才有起点。
    #[cfg(test)]
    fn start(&self, id: &str, phase: TaskPhase) {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            // 取消与 worker 拿到并发令牌可能同时发生。终态一旦落下，迟到的
            // worker 绝不能再把它翻回 running。
            if stops_worker_updates(entry.task.state) {
                return;
            }
            entry.samples.push_back((monotonic(), 0));
            entry.task.state = TaskState::Running;
            entry.task.phase = phase;
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            let task = entry.task.clone();
            self.persist_locked_or_warn(&entries);
            task
        };
        self.hub.publish("download.updated", &updated);
    }

    fn phase(&self, id: &str, phase: TaskPhase) {
        self.update_active(id, |task| task.phase = phase);
    }

    /// provider 的下载循环每收到一块就调一次：更新字节数和速度，广播则要过节流。
    pub(crate) fn progress(&self, id: &str, downloaded: u64, total: u64) {
        self.progress_inner(id, None, downloaded, total);
    }

    /// 外部准备的进度还要绑定尝试代号；旧请求即使在暂停/重试后迟到，也不能把
    /// 新任务的字节数和阶段改回去。
    pub(crate) fn preparation_progress(&self, id: &str, attempt: u64, downloaded: u64, total: u64) {
        self.progress_inner(id, Some(attempt), downloaded, total);
    }

    fn progress_inner(&self, id: &str, attempt: Option<u64>, downloaded: u64, total: u64) {
        let payload = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            if attempt.is_some_and(|attempt| attempt == 0 || entry.preparation_attempt != attempt) {
                return;
            }
            // 网络 future 收到取消后仍可能交付最后一个已经到达的 chunk。
            // 已取消是单向终态，迟到的进度只能丢弃，不能复活任务。
            if stops_worker_updates(entry.task.state) {
                return;
            }
            let now = monotonic();
            // 解析 / 授权结束后第一次 report 往往是 (0, unknown)。字节没有前进，
            // 但阶段已经真实切到下载；这条事件必须绕过 250ms / 1% 的进度节流。
            let entered_downloading = entry.task.state != TaskState::Running
                || entry.task.phase != TaskPhase::Downloading;
            entry.task.downloaded_bytes = downloaded;
            entry.task.state = TaskState::Running;
            entry.task.phase = TaskPhase::Downloading;
            if total > 0 {
                entry.task.total_bytes = total;
            }
            entry.task.progress = if total > 0 {
                (downloaded as f64 / total as f64).min(1.0)
            } else {
                0.0
            };
            // DASH 的最后一个字节只代表音/视频流已到齐；之后仍可能要让 FFmpeg
            // 合并（或按设置转码）、原子落盘、移入目标目录并入库。以前 UI 在这段
            // 时间继续写「下载中 100%」，看起来像卡死。总量已知且收齐就立刻切相位。
            let entered_processing =
                total > 0 && downloaded >= total && entry.task.state == TaskState::Running;
            if entered_processing {
                entry.task.state = TaskState::Processing;
                entry.task.phase = TaskPhase::PostProcessing;
                entry.task.speed_bps = 0.0;
            }
            entry.samples.push_back((now, downloaded));
            if entry.samples.len() > SPEED_SAMPLES {
                entry.samples.pop_front();
            }
            entry.task.speed_bps = window_speed(&mut entry.samples, now);
            entry.task.updated_at = now_secs();

            let due = entered_downloading
                || entered_processing
                || now - entry.last_emit >= PROGRESS_MIN_INTERVAL
                || entry.task.progress - entry.last_progress >= PROGRESS_MIN_DELTA;
            if !due {
                return;
            }
            entry.last_emit = now;
            entry.last_progress = entry.task.progress;
            entry.task.clone()
        };
        self.hub.publish("download.updated", &payload);
    }

    /// 下载完成的收尾：进度顶到 1、速度归零，并用最终文件纠正体积与音质显示。
    ///
    /// 已经落到终态的不再改：取消是在下载循环的**下一次**回调才生效的，
    /// 「点了取消 → 最后一块正好下完」这条时序会把「已取消」翻回「已完成」。
    fn finish(&self, id: &str, path: &std::path::Path, track_id: Option<i64>) {
        self.finish_file(id, path, TaskState::Done, "", track_id);
    }

    /// 文件已经落盘，但写进曲库失败：必须保留成品路径并明确标失败。
    ///
    /// 旧逻辑仍调用 `finish(..., None)`，右栏因此显示「完成」，左表却永远没有对应
    /// 曲目——正是最像“视频消失了”的状态。下载成功和入库成功是两段结果，目标
    /// 文件夹下载只有两段都成功才能标 Done。
    fn fail_after_download(&self, id: &str, path: &std::path::Path, error: &str) {
        self.finish_file(id, path, TaskState::Failed, error, None);
    }

    fn finish_file(
        &self,
        id: &str,
        path: &std::path::Path,
        state: TaskState,
        error: &str,
        track_id: Option<i64>,
    ) {
        let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let suffix = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        self.update_active(id, |task| {
            task.state = state;
            if state == TaskState::Done {
                task.phase = TaskPhase::Completed;
            }
            task.progress = if state == TaskState::Done {
                1.0
            } else {
                task.progress
            };
            // 收尾还挂着最后一次的瞬时速度的话，完成的条目会一直显示 "3.2 MB/s"
            task.speed_bps = 0.0;
            task.path = path.to_string_lossy().into_owned();
            task.error = error.to_string();
            task.track_id = track_id;
            if size > 0 {
                task.downloaded_bytes = size;
                // 下载流可能在收尾时无损重封装（YTM WebM -> Ogg Opus）或转码；
                // 完成行显示的是成品体积，不能继续拿源容器大小当分母。
                task.total_bytes = if task.kind == TaskKind::Audio {
                    size
                } else {
                    task.total_bytes.max(size)
                };
            }
            // provider 可能因为版权降级了音质，用最终文件后缀纠正显示值
            if task.kind == TaskKind::Audio
                && matches!(
                    suffix.as_str(),
                    "flac" | "mp3" | "m4a" | "wav" | "aac" | "ogg" | "opus" | "mp4"
                )
            {
                task.quality = suffix.clone();
            }
        });
    }

    pub fn cancel(&self, id: &str) -> Option<DownloadTask> {
        // 还没开始的任务没有产生文件、网络请求或进度，“取消”它就是从待办里
        // 删掉，不应留下一条假的历史记录。先移出 map 再广播，等待闸门的 worker
        // 会被 token 唤醒并自行退出，之后的 settle 找不到 entry 也不会把它加回来。
        let removed_queued = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get(id) {
                Some(entry) if entry.task.state == TaskState::Queued => {
                    let entry = entries.remove(id)?;
                    entry.cancel.cancel();
                    let task = entry.task;
                    self.persist_locked_or_warn(&entries);
                    Some(task)
                }
                _ => None,
            }
        };
        if let Some(task) = removed_queued {
            self.broadcast_list();
            return Some(task);
        }

        {
            let entries = self.entries.lock().unwrap();
            let entry = entries.get(id)?;
            // 已经结束的任务不再改状态，否则"完成"会被点成"已取消"
            if is_terminal(entry.task.state) {
                return Some(entry.task.clone());
            }
            entry.cancel.cancel();
        }
        self.settle(id, TaskState::Canceled, "已取消")
            .or_else(|| self.get(id))
    }

    /// 一次性取消整份活动队列。
    ///
    /// 不能让前端对每一行各发一个请求：那样清单会在 N 个请求之间不断变化，
    /// 刚入队或刚转入 processing 的任务很容易漏掉。queued 直接移除；已经持有
    /// 网络流/FFmpeg 的任务触发 token，并保留一条 canceled 记录供用户确认结果。
    pub fn cancel_all(&self) -> usize {
        let (count, updated) = {
            let mut entries = self.entries.lock().unwrap();
            let mut queued = Vec::new();
            let mut updated = Vec::new();
            for (id, entry) in entries.iter_mut() {
                match entry.task.state {
                    TaskState::Queued => {
                        entry.cancel.cancel();
                        queued.push(id.clone());
                    }
                    TaskState::Running | TaskState::Processing => {
                        entry.cancel.cancel();
                        entry.task.state = TaskState::Canceled;
                        entry.task.error = "已取消".into();
                        entry.task.speed_bps = 0.0;
                        entry.task.updated_at = now_secs();
                        updated.push(entry.task.clone());
                    }
                    TaskState::Paused
                    | TaskState::Done
                    | TaskState::Failed
                    | TaskState::Canceled => {}
                }
            }
            for id in &queued {
                entries.remove(id);
            }
            self.persist_locked_or_warn(&entries);
            (queued.len() + updated.len(), updated)
        };
        for task in updated {
            self.hub.publish("download.updated", &task);
        }
        self.broadcast_list();
        count
    }

    /// 暂停整批尚未完成的任务。包括正在传输/处理的项目，也包括已经被「开始」
    /// 放行但还在等待并发令牌的 queued 项；否则前几首停下后，后面的会继续启动。
    ///
    /// Paused 会挡住旧 worker 的迟到回调。下一次「开始」使用每条 Entry 中冻结的
    /// retry 参数创建新 worker，因此不会把“暂停”伪装成不可恢复的“取消”。
    pub fn pause_all(&self) -> usize {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let mut updated = Vec::new();
            for entry in entries.values_mut() {
                if !matches!(
                    entry.task.state,
                    TaskState::Queued | TaskState::Running | TaskState::Processing
                ) {
                    continue;
                }
                entry.cancel.cancel();
                entry.prepared_source_url = None;
                entry.task.state = TaskState::Paused;
                entry.task.phase = TaskPhase::Waiting;
                entry.task.speed_bps = 0.0;
                entry.task.error.clear();
                entry.task.updated_at = now_secs();
                updated.push(entry.task.clone());
            }
            self.persist_locked_or_warn(&entries);
            updated
        };
        for task in &updated {
            self.hub.publish("download.updated", task);
        }
        if !updated.is_empty() {
            self.broadcast_list();
        }
        updated.len()
    }

    /// 只移除一条已结束任务。用于清理某次导出记录，不能误伤同队列中的其他任务。
    pub fn remove_finished(&self, id: &str) -> Option<DownloadTask> {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get(id)?;
            if !is_terminal(entry.task.state) && entry.task.state != TaskState::Paused {
                return None;
            }
            let removed = entries.remove(id).map(|entry| entry.task);
            self.persist_locked_or_warn(&entries);
            removed
        };
        self.broadcast_list();
        removed
    }

    /// 清掉所有当前没有在执行的任务，返回清掉几条。
    ///
    /// 队列里的失败项仍是一首待下载的歌，只带着“上次下载失败”的状态；
    /// 因而「清理」既要移除这些失败/已结束记录，也要移除尚未开始的 queued。
    /// 正在下载或处理的任务不受影响。
    pub fn clear_inactive(&self) -> usize {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
            let before = entries.len();
            entries.retain(|_, entry| {
                let keep = matches!(entry.task.state, TaskState::Running | TaskState::Processing);
                if !keep {
                    // queued worker 可能还在等显式 start；移出 map 前先唤醒它退出。
                    entry.cancel.cancel();
                }
                keep
            });
            self.persist_locked_or_warn(&entries);
            before - entries.len()
        };
        self.broadcast_list();
        removed
    }
}

/// 超出上限时从最老的**终态**任务开始丢；全都在跑就一条都不丢。
fn trim_locked(entries: &mut BTreeMap<String, Entry>) {
    while entries.len() > MAX_HISTORY {
        let oldest = entries
            .iter()
            .filter(|(_, entry)| is_terminal(entry.task.state))
            .min_by(|a, b| a.1.task.created_at.total_cmp(&b.1.task.created_at))
            .map(|(id, _)| id.clone());
        let Some(oldest) = oldest else {
            return;
        };
        entries.remove(&oldest);
    }
}

/// 「自动下载」关着时任务停在 `queued`，等开关拨开再往下走。
/// 返回 `false` 表示还没轮到就被取消了。
async fn wait_until_started(
    manager: &DownloadManager,
    cancel: &CancellationToken,
    queued_generation: u64,
    allow_auto_start: bool,
) -> bool {
    // 先订阅再判断：反过来的话，两步之间拨开的开关会漏掉，任务永远醒不过来
    let mut rx = manager.auto_start.subscribe();
    let mut start_rx = manager.start_generation.subscribe();
    loop {
        if cancel.is_cancelled() {
            return false;
        }
        if allow_auto_start && *rx.borrow_and_update() {
            return true;
        }
        if *start_rx.borrow_and_update() > queued_generation {
            return true;
        }
        tokio::select! {
            _ = cancel.cancelled() => return false,
            changed = rx.changed() => {
                if changed.is_err() {
                    return false;
                }
            }
            changed = start_rx.changed() => {
                if changed.is_err() {
                    return false;
                }
            }
        }
    }
}

/// 等下载并发令牌时也响应取消。单纯在拿到令牌后检查 token 会让一个已取消的
/// 大歌单 worker 继续在信号量里排很久，占着任务和 future 不退出。
async fn acquire_download_permit(
    manager: &DownloadManager,
    cancel: &CancellationToken,
) -> Option<OwnedSemaphorePermit> {
    let permits = manager.permits();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        permit = permits.acquire_owned() => permit.ok(),
    }
}

/// 需要外部挑战的 Provider 必须等适配器提交一次性媒体源；任务已经可见并处于
/// authorizing，相同等待/取消/超时语义不再散落在平台分支里。
async fn wait_for_prepared_source(
    manager: &DownloadManager,
    id: &str,
    cancel: &CancellationToken,
) -> bool {
    // A protected YTM source is now materialized by one uninterrupted GVS transfer before the
    // provider consumes its local file. Long mixes must not time out while progress is advancing.
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
    let mut last_activity = tokio::time::Instant::now();
    let mut last_downloaded = 0_u64;
    loop {
        if cancel.is_cancelled() {
            return false;
        }
        if manager.peek_prepared_source_url(id).is_some() {
            return true;
        }
        if let Some(task) = manager.get(id) {
            if task.downloaded_bytes > last_downloaded {
                last_downloaded = task.downloaded_bytes;
                last_activity = tokio::time::Instant::now();
            }
        }
        if tokio::time::Instant::now().duration_since(last_activity) >= TIMEOUT {
            return false;
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return false,
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
    }
}

fn new_task(
    kind: TaskKind,
    platform: Platform,
    source_key: String,
    title: &str,
    artist: &str,
    quality: String,
    dest_dir: String,
    output_dir: String,
    cover: String,
) -> DownloadTask {
    let now = now_secs();
    DownloadTask {
        id: new_id(),
        kind,
        platform,
        source_key,
        // 空标题在队列面板上就是一行空白，用户认不出这是哪一条
        title: if title.is_empty() {
            "未命名".to_string()
        } else {
            title.to_string()
        },
        artist: artist.to_string(),
        quality,
        state: TaskState::Queued,
        phase: TaskPhase::Waiting,
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0.0,
        path: String::new(),
        error: String::new(),
        track_id: None,
        dest_dir,
        output_dir,
        cover,
        video_page: None,
        created_at: now,
        updated_at: now,
    }
}

/// 下载启动前验证目标仍在线且真正可写。
///
/// 尤其不能在这里 create_dir_all：macOS/Linux 的移动盘被拔掉后，原挂载点路径
/// 可能仍可在内置盘上重建，结果用户明明选了 U 盘，文件却悄悄写进系统盘。
pub fn validate_download_target(dest: &Path) -> Result<(), String> {
    if !dest.is_dir() {
        return Err(format!("下载文件夹不存在或设备未连接：{}", dest.display()));
    }
    let probe = dest.join(format!(
        ".kdj-write-test-{}-{:08x}.tmp",
        std::process::id(),
        rand::random::<u32>()
    ));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        file.write_all(b"KDJ")?;
        file.flush()
    })();
    let _ = std::fs::remove_file(&probe);
    result.map_err(|err| format!("下载文件夹不可写：{}（{err}）", dest.display()))
}

/// provider 通常直接写进目标目录；若用户在排队后改了全局设置，则把成品移回
/// 任务入队时冻结的目录。目标路径在 HTTP 边界或配置读取时已经校验过来源。
fn relocate_download(path: &Path, dest_dir: &str) -> Result<PathBuf, String> {
    let dest = PathBuf::from(dest_dir.trim());
    validate_download_target(&dest)?;
    if path.parent() == Some(dest.as_path()) {
        return Ok(path.to_path_buf());
    }
    kdj_library::folders::move_file(path, &dest).map_err(|err| format!("{err:#}"))
}

/// 建一条音频下载任务并在后台跑。
pub fn enqueue_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    source: SongSource,
    quality: Quality,
    analyze: bool,
    dest_dir: String,
    hold: bool,
) -> DownloadTask {
    let external_preparation = state
        .provider(source.platform)
        .is_some_and(|provider| provider.capabilities().external_download_preparation);
    let requested_dest = dest_dir;
    let output_dir = if requested_dest.trim().is_empty() {
        state.config.download_dir().to_string_lossy().into_owned()
    } else {
        requested_dest.clone()
    };
    let task = new_task(
        TaskKind::Audio,
        source.platform,
        source.key.clone(),
        &source.title,
        &source.artist_text(),
        quality.as_str().to_string(),
        requested_dest,
        output_dir.clone(),
        source.cover.clone(),
    );
    let cancel = CancellationToken::new();
    manager.insert_with_retry(
        task.clone(),
        cancel.clone(),
        Some(AudioRetry {
            source: source.clone(),
            quality,
            analyze,
            dest_dir: output_dir.clone(),
            external_preparation,
        }),
        None,
    );
    let queued_generation = manager.start_generation();

    let id = task.id.clone();
    tokio::spawn(async move {
        run_audio(state, manager, id, cancel, queued_generation, !hold, false).await;
    });
    task
}

/// 用原任务冻结的来源、音质和目标目录重新执行一条失败的歌曲下载。
/// 沿用任务 id，前端不需要先删旧行再插新行；用户主动点击重试时立即开始，
/// 不受“自动下载”开关影响。
pub fn retry_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: &str,
) -> Result<DownloadTask> {
    let (task, _retry, cancel) = manager.prepare_audio_retry(id)?;
    let task_id = task.id.clone();
    let queued_generation = manager.start_generation();
    tokio::spawn(async move {
        run_audio(
            state,
            manager,
            task_id,
            cancel,
            queued_generation,
            true,
            true,
        )
        .await;
    });
    Ok(task)
}

/// 用原任务冻结的视频参数重新执行失败项，并沿用原 id/排序位置。
pub fn retry_video(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: &str,
) -> Result<DownloadTask> {
    let (task, _retry, cancel) = manager.prepare_video_retry(id)?;
    let task_id = task.id.clone();
    let queued_generation = manager.start_generation();
    tokio::spawn(async move {
        run_video(
            state,
            manager,
            task_id,
            cancel,
            queued_generation,
            true,
            true,
        )
        .await;
    });
    Ok(task)
}

/// 单条重试的统一入口；行内“重试”和队列“开始”都走同一套状态重置。
pub fn retry_task(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: &str,
) -> Result<DownloadTask> {
    match manager.get(id).context("任务不存在")?.kind {
        TaskKind::Audio => retry_audio(state, manager, id),
        TaskKind::Video => retry_video(state, manager, id),
    }
}

/// 重新开始当前快照里所有暂停或可重试的失败媒体。单条可能被另一个点击抢先，
/// 这种竞态直接跳过即可，其余任务仍照常启动。
pub fn restart_inactive_tasks(state: Arc<AppState>, manager: Arc<DownloadManager>) -> usize {
    manager
        .restartable_ids()
        .into_iter()
        .filter(|id| retry_task(state.clone(), manager.clone(), id).is_ok())
        .count()
}

#[allow(clippy::too_many_arguments)]
async fn run_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: String,
    cancel: CancellationToken,
    queued_generation: u64,
    allow_auto_start: bool,
    start_immediately: bool,
) {
    if !start_immediately
        && !wait_until_started(&manager, &cancel, queued_generation, allow_auto_start).await
    {
        return;
    }
    let Some(_permit) = acquire_download_permit(&manager, &cancel).await else {
        return;
    };
    if cancel.is_cancelled() {
        return;
    }
    let Some(retry) = manager.start_audio(&id) else {
        return;
    };
    let AudioRetry {
        source,
        quality,
        analyze,
        dest_dir,
        external_preparation,
    } = retry;
    if let Err(message) = validate_download_target(Path::new(&dest_dir)) {
        manager.settle(&id, TaskState::Failed, &message);
        return;
    }
    if external_preparation && !wait_for_prepared_source(&manager, &id, &cancel).await {
        if cancel.is_cancelled() {
            manager.settle(&id, TaskState::Canceled, "已取消");
        } else {
            manager.settle(&id, TaskState::Failed, "下载来源未及时就绪，请重试");
        }
        return;
    }
    manager.phase(
        &id,
        if external_preparation {
            // YTM 的受保护来源在准备路由里已经按真实网络字节完整落盘；provider
            // 接下来只做容器整理/搬运，不能让 UI 从 100% 又退回“解析中”。
            TaskPhase::PostProcessing
        } else {
            TaskPhase::Resolving
        },
    );
    let Some(provider) = state.provider(source.platform).cloned() else {
        manager.settle(
            &id,
            TaskState::Failed,
            &format!("平台 {} 不可用（provider 未加载）", source.platform),
        );
        return;
    };

    // 进度回调跨线程：闭包捕获 Arc 后在 provider 的下载循环里被调用
    let progress_manager = manager.clone();
    let progress_id = id.clone();
    let progress = Arc::new(move |downloaded: u64, total: u64| {
        progress_manager.progress(&progress_id, downloaded, total);
    });

    let prepared_source_url = manager.take_prepared_source_url(&id);
    let job = DownloadJob::new(&source, quality)
        .with_cancel(cancel.clone())
        .with_progress(progress)
        .with_prepared_source_url(prepared_source_url.as_deref());
    // Provider 的解析阶段通常在等一个平台 HTTP 请求，未必有自己的取消检查点。
    // 直接等它返回会继续占住下载并发；在任务层竞速 token，取消即可丢弃请求 future。
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
            return;
        }
        result = provider.download(job) => result,
    };

    match result {
        // 取消是协作式的，provider 有可能在收到取消之前就把最后一块下完了。
        // 这时候不能当成成功：那样队列里会从「已取消」跳回「已完成」，
        // 而且这首歌还会被入库——用户点的明明是取消。
        Ok(_) if cancel.is_cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Ok(path) => {
            manager.phase(&id, TaskPhase::Relocating);
            let path = match relocate_download(&path, &dest_dir) {
                Ok(path) => path,
                Err(message) => {
                    manager.settle(
                        &id,
                        TaskState::Failed,
                        &format!("已下载但移入目标文件夹失败：{message}"),
                    );
                    return;
                }
            };
            if cancel.is_cancelled() {
                manager.settle(&id, TaskState::Canceled, "已取消");
                return;
            }
            // 音频已经完整落到目标目录，先释放下载并发槽。歌词接口可能很慢，
            // 不该让网络取词占住一个下载名额、挡住队列里的下一首。
            drop(_permit);

            // 歌词很小，下载完成后一律按精确平台 key 缓存，不再受设置开关控制。
            // 歌曲本体已经完成后，歌词失败只记日志，不影响下载任务成功。
            manager.phase(&id, TaskPhase::PostProcessing);
            let lyric = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    manager.settle(&id, TaskState::Canceled, "已取消");
                    return;
                }
                lyric = provider.lyric(&source.key) => lyric,
            };
            match lyric {
                Ok(Some(text)) => {
                    if !crate::lyrics::lyric_timeline_compatible(
                        source.duration,
                        &text.lrc,
                        &text.word_lrc,
                    ) {
                        tracing::warn!(
                            platform = source.platform.as_str(),
                            key = source.key,
                            title = source.title,
                            "下载后的歌词时间轴超出音频时长，跳过缓存"
                        );
                    } else {
                        let cached = kdj_library::folders::StoredLyrics {
                            lrc: text.lrc,
                            word_lrc: text.word_lrc,
                            translated_lrc: text.translated_lrc,
                            romaji_lrc: text.romaji_lrc,
                            platform: source.platform.as_str().to_string(),
                            key: source.key.clone(),
                            title: source.title.clone(),
                            artist: source.artist_text(),
                            score: 1.0,
                        };
                        if let Err(err) = kdj_library::folders::write_lyrics_cache(
                            &path,
                            source.platform.as_str(),
                            &source.key,
                            &cached,
                        ) {
                            tracing::warn!("下载后写歌词失败 {}：{err:#}", path.display());
                        }
                    }
                }
                Ok(None) => {}
                Err(err) => tracing::warn!("下载后取歌词失败 {}：{err:#}", source.title),
            }
            if cancel.is_cancelled() {
                manager.settle(&id, TaskState::Canceled, "已取消");
                return;
            }
            // 下载完立刻入库，并把来源信息带上，这样曲库里能看出这首是从哪来的
            manager.phase(&id, TaskPhase::Importing);
            let track_id =
                match state
                    .library
                    .upsert_file(&path, source.platform.as_str(), &source.key)
                {
                    Ok(id) => id,
                    Err(err) => {
                        let message = format!("文件已下载，但加入曲库失败：{err:#}");
                        tracing::error!("{} {}", message, path.display());
                        manager.fail_after_download(&id, &path, &message);
                        return;
                    }
                };
            manager.finish(&id, &path, Some(track_id));
            state.hub.publish_library_updated(&[track_id]);
            if analyze {
                match state.library.pending_analysis_ids(Some(&[track_id]), false) {
                    Ok(pending) if !pending.is_empty() => {
                        // 下载完顺手分析是后台活，「停止分析」应该停得掉
                        crate::jobs::spawn_analysis(state.clone(), pending, false);
                    }
                    Ok(_) => {}
                    Err(err) => tracing::warn!("取待分析队列失败：{err:#}"),
                }
            }
        }
        Err(err) if cancel.is_cancelled() => {
            tracing::debug!("下载取消：{err:#}");
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Err(err) => {
            let message = format!("{err:#}");
            // 失败原因走 settle → download.updated，队列面板就地显示；
            // 没有任何浮层通知，这里不再另发事件
            manager.settle(&id, TaskState::Failed, &message);
        }
    }
}

/// 入队时先挂什么标题。真名要发一次网络请求才知道，不能让 HTTP 请求等它。
///
/// 和 Python 的 `request.bvid or request.url or "视频"` 一致：**BV 号优先**，
/// 因为分享链接那一长串在队列面板上根本看不出是哪个视频。
fn video_placeholder_title(req: &VideoDownloadRequest) -> String {
    for candidate in [req.bvid.trim(), req.url.trim()] {
        if !candidate.is_empty() {
            return candidate.to_string();
        }
    }
    "视频".to_string()
}

fn local_youtube_hls_ticket(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    let ticket = url.path().strip_prefix("/api/video/youtube/hls/")?;
    (matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    ) && ticket.len() == 64
        && ticket.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| ticket.to_string())
}

/// 建一条视频下载任务。
pub fn enqueue_video(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    req: VideoDownloadRequest,
    hold: bool,
) -> DownloadTask {
    let external_preparation = state
        .provider(req.platform)
        .is_some_and(|provider| provider.capabilities().external_download_preparation);
    // 只要音轨时画质选项无意义，标成 audio；否则是 "1080p" 这样的高度
    let quality = if req.audio_only {
        "audio".to_string()
    } else {
        format!("{}p", req.max_height)
    };
    let explicit_dest = !req.dest_dir.trim().is_empty();
    let dest_dir = if explicit_dest {
        req.dest_dir.clone()
    } else {
        state.config.download_dir().to_string_lossy().into_owned()
    };
    let title = {
        let hint = req.title.trim();
        if hint.is_empty() {
            video_placeholder_title(&req)
        } else {
            hint.to_string()
        }
    };
    let platform = req.platform;
    let mut task = new_task(
        TaskKind::Video,
        platform,
        req.bvid.trim().to_string(),
        &title,
        req.artist.trim(),
        quality,
        req.dest_dir.clone(),
        dest_dir.clone(),
        req.cover.trim().to_string(),
    );
    if platform == Platform::Bilibili {
        task.video_page = Some(DownloadVideoPage {
            index: req.page_index,
            count: req.page_count,
            title: req.page_title.trim().to_string(),
        });
    }
    let cancel = CancellationToken::new();
    manager.insert_with_retry(
        task.clone(),
        cancel.clone(),
        None,
        Some(VideoRetry {
            request: req.clone(),
            output_dir: dest_dir.clone(),
            external_preparation,
        }),
    );
    let queued_generation = manager.start_generation();

    let id = task.id.clone();
    tokio::spawn(run_video(
        state,
        manager,
        id,
        cancel,
        queued_generation,
        !hold,
        false,
    ));
    task
}

#[allow(clippy::too_many_arguments)]
async fn run_video(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: String,
    cancel: CancellationToken,
    queued_generation: u64,
    allow_auto_start: bool,
    start_immediately: bool,
) {
    if !start_immediately
        && !wait_until_started(&manager, &cancel, queued_generation, allow_auto_start).await
    {
        return;
    }
    let Some(_permit) = acquire_download_permit(&manager, &cancel).await else {
        return;
    };
    if cancel.is_cancelled() {
        return;
    }
    let Some(retry) = manager.start_video(&id) else {
        return;
    };
    let VideoRetry {
        request: req,
        output_dir: dest_dir,
        external_preparation,
    } = retry;
    let platform = req.platform;
    let explicit_dest = !req.dest_dir.trim().is_empty();
    if let Err(message) = validate_download_target(Path::new(&dest_dir)) {
        manager.settle(&id, TaskState::Failed, &message);
        return;
    }
    let Some(video_provider) = state.video_provider(platform).cloned() else {
        manager.settle(&id, TaskState::Failed, "视频 Provider 不可用");
        return;
    };

    // 先解析一次拿标题：队列里挂个 BV 号用户根本认不出是哪个视频。
    // 放在这里而不是放在 HTTP 处理函数里：B 站这一跳可能要好几秒（限流时更久），
    // 同步等的话「点下载」按钮要卡住那么久才回应。解析失败不影响下载。
    // 探针优先用 url：用户贴的短链里带 p= 分 P 信息，bvid 没有。
    let probe = if req.url.trim().is_empty() {
        req.bvid.clone()
    } else {
        req.url.clone()
    };
    let resolved = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
            return;
        }
        resolved = video_provider.resolve_video(&probe) => resolved,
    };
    let mut resolved_source_key = req.bvid.trim().to_string();
    match resolved {
        Ok(info) => {
            if !info.bvid.trim().is_empty() {
                resolved_source_key = info.bvid.trim().to_string();
            }
            manager.apply_video_resolution(&id, &info);
        }
        Err(err) => tracing::debug!("视频信息预解析失败（不影响下载）：{err:#}"),
    }
    if external_preparation {
        manager.phase(&id, TaskPhase::Authorizing);
        if !wait_for_prepared_source(&manager, &id, &cancel).await {
            if cancel.is_cancelled() {
                manager.settle(&id, TaskState::Canceled, "已取消");
            } else {
                manager.settle(&id, TaskState::Failed, "下载来源未及时就绪，请重试");
            }
            return;
        }
    }
    let progress_manager = manager.clone();
    let progress_id = id.clone();
    let progress: kdj_providers::ProgressSink = Arc::new(move |downloaded: u64, total: u64| {
        progress_manager.progress(&progress_id, downloaded, total);
    });

    let prepared_source_url = manager.take_prepared_source_url(&id);
    let prepared_hls_ticket = prepared_source_url
        .as_deref()
        .and_then(local_youtube_hls_ticket);
    let downloaded = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            if let Some(ticket) = prepared_hls_ticket.as_deref() {
                state.cancel_youtube_hls_resource(ticket);
            }
            manager.settle(&id, TaskState::Canceled, "已取消");
            return;
        }
        downloaded = video_provider.download_video_prepared(
            &req,
            &cancel,
            &progress,
            prepared_source_url.as_deref(),
        ) => downloaded,
    };
    if let Some(ticket) = prepared_hls_ticket.as_deref() {
        state.cancel_youtube_hls_resource(ticket);
    }
    match downloaded {
        // 和音频一路同理：取消撞上"最后一块刚好下完"不能算成功
        Ok(_) if cancel.is_cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Ok(path) => {
            manager.phase(&id, TaskPhase::Relocating);
            let path = match relocate_download(&path, &dest_dir) {
                Ok(path) => path,
                Err(message) => {
                    manager.settle(
                        &id,
                        TaskState::Failed,
                        &format!("已下载但移入目标文件夹失败：{message}"),
                    );
                    return;
                }
            };
            if cancel.is_cancelled() {
                manager.settle(&id, TaskState::Canceled, "已取消");
                return;
            }
            // 只要音轨：进曲库。完整视频默认不进（免得搅乱曲库），
            // 但拖进某个文件夹时用户就是要它出现在那里——dest_dir 非空也入库。
            let should_import = req.audio_only || explicit_dest;
            let track_id = if should_import {
                manager.phase(&id, TaskPhase::Importing);
                match state
                    .library
                    .upsert_file(&path, platform.as_str(), &resolved_source_key)
                {
                    Ok(id) => Some(id),
                    Err(err) => {
                        let message = format!("视频已下载，但加入曲库失败：{err:#}");
                        tracing::error!("{} {}", message, path.display());
                        manager.fail_after_download(&id, &path, &message);
                        return;
                    }
                }
            } else {
                None
            };
            manager.finish(&id, &path, track_id);
            if let Some(track_id) = track_id {
                state.hub.publish_library_updated(&[track_id]);
            }
        }
        Err(err) if cancel.is_cancelled() => {
            tracing::debug!("视频下载取消：{err:#}");
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Err(err) => {
            let message = format!("{err:#}");
            // 同上：settle 已把原因带给队列面板，不再另发浮层事件
            manager.settle(&id, TaskState::Failed, &message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> DownloadManager {
        DownloadManager::new(EventHub::default(), 3, true)
    }

    fn sample_task(id: &str, state: TaskState, created_at: f64) -> DownloadTask {
        DownloadTask {
            id: id.into(),
            kind: TaskKind::Audio,
            platform: Platform::Wyy,
            source_key: String::new(),
            title: "t".into(),
            artist: String::new(),
            quality: "flac".into(),
            state,
            phase: if state == TaskState::Done {
                TaskPhase::Completed
            } else {
                TaskPhase::Waiting
            },
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bps: 0.0,
            path: String::new(),
            error: String::new(),
            track_id: None,
            dest_dir: String::new(),
            output_dir: String::new(),
            cover: String::new(),
            video_page: None,
            created_at,
            updated_at: created_at,
        }
    }

    fn sample_audio_retry(external_preparation: bool) -> AudioRetry {
        AudioRetry {
            source: SongSource {
                platform: Platform::Ytm,
                key: "source-key".into(),
                title: "song".into(),
                artists: vec!["artist".into()],
                album: String::new(),
                duration: None,
                cover: String::new(),
                max_quality: Some(Quality::Flac),
                vip: false,
                payload: Default::default(),
            },
            quality: Quality::Flac,
            analyze: true,
            dest_dir: "/tmp/music".into(),
            external_preparation,
        }
    }

    fn journal_path(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "kdj-download-journal-{name}-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        (root.join("download-queue.json"), root)
    }

    #[test]
    fn unfinished_downloads_restore_paused_with_retry_parameters() {
        let (path, root) = journal_path("resume");
        {
            let manager =
                DownloadManager::open(EventHub::default(), 2, false, path.clone()).unwrap();
            let mut task = sample_task("resume", TaskState::Queued, 1.0);
            task.kind = TaskKind::Audio;
            task.platform = Platform::Ytm;
            manager.insert_with_retry(
                task,
                CancellationToken::new(),
                Some(sample_audio_retry(true)),
                None,
            );
            manager.start_audio("resume").unwrap();
            manager.progress("resume", 62, 100);
            manager
                .attach_prepared_source("resume", 1, "https://temporary.invalid/media".into())
                .unwrap();
        }

        let reopened = DownloadManager::open(EventHub::default(), 2, false, path).unwrap();
        let task = reopened.get("resume").unwrap();
        assert_eq!(task.state, TaskState::Paused);
        assert_eq!(task.phase, TaskPhase::Waiting);
        assert_eq!(reopened.restartable_ids(), vec!["resume"]);
        assert!(reopened.pending_download_preparations().is_empty());
        reopened.prepare_audio_retry("resume").unwrap();
        reopened.start_audio("resume").unwrap();
        assert_eq!(
            reopened.pending_download_preparations()[0].id(),
            "resume",
            "短期媒体 URL 不能跨重启复用，必须重新准备"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_history_and_removal_survive_reopen() {
        let (path, root) = journal_path("terminal");
        {
            let manager =
                DownloadManager::open(EventHub::default(), 2, false, path.clone()).unwrap();
            manager.insert(
                sample_task("done", TaskState::Done, 1.0),
                CancellationToken::new(),
            );
        }
        {
            let manager =
                DownloadManager::open(EventHub::default(), 2, false, path.clone()).unwrap();
            assert_eq!(manager.get("done").unwrap().state, TaskState::Done);
            assert!(manager.remove_finished("done").is_some());
        }
        let reopened = DownloadManager::open(EventHub::default(), 2, false, path).unwrap();
        assert!(reopened.get("done").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_video_history_recovers_the_bilibili_share_key() {
        let mut task = sample_task("bili-share", TaskState::Done, 1.0);
        task.kind = TaskKind::Video;
        task.platform = Platform::Bilibili;
        let persisted = PersistedEntry {
            task,
            audio_retry: None,
            video_retry: Some(VideoRetry {
                request: VideoDownloadRequest {
                    platform: Platform::Bilibili,
                    bvid: "BV1eiXRYHEzL".into(),
                    page_index: 2,
                    ..Default::default()
                },
                output_dir: "/video".into(),
                external_preparation: false,
            }),
        };

        let (_, restored) = persisted.restore().expect("队列记录应可恢复");
        assert_eq!(restored.task.source_key, "BV1eiXRYHEzL");
        assert_eq!(
            restored.task.video_page.as_ref().map(|page| page.index),
            Some(2)
        );
    }

    #[test]
    fn bilibili_resolution_writes_the_real_page_label_into_the_task() {
        let manager = manager();
        let mut task = sample_task("bili-p3", TaskState::Queued, 1.0);
        task.kind = TaskKind::Video;
        task.platform = Platform::Bilibili;
        manager.insert(task, CancellationToken::new());
        manager.attach_video_retry(
            "bili-p3",
            VideoRetry {
                request: VideoDownloadRequest {
                    platform: Platform::Bilibili,
                    bvid: "BV1L94y1H7CV".into(),
                    page_index: 2,
                    ..Default::default()
                },
                output_dir: "/video".into(),
                external_preparation: false,
            },
        );

        manager.apply_video_resolution(
            "bili-p3",
            &VideoInfo {
                platform: Platform::Bilibili,
                bvid: "BV1L94y1H7CV".into(),
                title: "合集".into(),
                author: "UP主".into(),
                cover: String::new(),
                duration: 360,
                pages: vec![
                    kdj_core::models::VideoPage {
                        index: 0,
                        title: "第一段".into(),
                        duration: 120,
                    },
                    kdj_core::models::VideoPage {
                        index: 1,
                        title: "第二段".into(),
                        duration: 120,
                    },
                    kdj_core::models::VideoPage {
                        index: 2,
                        title: "第三段".into(),
                        duration: 120,
                    },
                ],
                options: Vec::new(),
                logged_in: false,
            },
        );

        let task = manager.get("bili-p3").expect("任务仍在队列中");
        let page = task.video_page.expect("B 站任务应公开分 P");
        assert_eq!(page.index, 2);
        assert_eq!(page.count, 3);
        assert_eq!(page.title, "第三段");
    }

    #[test]
    fn corrupt_download_journal_is_quarantined_instead_of_blocking_startup() {
        let (path, root) = journal_path("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, b"{ definitely not json").unwrap();

        let manager = DownloadManager::open(EventHub::default(), 2, false, path.clone()).unwrap();
        assert!(manager.list().is_empty());
        assert!(path.is_file(), "启动后要建立新的空 journal");
        assert!(fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_download_journal_is_quarantined_before_it_is_read() {
        let (path, root) = journal_path("oversized");
        fs::create_dir_all(&root).unwrap();
        let file = fs::File::create(&path).unwrap();
        file.set_len(DOWNLOAD_JOURNAL_MAX_BYTES + 1).unwrap();
        drop(file);

        let manager = DownloadManager::open(EventHub::default(), 2, false, path.clone()).unwrap();

        assert!(manager.list().is_empty());
        assert!(path.is_file());
        assert!(fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_audio_can_be_reset_with_its_original_retry_parameters() {
        let manager = manager();
        let cancel = CancellationToken::new();
        let mut task = sample_task("retry", TaskState::Failed, 1.0);
        task.progress = 0.8;
        task.downloaded_bytes = 800;
        task.total_bytes = 1000;
        task.error = "网络失败".into();
        manager.insert(task, cancel);
        manager.attach_audio_retry(
            "retry",
            AudioRetry {
                source: SongSource {
                    platform: Platform::Wyy,
                    key: "123".into(),
                    title: "song".into(),
                    artists: vec!["artist".into()],
                    album: String::new(),
                    duration: None,
                    cover: String::new(),
                    max_quality: None,
                    vip: false,
                    payload: Default::default(),
                },
                quality: Quality::Flac,
                analyze: true,
                dest_dir: "/music".into(),
                external_preparation: false,
            },
        );

        assert_eq!(manager.restartable_ids(), vec!["retry"]);
        let (task, retry, fresh_cancel) = manager.prepare_audio_retry("retry").unwrap();
        assert_eq!(task.state, TaskState::Queued);
        assert_eq!(task.progress, 0.0);
        assert_eq!(task.downloaded_bytes, 0);
        assert_eq!(task.total_bytes, 0);
        assert!(task.error.is_empty());
        assert_eq!(retry.source.key, "123");
        assert_eq!(retry.dest_dir, "/music");
        assert!(!fresh_cancel.is_cancelled());
        assert!(manager.restartable_ids().is_empty());
        assert!(manager.prepare_audio_retry("retry").is_err());
    }

    #[test]
    fn queued_audio_quality_updates_the_task_and_worker_parameters_together() {
        let manager = manager();
        manager.insert(
            sample_task("quality", TaskState::Queued, 1.0),
            CancellationToken::new(),
        );
        manager.attach_audio_retry(
            "quality",
            AudioRetry {
                source: SongSource {
                    platform: Platform::Wyy,
                    key: "123".into(),
                    title: "song".into(),
                    artists: vec!["artist".into()],
                    album: String::new(),
                    duration: None,
                    cover: String::new(),
                    max_quality: None,
                    vip: false,
                    payload: Default::default(),
                },
                quality: Quality::Flac,
                analyze: true,
                dest_dir: "/music".into(),
                external_preparation: false,
            },
        );

        let task = manager
            .set_queued_audio_quality("quality", Quality::Q128)
            .unwrap();
        assert_eq!(task.quality, "128");
        let retry = manager.start_audio("quality").unwrap();
        assert_eq!(retry.quality, Quality::Q128);
        assert!(manager
            .set_queued_audio_quality("quality", Quality::Q320)
            .is_err());
    }

    #[test]
    fn failed_video_can_be_reset_with_its_original_request() {
        let manager = manager();
        let mut task = sample_task("video-retry", TaskState::Failed, 1.0);
        task.kind = TaskKind::Video;
        task.platform = Platform::Bilibili;
        task.error = "网络失败".into();
        manager.insert(task, CancellationToken::new());
        manager.attach_video_retry(
            "video-retry",
            VideoRetry {
                request: VideoDownloadRequest {
                    platform: Platform::Bilibili,
                    bvid: "BV1example".into(),
                    max_height: 1440,
                    ..Default::default()
                },
                output_dir: "/video".into(),
                external_preparation: false,
            },
        );

        assert_eq!(manager.restartable_ids(), vec!["video-retry"]);
        let updated = manager
            .set_pending_video_height("video-retry", 720)
            .unwrap();
        assert_eq!(updated.quality, "720p");
        let (task, retry, cancel) = manager.prepare_video_retry("video-retry").unwrap();
        assert_eq!(task.state, TaskState::Queued);
        assert!(task.error.is_empty());
        assert_eq!(retry.request.max_height, 720);
        assert_eq!(retry.output_dir, "/video");
        assert!(!cancel.is_cancelled());
        let retry = manager.start_video("video-retry").unwrap();
        assert_eq!(retry.request.max_height, 720);
        assert_eq!(
            manager.get("video-retry").unwrap().phase,
            TaskPhase::Resolving
        );
    }

    #[test]
    fn url_only_youtube_video_is_resolved_before_external_preparation() {
        let manager = manager();
        let mut task = sample_task("youtube-url", TaskState::Queued, 1.0);
        task.kind = TaskKind::Video;
        task.platform = Platform::Youtube;
        task.title = "https://youtu.be/dQw4w9WgXcQ".into();
        manager.insert(task, CancellationToken::new());
        manager.attach_video_retry(
            "youtube-url",
            VideoRetry {
                request: VideoDownloadRequest {
                    platform: Platform::Youtube,
                    url: "https://youtu.be/dQw4w9WgXcQ".into(),
                    max_height: 1080,
                    ..Default::default()
                },
                output_dir: "/video".into(),
                external_preparation: true,
            },
        );

        manager.start_video("youtube-url").unwrap();
        assert!(manager.pending_download_preparations().is_empty());
        manager.apply_video_resolution(
            "youtube-url",
            &VideoInfo {
                platform: Platform::Youtube,
                bvid: "dQw4w9WgXcQ".into(),
                title: "resolved title".into(),
                author: "resolved author".into(),
                cover: "https://i.ytimg.com/cover.jpg".into(),
                duration: 180,
                pages: Vec::new(),
                options: Vec::new(),
                logged_in: true,
            },
        );
        manager.phase("youtube-url", TaskPhase::Authorizing);

        let pending = manager.pending_download_preparations();
        let PendingDownloadPreparation::Video { request, .. } = &pending[0] else {
            panic!("YouTube 视频应返回视频准备请求");
        };
        assert_eq!(request.bvid, "dQw4w9WgXcQ");
        let task = manager.get("youtube-url").unwrap();
        assert_eq!(task.source_key, request.bvid);
        assert_eq!(task.title, "resolved title");
    }

    #[test]
    fn task_phase_exposes_one_platform_neutral_lifecycle() {
        let manager = manager();
        manager.insert(
            sample_task("phase", TaskState::Queued, 1.0),
            CancellationToken::new(),
        );
        manager.start("phase", TaskPhase::Resolving);
        let resolving = manager.get("phase").unwrap();
        assert_eq!(resolving.state, TaskState::Running);
        assert_eq!(resolving.phase, TaskPhase::Resolving);

        manager.progress("phase", 128, 1_024);
        assert_eq!(manager.get("phase").unwrap().phase, TaskPhase::Downloading);

        manager.progress("phase", 1_024, 1_024);
        let processing = manager.get("phase").unwrap();
        assert_eq!(processing.state, TaskState::Processing);
        assert_eq!(processing.phase, TaskPhase::PostProcessing);

        manager.settle("phase", TaskState::Done, "");
        assert_eq!(manager.get("phase").unwrap().phase, TaskPhase::Completed);
    }

    #[test]
    fn entering_download_bypasses_byte_progress_throttling() {
        let hub = EventHub::default();
        let mut events = hub.subscribe();
        let manager = DownloadManager::new(hub, 1, true);
        manager.insert(
            sample_task("phase-event", TaskState::Queued, 1.0),
            CancellationToken::new(),
        );
        manager.start("phase-event", TaskPhase::Resolving);
        while events.try_recv().is_ok() {}

        // 0 / 0 是 HLS 等未知总量下载的真实起点；即使字节尚未前进也要立即通知 UI。
        manager.progress("phase-event", 0, 0);
        let event = events.try_recv().expect("下载阶段切换应立即广播");
        assert!(event.contains(r#""phase":"downloading""#), "{event}");
    }

    #[test]
    fn externally_prepared_sources_cover_task_lifecycle_and_are_consumed_once() {
        let manager = manager();
        for (id, created_at) in [("later", 2.0), ("first", 1.0)] {
            let mut task = sample_task(id, TaskState::Queued, created_at);
            task.platform = Platform::Ytm;
            manager.insert(task, CancellationToken::new());
            manager.attach_audio_retry(
                id,
                AudioRetry {
                    source: SongSource {
                        platform: Platform::Ytm,
                        key: format!("key-{id}"),
                        title: id.into(),
                        artists: vec!["artist".into()],
                        album: String::new(),
                        duration: None,
                        cover: String::new(),
                        max_quality: None,
                        vip: false,
                        payload: Default::default(),
                    },
                    quality: Quality::Q320,
                    analyze: false,
                    dest_dir: String::new(),
                    external_preparation: true,
                },
            );
            manager.start_audio(id).unwrap();
        }

        let pending = manager.pending_download_preparations();
        assert_eq!(
            pending
                .iter()
                .map(PendingDownloadPreparation::id)
                .collect::<Vec<_>>(),
            vec!["first", "later"]
        );
        let failed = manager
            .fail_preparation("later", 1, "浏览器挑战失败")
            .unwrap();
        assert_eq!(failed.state, TaskState::Failed);
        assert_eq!(failed.phase, TaskPhase::Authorizing);
        assert_eq!(failed.error, "浏览器挑战失败");
        manager
            .attach_prepared_source("first", 1, "https://googlevideo.test/audio".into())
            .unwrap();
        assert_eq!(
            manager.take_prepared_source_url("first").as_deref(),
            Some("https://googlevideo.test/audio")
        );
        assert!(manager.take_prepared_source_url("first").is_none());

        let mut running = sample_task("running", TaskState::Queued, 3.0);
        running.platform = Platform::Ytm;
        manager.insert(running, CancellationToken::new());
        manager.attach_audio_retry(
            "running",
            AudioRetry {
                source: SongSource {
                    platform: Platform::Ytm,
                    key: "key-running".into(),
                    title: "running".into(),
                    artists: vec![],
                    album: String::new(),
                    duration: None,
                    cover: String::new(),
                    max_quality: None,
                    vip: false,
                    payload: Default::default(),
                },
                quality: Quality::Q128,
                analyze: false,
                dest_dir: String::new(),
                external_preparation: true,
            },
        );
        manager.start_audio("running").unwrap();
        manager
            .attach_prepared_source("running", 1, "https://googlevideo.test/audio".into())
            .unwrap();
        assert!(manager
            .attach_prepared_source("running", 1, "https://googlevideo.test/other".into())
            .is_err());
    }

    #[test]
    fn stale_preparation_cannot_overwrite_a_retried_task() {
        let manager = manager();
        let mut task = sample_task("attempt", TaskState::Queued, 1.0);
        task.platform = Platform::Ytm;
        manager.insert(task, CancellationToken::new());
        manager.attach_audio_retry("attempt", sample_audio_retry(true));
        manager.start_audio("attempt").unwrap();
        assert_eq!(manager.pause_all(), 1);
        manager.prepare_audio_retry("attempt").unwrap();
        manager.start_audio("attempt").unwrap();

        assert!(!manager.preparation_is_current("attempt", 1));
        assert!(manager.preparation_is_current("attempt", 2));
        assert!(manager
            .attach_prepared_source("attempt", 1, "https://stale.invalid/audio".into())
            .is_err());
        let still_running = manager
            .fail_preparation("attempt", 1, "旧请求迟到")
            .unwrap();
        assert_eq!(still_running.state, TaskState::Running);
        assert!(still_running.error.is_empty());
        manager
            .attach_prepared_source("attempt", 2, "https://current.invalid/audio".into())
            .unwrap();
    }

    #[test]
    fn tasks_are_listed_in_creation_order() {
        let manager = manager();
        manager.insert(
            sample_task("b", TaskState::Queued, 200.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("a", TaskState::Queued, 100.0),
            CancellationToken::new(),
        );
        let ids: Vec<String> = manager.list().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["a", "b"], "队列面板按入队时间排，不是按 id");
    }

    #[test]
    fn removing_one_finished_task_keeps_other_queue_history() {
        let manager = manager();
        manager.insert(
            sample_task("done", TaskState::Done, 1.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("running", TaskState::Running, 2.0),
            CancellationToken::new(),
        );
        assert!(manager.remove_finished("done").is_some());
        assert!(manager.get("done").is_none());
        assert!(manager.get("running").is_some());
        assert!(manager.remove_finished("running").is_none());
    }

    #[test]
    fn cancelling_a_finished_task_does_not_rewrite_it() {
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Done, 1.0),
            CancellationToken::new(),
        );
        let task = manager.cancel("x").unwrap();
        assert_eq!(task.state, TaskState::Done, "完成的任务不该被点成已取消");
    }

    #[test]
    fn cancelling_a_queued_task_removes_it_without_cancelled_history() {
        let manager = manager();
        let cancel = CancellationToken::new();
        manager.insert(sample_task("x", TaskState::Queued, 1.0), cancel.clone());
        let returned = manager.cancel("x").unwrap();
        assert_eq!(returned.state, TaskState::Queued);
        assert!(manager.get("x").is_none(), "尚未开始的任务应直接离开队列");
        assert!(
            cancel.is_cancelled(),
            "等待下载闸门的 worker 也必须被唤醒退出"
        );
    }

    #[test]
    fn cancelling_an_already_cancelled_task_is_idempotent() {
        // Python 的 TERMINAL_STATES 里含 canceled，重复点不该刷新时间戳
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Canceled, 1.0),
            CancellationToken::new(),
        );
        let task = manager.cancel("x").unwrap();
        assert_eq!(task.state, TaskState::Canceled);
        assert_eq!(task.updated_at, 1.0, "终态任务不该被再写一遍");
    }

    #[test]
    fn cancelling_a_running_task_marks_it_and_fires_the_token() {
        let manager = manager();
        let cancel = CancellationToken::new();
        manager.insert(sample_task("x", TaskState::Running, 1.0), cancel.clone());
        let task = manager.cancel("x").unwrap();
        assert_eq!(task.state, TaskState::Canceled);
        assert_eq!(task.error, "已取消");
        assert!(cancel.is_cancelled(), "下载循环要靠这个 token 停下来");
    }

    #[test]
    fn late_worker_updates_cannot_resurrect_a_cancelled_task() {
        let manager = manager();
        let cancel = CancellationToken::new();
        manager.insert(sample_task("x", TaskState::Running, 1.0), cancel);
        manager.cancel("x").unwrap();

        // 取消可能正好撞上 worker 的 start/phase，或已经到达的最后一个网络 chunk。
        manager.start("x", TaskPhase::Resolving);
        manager.phase("x", TaskPhase::Importing);
        manager.progress("x", 50, 100);

        let task = manager.get("x").unwrap();
        assert_eq!(task.state, TaskState::Canceled);
        assert_eq!(task.phase, TaskPhase::Waiting);
        assert_eq!(task.downloaded_bytes, 0);
        assert_eq!(task.progress, 0.0);
    }

    #[test]
    fn cancel_all_removes_queued_and_stops_every_active_task() {
        let manager = manager();
        let queued_cancel = CancellationToken::new();
        let running_cancel = CancellationToken::new();
        let processing_cancel = CancellationToken::new();
        manager.insert(
            sample_task("queued", TaskState::Queued, 1.0),
            queued_cancel.clone(),
        );
        manager.insert(
            sample_task("running", TaskState::Running, 2.0),
            running_cancel.clone(),
        );
        manager.insert(
            sample_task("processing", TaskState::Processing, 3.0),
            processing_cancel.clone(),
        );
        manager.insert(
            sample_task("done", TaskState::Done, 4.0),
            CancellationToken::new(),
        );

        assert_eq!(manager.cancel_all(), 3);
        assert!(manager.get("queued").is_none());
        assert_eq!(manager.get("running").unwrap().state, TaskState::Canceled);
        assert_eq!(
            manager.get("processing").unwrap().state,
            TaskState::Canceled
        );
        assert_eq!(manager.get("done").unwrap().state, TaskState::Done);
        assert!(queued_cancel.is_cancelled());
        assert!(running_cancel.is_cancelled());
        assert!(processing_cancel.is_cancelled());
    }

    #[test]
    fn pause_all_keeps_tasks_restartable_and_blocks_late_worker_updates() {
        let manager = manager();
        let queued_cancel = CancellationToken::new();
        let running_cancel = CancellationToken::new();
        manager.insert(
            sample_task("queued", TaskState::Queued, 1.0),
            queued_cancel.clone(),
        );
        manager.insert(
            sample_task("running", TaskState::Running, 2.0),
            running_cancel.clone(),
        );
        manager.attach_audio_retry(
            "running",
            AudioRetry {
                source: SongSource {
                    platform: Platform::Wyy,
                    key: "123".into(),
                    title: "song".into(),
                    artists: vec!["artist".into()],
                    album: String::new(),
                    duration: None,
                    cover: String::new(),
                    max_quality: None,
                    vip: false,
                    payload: Default::default(),
                },
                quality: Quality::Flac,
                analyze: true,
                dest_dir: "/music".into(),
                external_preparation: false,
            },
        );

        assert_eq!(manager.pause_all(), 2);
        assert!(queued_cancel.is_cancelled());
        assert!(running_cancel.is_cancelled());
        assert_eq!(manager.get("queued").unwrap().state, TaskState::Paused);
        assert_eq!(manager.get("running").unwrap().state, TaskState::Paused);

        // 暂停前的 worker 可能晚到一帧；这些回调都不能把 Paused 改成别的状态。
        manager.phase("running", TaskPhase::Importing);
        manager.progress("running", 100, 100);
        manager.settle("running", TaskState::Canceled, "已取消");
        assert_eq!(manager.get("running").unwrap().state, TaskState::Paused);

        assert_eq!(manager.restartable_ids(), vec!["running"]);
        let (task, retry, fresh_cancel) = manager.prepare_audio_retry("running").unwrap();
        assert_eq!(task.state, TaskState::Queued);
        assert_eq!(retry.source.key, "123");
        assert!(!fresh_cancel.is_cancelled());
    }

    #[test]
    fn clear_removes_every_inactive_task() {
        let manager = manager();
        manager.insert(
            sample_task("done", TaskState::Done, 1.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("failed", TaskState::Failed, 2.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("canceled", TaskState::Canceled, 3.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("running", TaskState::Running, 4.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("queued", TaskState::Queued, 5.0),
            CancellationToken::new(),
        );
        manager.insert(
            sample_task("paused", TaskState::Paused, 6.0),
            CancellationToken::new(),
        );

        assert_eq!(manager.clear_inactive(), 5);
        let ids: Vec<String> = manager.list().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["running"], "只有正在执行的任务不能被清掉");
    }

    #[test]
    fn progress_updates_compute_a_fraction() {
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.progress("x", 50, 200);
        let task = manager.get("x").unwrap();
        assert!((task.progress - 0.25).abs() < 1e-9);
        assert_eq!(task.downloaded_bytes, 50);
        assert_eq!(task.total_bytes, 200);
    }

    #[test]
    fn reaching_known_total_enters_processing_before_the_post_download_work() {
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.progress("x", 100, 100);
        let task = manager.get("x").unwrap();
        assert_eq!(task.state, TaskState::Processing);
        assert_eq!(task.progress, 1.0);
        assert_eq!(task.speed_bps, 0.0, "处理阶段不应留着旧下载速度");
    }

    #[test]
    fn progress_without_a_known_total_stays_at_zero() {
        // total=0 时 downloaded/total 是 NaN，前端拿它画进度条会整根消失
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.progress("x", 4096, 0);
        let task = manager.get("x").unwrap();
        assert_eq!(task.progress, 0.0);
        assert_eq!(task.downloaded_bytes, 4096);
    }

    #[test]
    fn progress_broadcasts_are_throttled() {
        // 一次下载每秒上百次回调，全广播会把 WS 打爆
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        let mut rx = manager.hub.subscribe();
        // 第一条永远放行，之后 250ms 内且进度前进不到 1% 的都要被吃掉
        for step in 0..200u64 {
            manager.progress("x", step, 1_000_000);
        }
        let mut seen = 0;
        while rx.try_recv().is_ok() {
            seen += 1;
        }
        assert!(seen <= 2, "200 次回调只该广播出个位数，实际 {seen}");
        assert_eq!(
            manager.get("x").unwrap().downloaded_bytes,
            199,
            "被节流掉的只是广播，任务本身要一直是最新的"
        );
    }

    #[test]
    fn a_one_percent_jump_is_broadcast_immediately() {
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        let mut rx = manager.hub.subscribe();
        manager.progress("x", 1, 100); // 第一条
        manager.progress("x", 2, 100); // +1% → 立刻放行
        let mut seen = 0;
        while rx.try_recv().is_ok() {
            seen += 1;
        }
        assert_eq!(seen, 2, "进度前进 1% 不该等满 250ms");
    }

    #[test]
    fn speed_uses_a_sliding_window_not_the_whole_download() {
        // 累计平均在网络变化时反应太慢：前 3 秒 1 B/s，之后飙到 1000 B/s，
        // 窗口内的读数必须是新的那一段
        let mut samples: VecDeque<(f64, u64)> = VecDeque::new();
        samples.push_back((0.0, 0));
        samples.push_back((10.0, 10));
        samples.push_back((11.0, 1010));
        assert_eq!(window_speed(&mut samples, 11.0), 1000.0);
        assert_eq!(samples.len(), 2, "超出 3 秒窗口的采样要被丢掉");
    }

    #[test]
    fn speed_is_zero_until_there_are_two_usable_samples() {
        let mut samples: VecDeque<(f64, u64)> = VecDeque::new();
        assert_eq!(window_speed(&mut samples, 0.0), 0.0);
        samples.push_back((0.0, 0));
        assert_eq!(window_speed(&mut samples, 0.0), 0.0, "只有一个点算不出速度");
        // 两个点挨得太近，分母趋零会算出天文数字
        samples.push_back((0.001, 8_000_000));
        assert_eq!(window_speed(&mut samples, 0.001), 0.0);
    }

    #[test]
    fn finishing_zeroes_the_speed_and_pins_progress() {
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.progress("x", 500, 1000);
        manager.finish("x", std::path::Path::new("/tmp/不存在的文件.mp3"), Some(7));
        let task = manager.get("x").unwrap();
        assert_eq!(task.state, TaskState::Done);
        assert_eq!(task.progress, 1.0);
        assert_eq!(task.speed_bps, 0.0, "完成的条目不能一直挂着最后的瞬时速度");
        assert_eq!(task.track_id, Some(7));
    }

    #[test]
    fn the_final_suffix_corrects_the_displayed_quality() {
        // provider 可能因为版权把 flac 降级成 mp3，队列里还写着 flac 就是撒谎
        let dir = std::env::temp_dir().join(format!("kdj-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("song.mp3");
        std::fs::write(&path, b"1234567890").unwrap();

        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.finish("x", &path, None);
        let task = manager.get("x").unwrap();
        assert_eq!(task.quality, "mp3");
        assert_eq!(task.downloaded_bytes, 10, "体积以最终文件为准");
        assert_eq!(task.total_bytes, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remuxed_opus_reports_the_final_format_and_size() {
        let dir = std::env::temp_dir().join(format!("kdj-opus-task-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("song.opus");
        std::fs::write(&path, b"remuxed").unwrap();

        let manager = manager();
        let mut task = sample_task("x", TaskState::Running, 1.0);
        task.total_bytes = 100;
        manager.insert(task, CancellationToken::new());
        manager.finish("x", &path, None);
        let task = manager.get("x").unwrap();
        assert_eq!(task.quality, "opus");
        assert_eq!(task.downloaded_bytes, 7);
        assert_eq!(task.total_bytes, 7, "完成后分母应改成重封装成品体积");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_quality_never_gets_overwritten_by_the_container() {
        // 视频那一栏写的是 "1080p"/"audio"，不该被 ".mp4" 改掉
        let manager = manager();
        let mut task = sample_task("v", TaskState::Running, 1.0);
        task.kind = TaskKind::Video;
        task.quality = "1080p".into();
        manager.insert(task, CancellationToken::new());
        manager.finish("v", std::path::Path::new("/tmp/x.mp4"), None);
        assert_eq!(manager.get("v").unwrap().quality, "1080p");
    }

    #[test]
    fn the_queue_is_capped_and_drops_the_oldest_finished_first() {
        let manager = manager();
        // 先放一条正在跑的老任务，它绝不能被裁掉
        manager.insert(
            sample_task("running", TaskState::Running, 0.0),
            CancellationToken::new(),
        );
        for i in 0..MAX_HISTORY + 10 {
            manager.insert(
                sample_task(&format!("done-{i:04}"), TaskState::Done, 1.0 + i as f64),
                CancellationToken::new(),
            );
        }
        let tasks = manager.list();
        assert_eq!(tasks.len(), MAX_HISTORY);
        assert!(
            tasks.iter().any(|task| task.id == "running"),
            "正在跑的任务不能因为超限被丢掉"
        );
        assert!(
            !tasks.iter().any(|task| task.id == "done-0000"),
            "该从最老的终态任务开始丢"
        );
    }

    #[test]
    fn a_full_queue_of_running_tasks_is_not_trimmed() {
        let manager = manager();
        for i in 0..MAX_HISTORY + 5 {
            manager.insert(
                sample_task(&format!("run-{i:04}"), TaskState::Running, i as f64),
                CancellationToken::new(),
            );
        }
        assert_eq!(
            manager.list().len(),
            MAX_HISTORY + 5,
            "没有终态任务可丢时宁可超限，也不能掐掉正在下的"
        );
    }

    #[test]
    fn empty_titles_get_a_placeholder() {
        let task = new_task(
            TaskKind::Audio,
            Platform::Wyy,
            String::new(),
            "",
            "",
            "flac".into(),
            String::new(),
            String::new(),
            String::new(),
        );
        assert_eq!(task.title, "未命名");
    }

    #[test]
    fn download_target_must_exist_and_be_writable() {
        let root = std::env::temp_dir().join(format!(
            "kdj-download-target-{}-{:08x}",
            std::process::id(),
            rand::random::<u32>()
        ));
        assert!(validate_download_target(&root).is_err());
        std::fs::create_dir_all(&root).unwrap();
        validate_download_target(&root).unwrap();
        assert!(
            std::fs::read_dir(&root).unwrap().next().is_none(),
            "写入探针完成后不能在下载目录留下垃圾"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_downloaded_file_that_failed_to_enter_the_library_is_not_reported_done() {
        let dir = std::env::temp_dir().join(format!("kdj-import-failed-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("kept.mp4");
        std::fs::write(&path, b"complete file").unwrap();

        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Running, 1.0),
            CancellationToken::new(),
        );
        manager.fail_after_download("x", &path, "加入曲库失败");

        let task = manager.get("x").unwrap();
        assert_eq!(task.state, TaskState::Failed, "入库失败不能对用户谎报完成");
        assert_eq!(
            task.path,
            path.to_string_lossy(),
            "成品路径必须保住，方便定位和补救"
        );
        assert_eq!(task.error, "加入曲库失败");
        assert!(task.downloaded_bytes > 0, "已经下完的体积不能清零");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finishing_a_cancelled_task_does_not_bring_it_back() {
        // 取消是协作式的：点了取消之后最后一块可能正好下完。
        // 不挡住的话队列里会从「已取消」跳回「已完成」，歌还被入了库
        let manager = manager();
        manager.insert(
            sample_task("x", TaskState::Canceled, 1.0),
            CancellationToken::new(),
        );
        manager.finish("x", std::path::Path::new("/tmp/x.mp3"), Some(9));
        let task = manager.get("x").unwrap();
        assert_eq!(task.state, TaskState::Canceled);
        assert_eq!(task.track_id, None, "取消掉的不该入库");
        assert_eq!(task.updated_at, 1.0, "终态任务不该被再写一遍");
    }

    #[test]
    fn setting_the_same_concurrency_keeps_the_current_gate() {
        // 前端改任何一项设置都会 PUT /api/settings。每次都换掉信号量的话，
        // 正在下的那几条还攥着旧闸门的令牌，新闸门却是满额的——并发悄悄翻倍
        let manager = manager();
        let before = manager.permits();
        manager.set_concurrency(3);
        assert!(
            Arc::ptr_eq(&before, &manager.permits()),
            "值没变就不能换闸门"
        );

        manager.set_concurrency(5);
        let after = manager.permits();
        assert!(!Arc::ptr_eq(&before, &after), "值变了才重建");
        assert_eq!(after.available_permits(), 5);

        // 0 会把闸门焊死，一条也下不动
        manager.set_concurrency(0);
        assert_eq!(manager.permits().available_permits(), 1);
    }

    #[test]
    fn video_tasks_start_out_labelled_with_the_bv_number() {
        // 真标题要发一次网络请求才知道，那一跳在任务线程里做；
        // 入队这一刻先挂 BV 号，别让队列面板空一行
        let req = |url: &str, bvid: &str| VideoDownloadRequest {
            url: url.into(),
            bvid: bvid.into(),
            ..Default::default()
        };
        assert_eq!(
            video_placeholder_title(&req("https://b23.tv/x", "BV1")),
            "BV1"
        );
        assert_eq!(
            video_placeholder_title(&req("https://b23.tv/x", "")),
            "https://b23.tv/x"
        );
        assert_eq!(video_placeholder_title(&req("", "")), "视频");
    }

    #[test]
    fn unknown_ids_are_reported_rather_than_panicking() {
        let manager = manager();
        assert!(manager.cancel("nope").is_none());
        assert!(manager.get("nope").is_none());
        manager.progress("nope", 1, 2);
        manager.finish("nope", std::path::Path::new("/tmp/x"), None);
    }

    #[tokio::test]
    async fn tasks_are_held_while_auto_start_is_off() {
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 3, false));
        let cancel = CancellationToken::new();
        let waiter = {
            let manager = manager.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                wait_until_started(&manager, &cancel, manager.start_generation(), true).await
            })
        };
        // 开关关着就该一直挂着
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "自动下载关着时任务必须停在队列里");

        manager.set_auto_start(true);
        assert!(waiter.await.unwrap(), "拨开开关就要放行");
    }

    #[tokio::test]
    async fn a_held_task_that_gets_cancelled_never_starts() {
        // 攒着的任务被取消后，之后拨开开关不能把它复活
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 3, false));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(!wait_until_started(&manager, &cancel, manager.start_generation(), true).await);
    }

    #[tokio::test]
    async fn task_level_hold_ignores_global_auto_start_until_explicit_release() {
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 3, true));
        let cancel = CancellationToken::new();
        let queued_generation = manager.start_generation();
        let waiter = {
            let manager = manager.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                wait_until_started(&manager, &cancel, queued_generation, false).await
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "任务级 hold 必须覆盖全局自动下载");

        manager.release_queued();
        assert!(waiter.await.unwrap(), "显式开始必须仍能放行 held 任务");
    }

    #[tokio::test]
    async fn waiting_for_a_download_slot_is_immediately_cancellable() {
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 1, true));
        let held = manager.permits().acquire_owned().await.unwrap();
        let cancel = CancellationToken::new();
        let waiter = {
            let manager = manager.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { acquire_download_permit(&manager, &cancel).await.is_some() })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "并发槽被占用时 worker 应当等待");

        cancel.cancel();
        let acquired = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("取消后不应继续卡在信号量")
            .unwrap();
        assert!(!acquired);
        drop(held);
    }

    #[tokio::test]
    async fn one_shot_start_does_not_release_future_tasks() {
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 3, false));
        let old_generation = manager.start_generation();
        manager.release_queued();
        assert!(
            wait_until_started(&manager, &CancellationToken::new(), old_generation, true,).await,
            "点击开始应放行点击前已经排队的任务"
        );

        let cancel = CancellationToken::new();
        let future_generation = manager.start_generation();
        let waiter = {
            let manager = manager.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                wait_until_started(&manager, &cancel, future_generation, true).await
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "点击后新加入的任务必须继续排队");
        cancel.cancel();
        assert!(!waiter.await.unwrap());
    }
}
