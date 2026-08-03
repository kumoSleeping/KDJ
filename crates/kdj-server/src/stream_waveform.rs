//! 在线试听缓存的渐进波形。
//!
//! 浏览器只能告诉我们 `<audio>.buffered` 覆盖了哪些时间，不能把尚未播放的
//! 压缩音频交给 Web Audio 解码。这里复用 `stream_cache` 已经从 0 顺序写入的
//! 临时文件：每隔一段增长量对当前可读前缀解一次，前端便能把真实波形铺到
//! “已经缓存且已经可解码”的位置。部分 MP4/M4A 的索引在文件尾，前缀不能探测时
//! 自然等完整缓存后再出结果，绝不拿随机柱子冒充分析结果。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kdj_core::models::Waveform;
use serde::Serialize;

const ENTRY_LIMIT: usize = 24;
/// 首次至少攒一点文件头和音频包；太早 probe 只会反复报“无法识别格式”。
const FIRST_ANALYSIS_BYTES: u64 = 768 * 1024;
/// PlayerBar 每 750ms 续一次这份租约；切歌/卸载后不会再续，已排队的后续前缀
/// 分析自然停止，不需要让浏览器额外发一个带竞态的 DELETE。
const REQUEST_LEASE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
pub struct StreamWaveformProgress {
    /// 已成功解码并分析的媒体前缀。`duration` 是这个前缀的实际秒数，而非
    /// 容器头可能声明的整曲时长。
    pub waveform: Option<Waveform>,
    pub covered_seconds: f64,
    pub revision: u64,
    /// 缓存文件已经完整落盘；若 waveform 仍为空，表示格式不支持前缀解码或
    /// 完整解码失败，前端可停止轮询并继续用 analyser 的已播兜底。
    pub complete: bool,
    /// 当前有一次波形解码在跑。路由层还会把 stream-cache 的网络写入状态合进来。
    pub active: bool,
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
    requested_until: Option<Instant>,
    complete: bool,
    inflight: bool,
    complete_analyzed: bool,
    last_requested_path: Option<PathBuf>,
    last_requested_bytes: u64,
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
            requested_until: None,
            complete: false,
            inflight: false,
            complete_analyzed: false,
            last_requested_path: None,
            last_requested_bytes: 0,
            waveform: None,
            covered_seconds: 0.0,
            revision: 0,
            last_access: Instant::now(),
        }
    }
}

#[derive(Clone, Default)]
pub struct StreamWaveformCoordinator {
    inner: Arc<Mutex<StreamWaveformInner>>,
}

#[derive(Clone)]
struct AnalyzeJob {
    key: String,
    path: PathBuf,
    epoch: u64,
    complete: bool,
}

impl StreamWaveformCoordinator {
    /// 标记当前试听确实需要缓存波形，并返回现有快照。没有写入路径时只记请求：
    /// 首个媒体 GET 建起后台缓存后 `observe` 会接着启动分析。
    pub fn request(&self, key: String) -> StreamWaveformProgress {
        let (snapshot, job) = {
            let mut inner = self.inner.lock().expect("stream waveform state");
            ensure_entry(&mut inner, &key);
            let entry = inner.entries.get_mut(&key).expect("stream waveform entry");
            entry.requested_until = Some(Instant::now() + REQUEST_LEASE);
            entry.last_access = Instant::now();
            let job = plan_job(&key, entry);
            let snapshot = snapshot(entry);
            trim_entries(&mut inner.entries);
            (snapshot, job)
        };
        if let Some(job) = job {
            self.spawn(job);
        }
        snapshot
    }

    /// stream-cache 每写完一段就报告当前临时文件。这里不写文件、不碰网络；只有
    /// 当前播放器实际轮询过本曲（仍在租约内）才会占后台分析额度。
    pub fn observe(&self, key: String, path: PathBuf, bytes: u64, complete: bool) {
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
            entry.complete = complete;
            entry.last_access = Instant::now();
            // partial → final media 的 rename 是同一串字节，保留已经画出的前缀以免
            // 瞬间闪白；若完整 media 被清掉后换成新 partial，则必须清空旧快照，
            // 否则更短的新前缀会被“覆盖秒数不得倒退”的保护错误拒绝。
            let same_download_commit = path_changed && !was_complete && complete;
            if path_changed && !same_download_commit {
                entry.waveform = None;
                entry.covered_seconds = 0.0;
                entry.revision = 0;
            }
            if path_changed || became_complete {
                entry.complete_analyzed = false;
            }
            // partial 原子改名为最终 media（或用户重试时换了一份 partial）后，旧
            // 读取任务无法再代表当前路径。放开新任务即可；旧任务结束时会因路径
            // 不匹配自行丢弃，不能让 `inflight` 永久卡住。
            if path_changed {
                entry.inflight = false;
            }
            let job = plan_job(&key, entry);
            trim_entries(&mut inner.entries);
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
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            // 渐进波形属于后台分析，不得绕过整库分析的并发上限。
            let _permit = crate::jobs::acquire_background_analysis_permit();
            let result = decode_cached_prefix(&job.path);
            finish_job(inner, job, result);
        });
    }
}

fn snapshot(entry: &StreamWaveformEntry) -> StreamWaveformProgress {
    StreamWaveformProgress {
        waveform: entry.waveform.clone(),
        covered_seconds: entry.covered_seconds,
        revision: entry.revision,
        complete: entry.complete,
        active: entry.inflight,
    }
}

/// 前缀每次至少增长 50%，能在下载早期很快出现第一段波形，随后保持对数次数，
/// 不会把 60 MB FLAC 反复从头解几十遍。
fn next_analysis_bytes(previous: u64) -> u64 {
    if previous == 0 {
        FIRST_ANALYSIS_BYTES
    } else {
        previous.saturating_add((previous / 2).max(FIRST_ANALYSIS_BYTES))
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
    let needs_complete_pass = entry.complete && !entry.complete_analyzed;
    let enough_growth = entry.bytes >= next_analysis_bytes(entry.last_requested_bytes);
    if !path_changed && !needs_complete_pass && !enough_growth {
        return None;
    }
    // 小到连一个稳妥 probe 都不值得的前缀等下一个 chunk；完整文件例外。
    if !entry.complete && entry.bytes < FIRST_ANALYSIS_BYTES {
        return None;
    }
    entry.inflight = true;
    entry.last_requested_path = Some(path.clone());
    entry.last_requested_bytes = entry.bytes;
    Some(AnalyzeJob {
        key: key.to_string(),
        path,
        epoch: entry.epoch,
        complete: entry.complete,
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

fn finish_job(
    inner: Arc<Mutex<StreamWaveformInner>>,
    job: AnalyzeJob,
    result: Option<(Waveform, f64)>,
) {
    let next = {
        let mut inner = inner.lock().expect("stream waveform state");
        let Some(current) = inner.entries.get(&job.key) else {
            return;
        };
        // 清理/重试后同一个缓存键可能指向一份新的 partial；旧任务的结果绝不能
        // 覆盖它。`inflight` 也只能由仍匹配的任务释放。
        if current.epoch != job.epoch || current.path.as_ref() != Some(&job.path) {
            return;
        }
        let should_update = result
            .as_ref()
            .is_some_and(|(_, covered_seconds)| *covered_seconds + 0.02 >= current.covered_seconds);
        let update_revision = should_update.then(|| allocate_revision(&mut inner));
        let entry = inner
            .entries
            .get_mut(&job.key)
            .expect("stream waveform entry was just validated");
        entry.inflight = false;
        entry.last_access = Instant::now();
        if let (Some((waveform, covered_seconds)), Some(revision)) = (result, update_revision) {
            entry.waveform = Some(waveform);
            entry.covered_seconds = covered_seconds;
            entry.revision = revision;
        }
        if job.complete {
            // 即便格式不支持，完整文件也只尝试一次；否则前端每轮轮询都可能再开一
            // 条昂贵的解码任务。
            entry.complete_analyzed = true;
        }
        plan_job(&job.key, entry)
    };
    if let Some(next) = next {
        let coordinator = StreamWaveformCoordinator { inner };
        coordinator.spawn(next);
    }
}

fn decode_cached_prefix(path: &Path) -> Option<(Waveform, f64)> {
    let decoded =
        kdj_analysis::decode::decode_audio(path, kdj_analysis::waveform::WAVEFORM_SR, None).ok()?;
    let covered_seconds =
        ((decoded.samples.len() as f64 / decoded.sample_rate as f64) * 1000.0).round() / 1000.0;
    if covered_seconds <= 0.0 {
        return None;
    }
    let mut waveform = kdj_analysis::waveform::band_waveform(
        &decoded.samples,
        decoded.sample_rate as f64,
        crate::waveform::DEFAULT_WAVEFORM_BUCKETS,
    );
    if waveform.amp.is_empty() {
        return None;
    }
    // 前端把它投影到整曲时长上；这里必须保留真实可解码的长度，不能使用 MP4
    // header 里的整曲时长，否则未下载尾部会被错误标成“已分析”。
    waveform.duration = covered_seconds;
    Some((waveform, covered_seconds))
}

fn trim_entries(entries: &mut HashMap<String, StreamWaveformEntry>) {
    while entries.len() > ENTRY_LIMIT {
        let Some(key) = entries
            .iter()
            .filter(|(_, entry)| !entry.inflight)
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
        }
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
            FIRST_ANALYSIS_BYTES * 12
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

        finish_job(
            Arc::clone(&coordinator.inner),
            AnalyzeJob {
                key: key.clone(),
                path,
                epoch: old_epoch,
                complete: true,
            },
            Some((test_waveform(), 1.0)),
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
        finish_job(
            Arc::clone(&coordinator.inner),
            AnalyzeJob {
                key: key.clone(),
                path: path.clone(),
                epoch: first_epoch,
                complete: true,
            },
            Some((test_waveform(), 1.0)),
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
        finish_job(
            Arc::clone(&coordinator.inner),
            AnalyzeJob {
                key: key.clone(),
                path,
                epoch: second_epoch,
                complete: true,
            },
            Some((test_waveform(), 1.0)),
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
        let root = std::env::temp_dir().join(format!(
            "kdj-stream-waveform-test-{:016x}",
            rand::random::<u64>()
        ));
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
}
