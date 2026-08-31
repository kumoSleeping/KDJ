//! 在线试听缓存的渐进波形。
//!
//! 浏览器只能告诉我们 `<audio>.buffered` 覆盖了哪些时间，不能把尚未播放的
//! 压缩音频交给 Web Audio 解码。这里优先复用 `stream_cache` 的顺序临时文件；用户
//! 关闭持久缓存时，则把媒体代理**本来就送给播放器**的同一份连续字节旁路到会话
//! 临时文件，不再额外下载整轨。每跨过一档增长量才解一次当前可读前缀，前端便能
//! 把真实波形铺到“已经缓存且已经可解码”的位置。部分 MP4/M4A 的索引在文件尾，
//! 前缀不能探测时自然等完整响应后再出结果，绝不拿随机柱子冒充分析结果。

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kdj_analysis::engine::AnalysisResult;
use kdj_core::models::Waveform;
use kdj_core::work_scheduler::WorkClass;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

const ENTRY_LIMIT: usize = 24;
/// 会话旁路不是下载缓存：单首和合计都必须有硬预算，避免异常超长直播流或长时间
/// 浏览把 data_dir 吃满。超过预算只关闭可选波形，声音仍继续。
const SESSION_FILE_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
const SESSION_TOTAL_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
/// 首次至少攒一点文件头和音频包；太早 probe 只会反复报“无法识别格式”。
const FIRST_ANALYSIS_BYTES: u64 = 768 * 1024;
/// 前缀解码每次都要从文件头开始。至少翻倍再重算，可把一首歌的累计解码量控制在
/// 约两倍整轨以内；原来的 50% 增长在移动端会连续抢占音频线程和闪存 IO。
const ANALYSIS_GROWTH_FACTOR: u64 = 2;
/// 即使网络瞬间灌入几十 MB，也不能把多次全前缀解码紧挨着跑。Android 给音频线程
/// 更大的喘息窗口；桌面仍能在首段之后较快补齐。
#[cfg(target_os = "android")]
const ANALYSIS_MIN_INTERVAL: Duration = Duration::from_secs(4);
#[cfg(not(target_os = "android"))]
const ANALYSIS_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// 代理已经实际送给播放器的字节每积累到这一档便 flush 一次，供只读分析句柄看见。
/// 这只是用户态 flush，不做 fsync，也不会阻塞音频网络流等待一次 FFT。
const CAPTURE_PUBLISH_BYTES: u64 = 512 * 1024;
const CAPTURE_WRITE_BUFFER_BYTES: usize = CAPTURE_PUBLISH_BYTES as usize;
/// PlayerBar 每 750ms 续一次这份租约；切歌/卸载后不会再续，已排队的后续前缀
/// 分析自然停止，不需要让浏览器额外发一个带竞态的 DELETE。
const REQUEST_LEASE: Duration = Duration::from_secs(5);
/// 流媒体完整分析沿用曲库的默认窗口；路由每次轮询会用当前设置覆盖它。
const DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS: f64 = 90.0;
/// Android 起播后的最初几秒只收集连续字节，不立刻做第一次完整前缀解码，避免
/// 768 KiB 门槛恰好和解码器/AudioTrack 建链撞在一起。
#[cfg(target_os = "android")]
const ANDROID_STARTUP_ANALYSIS_GUARD: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
struct SessionLimits {
    file_bytes: u64,
    total_bytes: u64,
}

impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            file_bytes: SESSION_FILE_LIMIT_BYTES,
            total_bytes: SESSION_TOTAL_LIMIT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamWaveformProgress {
    /// 已成功解码并分析的媒体前缀。`duration` 是这个前缀的实际秒数，而非
    /// 容器头可能声明的整曲时长。
    pub waveform: Option<Waveform>,
    pub covered_seconds: f64,
    pub revision: u64,
    /// 当前会话已真实落盘、可供播放器/缓存复用的媒体字节。它来自同一份代理响应
    /// 或持久 stream-cache，不会为了进度条再发一份下载。
    pub cached_bytes: u64,
    /// 上游媒体声明的完整字节数；未知时为 0。完整缓存命中时等于 cached_bytes。
    pub total_bytes: u64,
    /// 缓存文件已经完整落盘；若 waveform 仍为空，表示格式不支持前缀解码或
    /// 完整解码失败，前端可停止轮询并继续用 analyser 的已播兜底。
    pub complete: bool,
    /// 当前有一次波形解码在跑。路由层还会把 stream-cache 的网络写入状态合进来。
    pub active: bool,
    /// 完整音频分析与渐进波形共用同一份文件，但只在文件确认完整后启动。
    pub analysis_status: StreamAnalysisStatus,
    pub analysis: Option<AnalysisResult>,
    pub analysis_error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamAnalysisStatus {
    Waiting,
    Analyzing,
    Ready,
    Failed,
}

#[derive(Default)]
struct StreamWaveformInner {
    entries: HashMap<String, StreamWaveformEntry>,
    /// clear/remove 后同一 key 可能重新落到同一个最终 `.media` 路径；不能只靠
    /// 路径判别迟到的 decode 任务，必须给每次观察会话一个单调 epoch。
    next_epoch: u64,
    /// 供前端去重使用的版本号必须跨 entry 的 clear/recreate 仍单调递增；否则
    /// 新缓存从 revision 0 开始时会被旧播放器会话的 revision 拒收。
    next_revision: u64,
}

struct StreamWaveformEntry {
    epoch: u64,
    path: Option<PathBuf>,
    bytes: u64,
    total_bytes: u64,
    requested_until: Option<Instant>,
    complete: bool,
    inflight: bool,
    complete_analyzed: bool,
    analysis_complete: bool,
    analysis: Option<AnalysisResult>,
    analysis_error: String,
    analysis_duration: f64,
    /// true 表示媒体代理正在把已经送给播放器的连续字节旁路进临时文件。它与持久
    /// stream-cache 的后台下载无关，关闭缓存设置时也能提前画真实波形。
    capture_open: bool,
    /// 磁盘文件的实际/已预约长度；`bytes` 只表示 flush 后可交给解码器的长度。
    capture_file_bytes: u64,
    /// 只有上一段严格收满声明长度时，下一段 Range 才允许从文件尾续接。
    capture_continuable: bool,
    /// 只有会话临时文件需要生命周期租约；持久缓存文件由 stream_cache 自己持有。
    ephemeral_file: Option<Arc<EphemeralFile>>,
    last_requested_path: Option<PathBuf>,
    last_requested_bytes: u64,
    last_analysis_started_at: Option<Instant>,
    analysis_not_before: Option<Instant>,
    cleanup_scheduled: bool,
    waveform: Option<Waveform>,
    covered_seconds: f64,
    revision: u64,
    last_access: Instant,
}

impl Default for StreamWaveformEntry {
    fn default() -> Self {
        Self {
            epoch: 0,
            path: None,
            bytes: 0,
            total_bytes: 0,
            requested_until: None,
            complete: false,
            inflight: false,
            complete_analyzed: false,
            analysis_complete: false,
            analysis: None,
            analysis_error: String::new(),
            analysis_duration: DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS,
            capture_open: false,
            capture_file_bytes: 0,
            capture_continuable: false,
            ephemeral_file: None,
            last_requested_path: None,
            last_requested_bytes: 0,
            last_analysis_started_at: None,
            analysis_not_before: None,
            cleanup_scheduled: false,
            waveform: None,
            covered_seconds: 0.0,
            revision: 0,
            last_access: Instant::now(),
        }
    }
}

#[derive(Clone)]
pub struct StreamWaveformCoordinator {
    inner: Arc<Mutex<StreamWaveformInner>>,
    cleaned_session_roots: Arc<tokio::sync::Mutex<HashSet<PathBuf>>>,
    session_limits: SessionLimits,
    activity_log: Option<crate::activity_log::ActivityLog>,
}

impl Default for StreamWaveformCoordinator {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(StreamWaveformInner::default())),
            cleaned_session_roots: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
            session_limits: SessionLimits::default(),
            activity_log: None,
        }
    }
}

#[derive(Clone)]
struct AnalyzeJob {
    key: String,
    path: PathBuf,
    epoch: u64,
    complete: bool,
    analysis_duration: f64,
    /// 防止 entry 被清理后，正在排队的临时文件在真正开始解码前先被删除。
    _ephemeral_file: Option<Arc<EphemeralFile>>,
}

struct AnalyzeJobResult {
    waveform: Option<(Waveform, f64)>,
    analysis: Option<AnalysisResult>,
    analysis_error: String,
}

fn work_class_for_job(complete: bool) -> WorkClass {
    if complete {
        WorkClass::LibraryAnalysisLight
    } else {
        WorkClass::InteractiveWaveform
    }
}

#[derive(Debug)]
struct EphemeralFile {
    path: PathBuf,
}

impl Drop for EphemeralFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 一次媒体响应的顺序字节旁路。它只接收代理本来就要送给播放器的内容，不另发
/// HTTP 请求；响应被 WebView 提前取消时 Drop 会异步 flush 已到达的最后一段。
pub(crate) struct StreamWaveformCapture {
    coordinator: StreamWaveformCoordinator,
    key: String,
    epoch: u64,
    file_lease: Arc<EphemeralFile>,
    file: Option<tokio::io::BufWriter<tokio::fs::File>>,
    bytes: u64,
    published_bytes: u64,
    response_bytes: u64,
    expected_response_bytes: u64,
    complete_on_eof: bool,
    segment_healthy: bool,
}

/// 构造媒体响应时只创建计划，不碰文件系统。真正的 mkdir/open 在有界队列后台
/// worker 内执行；若初始化慢到队列装满，HTTP 热路径会直接放弃这份计划。
pub(crate) struct StreamWaveformCapturePlan {
    coordinator: StreamWaveformCoordinator,
    session_root: PathBuf,
    key: String,
    start: u64,
    expected_response_bytes: u64,
    media_total_bytes: u64,
    complete_on_eof: bool,
}

impl StreamWaveformCoordinator {
    pub fn with_activity_log(activity_log: crate::activity_log::ActivityLog) -> Self {
        Self {
            activity_log: Some(activity_log),
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_session_limits(file_bytes: u64, total_bytes: u64) -> Self {
        Self {
            session_limits: SessionLimits {
                file_bytes,
                total_bytes,
            },
            ..Self::default()
        }
    }

    /// 标记当前试听确实需要缓存波形，并返回现有快照。没有写入路径时只记请求：
    /// 首个媒体 GET 建起后台缓存后 `observe` 会接着启动分析。
    pub fn request(&self, key: String) -> StreamWaveformProgress {
        self.request_with_analysis_duration(key, DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS)
    }

    /// 当前设置中的分析窗口由路由传入；只改变尚未开始的完整分析，不重跑已经完成
    /// 的结果。波形轮询因此也是完整分析的短生命周期租约，不需要第二个端点。
    pub fn request_with_analysis_duration(
        &self,
        key: String,
        analysis_duration: f64,
    ) -> StreamWaveformProgress {
        let (snapshot, job, schedule_cleanup) = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            ensure_entry(&mut inner, &key);
            let entry = inner.entries.get_mut(&key).expect("stream waveform entry");
            if analysis_duration.is_finite() && analysis_duration > 0.0 {
                entry.analysis_duration = analysis_duration;
            }
            entry.requested_until = Some(Instant::now() + REQUEST_LEASE);
            entry.last_access = Instant::now();
            let schedule_cleanup = !entry.cleanup_scheduled;
            entry.cleanup_scheduled = true;
            let job = plan_job(&key, entry);
            let snapshot = snapshot(entry);
            trim_entries(&mut inner.entries, self.session_limits, Some(&key));
            (snapshot, job, schedule_cleanup)
        };
        if let Some(job) = job {
            self.spawn(job);
        }
        if schedule_cleanup {
            self.spawn_lease_cleanup(key);
        }
        snapshot
    }

    /// 媒体 GET 一到便续一份短租约；既避免“GET 先于首轮 waveform poll”时临时
    /// 文件被立即清理，也给 Android 的首次渐进分析设置起播保护窗。
    pub(crate) fn media_started(&self, key: &str) {
        let schedule_cleanup = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            ensure_entry(&mut inner, key);
            let entry = inner.entries.get_mut(key).expect("stream waveform entry");
            let now = Instant::now();
            entry.requested_until = Some(now + REQUEST_LEASE);
            entry.last_access = now;
            #[cfg(target_os = "android")]
            {
                let guard = now + ANDROID_STARTUP_ANALYSIS_GUARD;
                entry.analysis_not_before = Some(
                    entry
                        .analysis_not_before
                        .map_or(guard, |current| current.max(guard)),
                );
            }
            let schedule = !entry.cleanup_scheduled;
            entry.cleanup_scheduled = true;
            schedule
        };
        if schedule_cleanup {
            self.spawn_lease_cleanup(key.to_string());
        }
    }

    /// 这里只验证响应区间和预算并生成计划，不 mkdir/open。计划会在媒体响应已经
    /// 构造好之后由有界队列 worker 初始化，慢磁盘不能拖住首包。
    pub(crate) fn capture_plan(
        &self,
        session_root: PathBuf,
        key: String,
        start: u64,
        expected_response_bytes: u64,
        media_total_bytes: u64,
        complete_on_eof: bool,
    ) -> Option<StreamWaveformCapturePlan> {
        if expected_response_bytes == 0
            || media_total_bytes == 0
            || start >= self.session_limits.file_bytes
            || start
                .checked_add(expected_response_bytes)
                .is_none_or(|end| end > media_total_bytes)
        {
            return None;
        }
        Some(StreamWaveformCapturePlan {
            coordinator: self.clone(),
            session_root,
            key,
            start,
            expected_response_bytes,
            media_total_bytes,
            complete_on_eof,
        })
    }

    async fn begin_capture(
        &self,
        session_root: PathBuf,
        key: String,
        start: u64,
        expected_response_bytes: u64,
        media_total_bytes: u64,
        complete_on_eof: bool,
    ) -> io::Result<Option<StreamWaveformCapture>> {
        if start
            .checked_add(expected_response_bytes)
            .is_none_or(|end| end > media_total_bytes)
        {
            return Ok(None);
        }
        self.prepare_session_root(&session_root).await?;
        if start == 0 {
            let (file, file_lease) = create_ephemeral_file(&session_root).await?;
            let epoch = {
                let mut inner = self.inner.lock().expect("stream waveform state");
                ensure_entry(&mut inner, &key);
                let epoch = allocate_epoch(&mut inner);
                let entry = inner.entries.get_mut(&key).expect("stream waveform entry");
                // 另一个 0-based 媒体响应可能仍在收包。用新 epoch 使它后续的
                // flush/Drop 全部失效，避免两条响应交错写坏同一前缀。
                entry.epoch = epoch;
                entry.path = Some(file_lease.path.clone());
                entry.bytes = 0;
                entry.total_bytes = media_total_bytes;
                entry.complete = false;
                entry.inflight = false;
                entry.complete_analyzed = false;
                entry.analysis_complete = false;
                entry.analysis = None;
                entry.analysis_error.clear();
                entry.capture_open = true;
                entry.capture_file_bytes = 0;
                entry.capture_continuable = false;
                entry.ephemeral_file = Some(Arc::clone(&file_lease));
                entry.last_requested_path = None;
                entry.last_requested_bytes = 0;
                entry.last_analysis_started_at = None;
                entry.waveform = None;
                entry.covered_seconds = 0.0;
                entry.revision = 0;
                entry.last_access = Instant::now();
                trim_entries(&mut inner.entries, self.session_limits, Some(&key));
                epoch
            };
            return Ok(Some(StreamWaveformCapture {
                coordinator: self.clone(),
                key,
                epoch,
                file_lease,
                file: Some(file),
                bytes: 0,
                published_bytes: 0,
                response_bytes: 0,
                expected_response_bytes,
                complete_on_eof,
                segment_healthy: true,
            }));
        }

        let (epoch, file_lease) = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            let Some(entry) = inner.entries.get_mut(&key) else {
                return Ok(None);
            };
            let Some(file_lease) = entry.ephemeral_file.as_ref().cloned() else {
                return Ok(None);
            };
            if entry.capture_open
                || entry.complete
                || !entry.capture_continuable
                || entry.bytes != start
                || entry.capture_file_bytes != start
                || entry.total_bytes != media_total_bytes
            {
                return Ok(None);
            }
            entry.capture_open = true;
            entry.capture_continuable = false;
            entry.last_access = Instant::now();
            (entry.epoch, file_lease)
        };
        let actual_len = match tokio::fs::metadata(&file_lease.path).await {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                self.invalidate_capture(&key, epoch);
                return Err(error);
            }
        };
        if actual_len != start {
            self.invalidate_capture(&key, epoch);
            return Ok(None);
        }
        let file = match tokio::fs::OpenOptions::new()
            .append(true)
            .open(&file_lease.path)
            .await
        {
            Ok(file) => tokio::io::BufWriter::with_capacity(CAPTURE_WRITE_BUFFER_BYTES, file),
            Err(error) => {
                self.invalidate_capture(&key, epoch);
                return Err(error);
            }
        };
        Ok(Some(StreamWaveformCapture {
            coordinator: self.clone(),
            key,
            epoch,
            file_lease,
            file: Some(file),
            bytes: start,
            published_bytes: start,
            response_bytes: 0,
            expected_response_bytes,
            complete_on_eof,
            segment_healthy: true,
        }))
    }

    fn invalidate_capture(&self, key: &str, epoch: u64) {
        let mut inner = self.inner.lock().expect("stream waveform state");
        let matches = inner
            .entries
            .get(key)
            .is_some_and(|entry| entry.epoch == epoch && entry.ephemeral_file.is_some());
        if !matches {
            return;
        }
        let next_epoch = allocate_epoch(&mut inner);
        let entry = inner.entries.get_mut(key).expect("capture entry exists");
        entry.epoch = next_epoch;
        entry.path = None;
        entry.bytes = 0;
        entry.total_bytes = 0;
        entry.capture_file_bytes = 0;
        entry.capture_open = false;
        entry.capture_continuable = false;
        entry.ephemeral_file = None;
        entry.inflight = false;
        entry.complete = false;
        entry.complete_analyzed = false;
        entry.analysis_complete = false;
        entry.analysis = None;
        entry.analysis_error.clear();
        entry.last_requested_path = None;
        entry.last_requested_bytes = 0;
    }

    fn finish_capture(
        &self,
        key: &str,
        epoch: u64,
        bytes: u64,
        complete: bool,
        closed: bool,
        segment_valid: bool,
    ) {
        let job = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            let Some(entry) = inner.entries.get_mut(key) else {
                return;
            };
            if entry.epoch != epoch || entry.ephemeral_file.is_none() || bytes < entry.bytes {
                return;
            }
            entry.bytes = bytes;
            entry.capture_file_bytes = bytes;
            entry.complete |= complete;
            if complete {
                entry.complete_analyzed = false;
                entry.analysis_complete = false;
                entry.analysis = None;
                entry.analysis_error.clear();
            }
            if closed {
                entry.capture_open = false;
                entry.capture_continuable = segment_valid && !entry.complete;
            }
            entry.last_access = Instant::now();
            let job = plan_job(key, entry);
            let protect_current = job.is_some()
                || entry.capture_open
                || entry
                    .requested_until
                    .is_some_and(|deadline| deadline > Instant::now());
            trim_entries(
                &mut inner.entries,
                self.session_limits,
                protect_current.then_some(key),
            );
            job
        };
        if let Some(job) = job {
            self.spawn(job);
        }
    }

    async fn prepare_session_root(&self, root: &Path) -> io::Result<()> {
        let mut cleaned = self.cleaned_session_roots.lock().await;
        if cleaned.contains(root) {
            return Ok(());
        }
        tokio::fs::create_dir_all(root).await?;
        let mut entries = tokio::fs::read_dir(root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("capture-") && name.ends_with(".partial") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
        cleaned.insert(root.to_path_buf());
        Ok(())
    }

    fn reserve_capture_bytes(&self, key: &str, epoch: u64, target: u64) -> bool {
        if target > self.session_limits.file_bytes {
            return false;
        }
        let mut inner = self.inner.lock().expect("stream waveform state");
        loop {
            let Some(current) = inner.entries.get(key) else {
                return false;
            };
            if current.epoch != epoch || current.ephemeral_file.is_none() {
                return false;
            }
            let other_bytes = inner
                .entries
                .iter()
                .filter(|(candidate, entry)| *candidate != key && entry.ephemeral_file.is_some())
                .map(|(_, entry)| entry.capture_file_bytes)
                .sum::<u64>();
            if other_bytes.saturating_add(target) <= self.session_limits.total_bytes {
                break;
            }
            let Some(evict) = inner
                .entries
                .iter()
                .filter(|(candidate, entry)| {
                    *candidate != key
                        && entry.ephemeral_file.is_some()
                        && !entry.inflight
                        && !entry.capture_open
                        && entry
                            .requested_until
                            .is_none_or(|deadline| deadline <= Instant::now())
                })
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(candidate, _)| candidate.clone())
            else {
                return false;
            };
            inner.entries.remove(&evict);
        }
        let entry = inner.entries.get_mut(key).expect("capture entry remains");
        entry.capture_file_bytes = target;
        true
    }

    fn spawn_lease_cleanup(&self, key: String) {
        let coordinator = self.clone();
        tokio::spawn(async move {
            loop {
                let deadline = {
                    let inner = coordinator.inner.lock().expect("stream waveform state");
                    let Some(entry) = inner.entries.get(&key) else {
                        return;
                    };
                    entry.requested_until
                };
                let Some(deadline) = deadline else {
                    return;
                };
                tokio::time::sleep(deadline.saturating_duration_since(Instant::now())).await;
                let mut inner = coordinator.inner.lock().expect("stream waveform state");
                let Some(entry) = inner.entries.get_mut(&key) else {
                    return;
                };
                if entry
                    .requested_until
                    .is_some_and(|current| current > Instant::now())
                {
                    continue;
                }
                if !entry.inflight && !entry.capture_open {
                    inner.entries.remove(&key);
                } else {
                    // finish_capture/finish_job 会在工作结束时再走一次过期裁剪。
                    entry.cleanup_scheduled = false;
                }
                return;
            }
        });
    }

    /// 受保护或移动网络媒体的持久缓存回退只在播放器租约、会话写入和波形分析都
    /// 已结束后启动；返回 true 才允许另发整轨请求。
    pub(crate) fn is_session_idle(&self, key: &str) -> bool {
        let inner = self.inner.lock().expect("stream waveform state");
        inner.entries.get(key).is_none_or(|entry| {
            !entry.capture_open
                && !entry.inflight
                && entry
                    .requested_until
                    .is_none_or(|deadline| deadline <= Instant::now())
        })
    }

    /// stream-cache 每写完一段就报告当前临时文件。这里不写文件、不碰网络；只有
    /// 当前播放器实际轮询过本曲（仍在租约内）才会占后台分析额度。
    pub fn observe(&self, key: String, path: PathBuf, bytes: u64, complete: bool) {
        self.observe_with_total(key, path, bytes, if complete { bytes } else { 0 }, complete);
    }

    /// 与 `observe` 相同，但在后台顺序缓存尚未完成时也保留响应声明的整轨字节数，
    /// 供前端展示真实 0..100% 缓存进度。
    pub fn observe_with_total(
        &self,
        key: String,
        path: PathBuf,
        bytes: u64,
        total_bytes: u64,
        complete: bool,
    ) {
        let job = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            let path_changed = inner
                .entries
                .get(&key)
                .and_then(|entry| entry.path.as_ref())
                .is_some_and(|old| old != &path);
            ensure_entry(&mut inner, &key);
            let next_epoch = path_changed.then(|| allocate_epoch(&mut inner));
            let entry = inner.entries.get_mut(&key).expect("stream waveform entry");
            if let Some(epoch) = next_epoch {
                entry.epoch = epoch;
            }
            let was_complete = entry.complete;
            let became_complete = complete && !entry.complete;
            entry.path = Some(path);
            entry.bytes = bytes;
            if total_bytes > 0 {
                entry.total_bytes = total_bytes.max(bytes);
            } else if complete {
                entry.total_bytes = bytes;
            }
            entry.complete = complete;
            entry.capture_open = false;
            entry.capture_file_bytes = 0;
            entry.capture_continuable = false;
            entry.ephemeral_file = None;
            entry.last_access = Instant::now();
            // partial → final media 的 rename 是同一串字节，保留已经画出的前缀以免
            // 瞬间闪白；若完整 media 被清掉后换成新 partial，则必须清空旧快照，
            // 否则更短的新前缀会被“覆盖秒数不得倒退”的保护错误拒绝。
            let same_download_commit = path_changed && !was_complete && complete;
            if path_changed && !same_download_commit {
                entry.waveform = None;
                entry.covered_seconds = 0.0;
                entry.revision = 0;
                entry.last_analysis_started_at = None;
                entry.analysis = None;
                entry.analysis_error.clear();
            }
            if path_changed || became_complete {
                entry.complete_analyzed = false;
                entry.analysis_complete = false;
            }
            // partial 原子改名为最终 media（或用户重试时换了一份 partial）后，旧
            // 读取任务无法再代表当前路径。放开新任务即可；旧任务结束时会因路径
            // 不匹配自行丢弃，不能让 `inflight` 永久卡住。
            if path_changed {
                entry.inflight = false;
            }
            let job = plan_job(&key, entry);
            trim_entries(&mut inner.entries, self.session_limits, Some(&key));
            job
        };
        if let Some(job) = job {
            self.spawn(job);
        }
    }

    /// 设置关闭、切换下载目录或用户清理缓存时调用。迟到任务会按 epoch 被丢弃。
    pub fn clear(&self) {
        self.inner
            .lock()
            .expect("stream waveform state")
            .entries
            .clear();
    }

    pub fn remove(&self, key: &str) {
        self.inner
            .lock()
            .expect("stream waveform state")
            .entries
            .remove(key);
    }

    fn spawn(&self, job: AnalyzeJob) {
        let coordinator = self.clone();
        tokio::task::spawn_blocking(move || {
            kdj_core::thread_qos::prefer_background();
            // The online track currently feeding the Deck is not a bulk-library job. Classifying
            // it as `LibraryAnalysis` made the scheduler wait for `live_audio_decks == 0`, so the
            // exact moment a user pressed Play was also the moment every online waveform and
            // metric disappeared. A growing, visible overview is interactive work; the one final
            // BPM/key/loudness pass is the single light-analysis owner. Both still yield when the
            // output ring reports pressure, and the process-wide heavy budget remains one while
            // audio is live.
            let class = work_class_for_job(job.complete);
            let _permit = crate::jobs::acquire_scheduled_work(class);
            let waveform = decode_cached_waveform(&job.path, job.complete)
                .map(|(overview, covered)| (overview, covered));
            let (analysis, analysis_error) = if job.complete {
                analyze_complete_stream(&job.path, job.analysis_duration)
            } else {
                (None, String::new())
            };
            let result = AnalyzeJobResult {
                waveform,
                analysis,
                analysis_error,
            };
            coordinator.finish_job(job, result);
        });
    }

    fn finish_job(&self, job: AnalyzeJob, result: AnalyzeJobResult) {
        let analysis_warning = (job.complete && !result.analysis_error.is_empty())
            .then(|| result.analysis_error.clone());
        let next = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            let Some(current) = inner.entries.get(&job.key) else {
                return;
            };
            // 清理/重试后同一个缓存键可能指向一份新的 partial；旧任务的结果绝不能
            // 覆盖它。`inflight` 也只能由仍匹配的任务释放。
            if current.epoch != job.epoch || current.path.as_ref() != Some(&job.path) {
                return;
            }
            let should_update = result
                .waveform
                .as_ref()
                .is_some_and(|(_, covered_seconds)| {
                    *covered_seconds + 0.02 >= current.covered_seconds
                });
            let update_revision = should_update.then(|| allocate_revision(&mut inner));
            let entry = inner
                .entries
                .get_mut(&job.key)
                .expect("stream waveform entry was just validated");
            entry.inflight = false;
            entry.last_access = Instant::now();
            if let (Some((waveform, covered_seconds)), Some(revision)) =
                (result.waveform, update_revision)
            {
                entry.waveform = Some(waveform);
                entry.covered_seconds = covered_seconds;
                entry.revision = revision;
            }
            if job.complete {
                // 即便格式不支持，完整文件也只尝试一次；否则前端每轮轮询都可能再开一
                // 条昂贵的解码任务。
                entry.complete_analyzed = true;
                entry.analysis_complete = true;
                entry.analysis = result.analysis;
                entry.analysis_error = result.analysis_error;
            }
            let next = plan_job(&job.key, entry);
            let protect_current = next.is_some()
                || entry.capture_open
                || entry
                    .requested_until
                    .is_some_and(|deadline| deadline > Instant::now());
            trim_entries(
                &mut inner.entries,
                self.session_limits,
                protect_current.then_some(job.key.as_str()),
            );
            next
        };
        if let (Some(log), Some(detail)) = (&self.activity_log, analysis_warning) {
            log.record_analysis_warning("在线曲目分析异常", detail);
        }
        if let Some(next) = next {
            self.spawn(next);
        }
    }
}

impl StreamWaveformCapturePlan {
    pub(crate) async fn begin(self) -> io::Result<Option<StreamWaveformCapture>> {
        self.coordinator
            .begin_capture(
                self.session_root,
                self.key,
                self.start,
                self.expected_response_bytes,
                self.media_total_bytes,
                self.complete_on_eof,
            )
            .await
    }
}

impl StreamWaveformCapture {
    pub(crate) async fn write_chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "流媒体波形旁路已经关闭",
            ));
        };
        let chunk_bytes = bytes.len() as u64;
        let Some(next_response_bytes) = self.response_bytes.checked_add(chunk_bytes) else {
            self.segment_healthy = false;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "媒体响应实际字节数溢出",
            ));
        };
        let declared_remaining = self
            .expected_response_bytes
            .saturating_sub(self.response_bytes);
        let file_remaining = self
            .coordinator
            .session_limits
            .file_bytes
            .saturating_sub(self.bytes);
        let accepted_bytes = chunk_bytes.min(declared_remaining).min(file_remaining);
        if accepted_bytes == 0 {
            self.response_bytes = next_response_bytes;
            self.segment_healthy = false;
            return Err(if declared_remaining == 0 {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "媒体响应实际字节超过 Content-Length/Content-Range 声明",
                )
            } else {
                io::Error::other("会话波形临时文件超过字节预算")
            });
        }
        let next_bytes = self.bytes + accepted_bytes;
        if !self
            .coordinator
            .reserve_capture_bytes(&self.key, self.epoch, next_bytes)
        {
            self.response_bytes = next_response_bytes;
            self.segment_healthy = false;
            return Err(io::Error::other("会话波形临时文件超过字节预算"));
        }
        if let Err(error) = file.write_all(&bytes[..accepted_bytes as usize]).await {
            self.response_bytes = next_response_bytes;
            self.segment_healthy = false;
            return Err(error);
        }
        self.bytes = next_bytes;
        self.response_bytes = next_response_bytes;
        if self.bytes.saturating_sub(self.published_bytes) >= CAPTURE_PUBLISH_BYTES {
            // Tokio File 的 write 可能仍在用户态队列里；先 flush 再把长度发布给
            // 只读解码线程，绝不能让它看到“声明长度大于实际可读长度”的前缀。
            if let Err(error) = file.flush().await {
                self.segment_healthy = false;
                return Err(error);
            }
            self.coordinator
                .finish_capture(&self.key, self.epoch, self.bytes, false, false, false);
            self.published_bytes = self.bytes;
        }
        if accepted_bytes != chunk_bytes {
            self.segment_healthy = false;
            return Err(if chunk_bytes > declared_remaining {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "媒体响应实际字节超过 Content-Length/Content-Range 声明",
                )
            } else {
                io::Error::other("会话波形临时文件已写到单文件上限")
            });
        }
        Ok(())
    }

    pub(crate) async fn finish(mut self, reached_eof: bool) -> io::Result<()> {
        let Some(mut file) = self.file.take() else {
            return Ok(());
        };
        let flush_result = file.flush().await;
        drop(file);
        let flushed = flush_result.is_ok();
        let segment_valid = self.segment_healthy
            && flushed
            && reached_eof
            && self.response_bytes == self.expected_response_bytes;
        self.coordinator.finish_capture(
            &self.key,
            self.epoch,
            if flushed {
                self.bytes
            } else {
                self.published_bytes
            },
            segment_valid && self.complete_on_eof,
            true,
            segment_valid,
        );
        if flushed {
            self.published_bytes = self.bytes;
        }
        flush_result
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.file_lease.path
    }
}

impl Drop for StreamWaveformCapture {
    fn drop(&mut self) {
        let Some(mut file) = self.file.take() else {
            return;
        };
        let coordinator = self.coordinator.clone();
        let key = self.key.clone();
        let epoch = self.epoch;
        let bytes = self.bytes;
        let published_bytes = self.published_bytes;
        let file_lease = Arc::clone(&self.file_lease);
        // WebView 停止读取响应时不会再 poll 到 EOF。把最后一个不足 512 KiB 的
        // 尾段异步 flush 后发布；若运行时已经退出，则只关闭 capture 标志并保留
        // 上一次已发布长度，不能在析构里阻塞音频线程。
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let flushed = file.flush().await.is_ok();
                drop(file);
                let _keep_path_alive = file_lease;
                coordinator.finish_capture(
                    &key,
                    epoch,
                    if flushed { bytes } else { published_bytes },
                    false,
                    true,
                    false,
                );
            });
        } else {
            drop(file);
            coordinator.finish_capture(&key, epoch, published_bytes, false, true, false);
        }
    }
}

fn snapshot(entry: &StreamWaveformEntry) -> StreamWaveformProgress {
    let analysis_status = if entry.analysis_complete {
        if entry.analysis.is_some() {
            StreamAnalysisStatus::Ready
        } else {
            StreamAnalysisStatus::Failed
        }
    } else if entry.complete {
        StreamAnalysisStatus::Analyzing
    } else {
        StreamAnalysisStatus::Waiting
    };
    StreamWaveformProgress {
        waveform: entry.waveform.clone(),
        covered_seconds: entry.covered_seconds,
        revision: entry.revision,
        cached_bytes: entry.bytes,
        total_bytes: entry.total_bytes,
        complete: entry.complete,
        // complete 可能刚好落在节流窗口内，最终 pass 尚未启动；仍报 active 让
        // PlayerBar 续租，窗口结束后 request 才有机会真正排入。否则前端会因
        // complete && !active 提前停止，永远只留在 90% 的旧波形。
        active: entry.inflight
            || entry.capture_open
            || (entry.complete && (!entry.complete_analyzed || !entry.analysis_complete)),
        analysis_status,
        analysis: entry.analysis.clone(),
        analysis_error: entry.analysis_error.clone(),
    }
}

/// 第一段尽快出现，之后至少翻倍才重新从头解码。这样 60 MB FLAC 的全部渐进
/// 任务合计读取量小于约 120 MB，不会像 50% 增长那样在移动端密集反复扫前缀。
fn next_analysis_bytes(previous: u64) -> u64 {
    if previous == 0 {
        FIRST_ANALYSIS_BYTES
    } else {
        previous
            .saturating_mul(ANALYSIS_GROWTH_FACTOR)
            .max(previous.saturating_add(FIRST_ANALYSIS_BYTES))
    }
}

fn plan_job(key: &str, entry: &mut StreamWaveformEntry) -> Option<AnalyzeJob> {
    if !entry
        .requested_until
        .is_some_and(|until| until > Instant::now())
        || entry.inflight
    {
        return None;
    }
    let path = entry.path.clone()?;
    if entry.bytes == 0 {
        return None;
    }
    let path_changed = entry.last_requested_path.as_ref() != Some(&path);
    let needs_complete_pass =
        entry.complete && (!entry.complete_analyzed || !entry.analysis_complete);
    let enough_growth = entry.bytes >= next_analysis_bytes(entry.last_requested_bytes);
    if !path_changed && !needs_complete_pass && !enough_growth {
        return None;
    }
    // 小到连一个稳妥 probe 都不值得的前缀等下一个 chunk；完整文件例外。
    if !entry.complete && entry.bytes < FIRST_ANALYSIS_BYTES {
        return None;
    }
    // 完整文件也尊重节流：刚分析完 90% 又立刻为 100% 重跑整轨，正是 Android
    // 上最容易听成爆音的 CPU/IO 尖峰。PlayerBar 的续租轮询会在窗口后再次计划。
    let now = Instant::now();
    if entry
        .analysis_not_before
        .is_some_and(|not_before| not_before > now)
    {
        return None;
    }
    if entry
        .last_analysis_started_at
        .is_some_and(|started| now.saturating_duration_since(started) < ANALYSIS_MIN_INTERVAL)
    {
        return None;
    }
    entry.inflight = true;
    entry.last_requested_path = Some(path.clone());
    entry.last_requested_bytes = entry.bytes;
    entry.last_analysis_started_at = Some(now);
    Some(AnalyzeJob {
        key: key.to_string(),
        path,
        epoch: entry.epoch,
        complete: entry.complete,
        analysis_duration: entry.analysis_duration,
        _ephemeral_file: entry.ephemeral_file.as_ref().cloned(),
    })
}

fn allocate_epoch(inner: &mut StreamWaveformInner) -> u64 {
    inner.next_epoch = inner.next_epoch.wrapping_add(1).max(1);
    inner.next_epoch
}

fn allocate_revision(inner: &mut StreamWaveformInner) -> u64 {
    inner.next_revision = inner.next_revision.wrapping_add(1).max(1);
    inner.next_revision
}

fn ensure_entry(inner: &mut StreamWaveformInner, key: &str) {
    if inner.entries.contains_key(key) {
        return;
    }
    let epoch = allocate_epoch(inner);
    let mut entry = StreamWaveformEntry::default();
    entry.epoch = epoch;
    inner.entries.insert(key.to_string(), entry);
}

async fn create_ephemeral_file(
    root: &Path,
) -> io::Result<(tokio::io::BufWriter<tokio::fs::File>, Arc<EphemeralFile>)> {
    // 根目录由 AppConfig.data_dir 显式提供；随机名配合 create_new，既不依赖全局
    // temp_dir，也不会误碰另一会话的文件。
    for _ in 0..8 {
        let path = root.join(format!("capture-{:016x}.partial", rand::random::<u64>()));
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => {
                return Ok((
                    tokio::io::BufWriter::with_capacity(CAPTURE_WRITE_BUFFER_BYTES, file),
                    Arc::new(EphemeralFile { path }),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法分配流媒体波形临时文件",
    ))
}

fn decode_cached_waveform(path: &Path, complete: bool) -> Option<(Waveform, f64)> {
    let decoded = kdj_analysis::decode::decode_audio_native(path, None).ok()?;
    let covered_seconds =
        ((decoded.samples.len() as f64 / decoded.sample_rate as f64) * 1000.0).round() / 1000.0;
    if covered_seconds <= 0.0 {
        return None;
    }
    if !complete {
        // A growing media file is decoded repeatedly. Running the full semantic/inverse-FFT
        // pipeline on every prefix competes with the very playback that is filling this file and
        // produces periodic CPU/IO spikes. The temporary preview keeps the release structure and
        // base RGB on one low-QoS worker; the exact release overview replaces it once complete.
        let mut overview = kdj_analysis::waveform::progressive_release_overview_waveform(
            &decoded.samples,
            f64::from(decoded.sample_rate),
            crate::waveform::RELEASE_OVERVIEW_BUCKETS,
        );
        if overview.amp.is_empty() {
            return None;
        }
        overview.duration = covered_seconds;
        return Some((overview, covered_seconds));
    }
    // The complete online file needs one exact release overview for the bottom rail. Do not also
    // build/serialize the old 400-columns/sec full-song DJ asset: Manager now gets a six-second
    // window from playback PCM, so that large array had no consumer and caused the heaviest CPU
    // spike precisely when a download completed.
    let evidence_resampled = (decoded.sample_rate != kdj_analysis::waveform::WAVEFORM_EVIDENCE_SR)
        .then(|| {
            kdj_analysis::decode::resample_mono(
                &decoded.samples,
                decoded.sample_rate,
                kdj_analysis::waveform::WAVEFORM_EVIDENCE_SR,
            )
        });
    let evidence_samples = evidence_resampled.as_deref().unwrap_or(&decoded.samples);
    let evidence = kdj_analysis::waveform::analyze_waveform_evidence(
        evidence_samples,
        f64::from(kdj_analysis::waveform::WAVEFORM_EVIDENCE_SR),
    );
    let release_resampled = (decoded.sample_rate != kdj_analysis::waveform::RELEASE_OVERVIEW_SR)
        .then(|| {
            kdj_analysis::decode::resample_mono(
                &decoded.samples,
                decoded.sample_rate,
                kdj_analysis::waveform::RELEASE_OVERVIEW_SR,
            )
        });
    let release_samples = release_resampled.as_deref().unwrap_or(&decoded.samples);
    let mut overview = kdj_analysis::waveform::release_overview_waveform_with_evidence(
        release_samples,
        f64::from(kdj_analysis::waveform::RELEASE_OVERVIEW_SR),
        crate::waveform::RELEASE_OVERVIEW_BUCKETS,
        &evidence,
    );
    if overview.amp.is_empty() {
        return None;
    }
    // 前端把渐进 overview 投影到整曲时长；这里保留真实可解码长度，不能把前缀
    // 拉伸成完整曲目。
    overview.duration = covered_seconds;
    Some((overview, covered_seconds))
}

#[cfg(test)]
fn decode_cached_prefix(path: &Path) -> Option<(Waveform, f64)> {
    decode_cached_waveform(path, false)
}

fn analyze_complete_stream(path: &Path, duration_limit: f64) -> (Option<AnalysisResult>, String) {
    let result = kdj_analysis::engine::analyze_file(path, duration_limit);
    let has_result = result.bpm.is_some()
        || !result.key.is_empty()
        || !result.camelot.is_empty()
        || result.energy.is_some()
        || result.rms_db.is_some()
        || result.peak_db.is_some();
    let error = result.errors.join("；");
    if has_result {
        (Some(result), error)
    } else {
        (
            None,
            if error.is_empty() {
                "完整音频未能生成可用的分析结果".to_string()
            } else {
                error
            },
        )
    }
}

fn trim_entries(
    entries: &mut HashMap<String, StreamWaveformEntry>,
    limits: SessionLimits,
    protected: Option<&str>,
) {
    let now = Instant::now();
    let expired = entries
        .iter()
        .filter(|(key, entry)| {
            protected != Some(key.as_str())
                && entry.ephemeral_file.is_some()
                && !entry.inflight
                && !entry.capture_open
                && entry.requested_until.is_none_or(|deadline| deadline <= now)
        })
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    for key in expired {
        entries.remove(&key);
    }

    while entries.len() > ENTRY_LIMIT
        || entries
            .values()
            .filter(|entry| entry.ephemeral_file.is_some())
            .map(|entry| entry.capture_file_bytes)
            .sum::<u64>()
            > limits.total_bytes
    {
        let Some(key) = entries
            .iter()
            .filter(|(key, entry)| {
                protected != Some(key.as_str()) && !entry.inflight && !entry.capture_open
            })
            .min_by_key(|(_, entry)| entry.last_access)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        entries.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_core::models::{Platform, Quality, SongSource};

    fn scratch(name: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/stream-waveform-tests")
            .join(format!("{name}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).expect("create stream waveform test root");
        root
    }

    fn source(key: &str) -> SongSource {
        SongSource {
            platform: Platform::Wyy,
            key: key.to_string(),
            title: key.to_string(),
            artists: vec![],
            album: String::new(),
            duration: Some(3.0),
            cover: String::new(),
            max_quality: Some(Quality::Q128),
            vip: false,
            payload: Default::default(),
        }
    }

    /// 生成一小段单声道 PCM WAV；路径故意没有音频扩展名，和 stream-cache 的
    /// `.partial` 一样，用来锁住“靠文件头 probe、并发只读前缀”的真实路径。
    fn pcm_wav(seconds: usize) -> Vec<u8> {
        const SAMPLE_RATE: u32 = 16_000;
        let frames = SAMPLE_RATE as usize * seconds;
        let data_bytes = (frames * 2) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16_u32.to_le_bytes());
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        out.extend_from_slice(&2_u16.to_le_bytes());
        out.extend_from_slice(&16_u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for frame in 0..frames {
            // 不用依赖浮点三角函数；周期锯齿足以让 FFT 有非零真实样本。
            let sample = (((frame % 200) as i32 - 100) * 250) as i16;
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out
    }

    fn test_waveform() -> Waveform {
        Waveform {
            track_id: 0,
            duration: 1.0,
            amp: vec![0.5],
            r: vec![255],
            g: vec![128],
            b: vec![64],
            ..Default::default()
        }
    }

    fn test_job_result() -> AnalyzeJobResult {
        AnalyzeJobResult {
            waveform: Some((test_waveform(), 1.0)),
            analysis: None,
            analysis_error: "test analysis omitted".to_string(),
        }
    }

    #[test]
    fn snapshot_reports_real_cache_byte_progress() {
        let entry = StreamWaveformEntry {
            bytes: 3,
            total_bytes: 10,
            ..Default::default()
        };
        let progress = snapshot(&entry);
        assert_eq!(progress.cached_bytes, 3);
        assert_eq!(progress.total_bytes, 10);
        assert!(!progress.complete);
    }

    fn capture_plan(
        coordinator: &StreamWaveformCoordinator,
        root: &Path,
        key: &str,
        start: u64,
        expected: u64,
        total: u64,
        complete: bool,
    ) -> StreamWaveformCapturePlan {
        coordinator
            .capture_plan(
                root.to_path_buf(),
                key.to_string(),
                start,
                expected,
                total,
                complete,
            )
            .expect("capture plan fits configured limits")
    }

    #[test]
    fn progressive_threshold_grows_with_the_cache() {
        assert_eq!(next_analysis_bytes(0), FIRST_ANALYSIS_BYTES);
        assert_eq!(
            next_analysis_bytes(FIRST_ANALYSIS_BYTES),
            FIRST_ANALYSIS_BYTES * 2
        );
        assert_eq!(
            next_analysis_bytes(FIRST_ANALYSIS_BYTES * 8),
            FIRST_ANALYSIS_BYTES * 16
        );
    }

    #[test]
    fn current_online_work_never_enters_the_idle_only_bulk_lane() {
        assert_eq!(
            work_class_for_job(false),
            WorkClass::InteractiveWaveform,
            "the visible progressive rail must remain admissible during playback"
        );
        assert_eq!(
            work_class_for_job(true),
            WorkClass::LibraryAnalysisLight,
            "the final temporary metrics get one throttled live-audio slot"
        );
    }

    #[test]
    fn a_recent_prefix_decode_throttles_even_the_final_pass() {
        let mut entry = StreamWaveformEntry {
            requested_until: Some(Instant::now() + REQUEST_LEASE),
            path: Some(PathBuf::from("complete.media")),
            bytes: FIRST_ANALYSIS_BYTES * 4,
            complete: true,
            complete_analyzed: false,
            last_requested_path: Some(PathBuf::from("complete.media")),
            last_requested_bytes: FIRST_ANALYSIS_BYTES * 2,
            last_analysis_started_at: Some(Instant::now()),
            ..Default::default()
        };
        assert!(plan_job("song", &mut entry).is_none());
        assert!(
            snapshot(&entry).active,
            "delayed final pass must keep PlayerBar polling"
        );

        entry.last_analysis_started_at = Some(
            Instant::now()
                .checked_sub(ANALYSIS_MIN_INTERVAL + Duration::from_millis(1))
                .expect("test instant supports a short subtraction"),
        );
        assert!(
            plan_job("song", &mut entry).is_some(),
            "the next request schedules the final pass after the throttle window"
        );
        entry.inflight = false;
        entry.complete_analyzed = true;
        entry.analysis_complete = true;
        assert!(
            !snapshot(&entry).active,
            "a finished final pass lets PlayerBar stop polling"
        );
    }

    #[test]
    fn a_complete_file_forces_one_final_pass() {
        let mut entry = StreamWaveformEntry {
            requested_until: Some(Instant::now() + REQUEST_LEASE),
            path: Some(PathBuf::from("complete.media")),
            bytes: 10,
            complete: true,
            complete_analyzed: false,
            last_requested_path: Some(PathBuf::from("complete.media")),
            last_requested_bytes: 10,
            ..Default::default()
        };
        assert!(plan_job("song", &mut entry).is_some());
    }

    #[test]
    fn expired_player_lease_cannot_schedule_another_prefix_decode() {
        let mut entry = StreamWaveformEntry {
            requested_until: Some(Instant::now() - Duration::from_millis(1)),
            path: Some(PathBuf::from("stale.partial")),
            bytes: FIRST_ANALYSIS_BYTES,
            ..Default::default()
        };
        assert!(plan_job("song", &mut entry).is_none());
    }

    #[test]
    fn startup_guard_defers_the_first_progressive_decode() {
        let mut entry = StreamWaveformEntry {
            requested_until: Some(Instant::now() + REQUEST_LEASE),
            path: Some(PathBuf::from("starting.partial")),
            bytes: FIRST_ANALYSIS_BYTES,
            analysis_not_before: Some(Instant::now() + Duration::from_secs(3)),
            ..Default::default()
        };
        assert!(plan_job("song", &mut entry).is_none());
        entry.analysis_not_before = Some(Instant::now() - Duration::from_millis(1));
        assert!(plan_job("song", &mut entry).is_some());
    }

    #[test]
    fn expired_inactive_session_is_removed_by_trim() {
        let root = scratch("expired-lease");
        let path = root.join("capture-expired.partial");
        std::fs::write(&path, b"old").expect("write expired prefix");
        let mut entries = HashMap::new();
        entries.insert(
            "expired".into(),
            StreamWaveformEntry {
                requested_until: Some(Instant::now() - Duration::from_millis(1)),
                path: Some(path.clone()),
                bytes: 3,
                capture_file_bytes: 3,
                ephemeral_file: Some(Arc::new(EphemeralFile { path: path.clone() })),
                ..Default::default()
            },
        );
        trim_entries(&mut entries, SessionLimits::default(), None);
        assert!(entries.is_empty());
        assert!(!path.exists(), "entry drop removes the session partial");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn capture_plan_does_no_io_and_first_begin_cleans_stale_partials() {
        let parent = scratch("lazy-plan-parent");
        let unopened_root = parent.join("not-created-by-plan");
        let coordinator = StreamWaveformCoordinator::default();
        let unopened = capture_plan(&coordinator, &unopened_root, "unopened", 0, 4, 4, true);
        assert!(
            !unopened_root.exists(),
            "constructing a plan must not even create its session root"
        );
        drop(unopened);

        let root = parent.join("stream-waveform-session");
        std::fs::create_dir_all(&root).expect("create explicit session root");
        let stale = root.join("capture-stale.partial");
        let unrelated = root.join("keep.txt");
        std::fs::write(&stale, b"stale").unwrap();
        std::fs::write(&unrelated, b"keep").unwrap();

        let plan = capture_plan(&coordinator, &root, "lazy", 0, 4, 4, true);
        assert!(
            stale.exists(),
            "planning itself must not touch the filesystem"
        );
        let capture = plan.begin().await.unwrap().unwrap();
        assert!(
            !stale.exists(),
            "first worker begin removes stale session files"
        );
        assert!(unrelated.exists(), "cleanup is scoped to capture-*.partial");
        drop(capture);
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(parent).await;
    }

    #[tokio::test]
    async fn truncated_segment_is_never_complete_or_continuable() {
        let root = scratch("truncated-segment");
        let coordinator = StreamWaveformCoordinator::default();
        coordinator.media_started("song");
        let mut first = capture_plan(&coordinator, &root, "song", 0, 4, 8, false)
            .begin()
            .await
            .unwrap()
            .unwrap();
        first.write_chunk(b"ab").await.unwrap();
        first.finish(true).await.unwrap();

        let inner = coordinator.inner.lock().unwrap();
        let entry = inner.entries.get("song").unwrap();
        assert!(!entry.complete);
        assert!(!entry.capture_continuable);
        drop(inner);
        assert!(capture_plan(&coordinator, &root, "song", 2, 6, 8, true)
            .begin()
            .await
            .unwrap()
            .is_none());
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn append_requires_the_real_file_length_to_match_the_range_start() {
        let root = scratch("append-length");
        let coordinator = StreamWaveformCoordinator::default();
        coordinator.media_started("song");
        let mut first = capture_plan(&coordinator, &root, "song", 0, 4, 8, false)
            .begin()
            .await
            .unwrap()
            .unwrap();
        let path = first.path().to_path_buf();
        first.write_chunk(b"abcd").await.unwrap();
        first.finish(true).await.unwrap();
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        assert!(capture_plan(&coordinator, &root, "song", 4, 4, 8, true)
            .begin()
            .await
            .unwrap()
            .is_none());
        let inner = coordinator.inner.lock().unwrap();
        assert!(inner.entries.get("song").unwrap().ephemeral_file.is_none());
        drop(inner);
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn a_track_larger_than_the_file_budget_keeps_its_safe_prefix() {
        let root = scratch("large-track-prefix");
        let coordinator = StreamWaveformCoordinator::with_session_limits(8, 16);
        coordinator.media_started("large");
        let mut capture = capture_plan(&coordinator, &root, "large", 0, 16, 16, true)
            .begin()
            .await
            .unwrap()
            .unwrap();
        let path = capture.path().to_path_buf();
        assert!(
            capture.write_chunk(b"123456789").await.is_err(),
            "only the optional tee stops at the per-file cap, even within one large chunk"
        );
        capture.finish(false).await.unwrap();
        let inner = coordinator.inner.lock().unwrap();
        let entry = inner.entries.get("large").unwrap();
        assert_eq!(entry.bytes, 8);
        assert!(!entry.complete);
        assert!(!entry.capture_continuable);
        drop(inner);
        assert_eq!(std::fs::metadata(path).unwrap().len(), 8);
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn an_overlong_response_cannot_be_marked_complete_even_if_eof_is_reported() {
        let root = scratch("overlong-segment");
        let coordinator = StreamWaveformCoordinator::with_session_limits(16, 16);
        coordinator.media_started("overlong");
        let mut capture = capture_plan(&coordinator, &root, "overlong", 0, 4, 4, true)
            .begin()
            .await
            .unwrap()
            .unwrap();
        assert!(capture.write_chunk(b"abcde").await.is_err());
        capture.finish(true).await.unwrap();
        let inner = coordinator.inner.lock().unwrap();
        let entry = inner.entries.get("overlong").unwrap();
        assert_eq!(
            entry.bytes, 4,
            "only the declared continuous prefix is kept"
        );
        assert!(!entry.complete);
        assert!(!entry.capture_continuable);
        drop(inner);
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn total_byte_budget_evicts_only_an_idle_session_prefix() {
        let root = scratch("total-byte-budget");
        let coordinator = StreamWaveformCoordinator::with_session_limits(8, 12);
        coordinator.media_started("first");
        let mut first = capture_plan(&coordinator, &root, "first", 0, 8, 8, false)
            .begin()
            .await
            .unwrap()
            .unwrap();
        let first_path = first.path().to_path_buf();
        first.write_chunk(b"12345678").await.unwrap();
        first.finish(true).await.unwrap();
        coordinator
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut("first")
            .unwrap()
            .requested_until = Some(Instant::now() - Duration::from_millis(1));

        coordinator.media_started("second");
        let mut second = capture_plan(&coordinator, &root, "second", 0, 8, 8, false)
            .begin()
            .await
            .unwrap()
            .unwrap();
        second.write_chunk(b"abcdefgh").await.unwrap();
        assert!(
            !first_path.exists(),
            "LRU inactive prefix is evicted before total bytes exceed the budget"
        );
        second.finish(true).await.unwrap();
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn android_cache_fallback_waits_for_the_whole_playback_session_to_be_idle() {
        let coordinator = StreamWaveformCoordinator::default();
        coordinator.media_started("song");
        assert!(!coordinator.is_session_idle("song"));
        {
            let mut inner = coordinator.inner.lock().unwrap();
            let entry = inner.entries.get_mut("song").unwrap();
            entry.requested_until = Some(Instant::now() - Duration::from_millis(1));
            entry.capture_open = true;
        }
        assert!(!coordinator.is_session_idle("song"));
        {
            let mut inner = coordinator.inner.lock().unwrap();
            let entry = inner.entries.get_mut("song").unwrap();
            entry.capture_open = false;
            entry.inflight = true;
        }
        assert!(!coordinator.is_session_idle("song"));
        coordinator
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut("song")
            .unwrap()
            .inflight = false;
        assert!(coordinator.is_session_idle("song"));
    }

    #[test]
    fn stale_epoch_cannot_mutate_a_reused_final_media_path() {
        let coordinator = StreamWaveformCoordinator::default();
        let key = "same-cache-key".to_string();
        let path = PathBuf::from("same-cache-key.media");
        coordinator.observe(key.clone(), path.clone(), FIRST_ANALYSIS_BYTES, true);
        let old_epoch = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("old entry")
            .epoch;

        // 模拟清理后立即重播：最终文件名相同，但它必须是新的一代。
        coordinator.clear();
        coordinator.observe(key.clone(), path.clone(), FIRST_ANALYSIS_BYTES, true);
        let new_epoch = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("new entry")
            .epoch;
        assert_ne!(old_epoch, new_epoch);

        coordinator.finish_job(
            AnalyzeJob {
                key: key.clone(),
                path,
                epoch: old_epoch,
                complete: true,
                analysis_duration: DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS,
                _ephemeral_file: None,
            },
            test_job_result(),
        );
        let inner = coordinator.inner.lock().expect("state");
        let entry = inner.entries.get(&key).expect("new entry");
        assert_eq!(entry.epoch, new_epoch);
        assert!(entry.waveform.is_none(), "stale job must be ignored");
    }

    #[test]
    fn recreated_entry_receives_a_later_global_revision() {
        let coordinator = StreamWaveformCoordinator::default();
        let key = "same-cache-key".to_string();
        let path = PathBuf::from("same-cache-key.media");

        coordinator.observe(key.clone(), path.clone(), FIRST_ANALYSIS_BYTES, true);
        let first_epoch = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("first entry")
            .epoch;
        coordinator.finish_job(
            AnalyzeJob {
                key: key.clone(),
                path: path.clone(),
                epoch: first_epoch,
                complete: true,
                analysis_duration: DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS,
                _ephemeral_file: None,
            },
            test_job_result(),
        );
        let first_revision = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("first entry")
            .revision;
        assert!(first_revision > 0);

        coordinator.clear();
        coordinator.observe(key.clone(), path.clone(), FIRST_ANALYSIS_BYTES, true);
        let second_epoch = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("second entry")
            .epoch;
        coordinator.finish_job(
            AnalyzeJob {
                key: key.clone(),
                path,
                epoch: second_epoch,
                complete: true,
                analysis_duration: DEFAULT_STREAM_ANALYSIS_DURATION_SECONDS,
                _ephemeral_file: None,
            },
            test_job_result(),
        );
        let second_revision = coordinator
            .inner
            .lock()
            .expect("state")
            .entries
            .get(&key)
            .expect("second entry")
            .revision;
        assert!(second_revision > first_revision);
    }

    #[tokio::test]
    async fn decodes_a_flushed_partial_while_the_cache_writer_is_still_open() {
        let root = scratch("persistent-prefix");
        let cache = crate::stream_cache::StreamCache::default();
        cache.set_enabled(true);
        let source = source("progressive-wav");
        let key = crate::stream_cache::StreamCache::key(&source, Quality::Q128);
        let bytes = pcm_wav(3);
        let cut = 44 + (((bytes.len() - 44) * 2 / 3) & !1);
        let mut writer = cache
            .begin_write(
                &root,
                key,
                &source,
                Quality::Q128,
                "audio/wav".into(),
                Some(bytes.len() as u64),
            )
            .await
            .expect("create partial cache writer")
            .expect("cache is enabled");
        assert!(writer
            .write_chunk(&bytes[..cut])
            .await
            .expect("write partial"));
        assert!(writer.flush_for_observer().await.expect("flush partial"));

        let (waveform, covered) =
            decode_cached_prefix(writer.partial_path()).expect("readable partial must decode");
        assert!(
            covered > 1.0 && covered < 3.0,
            "decoded coverage: {covered}"
        );
        assert!(
            !waveform.amp.is_empty(),
            "PCM prefix must create real waveform columns"
        );

        drop(writer);
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn proxy_capture_builds_future_waveform_without_persistent_cache() {
        let coordinator = StreamWaveformCoordinator::default();
        let key = "session-only-waveform".to_string();
        let bytes = pcm_wav(3);
        let root = scratch("session-prefix");

        // 先模拟 PlayerBar 首轮轮询续租，再让媒体代理把同一响应旁路进临时文件。
        // 全程没有创建/启用 StreamCache，这正是默认设置下的回归场景。
        let initial = coordinator.request(key.clone());
        assert!(initial.waveform.is_none());
        let plan = coordinator
            .capture_plan(
                root.clone(),
                key.clone(),
                0,
                bytes.len() as u64,
                bytes.len() as u64,
                true,
            )
            .expect("small response fits the session budget");
        let mut capture = plan
            .begin()
            .await
            .expect("create session capture")
            .expect("0-based response is capturable");
        let capture_path = capture.path().to_path_buf();
        capture
            .write_chunk(&bytes)
            .await
            .expect("tee bytes into session file");
        capture.finish(true).await.expect("finish session capture");

        let progress = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let progress = coordinator.request(key.clone());
                if progress.waveform.is_some() && !progress.active {
                    break progress;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("session waveform decode must finish");
        assert!(progress.complete);
        assert!(progress.covered_seconds > 2.5);
        assert!(progress.waveform.is_some());
        assert!(
            progress
                .waveform
                .as_ref()
                .is_some_and(|waveform| !waveform.amp.is_empty()),
            "complete stream must publish its exact release overview"
        );
        assert_eq!(progress.analysis_status, StreamAnalysisStatus::Ready);
        assert!(
            progress
                .analysis
                .as_ref()
                .is_some_and(|analysis| analysis.energy.is_some() && analysis.rms_db.is_some()),
            "the same complete session file must also produce full analysis"
        );
        assert!(
            capture_path.is_file(),
            "coordinator keeps its session file alive"
        );

        coordinator.clear();
        assert!(
            !capture_path.exists(),
            "clearing the session removes the short-lived media prefix"
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn an_already_complete_cache_hit_is_analyzed_on_request() {
        let coordinator = StreamWaveformCoordinator::default();
        let key = "complete-cache-hit".to_string();
        let root = scratch("complete-cache-analysis");
        let path = root.join("complete.media");
        let bytes = pcm_wav(3);
        tokio::fs::write(&path, &bytes)
            .await
            .expect("write complete cached media");

        // 进程重启后的缓存命中会先 observe，直到当前 PlayerBar 带 token 轮询后才
        // 真正占分析额度；这条路径不经过会话 capture。
        coordinator.observe(key.clone(), path.clone(), bytes.len() as u64, true);
        let progress = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let progress = coordinator.request_with_analysis_duration(key.clone(), 120.0);
                if progress.analysis_status == StreamAnalysisStatus::Ready && !progress.active {
                    break progress;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("complete cache analysis must finish");

        assert!(progress.analysis.is_some());
        assert!(
            path.exists(),
            "analysis never consumes or removes persistent media"
        );
        coordinator.clear();
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
