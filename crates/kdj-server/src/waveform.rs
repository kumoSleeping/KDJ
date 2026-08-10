//! 交互波形：缓存读写 + 单飞计算 + 给分析让路。
//!
//! 波形是用户盯着看的交互路径；后台分析不能把它堵在 `spawn_blocking`
//! 队列里几十秒。这里：
//! - 同 `(track_id, buckets, mtime)` 只解一次，PlayerBar / 详情栏共享结果；
//! - 开算之前先占住分析闸门，逼正在跑的分析在歌与歌之间让开。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use anyhow::{Context, Result};
use kdj_core::models::Waveform;
use kdj_library::LibraryService;
use tokio::sync::broadcast;

use crate::jobs;

/// 播放条 / 详情栏默认要的列数。分析预热也写这一档。
pub const DEFAULT_WAVEFORM_BUCKETS: usize = 640;
pub const CANONICAL_WAVEFORM_PROFILE: &str = "kdwave-v1-640";
pub const CANONICAL_WAVEFORM_REVISION: i64 = 1;
const CACHE_MAGIC: &[u8; 8] = b"KDJWAVE\0";
const CACHE_VERSION: u16 = 1;
const CACHE_HEADER_LEN: usize = 8 + 2 + 8 + 8 + 4;
const MAX_CACHE_COLUMNS: usize = 100_000;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct WaveKey {
    track_id: i64,
    buckets: usize,
    mtime: u64,
}

#[derive(Clone)]
enum WaveOutcome {
    Ok(Waveform),
    Err(String),
}

#[derive(Clone)]
struct WarmRequest {
    key: WaveKey,
    path: PathBuf,
    cache_dir: PathBuf,
}

#[derive(Default)]
struct WarmQueue {
    requests: VecDeque<WarmRequest>,
    /// 排队和正在计算的都留在这里，避免分析线程每首完成时重复塞同一个任务。
    active: HashSet<WaveKey>,
}

/// 单飞 + 一条不会丢任务的波形预热队列。
///
/// 旧实现用全局 `BUSY`：上一首没算完，后续所有歌曲直接跳过，批量分析结束后
/// 大量歌曲仍要在播放时现场计算。这里固定一个 worker，忙时排队而不是丢弃。
pub struct WaveformCoordinator {
    inflight: Mutex<HashMap<WaveKey, broadcast::Sender<WaveOutcome>>>,
    warm: Mutex<WarmQueue>,
    warm_ready: Condvar,
    library: Arc<LibraryService>,
}

impl WaveformCoordinator {
    pub fn new(library: Arc<LibraryService>) -> Arc<Self> {
        let coordinator = Arc::new(Self {
            inflight: Default::default(),
            warm: Default::default(),
            warm_ready: Condvar::new(),
            library,
        });
        let worker = Arc::clone(&coordinator);
        let _ = std::thread::Builder::new()
            .name("waveform-worker".into())
            .spawn(move || worker.warm_loop());
        coordinator
    }

    /// 把固定 640 列的演奏波形放进单 worker 队列。`priority` 给已装入 Deck 的歌曲用；
    /// 普通批量分析走队尾。缓存已存在、已排队或正在算都不会重复提交。
    pub fn enqueue_default(
        &self,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
        priority: bool,
    ) {
        let mtime = file_mtime(&path);
        let key = WaveKey {
            track_id,
            buckets: DEFAULT_WAVEFORM_BUCKETS,
            mtime,
        };
        if let Some((_, canonical)) = read_cached(&cache_dir, key) {
            if canonical {
                self.record_status(key, None);
            }
            return;
        }
        let mut queue = self.warm.lock().expect("waveform warm queue");
        if !queue.active.insert(key) {
            return;
        }
        let request = WarmRequest {
            key,
            path,
            cache_dir,
        };
        if priority {
            queue.requests.push_front(request);
        } else {
            queue.requests.push_back(request);
        }
        self.warm_ready.notify_one();
    }

    fn warm_loop(&self) {
        loop {
            let request = {
                let mut queue = self.warm.lock().expect("waveform warm queue");
                while queue.requests.is_empty() {
                    queue = self.warm_ready.wait(queue).expect("waveform warm wait");
                }
                queue.requests.pop_front().expect("队列刚确认非空")
            };
            self.run_warm_request(&request);
            self.warm
                .lock()
                .expect("waveform warm queue")
                .active
                .remove(&request.key);
        }
    }

    fn run_warm_request(&self, request: &WarmRequest) {
        let cache_file = cache_path(
            &request.cache_dir,
            request.key.track_id,
            request.key.buckets,
            request.key.mtime,
        );
        if let Some((_, canonical)) = read_cached(&request.cache_dir, request.key) {
            if canonical {
                self.record_status(request.key, None);
            }
            return;
        }

        // 等后台额度时先不要占 inflight：播放器若在这时要同一首，可以直接成为
        // 交互 leader；拿到额度后再查一次缓存，就不会重复解码。
        let _permit = jobs::acquire_background_analysis_permit();
        if let Some((_, canonical)) = read_cached(&request.cache_dir, request.key) {
            if canonical {
                self.record_status(request.key, None);
            }
            return;
        }

        // 真正开始后和交互请求共用 inflight 表，同一首只解一次。
        let leader = {
            let mut map = self.inflight.lock().expect("waveform inflight");
            if map.contains_key(&request.key) {
                false
            } else {
                let (tx, _rx) = broadcast::channel(1);
                map.insert(request.key, tx);
                true
            }
        };
        if !leader {
            return;
        }

        let computed = compute_waveform(&request.path, request.key.track_id, request.key.buckets);
        let outcome = match computed {
            Ok(wave) => match write_cache(&cache_file, &wave) {
                Ok(()) => WaveOutcome::Ok(wave),
                Err(err) => WaveOutcome::Err(format!("{err:#}")),
            },
            Err(err) => WaveOutcome::Err(format!("{err:#}")),
        };
        if let WaveOutcome::Err(message) = &outcome {
            tracing::debug!("波形预热跳过 {}：{}", request.key.track_id, message);
        }
        self.record_outcome(request.key, &outcome);
        publish(self, request.key, outcome);
    }

    /// 交互读取：缓存未命中时暂停后台分析接下一首，把 CPU 先让给播放器。
    pub async fn get_or_compute(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(track_id, path, buckets, cache_dir, true, true)
            .await
    }

    /// 外置文件的交互波形只使用解码/缓存能力，不向 KDJ 本地曲库写资产状态。
    pub async fn get_or_compute_detached(
        self: &Arc<Self>,
        cache_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(cache_id, path, buckets, cache_dir, true, false)
            .await
    }

    /// 旧曲库补齐固定演奏波形。它仍然单飞，但不抢交互优先权、不暂停主分析。
    pub async fn prepare_default(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        self.get_or_compute_mode(
            track_id,
            path,
            DEFAULT_WAVEFORM_BUCKETS,
            cache_dir,
            false,
            true,
        )
        .await
    }

    async fn get_or_compute_mode(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
        interactive: bool,
        record_status: bool,
    ) -> Result<Waveform> {
        let buckets = buckets.clamp(64, 2000);
        let mtime = file_mtime(&path);
        let key = WaveKey {
            track_id,
            buckets,
            mtime,
        };
        let cache_file = cache_path(&cache_dir, track_id, buckets, mtime);
        if let Some((cached, canonical)) = read_cached(&cache_dir, key) {
            if canonical && record_status {
                self.record_status(key, None);
            }
            return Ok(cached);
        }

        let follower = {
            let mut map = self.inflight.lock().expect("waveform inflight");
            if let Some(tx) = map.get(&key) {
                Some(tx.subscribe())
            } else {
                let (tx, _rx) = broadcast::channel(1);
                map.insert(key, tx);
                None
            }
        };

        if let Some(mut rx) = follower {
            return match rx.recv().await.context("等待波形结果失败")? {
                WaveOutcome::Ok(wave) => Ok(wave),
                WaveOutcome::Err(msg) => Err(anyhow::anyhow!(msg)),
            };
        }

        let coord = Arc::clone(self);
        let outcome = tokio::task::spawn_blocking(move || {
            // 只有播放器请求占交互优先权；全库补齐和预热则与 BPM 共用 2 个额度。
            let _yield = interactive.then(jobs::yield_analysis_permits);
            let _background_permit = (!interactive).then(jobs::acquire_background_analysis_permit);
            // 等闸门期间别人可能已经写好缓存（分析预热 / 并发请求）
            if let Some((cached, canonical)) = read_cached(&cache_dir, key) {
                let outcome = WaveOutcome::Ok(cached);
                if canonical && record_status {
                    coord.record_outcome(key, &outcome);
                }
                publish(&coord, key, outcome.clone());
                return outcome;
            }
            let computed = compute_waveform(&path, track_id, buckets);
            let outcome = match computed {
                Ok(wave) => match write_cache(&cache_file, &wave) {
                    Ok(()) => WaveOutcome::Ok(wave),
                    Err(err) => WaveOutcome::Err(format!("{err:#}")),
                },
                Err(err) => {
                    tracing::warn!("波形生成失败 {track_id}：{err:#}");
                    WaveOutcome::Err(format!("{err:#}"))
                }
            };
            if record_status {
                coord.record_outcome(key, &outcome);
            }
            publish(&coord, key, outcome.clone());
            outcome
        })
        .await
        .context("波形任务被取消")?;

        match outcome {
            WaveOutcome::Ok(wave) => Ok(wave),
            WaveOutcome::Err(msg) => Err(anyhow::anyhow!(msg)),
        }
    }

    fn record_outcome(&self, key: WaveKey, outcome: &WaveOutcome) {
        match outcome {
            WaveOutcome::Ok(_) => self.record_status(key, None),
            WaveOutcome::Err(message) => self.record_status(key, Some(message)),
        }
    }

    fn record_status(&self, key: WaveKey, error: Option<&str>) {
        if key.buckets != DEFAULT_WAVEFORM_BUCKETS {
            return;
        }
        if let Err(err) = self.library.record_waveform_asset(
            key.track_id,
            CANONICAL_WAVEFORM_PROFILE,
            CANONICAL_WAVEFORM_REVISION,
            key.mtime,
            error,
        ) {
            tracing::warn!("记录波形就绪状态失败 {}：{err:#}", key.track_id);
        }
    }
}

fn publish(coord: &WaveformCoordinator, key: WaveKey, outcome: WaveOutcome) {
    if let Some(tx) = coord
        .inflight
        .lock()
        .expect("waveform inflight")
        .remove(&key)
    {
        let _ = tx.send(outcome);
    }
}

/// `.kdwave` 是固定小端二进制：魔数、格式版本、track、时长、列数，随后依次是
/// f32 amp 与三个 u8 色彩通道。长度可以在分配前精确校验，半截文件不会被接受。
fn encode_cache(wave: &Waveform) -> Result<Vec<u8>> {
    let count = wave.amp.len();
    anyhow::ensure!(
        count > 0 && count <= MAX_CACHE_COLUMNS,
        "波形列数非法：{count}"
    );
    anyhow::ensure!(
        wave.r.len() == count && wave.g.len() == count && wave.b.len() == count,
        "波形通道长度不一致"
    );
    anyhow::ensure!(
        wave.duration.is_finite() && wave.duration >= 0.0,
        "波形时长非法"
    );
    anyhow::ensure!(
        wave.amp.iter().all(|value| value.is_finite()),
        "波形振幅含非法值"
    );

    let mut body = Vec::with_capacity(CACHE_HEADER_LEN + count * 7);
    body.extend_from_slice(CACHE_MAGIC);
    body.extend_from_slice(&CACHE_VERSION.to_le_bytes());
    body.extend_from_slice(&wave.track_id.to_le_bytes());
    body.extend_from_slice(&wave.duration.to_le_bytes());
    body.extend_from_slice(&(count as u32).to_le_bytes());
    for value in &wave.amp {
        body.extend_from_slice(&value.to_le_bytes());
    }
    body.extend_from_slice(&wave.r);
    body.extend_from_slice(&wave.g);
    body.extend_from_slice(&wave.b);
    Ok(body)
}

/// 缓存也走“临时文件 → 原子提交”。进程被 kill 时最多留下 `.partial`，
/// 已有完整资产不会被截断。
fn write_cache(path: &Path, wave: &Waveform) -> Result<()> {
    let parent = path.parent().context("波形缓存没有上级目录")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("创建波形缓存目录失败：{}", parent.display()))?;
    let body = encode_cache(wave)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".wave-{nonce}.partial"));
    std::fs::write(&tmp, body).with_context(|| format!("写波形临时文件失败：{}", tmp.display()))?;
    if let Err(first) = std::fs::rename(&tmp, path) {
        if path.is_file() {
            let rollback = parent.join(format!(".wave-{nonce}.rollback"));
            std::fs::rename(path, &rollback)
                .with_context(|| format!("暂存旧波形失败：{}", path.display()))?;
            if let Err(second) = std::fs::rename(&tmp, path) {
                let _ = std::fs::rename(&rollback, path);
                let _ = std::fs::remove_file(&tmp);
                return Err(second).with_context(|| {
                    format!("提交波形失败：{}（首次错误：{first}）", path.display())
                });
            }
            let _ = std::fs::remove_file(rollback);
        } else {
            let _ = std::fs::remove_file(&tmp);
            return Err(first).with_context(|| format!("提交波形失败：{}", path.display()));
        }
    }
    Ok(())
}

fn compute_waveform(path: &Path, track_id: i64, buckets: usize) -> Result<Waveform> {
    let decoded =
        kdj_analysis::decode::decode_audio(path, kdj_analysis::waveform::WAVEFORM_SR, None)
            .with_context(|| format!("解码失败：{}", path.display()))?;
    let mut wave = kdj_analysis::waveform::band_waveform(
        &decoded.samples,
        decoded.sample_rate as f64,
        buckets,
    );
    if wave.amp.is_empty() {
        anyhow::bail!("文件没有可解码的音频");
    }
    wave.track_id = track_id;
    Ok(wave)
}

/// 完整播放条使用固定列数。分析器按 STFT 整数步长输出近似列数，这里以时间面积
/// 重采样到请求宽度；高度保留窗口峰值，颜色按响度加权，短曲也不会退化成双空线。
pub fn fit_waveform_columns(wave: Waveform, columns: usize) -> Waveform {
    let columns = columns.clamp(64, 2_000);
    let source_len = wave.amp.len();
    if source_len == columns
        || source_len == 0
        || wave.r.len() != source_len
        || wave.g.len() != source_len
        || wave.b.len() != source_len
    {
        return wave;
    }
    let mut amp = Vec::with_capacity(columns);
    let mut red = Vec::with_capacity(columns);
    let mut green = Vec::with_capacity(columns);
    let mut blue = Vec::with_capacity(columns);
    for target in 0..columns {
        let start = target as f64 * source_len as f64 / columns as f64;
        let end = (target + 1) as f64 * source_len as f64 / columns as f64;
        let first = start.floor() as usize;
        let last = (end.ceil() as usize).min(source_len);
        let mut peak = 0.0f32;
        let mut r = 0.0f64;
        let mut g = 0.0f64;
        let mut b = 0.0f64;
        let mut total_weight = 0.0f64;
        for source in first..last {
            let overlap = (end.min((source + 1) as f64) - start.max(source as f64)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            let value = wave.amp[source].clamp(0.0, 1.0);
            peak = peak.max(value);
            let weight = overlap * (f64::from(value) + 0.001);
            r += f64::from(wave.r[source]) * weight;
            g += f64::from(wave.g[source]) * weight;
            b += f64::from(wave.b[source]) * weight;
            total_weight += weight;
        }
        let fallback = first.min(source_len - 1);
        amp.push(peak);
        red.push(if total_weight > 0.0 {
            (r / total_weight).round() as u8
        } else {
            wave.r[fallback]
        });
        green.push(if total_weight > 0.0 {
            (g / total_weight).round() as u8
        } else {
            wave.g[fallback]
        });
        blue.push(if total_weight > 0.0 {
            (b / total_weight).round() as u8
        } else {
            wave.b[fallback]
        });
    }
    Waveform {
        track_id: wave.track_id,
        duration: wave.duration,
        amp,
        r: red,
        g: green,
        b: blue,
    }
}

pub fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

fn cache_path(cache_dir: &Path, track_id: i64, buckets: usize, mtime: u64) -> PathBuf {
    cache_dir.join(format!("{track_id}-v3-{buckets}-{mtime}.kdwave"))
}

fn legacy_cache_path(cache_dir: &Path, track_id: i64, buckets: usize, mtime: u64) -> PathBuf {
    cache_dir.join(format!("{track_id}-v2-{buckets}-{mtime}.json"))
}

fn read_cache(path: &Path) -> Option<Waveform> {
    let body = std::fs::read(path).ok()?;
    if body.len() < CACHE_HEADER_LEN || &body[..8] != CACHE_MAGIC {
        return None;
    }
    let version = u16::from_le_bytes(body[8..10].try_into().ok()?);
    if version != CACHE_VERSION {
        return None;
    }
    let track_id = i64::from_le_bytes(body[10..18].try_into().ok()?);
    let duration = f64::from_le_bytes(body[18..26].try_into().ok()?);
    let count = u32::from_le_bytes(body[26..30].try_into().ok()?) as usize;
    if count == 0 || count > MAX_CACHE_COLUMNS || body.len() != CACHE_HEADER_LEN + count * 7 {
        return None;
    }
    let mut amp = Vec::with_capacity(count);
    let amp_end = CACHE_HEADER_LEN + count * 4;
    for chunk in body[CACHE_HEADER_LEN..amp_end].chunks_exact(4) {
        let value = f32::from_le_bytes(chunk.try_into().ok()?);
        if !value.is_finite() {
            return None;
        }
        amp.push(value);
    }
    if !duration.is_finite() || duration < 0.0 {
        return None;
    }
    let r_end = amp_end + count;
    let g_end = r_end + count;
    Some(Waveform {
        track_id,
        duration,
        amp,
        r: body[amp_end..r_end].to_vec(),
        g: body[r_end..g_end].to_vec(),
        b: body[g_end..].to_vec(),
    })
}

fn read_legacy_cache(path: &Path) -> Option<Waveform> {
    let text = std::fs::read_to_string(path).ok()?;
    let wave: Waveform = serde_json::from_str(&text).ok()?;
    encode_cache(&wave).ok()?;
    Some(wave)
}

/// 旧 JSON 通过结构校验后直接转成 `.kdwave`，不重新解码音频。只有新文件写完并
/// 重新读回成功才删除旧文件；转换写失败时仍返回旧波形，播放不受迁移影响。
fn read_cached(cache_dir: &Path, key: WaveKey) -> Option<(Waveform, bool)> {
    let current = cache_path(cache_dir, key.track_id, key.buckets, key.mtime);
    if let Some(wave) = read_cache(&current).filter(|wave| wave.track_id == key.track_id) {
        return Some((wave, true));
    }
    let legacy = legacy_cache_path(cache_dir, key.track_id, key.buckets, key.mtime);
    let wave = read_legacy_cache(&legacy).filter(|wave| wave.track_id == key.track_id)?;
    let canonical = write_cache(&current, &wave).is_ok()
        && read_cache(&current).is_some_and(|saved| saved.track_id == key.track_id);
    if canonical {
        let _ = std::fs::remove_file(legacy);
    }
    Some((wave, canonical))
}

/// 只读取本地曲目已经生成好的固定波形，不触发解码或重新分析。
///
/// OneLibrary 导出走这条只读路径：缓存不存在时由目标软件沿用原来的分析兜底，
/// 不能因为一次拖放在后台偷偷再解一遍整首音频。
pub(crate) fn load_cached_default(
    track_id: i64,
    path: &Path,
    cache_dir: &Path,
) -> Option<Waveform> {
    let key = WaveKey {
        track_id,
        buckets: DEFAULT_WAVEFORM_BUCKETS,
        mtime: file_mtime(path),
    };
    if let Some((waveform, _)) = read_cached(cache_dir, key) {
        return Some(waveform);
    }

    // 旧分析任务曾先生成波形、再把 BPM/Key 写入音频标签。音频内容没变，但
    // 标签写入会改变 mtime，留下一个仍然有效、文件名时间戳却落后一拍的缓存。
    // 这里仅回读已有文件，不把它冒充当前资产状态，也不会触发重新解码。
    let prefix = format!("{track_id}-v3-{}-", DEFAULT_WAVEFORM_BUCKETS);
    let mut candidates: Vec<(u64, PathBuf)> = std::fs::read_dir(cache_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let stamp = name
                .strip_prefix(&prefix)?
                .strip_suffix(".kdwave")?
                .parse::<u64>()
                .ok()?;
            Some((stamp, entry.path()))
        })
        .collect();
    candidates.sort_unstable_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    candidates.into_iter().find_map(|(_, candidate)| {
        read_cache(&candidate).filter(|waveform| waveform.track_id == track_id)
    })
}

#[cfg(test)]
pub(crate) fn write_cached_default_for_test(
    track_id: i64,
    path: &Path,
    cache_dir: &Path,
    waveform: &Waveform,
) -> Result<()> {
    let key = WaveKey {
        track_id,
        buckets: DEFAULT_WAVEFORM_BUCKETS,
        mtime: file_mtime(path),
    };
    write_cache(
        &cache_path(cache_dir, key.track_id, key.buckets, key.mtime),
        waveform,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kdj-wave-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_wav(path: &Path) {
        const RATE: u32 = 44_100;
        let data_len = RATE * 30;
        let mut data = Vec::with_capacity(44 + data_len as usize);
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + data_len).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&RATE.to_le_bytes());
        data.extend_from_slice(&RATE.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&8u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&data_len.to_le_bytes());
        data.resize(44 + data_len as usize, 128);
        std::fs::write(path, data).unwrap();
    }

    #[tokio::test]
    async fn detached_onelibrary_waveform_has_640_columns_without_library_asset_write() {
        let dir = scratch("detached");
        let audio = dir.join("track.wav");
        let cache_dir = dir.join("cache");
        write_test_wav(&audio);
        let library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let coordinator = WaveformCoordinator::new(Arc::clone(&library));
        let waveform = coordinator
            .get_or_compute_detached(9_999, audio.clone(), 640, cache_dir.clone())
            .await
            .unwrap();
        let waveform = fit_waveform_columns(waveform, 640);
        assert_eq!(waveform.track_id, 9_999);
        assert_eq!(waveform.amp.len(), 640);
        assert_eq!(waveform.r.len(), 640);
        assert_eq!(waveform.g.len(), 640);
        assert_eq!(waveform.b.len(), 640);
        let count: i64 = library
            .db()
            .conn()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM waveform_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "外置即时波形不能写 KDJ 本地曲库资产状态");

        let cache_file = cache_path(&cache_dir, 9_999, 640, file_mtime(&audio));
        let written_at = std::fs::metadata(&cache_file).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let restarted_library = Arc::new(kdj_library::LibraryService::new(
            kdj_library::Database::open_in_memory().unwrap(),
        ));
        let restarted = WaveformCoordinator::new(restarted_library);
        let reused = restarted
            .get_or_compute_detached(9_999, audio, 640, cache_dir)
            .await
            .unwrap();
        let reused = fit_waveform_columns(reused, 640);
        assert_eq!(reused.amp, waveform.amp);
        assert_eq!(
            std::fs::metadata(cache_file).unwrap().modified().unwrap(),
            written_at,
            "新 coordinator 应直接复用磁盘缓存，不能重写波形"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cache_writes_atomically_and_roundtrips() {
        let dir = scratch("roundtrip");
        let path = dir.join("1-v3-640-1.kdwave");
        let wave = Waveform {
            track_id: 1,
            duration: 3.5,
            amp: vec![0.25, 0.75],
            r: vec![255, 32],
            g: vec![64, 128],
            b: vec![32, 255],
        };
        write_cache(&path, &wave).unwrap();
        let loaded = read_cache(&path).unwrap();
        assert_eq!(loaded.track_id, 1);
        assert_eq!(loaded.amp, wave.amp);
        assert!(
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".partial")),
            "成功提交后不能留下半成品"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn export_can_reuse_a_cache_timestamped_before_analysis_tags_were_written() {
        let dir = scratch("stale-mtime-export");
        let audio = dir.join("track.mp3");
        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(&audio, b"metadata-changed-after-analysis").unwrap();
        let wave = Waveform {
            track_id: 17,
            duration: 3.5,
            amp: vec![0.25, 0.75],
            r: vec![255, 32],
            g: vec![64, 128],
            b: vec![32, 255],
        };
        write_cache(&cache_path(&cache, 17, DEFAULT_WAVEFORM_BUCKETS, 1), &wave).unwrap();

        let loaded = load_cached_default(17, &audio, &cache).expect("应复用旧 mtime 的现成缓存");
        assert_eq!(loaded.amp, wave.amp);
        assert!(
            !cache_path(&cache, 17, DEFAULT_WAVEFORM_BUCKETS, file_mtime(&audio),).is_file(),
            "只读导出不能把旧缓存伪装成当前资产"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_or_misaligned_cache_is_rejected() {
        let dir = scratch("invalid");
        let path = dir.join("bad.kdwave");
        std::fs::write(&path, CACHE_MAGIC).unwrap();
        assert!(read_cache(&path).is_none(), "只有魔数的半截文件不能通过");

        let bad = Waveform {
            track_id: 1,
            duration: 3.0,
            amp: vec![0.5],
            r: vec![],
            g: vec![1],
            b: vec![2],
        };
        assert!(encode_cache(&bad).is_err(), "通道错位不能写进缓存");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_json_is_converted_without_decoding_audio() {
        let dir = scratch("legacy");
        let key = WaveKey {
            track_id: 7,
            buckets: 640,
            mtime: 99,
        };
        let old = legacy_cache_path(&dir, key.track_id, key.buckets, key.mtime);
        let wave = Waveform {
            track_id: 7,
            duration: 8.0,
            amp: vec![0.2, 0.8],
            r: vec![1, 2],
            g: vec![3, 4],
            b: vec![5, 6],
        };
        std::fs::write(&old, serde_json::to_vec(&wave).unwrap()).unwrap();

        let (loaded, canonical) = read_cached(&dir, key).unwrap();
        assert!(canonical);
        assert_eq!(loaded.amp, wave.amp);
        let current = cache_path(&dir, key.track_id, key.buckets, key.mtime);
        assert!(current.is_file());
        assert!(read_cache(&current).is_some());
        assert!(!old.exists(), "新二进制重新校验成功后才清理旧 JSON");
        let _ = std::fs::remove_dir_all(dir);
    }
}
