//! 下载队列：并发控制、进度上报、取消。

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use kdj_core::models::{
    DownloadTask, Platform, Quality, SongSource, TaskKind, TaskState, Track, VideoDownloadRequest,
    VjExportRequest,
};
use kdj_core::EventHub;
use kdj_providers::DownloadJob;
use tokio::sync::{watch, Semaphore};
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

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 单调秒。节流和测速只关心"过了多久"，用挂钟的话改系统时间会把速度算成天文数字。
fn monotonic() -> f64 {
    static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
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

#[derive(Clone)]
struct AudioRetry {
    source: SongSource,
    quality: Quality,
    analyze: bool,
    dest_dir: String,
}

struct Entry {
    task: DownloadTask,
    cancel: CancellationToken,
    audio_retry: Option<AudioRetry>,
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
            samples: VecDeque::new(),
            last_emit: -1.0,
            last_progress: -1.0,
        }
    }
}

pub struct DownloadManager {
    hub: EventHub,
    entries: Mutex<BTreeMap<String, Entry>>,
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
        let concurrency = concurrency.max(1);
        DownloadManager {
            hub,
            entries: Mutex::new(BTreeMap::new()),
            permits: Mutex::new((concurrency, Arc::new(Semaphore::new(concurrency as usize)))),
            auto_start: watch::channel(auto_start).0,
            start_generation: watch::channel(0).0,
        }
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
        self.start_generation.send_modify(|generation| *generation += 1);
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

    /// 整份队列快照。入队/清理之后广播一次，前端才能知道有条目被裁掉了。
    pub fn broadcast_list(&self) {
        self.hub.publish("download.list", &self.list());
    }

    fn insert(&self, task: DownloadTask, cancel: CancellationToken) {
        {
            let mut entries = self.entries.lock().unwrap();
            entries.insert(task.id.clone(), Entry::new(task.clone(), cancel));
            trim_locked(&mut entries);
        }
        self.hub.publish("download.updated", &task);
    }

    fn attach_audio_retry(&self, id: &str, retry: AudioRetry) {
        if let Some(entry) = self.entries.lock().unwrap().get_mut(id) {
            entry.audio_retry = Some(retry);
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
                entry.task.state == TaskState::Failed,
                "只有失败的任务可以重试"
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
            entry.task.state = TaskState::Queued;
            entry.task.progress = 0.0;
            entry.task.downloaded_bytes = 0;
            entry.task.total_bytes = 0;
            entry.task.speed_bps = 0.0;
            entry.task.path.clear();
            entry.task.error.clear();
            entry.task.track_id = None;
            entry.task.updated_at = now_secs();
            (entry.task.clone(), retry, cancel)
        };
        self.hub.publish("download.updated", &task);
        Ok((task, retry, cancel))
    }

    /// 改任务并**立刻**广播。状态变更走这里，进度走 `progress`（有节流）。
    fn update(&self, id: &str, mutate: impl FnOnce(&mut DownloadTask)) -> Option<DownloadTask> {
        let updated = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id)?;
            mutate(&mut entry.task);
            entry.task.updated_at = now_secs();
            entry.last_emit = monotonic();
            entry.last_progress = entry.task.progress;
            entry.task.clone()
        };
        self.hub.publish("download.updated", &updated);
        Some(updated)
    }

    /// 落到终态。已经是终态的不再改——否则下载完成的那一瞬间收到取消
    /// 会把"完成"覆盖成"已取消"。
    fn settle(&self, id: &str, state: TaskState, error: &str) -> Option<DownloadTask> {
        {
            let entries = self.entries.lock().unwrap();
            if is_terminal(entries.get(id)?.task.state) {
                return None;
            }
        }
        self.update(id, |task| {
            task.state = state;
            task.error = error.to_string();
            task.speed_bps = 0.0;
        })
    }

    /// 任务开跑：记一个零点采样，滑窗才有起点。
    fn start(&self, id: &str) {
        {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            entry.samples.push_back((monotonic(), 0));
        }
        self.update(id, |task| task.state = TaskState::Running);
    }

    /// provider 的下载循环每收到一块就调一次：更新字节数和速度，广播则要过节流。
    fn progress(&self, id: &str, downloaded: u64, total: u64) {
        let payload = {
            let mut entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get_mut(id) else {
                return;
            };
            let now = monotonic();
            entry.task.downloaded_bytes = downloaded;
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
            let entered_processing = total > 0
                && downloaded >= total
                && entry.task.state == TaskState::Running;
            if entered_processing {
                entry.task.state = TaskState::Processing;
                entry.task.speed_bps = 0.0;
            }
            entry.samples.push_back((now, downloaded));
            if entry.samples.len() > SPEED_SAMPLES {
                entry.samples.pop_front();
            }
            entry.task.speed_bps = window_speed(&mut entry.samples, now);
            entry.task.updated_at = now_secs();

            let due = entered_processing
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
        {
            let entries = self.entries.lock().unwrap();
            match entries.get(id) {
                Some(entry) if is_terminal(entry.task.state) => return,
                Some(_) => {}
                None => return,
            }
        }
        let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let suffix = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        self.update(id, |task| {
            task.state = state;
            task.progress = if state == TaskState::Done { 1.0 } else { task.progress };
            // 收尾还挂着最后一次的瞬时速度的话，完成的条目会一直显示 "3.2 MB/s"
            task.speed_bps = 0.0;
            task.path = path.to_string_lossy().into_owned();
            task.error = error.to_string();
            task.track_id = track_id;
            if size > 0 {
                task.downloaded_bytes = size;
                task.total_bytes = task.total_bytes.max(size);
            }
            // provider 可能因为版权降级了音质，用最终文件后缀纠正显示值
            if task.kind == TaskKind::Audio
                && matches!(
                    suffix.as_str(),
                    "flac" | "mp3" | "m4a" | "wav" | "aac" | "ogg" | "mp4"
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
                    Some(entry.task)
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

    /// 只移除一条已结束任务。用于清理某次导出记录，不能误伤同队列中的其他任务。
    pub fn remove_finished(&self, id: &str) -> Option<DownloadTask> {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get(id)?;
            if !is_terminal(entry.task.state) {
                return None;
            }
            entries.remove(id).map(|entry| entry.task)
        };
        self.broadcast_list();
        removed
    }

    /// 清掉所有已结束的任务，返回清掉几条。
    pub fn clear_finished(&self) -> usize {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
            let before = entries.len();
            entries.retain(|_, entry| !is_terminal(entry.task.state));
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
) -> bool {
    // 先订阅再判断：反过来的话，两步之间拨开的开关会漏掉，任务永远醒不过来
    let mut rx = manager.auto_start.subscribe();
    let mut start_rx = manager.start_generation.subscribe();
    loop {
        if cancel.is_cancelled() {
            return false;
        }
        if *rx.borrow_and_update() {
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

fn new_task(
    kind: TaskKind,
    platform: Platform,
    title: &str,
    artist: &str,
    quality: String,
    dest_dir: String,
    cover: String,
) -> DownloadTask {
    let now = now_secs();
    DownloadTask {
        id: new_id(),
        kind,
        platform,
        // 空标题在队列面板上就是一行空白，用户认不出这是哪一条
        title: if title.is_empty() {
            "未命名".to_string()
        } else {
            title.to_string()
        },
        artist: artist.to_string(),
        quality,
        state: TaskState::Queued,
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0.0,
        path: String::new(),
        error: String::new(),
        track_id: None,
        dest_dir,
        cover,
        created_at: now,
        updated_at: now,
    }
}

/// 下完后若指定了目标文件夹，挪进去（须在曲库根目录内）。
fn relocate_download(state: &AppState, path: &Path, dest_dir: &str) -> Result<PathBuf, String> {
    let dest_dir = dest_dir.trim();
    if dest_dir.is_empty() {
        return Ok(path.to_path_buf());
    }
    let roots: Vec<PathBuf> = state
        .config
        .to_settings()
        .library_dirs
        .iter()
        .map(PathBuf::from)
        .collect();
    if roots.is_empty() {
        return Err("还没有配置曲库目录".into());
    }
    let dest = kdj_library::folders::ensure_inside(Path::new(dest_dir), &roots)
        .map_err(|err| format!("{err:#}"))?;
    if !dest.is_dir() {
        return Err("目标不是文件夹".into());
    }
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
) -> DownloadTask {
    let task = new_task(
        TaskKind::Audio,
        source.platform,
        &source.title,
        &source.artist_text(),
        quality.as_str().to_string(),
        dest_dir.clone(),
        source.cover.clone(),
    );
    let cancel = CancellationToken::new();
    manager.insert(task.clone(), cancel.clone());
    manager.attach_audio_retry(
        &task.id,
        AudioRetry {
            source: source.clone(),
            quality,
            analyze,
            dest_dir: dest_dir.clone(),
        },
    );
    let queued_generation = manager.start_generation();

    let id = task.id.clone();
    tokio::spawn(async move {
        run_audio(
            state,
            manager,
            id,
            source,
            quality,
            analyze,
            dest_dir,
            cancel,
            queued_generation,
            false,
        )
        .await;
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
    let (task, retry, cancel) = manager.prepare_audio_retry(id)?;
    let task_id = task.id.clone();
    let queued_generation = manager.start_generation();
    tokio::spawn(async move {
        run_audio(
            state,
            manager,
            task_id,
            retry.source,
            retry.quality,
            retry.analyze,
            retry.dest_dir,
            cancel,
            queued_generation,
            true,
        )
        .await;
    });
    Ok(task)
}

#[allow(clippy::too_many_arguments)]
async fn run_audio(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: String,
    source: SongSource,
    quality: Quality,
    analyze: bool,
    dest_dir: String,
    cancel: CancellationToken,
    queued_generation: u64,
    start_immediately: bool,
) {
    if !start_immediately && !wait_until_started(&manager, &cancel, queued_generation).await {
        return;
    }
    let permits = manager.permits();
    let Ok(_permit) = permits.acquire_owned().await else {
        return;
    };
    if cancel.is_cancelled() {
        return;
    }
    let Some(provider) = state.provider(source.platform).cloned() else {
        manager.settle(
            &id,
            TaskState::Failed,
            &format!("平台 {} 不可用（provider 未加载）", source.platform),
        );
        return;
    };

    manager.start(&id);

    // 进度回调跨线程：闭包捕获 Arc 后在 provider 的下载循环里被调用
    let progress_manager = manager.clone();
    let progress_id = id.clone();
    let progress = Arc::new(move |downloaded: u64, total: u64| {
        progress_manager.progress(&progress_id, downloaded, total);
    });

    let job = DownloadJob::new(&source, quality)
        .with_cancel(cancel.clone())
        .with_progress(progress);
    let result = provider.download(job).await;

    match result {
        // 取消是协作式的，provider 有可能在收到取消之前就把最后一块下完了。
        // 这时候不能当成成功：那样队列里会从「已取消」跳回「已完成」，
        // 而且这首歌还会被入库——用户点的明明是取消。
        Ok(_) if cancel.is_cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Ok(path) => {
            let path = match relocate_download(&state, &path, &dest_dir) {
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
            // 音频已经完整落到目标目录，先释放下载并发槽。歌词接口可能很慢，
            // 不该让网络取词占住一个下载名额、挡住队列里的下一首。
            drop(_permit);

            // 歌词跟着下载结果的精确平台 key 保存，不经过标题模糊匹配。
            // 歌曲本体已经完成后，歌词失败只记日志，不影响下载任务成功。
            if state.config.to_settings().download_lyrics {
                match provider.lyric(&source.key).await {
                    Ok(Some(text)) => {
                        if let Err(err) = kdj_library::folders::write_lyrics(
                            &path,
                            source.platform.as_str(),
                            &source.key,
                            &text.lrc,
                            &text.translated_lrc,
                            &text.romaji_lrc,
                        ) {
                            tracing::warn!("下载后写歌词失败 {}：{err:#}", path.display());
                        }
                    }
                    Ok(None) => {}
                    Err(err) => tracing::warn!("下载后取歌词失败 {}：{err:#}", source.title),
                }
            }
            // 下载完立刻入库，并把来源信息带上，这样曲库里能看出这首是从哪来的
            let track_id = match state.library.upsert_file(
                &path,
                source.platform.as_str(),
                &source.key,
            ) {
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

/// 一段已验证的 VJ 裁切。`duration` 是裁切后的有效时长，专门用于把淡入淡出
/// 夹在两段都留有内容的范围内。
struct VjClipPlan {
    track: Track,
    start: f64,
    end: f64,
    duration: f64,
}

/// 把时间吸到分析出的第一拍网格。没有可信 BPM 或第一拍时宁可不动，不能用
/// 文件开头假装 downbeat；整小节就是每 4 拍取一个点。
fn snap_vj_time(track: &Track, time: f64, whole_bar: bool) -> Option<f64> {
    let bpm = track.bpm.filter(|bpm| bpm.is_finite() && *bpm > 0.0)?;
    let first_beat = track.first_beat.filter(|beat| beat.is_finite() && *beat >= 0.0)?;
    let step = 60.0 / bpm * if whole_bar { 4.0 } else { 1.0 };
    Some(first_beat + ((time - first_beat) / step).round() * step)
}

fn vj_interval(
    track: &Track,
    use_in_out_points: bool,
    snap_nearest_beat: bool,
    snap_whole_bar: bool,
) -> Result<(f64, f64)> {
    let duration = track
        .duration
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| kdj_providers::tags::read_duration_secs(Path::new(&track.path)))
        .context("读不到素材时长；请重新扫描该 VJ 后再导出")?;
    let start = if use_in_out_points {
        track.cue_ms.unwrap_or(0).max(0) as f64 / 1000.0
    } else {
        0.0
    };
    let end = if use_in_out_points {
        track.end_ms.map(|value| value as f64 / 1000.0).unwrap_or(duration)
    } else {
        duration
    }
    .min(duration);
    let (start, end) = if snap_nearest_beat {
        let snapped_start = snap_vj_time(track, start, snap_whole_bar)
            .map(|value| value.clamp(0.0, duration))
            .unwrap_or(start);
        let snapped_end = snap_vj_time(track, end, snap_whole_bar)
            .map(|value| value.clamp(0.0, duration))
            .unwrap_or(end);
        // 一个短片段吸到同一拍会成为零长度，保留用户原来的精确裁切比导出失败好。
        if snapped_end - snapped_start >= 0.1 {
            (snapped_start, snapped_end)
        } else {
            (start, end)
        }
    } else {
        (start, end)
    };
    if !start.is_finite() || !end.is_finite() || end - start < 0.1 {
        bail!("{} 的开始 / 结束点没有可导出的内容", track.filename);
    }
    Ok((start, end))
}

/// 把请求里的 id 严格按用户给出的次序取回。不能用 SQL 的 `IN` 排序：它会悄悄
/// 丢掉用户在面板里排好的顺序，VJ 接歌就完全变味了。
fn vj_clip_plans(state: &AppState, req: &VjExportRequest) -> Result<Vec<VjClipPlan>> {
    let selected_folder = kdj_library::service::normalize_path(Path::new(&req.folder));
    req.track_ids
        .iter()
        .map(|id| {
            let track = state
                .library
                .get(*id)?
                .with_context(|| format!("曲目不存在：{id}"))?;
            let parent = Path::new(&track.path)
                .parent()
                .map(kdj_library::service::normalize_path)
                .unwrap_or_default();
            if parent != selected_folder {
                bail!("{} 不在本次选择的文件夹内", track.filename);
            }
            if !Path::new(&track.path).is_file() {
                bail!("找不到 VJ 素材：{}", track.path);
            }
            let (start, end) = vj_interval(
                &track,
                req.use_in_out_points,
                req.snap_nearest_beat,
                req.snap_whole_bar,
            )?;
            Ok(VjClipPlan {
                track,
                start,
                end,
                duration: end - start,
            })
        })
        .collect()
}

/// 小节模式的每个过渡都取**上一首**的 BPM：退场素材的节拍才是观众正在听的节拍。
/// 未分析素材按 120 BPM 兜底，保证导出不会因一条缺分析数据而失败。
fn vj_fade_seconds(req: &VjExportRequest, previous: &Track) -> f64 {
    if req.fade_bars > 0 {
        let bpm = previous.bpm.filter(|bpm| bpm.is_finite() && *bpm > 0.0).unwrap_or(120.0);
        f64::from(req.fade_bars) * 4.0 * 60.0 / bpm
    } else {
        req.fade_seconds
    }
}

fn vj_output_path(state: &AppState) -> Result<(PathBuf, PathBuf)> {
    // 所有导出与普通下载遵从用户设置的同一个默认下载目录，不额外套 VJ 子文件夹。
    let directory = state.config.download_dir();
    std::fs::create_dir_all(&directory).context("创建 VJ 导出目录失败")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let output = directory.join(format!("VJ Export {stamp}.mp4"));
    let partial = directory.join(format!("VJ Export {stamp}.partial.mp4"));
    Ok((output, partial))
}

/// 默认下载目录可能只是系统 Downloads，也可能正好是用户登记过的曲库文件夹。
/// 后一种情况下，VJ 成品必须像拖进文件夹的普通视频一样立刻入库；否则文件已经
/// 在磁盘上，左表和文件夹计数却一直少一首，只能靠用户再手动扫描一次。
fn vj_output_belongs_to_library(path: &Path, library_dirs: &[String]) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let roots: Vec<PathBuf> = library_dirs.iter().map(PathBuf::from).collect();
    !roots.is_empty() && kdj_library::folders::ensure_inside(parent, &roots).is_ok()
}

/// 建一条「按顺序导出 VJ」任务，走同一条下载队列和取消令牌。
pub fn enqueue_vj_export(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    req: VjExportRequest,
    folder_label: &str,
) -> DownloadTask {
    let count = req.track_ids.len();
    let title = if folder_label.is_empty() {
        "VJ 导出".into()
    } else {
        format!("VJ 导出 · {folder_label}")
    };
    let artist = format!("{count} 首");
    let quality = if req.quality.trim().is_empty() {
        "1080p".into()
    } else {
        req.quality.trim().to_string()
    };
    let task = new_task(
        TaskKind::VjExport,
        Platform::Local,
        &title,
        &artist,
        quality,
        state.config.download_dir().to_string_lossy().into_owned(),
        String::new(),
    );
    let cancel = CancellationToken::new();
    manager.insert(task.clone(), cancel.clone());
    let queued_generation = manager.start_generation();

    let id = task.id.clone();
    tokio::spawn(async move {
        if !wait_until_started(&manager, &cancel, queued_generation).await {
            return;
        }
        let permits = manager.permits();
        let Ok(_permit) = permits.acquire_owned().await else {
            return;
        };
        if cancel.is_cancelled() {
            return;
        }
        run_vj_export(state, manager, id, req, cancel).await;
    });
    task
}

async fn run_vj_export(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    id: String,
    req: VjExportRequest,
    cancel: CancellationToken,
) {
    manager.start(&id);
    if !kdj_providers::ffmpeg::available() {
        manager.settle(&id, TaskState::Failed, "系统里没有 ffmpeg，无法渲染 VJ 导出");
        return;
    }
    let result: Result<PathBuf> = async {
        let plans = vj_clip_plans(&state, &req)?;
        let mut clips = Vec::with_capacity(plans.len());
        for (index, plan) in plans.iter().enumerate() {
            let desired_fade = plans
                .get(index + 1)
                .map(|_| vj_fade_seconds(&req, &plan.track))
                .unwrap_or(0.0);
            // 不让一次过长的淡化吞掉任一首；ffmpeg 的 xfade 也要求这个约束。
            let next_duration = plans.get(index + 1).map(|next| next.duration).unwrap_or(0.0);
            let fade_to_next = if next_duration > 0.0 {
                desired_fade.max(0.0).min(plan.duration * 0.5).min(next_duration * 0.5)
            } else {
                0.0
            };
            clips.push(kdj_providers::ffmpeg::VjExportClip {
                source: PathBuf::from(&plan.track.path),
                start: plan.start,
                end: plan.end,
                fade_to_next,
            });
        }
        let (output, partial) = vj_output_path(&state)?;
        let encoder = kdj_providers::ffmpeg::preferred_vj_video_encoder();
        let args = kdj_providers::ffmpeg::vj_export_args_with_encoder(
            &clips,
            &partial,
            &req.quality,
            req.keep_audio,
            req.keep_audio && req.unify_gain,
            encoder,
        )?;
        manager.update(&id, |task| task.state = TaskState::Processing);
        let log = partial.with_extension("log");
        let rendered = kdj_providers::ffmpeg::run(&args, &log, &cancel).await;
        if let Err(err) = rendered {
            // FFmpeg 能列出硬件编码器不代表本机驱动 / 会话一定可实际打开；失败后
            // 无需用户改设置，立刻用 libx264 重试同一份临时文件。
            if encoder != kdj_providers::ffmpeg::VjVideoEncoder::Software && !cancel.is_cancelled() {
                tracing::warn!(?encoder, "VJ 硬件编码失败，回退到 libx264：{err:#}");
                let fallback = kdj_providers::ffmpeg::vj_export_args_with_encoder(
                    &clips,
                    &partial,
                    &req.quality,
                    req.keep_audio,
                    req.keep_audio && req.unify_gain,
                    kdj_providers::ffmpeg::VjVideoEncoder::Software,
                )?;
                kdj_providers::ffmpeg::run(&fallback, &log, &cancel).await?;
            } else {
                let _ = std::fs::remove_file(&partial);
                return Err(err);
            }
        }
        if std::fs::metadata(&partial).map(|meta| meta.len()).unwrap_or(0) == 0 {
            bail!("FFmpeg 没有写出 VJ 成品");
        }
        std::fs::rename(&partial, &output).context("提交 VJ 成品失败")?;
        // 成功日志只是 FFmpeg 诊断用的临时物；留在导出文件夹里会让成品旁边
        // 永远多一份 `*.partial.log`，看起来像导出没有真正收尾。
        let _ = std::fs::remove_file(&log);
        Ok(output)
    }
    .await;

    match result {
        Ok(path) if cancel.is_cancelled() => {
            let _ = std::fs::remove_file(path);
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Ok(path) => {
            let settings = state.config.to_settings();
            let track_id = if vj_output_belongs_to_library(&path, &settings.library_dirs) {
                match state.library.upsert_file(&path, "local", "") {
                    Ok(track_id) => Some(track_id),
                    Err(err) => {
                        let message = format!("VJ 已导出，但加入曲库失败：{err:#}");
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
        Err(_err) if cancel.is_cancelled() => {
            manager.settle(&id, TaskState::Canceled, "已取消");
        }
        Err(err) => {
            manager.settle(&id, TaskState::Failed, &format!("{err:#}"));
        }
    };
}

/// 建一条视频下载任务。
pub fn enqueue_video(
    state: Arc<AppState>,
    manager: Arc<DownloadManager>,
    req: VideoDownloadRequest,
) -> DownloadTask {
    // 只要音轨时画质选项无意义，标成 audio；否则是 "1080p" 这样的高度
    let quality = if req.audio_only {
        "audio".to_string()
    } else {
        format!("{}p", req.max_height)
    };
    let dest_dir = req.dest_dir.clone();
    let title = {
        let hint = req.title.trim();
        if hint.is_empty() {
            video_placeholder_title(&req)
        } else {
            hint.to_string()
        }
    };
    let task = new_task(
        TaskKind::Video,
        Platform::Bilibili,
        &title,
        req.artist.trim(),
        quality,
        dest_dir,
        req.cover.trim().to_string(),
    );
    let cancel = CancellationToken::new();
    manager.insert(task.clone(), cancel.clone());
    let queued_generation = manager.start_generation();

    let id = task.id.clone();
    tokio::spawn(async move {
        if !wait_until_started(&manager, &cancel, queued_generation).await {
            return;
        }
        let permits = manager.permits();
        let Ok(_permit) = permits.acquire_owned().await else {
            return;
        };
        if cancel.is_cancelled() {
            return;
        }
        manager.start(&id);

        // 先解析一次拿标题：队列里挂个 BV 号用户根本认不出是哪个视频。
        // 放在这里而不是放在 HTTP 处理函数里：B 站这一跳可能要好几秒（限流时更久），
        // 同步等的话「点下载」按钮要卡住那么久才回应。解析失败不影响下载。
        // 探针优先用 url：用户贴的短链里带 p= 分 P 信息，bvid 没有。
        let probe = if req.url.trim().is_empty() {
            req.bvid.clone()
        } else {
            req.url.clone()
        };
        match state.bilibili.resolve_video(&probe).await {
            Ok(info) if !info.title.is_empty() => {
                manager.update(&id, |task| {
                    // 入队时搜索结果可能已经盖过标题/封面；解析结果只补空缺，别把好的冲掉。
                    if task.title.is_empty()
                        || task.title == "未命名"
                        || task.title.starts_with("BV")
                    {
                        task.title = info.title.clone();
                    }
                    if task.artist.trim().is_empty() {
                        task.artist = info.author.clone();
                    }
                    if task.cover.trim().is_empty() && !info.cover.trim().is_empty() {
                        task.cover = info.cover.clone();
                    }
                });
            }
            Ok(_) => {}
            Err(err) => tracing::debug!("视频信息预解析失败（不影响下载）：{err:#}"),
        }
        let progress_manager = manager.clone();
        let progress_id = id.clone();
        let progress: kdj_providers::ProgressSink =
            Arc::new(move |downloaded: u64, total: u64| {
                progress_manager.progress(&progress_id, downloaded, total);
            });

        match state.bilibili.download_video(&req, &cancel, &progress).await {
            // 和音频一路同理：取消撞上"最后一块刚好下完"不能算成功
            Ok(_) if cancel.is_cancelled() => {
                manager.settle(&id, TaskState::Canceled, "已取消");
            }
            Ok(path) => {
                let path = match relocate_download(&state, &path, &req.dest_dir) {
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
                // 只要音轨：进曲库。完整视频默认不进（免得搅乱曲库），
                // 但拖进某个文件夹时用户就是要它出现在那里——dest_dir 非空也入库。
                let should_import = req.audio_only || !req.dest_dir.trim().is_empty();
                let track_id = if should_import {
                    match state.library.upsert_file(&path, "bilibili", &req.bvid) {
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
    });
    task
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
            title: "t".into(),
            artist: String::new(),
            quality: "flac".into(),
            state,
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bps: 0.0,
            path: String::new(),
            error: String::new(),
            track_id: None,
            dest_dir: String::new(),
            cover: String::new(),
            created_at,
            updated_at: created_at,
        }
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
            },
        );

        let (task, retry, fresh_cancel) = manager.prepare_audio_retry("retry").unwrap();
        assert_eq!(task.state, TaskState::Queued);
        assert_eq!(task.progress, 0.0);
        assert_eq!(task.downloaded_bytes, 0);
        assert_eq!(task.total_bytes, 0);
        assert!(task.error.is_empty());
        assert_eq!(retry.source.key, "123");
        assert_eq!(retry.dest_dir, "/music");
        assert!(!fresh_cancel.is_cancelled());
        assert!(manager.prepare_audio_retry("retry").is_err());
    }

    #[test]
    fn vj_outputs_inside_a_library_are_imported_like_regular_videos() {
        let base = std::env::temp_dir().join(format!("kdj-vj-library-{}", std::process::id()));
        let library = base.join("library");
        let inside = library.join("set/VJ Export 1.mp4");
        let outside = base.join("downloads/VJ Export 2.mp4");
        std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        let roots = vec![library.to_string_lossy().into_owned()];

        assert!(vj_output_belongs_to_library(&inside, &roots));
        assert!(!vj_output_belongs_to_library(&outside, &roots));
        assert!(!vj_output_belongs_to_library(&inside, &[]));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn vj_trims_snap_to_analyzed_beats_or_bars() {
        let track = Track {
            duration: Some(20.0),
            bpm: Some(120.0),
            first_beat: Some(0.2),
            cue_ms: Some(1100),
            end_ms: Some(4500),
            ..Default::default()
        };
        let beats = vj_interval(&track, true, true, false).unwrap();
        assert_eq!(beats, (1.2, 4.7));
        let bars = vj_interval(&track, true, true, true).unwrap();
        assert_eq!(bars, (0.2, 4.2));

        let no_grid = Track {
            first_beat: None,
            ..track.clone()
        };
        assert_eq!(vj_interval(&no_grid, true, true, false).unwrap(), (1.1, 4.5));
    }

    #[test]
    fn vj_bar_fade_uses_the_outgoing_tracks_bpm() {
        let req = VjExportRequest {
            fade_bars: 4,
            fade_seconds: 99.0,
            ..Default::default()
        };
        let previous = Track {
            bpm: Some(100.0),
            ..Default::default()
        };
        // 4 小节 × 4 拍 × (60 / 100) 秒；不能误拿下一首或固定秒数。
        assert!((vj_fade_seconds(&req, &previous) - 9.6).abs() < 1e-9);
        assert!((vj_fade_seconds(&req, &Track::default()) - 8.0).abs() < 1e-9);
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
        assert!(cancel.is_cancelled(), "等待下载闸门的 worker 也必须被唤醒退出");
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
    fn clear_only_removes_finished_tasks() {
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

        assert_eq!(manager.clear_finished(), 3);
        let ids: Vec<String> = manager.list().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["running", "queued"], "正在跑和排队的不能被清掉");
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
            "",
            "",
            "flac".into(),
            String::new(),
            String::new(),
        );
        assert_eq!(task.title, "未命名");
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
        assert_eq!(task.path, path.to_string_lossy(), "成品路径必须保住，方便定位和补救");
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
        assert!(Arc::ptr_eq(&before, &manager.permits()), "值没变就不能换闸门");

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
        assert_eq!(video_placeholder_title(&req("https://b23.tv/x", "BV1")), "BV1");
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
                wait_until_started(&manager, &cancel, manager.start_generation()).await
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
        assert!(!wait_until_started(&manager, &cancel, manager.start_generation()).await);
    }

    #[tokio::test]
    async fn one_shot_start_does_not_release_future_tasks() {
        let manager = Arc::new(DownloadManager::new(EventHub::default(), 3, false));
        let old_generation = manager.start_generation();
        manager.release_queued();
        assert!(
            wait_until_started(&manager, &CancellationToken::new(), old_generation).await,
            "点击开始应放行点击前已经排队的任务"
        );

        let cancel = CancellationToken::new();
        let future_generation = manager.start_generation();
        let waiter = {
            let manager = manager.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                wait_until_started(&manager, &cancel, future_generation).await
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "点击后新加入的任务必须继续排队");
        cancel.cancel();
        assert!(!waiter.await.unwrap());
    }
}
