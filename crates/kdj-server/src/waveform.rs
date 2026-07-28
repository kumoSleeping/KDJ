//! 交互波形：缓存读写 + 单飞计算 + 给分析让路。
//!
//! 波形是用户盯着看的交互路径；后台分析不能把它堵在 `spawn_blocking`
//! 队列里几十秒。这里：
//! - 同 `(track_id, buckets, mtime)` 只解一次，PlayerBar / 详情栏共享结果；
//! - 开算之前先占住分析闸门，逼正在跑的分析在歌与歌之间让开。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use kdj_core::models::Waveform;
use tokio::sync::broadcast;

use crate::jobs;

/// 播放条 / 详情栏默认要的列数。分析预热也写这一档。
pub const DEFAULT_WAVEFORM_BUCKETS: usize = 640;

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

/// 进程内单飞表：同一个缓存键只跑一台计算器。
#[derive(Default)]
pub struct WaveformCoordinator {
    inflight: Mutex<HashMap<WaveKey, broadcast::Sender<WaveOutcome>>>,
}

impl WaveformCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 读缓存；没有就单飞计算并落盘。
    pub async fn get_or_compute(
        self: &Arc<Self>,
        track_id: i64,
        path: PathBuf,
        buckets: usize,
        cache_dir: PathBuf,
    ) -> Result<Waveform> {
        let buckets = buckets.clamp(64, 2000);
        let mtime = file_mtime(&path);
        let cache_file = cache_path(&cache_dir, track_id, buckets, mtime);
        if let Some(cached) = read_cache(&cache_file) {
            return Ok(cached);
        }

        let key = WaveKey {
            track_id,
            buckets,
            mtime,
        };

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
            // 占满分析闸门：新歌进不来，正在解的那一两首跑完就让路。
            let _yield = jobs::yield_analysis_permits();
            // 等闸门期间别人可能已经写好缓存（分析预热 / 并发请求）
            if let Some(cached) = read_cache(&cache_file) {
                let outcome = WaveOutcome::Ok(cached);
                publish(&coord, key, outcome.clone());
                return outcome;
            }
            let computed = compute_waveform(&path, track_id, buckets);
            match &computed {
                Ok(wave) => {
                    let _ = std::fs::create_dir_all(&cache_dir);
                    if let Ok(body) = serde_json::to_string(wave) {
                        let _ = std::fs::write(&cache_file, body);
                    }
                }
                Err(err) => tracing::warn!("波形生成失败 {track_id}：{err:#}"),
            }
            let outcome = match computed {
                Ok(wave) => WaveOutcome::Ok(wave),
                Err(err) => WaveOutcome::Err(format!("{err:#}")),
            };
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
}

fn publish(coord: &WaveformCoordinator, key: WaveKey, outcome: WaveOutcome) {
    if let Some(tx) = coord.inflight.lock().expect("waveform inflight").remove(&key) {
        let _ = tx.send(outcome);
    }
}

/// 分析完一首后预热默认档位缓存。失败只打日志，不拖分析主路径的错误处理。
///
/// 全局最多 1 条预热：分析本身已经占 2 个 worker，再无脑堆解码线程
/// 会把交互波形又抢干。拿不到名额就跳过，下次点播再算。
pub fn warm_default_cache(track_id: i64, path: &Path, cache_dir: &Path) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static BUSY: AtomicBool = AtomicBool::new(false);
    struct WarmGuard;
    impl Drop for WarmGuard {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::Release);
        }
    }
    if BUSY.swap(true, Ordering::AcqRel) {
        return;
    }
    let _guard = WarmGuard;
    let mtime = file_mtime(path);
    let cache_file = cache_path(cache_dir, track_id, DEFAULT_WAVEFORM_BUCKETS, mtime);
    if cache_file.is_file() {
        return;
    }
    match compute_waveform(path, track_id, DEFAULT_WAVEFORM_BUCKETS) {
        Ok(wave) => {
            let _ = std::fs::create_dir_all(cache_dir);
            if let Ok(body) = serde_json::to_string(&wave) {
                let _ = std::fs::write(cache_file, body);
            }
        }
        Err(err) => tracing::debug!("波形预热跳过 {track_id}：{err:#}"),
    }
}

fn compute_waveform(path: &Path, track_id: i64, buckets: usize) -> Result<Waveform> {
    let decoded = kdj_analysis::decode::decode_audio(
        path,
        kdj_analysis::waveform::WAVEFORM_SR,
        None,
    )
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

pub fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

fn cache_path(cache_dir: &Path, track_id: i64, buckets: usize, mtime: u64) -> PathBuf {
    // v2 = 三条包络 → 每列一色的格式变更。不带版本号的话，旧缓存会以旧结构
    // 被原样返回，前端拿到没有 amp 的对象只会画出一片空白。
    cache_dir.join(format!("{track_id}-v2-{buckets}-{mtime}.json"))
}

fn read_cache(path: &Path) -> Option<Waveform> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}
