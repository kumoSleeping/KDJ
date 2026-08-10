//! 在线音频流的有界职责缓存。
//!
//! 首播媒体请求直接代理给播放器；后台单并发从 0 顺序拉完整资源，因此 WebView
//! 的探测 Range 或提前断开不会制造“永远完不成”的缓存。缓存不整轨解码，也不
//! 阻塞首包；临时文件核对长度后才原子 rename，`.partial` 永远不会被当成命中。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kdj_core::models::{Quality, SongSource};
use kdj_core::AppConfig;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

const CACHE_VERSION: u8 = 2;
const CHECKSUM_SEED: u64 = 0xcbf29ce484222325;
const MEDIA_SUFFIX: &str = ".media";
const MANIFEST_SUFFIX: &str = ".json";
const PARTIAL_MARKER: &str = ".partial";
/// CDN chunk 往往很小；合并后再顺序写，避免下载目录位于 U 盘时持续打小写请求。
const WRITE_BUFFER_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct StreamCacheStats {
    pub enabled: bool,
    pub path: String,
    pub files: u64,
    pub bytes: u64,
    pub partial_files: u64,
    pub partial_bytes: u64,
    pub active_writes: usize,
}

#[derive(Debug, Clone)]
pub struct CachedStream {
    pub path: PathBuf,
    pub bytes: u64,
    pub mime: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheManifest {
    version: u8,
    platform: String,
    source_key: String,
    quality: String,
    bytes: u64,
    mime: String,
    checksum: u64,
}

struct StreamCacheInner {
    /// key -> 唯一预约 id；旧预约释放时不会误删 clear/invalidate 后的新预约。
    inflight: Mutex<HashMap<String, u64>>,
    /// 本进程已经按 manifest 校验过的文件；重启后会重新逐字节校验一次。
    verified: Mutex<HashSet<String>>,
    verifying: Mutex<HashSet<String>>,
    /// Android bounded Range 无法直接提交完整 writer 时，只保留一份“播放空闲后再
    /// 补整轨”的计划；它不算 active write，也不持有网络/磁盘槽位。
    deferred: Mutex<HashSet<String>>,
    enabled: AtomicBool,
    /// 清理或关闭缓存时递增；旧 writer 下一块数据到达便主动放弃。
    generation: AtomicU64,
    next_reservation: AtomicU64,
    /// 后台整轨缓存最多一首，避免快速切歌与当前播放争抢网络。
    background_slots: Arc<tokio::sync::Semaphore>,
}

impl Default for StreamCacheInner {
    fn default() -> Self {
        Self {
            inflight: Mutex::new(HashMap::new()),
            verified: Mutex::new(HashSet::new()),
            verifying: Mutex::new(HashSet::new()),
            deferred: Mutex::new(HashSet::new()),
            enabled: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            next_reservation: AtomicU64::new(0),
            background_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}

#[derive(Clone, Default)]
pub struct StreamCache {
    inner: Arc<StreamCacheInner>,
}

impl StreamCache {
    pub fn cache_dir(config: &AppConfig) -> PathBuf {
        config.download_dir().join(".kdj").join("stream-cache")
    }

    /// 已提交媒体的确定性路径。只供同进程的渐进波形在 `finish` 后打开；外部
    /// HTTP 一律通过 preview token，不能把这个磁盘路径暴露给前端。
    pub fn media_path(root: &Path, key: &str) -> PathBuf {
        CachePaths::new(root, key).media
    }

    pub fn key(source: &SongSource, quality: Quality) -> String {
        // FNV-1a 足够做本机文件名；manifest 还会核对平台/来源/音质，极端碰撞只会
        // 被判为 miss，不会把另一首歌当成当前歌曲播放。
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in source
            .platform
            .as_str()
            .bytes()
            .chain([0])
            .chain(source.key.bytes())
            .chain([0])
            .chain(quality.as_str().bytes())
        {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!(
            "{}-{}-{hash:016x}",
            source.platform.as_str(),
            quality.as_str()
        )
    }

    pub fn cancel_writes(&self) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        self.inner.inflight.lock().unwrap().clear();
        self.inner.verified.lock().unwrap().clear();
        self.inner.verifying.lock().unwrap().clear();
        self.inner.deferred.lock().unwrap().clear();
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::Release);
        if !enabled {
            self.cancel_writes();
        }
    }

    pub fn is_writing(&self, key: &str) -> bool {
        self.inner.inflight.lock().unwrap().contains_key(key)
    }

    /// 预约一份“不与播放争抢”的延迟缓存任务。同 key 已有计划时立即返回 None。
    pub fn defer_until_idle(&self, key: String) -> Option<DeferredStreamCache> {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return None;
        }
        let generation = self.inner.generation.load(Ordering::Acquire);
        if !self.inner.deferred.lock().unwrap().insert(key.clone()) {
            return None;
        }
        Some(DeferredStreamCache {
            inner: Arc::clone(&self.inner),
            key,
            generation,
        })
    }

    /// 在任何 sleep/网络请求前原子预约 key。clear/关闭会使预约 generation 失效，
    /// 因而清理返回后，旧后台任务即使才被调度也不能重新开始写盘。
    pub fn reserve(&self, key: String) -> Option<StreamCacheReservation> {
        if !self.inner.enabled.load(Ordering::Acquire) {
            return None;
        }
        let generation = self.inner.generation.load(Ordering::Acquire);
        let reservation_id = self
            .inner
            .next_reservation
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let mut inflight = self.inner.inflight.lock().unwrap();
        if inflight.contains_key(&key) {
            return None;
        }
        inflight.insert(key.clone(), reservation_id);
        Some(StreamCacheReservation {
            inner: self.inner.clone(),
            key,
            generation,
            reservation_id,
            slot: None,
            transferred: false,
        })
    }

    pub async fn lookup(
        &self,
        root: &Path,
        key: &str,
        source: &SongSource,
        quality: Quality,
    ) -> Option<CachedStream> {
        let paths = CachePaths::new(root, key);
        let body = match tokio::fs::read(&paths.manifest).await {
            Ok(body) => body,
            Err(_) => {
                // 只有媒体没有 manifest = 上次在两个原子 rename 之间退出；不可命中。
                // 正在提交时也会短暂处于这个状态，此时绝不能把 writer 刚 rename 的
                // media 删掉；等 manifest 最后落下即可。
                if !self.is_writing(key) && tokio::fs::metadata(&paths.media).await.is_ok() {
                    let _ = tokio::fs::remove_file(&paths.media).await;
                }
                return None;
            }
        };
        let manifest: CacheManifest = match serde_json::from_slice(&body) {
            Ok(manifest) => manifest,
            Err(_) => {
                invalidate(&paths).await;
                return None;
            }
        };
        let expected = manifest.version == CACHE_VERSION
            && manifest.platform == source.platform.as_str()
            && manifest.source_key == source.key
            && manifest.quality == quality.as_str()
            && manifest.bytes > 0
            && manifest.mime.starts_with("audio/");
        let actual = tokio::fs::metadata(&paths.media).await.ok();
        if !expected || actual.as_ref().map(|meta| meta.len()) != Some(manifest.bytes) {
            self.inner
                .verified
                .lock()
                .unwrap()
                .remove(&verification_key(root, key));
            invalidate(&paths).await;
            return None;
        }
        Some(CachedStream {
            path: paths.media,
            bytes: manifest.bytes,
            mime: manifest.mime,
        })
    }

    pub async fn invalidate(&self, root: &Path, key: &str) {
        self.inner.inflight.lock().unwrap().remove(key);
        let verification_key = verification_key(root, key);
        self.inner
            .verified
            .lock()
            .unwrap()
            .remove(&verification_key);
        self.inner
            .verifying
            .lock()
            .unwrap()
            .remove(&verification_key);
        invalidate(&CachePaths::new(root, key)).await;
    }

    /// 不挡首包的完整校验。manifest/长度已由 lookup 同步核对；这里逐字节检查
    /// checksum，失败便移除缓存，播放器的后续 Range 会自然回源。
    pub async fn verify(&self, root: &Path, key: &str) -> bool {
        let verification_key = verification_key(root, key);
        if self
            .inner
            .verified
            .lock()
            .unwrap()
            .contains(&verification_key)
        {
            return true;
        }
        {
            let mut verifying = self.inner.verifying.lock().unwrap();
            if !verifying.insert(verification_key.clone()) {
                return true;
            }
        }
        let generation = self.inner.generation.load(Ordering::Acquire);
        let paths = CachePaths::new(root, key);
        let manifest_body = tokio::fs::read(&paths.manifest).await.ok();
        let valid = match manifest_body.as_deref() {
            Some(body) => match serde_json::from_slice::<CacheManifest>(body) {
                Ok(manifest) => file_checksum(&paths.media)
                    .await
                    .is_ok_and(|checksum| checksum == manifest.checksum),
                Err(_) => false,
            },
            None => false,
        };
        self.inner
            .verifying
            .lock()
            .unwrap()
            .remove(&verification_key);
        if self.inner.generation.load(Ordering::Acquire) != generation {
            return false;
        }
        // invalidate/bypass 后可能已有同 key 的新 writer；只处理仍是起始 manifest
        // 的那一版文件，绝不让迟到校验删掉新提交。
        if tokio::fs::read(&paths.manifest).await.ok() != manifest_body {
            return false;
        }
        if valid {
            self.inner.verified.lock().unwrap().insert(verification_key);
        } else {
            invalidate(&paths).await;
        }
        valid
    }

    pub async fn begin_write(
        &self,
        root: &Path,
        key: String,
        source: &SongSource,
        quality: Quality,
        mime: String,
        expected_bytes: Option<u64>,
    ) -> std::io::Result<Option<StreamCacheWriter>> {
        let Some(mut reservation) = self.reserve(key) else {
            return Ok(None);
        };
        if !reservation.acquire_slot().await {
            return Ok(None);
        }
        reservation
            .begin_write(root, source, quality, mime, expected_bytes)
            .await
    }

    pub async fn stats(&self, config: &AppConfig) -> StreamCacheStats {
        let root = Self::cache_dir(config);
        let mut stats = StreamCacheStats {
            enabled: config.to_settings().stream_cache_enabled,
            path: root.to_string_lossy().into_owned(),
            files: 0,
            bytes: 0,
            partial_files: 0,
            partial_bytes: 0,
            active_writes: self.inner.inflight.lock().unwrap().len(),
        };
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            return stats;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let bytes = entry.metadata().await.map(|meta| meta.len()).unwrap_or(0);
            if name.ends_with(MEDIA_SUFFIX) {
                let key = name.trim_end_matches(MEDIA_SUFFIX);
                let manifest = root.join(format!("{key}{MANIFEST_SUFFIX}"));
                let valid = tokio::fs::read(manifest)
                    .await
                    .ok()
                    .and_then(|body| serde_json::from_slice::<CacheManifest>(&body).ok())
                    .is_some_and(|manifest| {
                        manifest.version == CACHE_VERSION && manifest.bytes == bytes
                    });
                if valid {
                    stats.files += 1;
                    stats.bytes = stats.bytes.saturating_add(bytes);
                }
            } else if name.ends_with(PARTIAL_MARKER) {
                stats.partial_files += 1;
                stats.partial_bytes = stats.partial_bytes.saturating_add(bytes);
            }
        }
        stats
    }

    pub async fn clear(&self, config: &AppConfig) -> StreamCacheStats {
        self.cancel_writes();
        self.inner.verified.lock().unwrap().clear();
        self.inner.verifying.lock().unwrap().clear();
        let root = Self::cache_dir(config);
        if let Ok(mut entries) = tokio::fs::read_dir(&root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(MEDIA_SUFFIX)
                    || name.ends_with(MANIFEST_SUFFIX)
                    || name.ends_with(PARTIAL_MARKER)
                    || name.contains(".tmp-")
                {
                    // Windows 不能删除仍打开的 partial；writer 下一块数据会看见
                    // generation 已变化，关闭句柄后自行清理。
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        self.stats(config).await
    }
}

pub struct DeferredStreamCache {
    inner: Arc<StreamCacheInner>,
    key: String,
    generation: u64,
}

impl DeferredStreamCache {
    pub fn is_valid(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
            && self.inner.generation.load(Ordering::Acquire) == self.generation
            && self.inner.deferred.lock().unwrap().contains(&self.key)
    }
}

impl Drop for DeferredStreamCache {
    fn drop(&mut self) {
        self.inner.deferred.lock().unwrap().remove(&self.key);
    }
}

pub struct StreamCacheReservation {
    inner: Arc<StreamCacheInner>,
    key: String,
    generation: u64,
    reservation_id: u64,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    transferred: bool,
}

impl StreamCacheReservation {
    pub fn is_valid(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
            && self.inner.generation.load(Ordering::Acquire) == self.generation
            && self
                .inner
                .inflight
                .lock()
                .unwrap()
                .get(&self.key)
                .is_some_and(|reservation_id| *reservation_id == self.reservation_id)
    }

    pub async fn acquire_slot(&mut self) -> bool {
        if !self.is_valid() {
            return false;
        }
        let Ok(slot) = self.inner.background_slots.clone().acquire_owned().await else {
            return false;
        };
        if !self.is_valid() {
            return false;
        }
        self.slot = Some(slot);
        true
    }

    /// 媒体代理的 inline tee 绝不能等后台缓存槽位：等待会延迟首包，等价于让
    /// 可选缓存反向阻塞声音。拿不到就立即放弃本次持久写入，媒体仍照常播放。
    pub fn try_acquire_slot(&mut self) -> bool {
        if !self.is_valid() {
            return false;
        }
        let Ok(slot) = self.inner.background_slots.clone().try_acquire_owned() else {
            return false;
        };
        if !self.is_valid() {
            return false;
        }
        self.slot = Some(slot);
        true
    }

    pub async fn begin_write(
        mut self,
        root: &Path,
        source: &SongSource,
        quality: Quality,
        mime: String,
        expected_bytes: Option<u64>,
    ) -> std::io::Result<Option<StreamCacheWriter>> {
        if !self.is_valid() || self.slot.is_none() || !mime.starts_with("audio/") {
            return Ok(None);
        }
        let verification_key = verification_key(root, &self.key);
        self.inner
            .verified
            .lock()
            .unwrap()
            .remove(&verification_key);
        tokio::fs::create_dir_all(root).await?;
        let paths = CachePaths::new(root, &self.key);
        let partial = root.join(format!(
            "{}-{:016x}{PARTIAL_MARKER}",
            self.key,
            rand::random::<u64>()
        ));
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .await?;
        if !self.is_valid() {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            return Ok(None);
        }

        let writer = StreamCacheWriter {
            file: Some(tokio::io::BufWriter::with_capacity(
                WRITE_BUFFER_BYTES,
                file,
            )),
            key: self.key.clone(),
            partial,
            paths,
            manifest: CacheManifest {
                version: CACHE_VERSION,
                platform: source.platform.as_str().to_string(),
                source_key: source.key.clone(),
                quality: quality.as_str().to_string(),
                bytes: 0,
                mime,
                checksum: CHECKSUM_SEED,
            },
            expected_bytes,
            written: 0,
            generation: self.generation,
            reservation_id: self.reservation_id,
            inner: self.inner.clone(),
            committed: false,
            _slot: self.slot.take(),
            verification_key,
        };
        self.transferred = true;
        Ok(Some(writer))
    }
}

impl Drop for StreamCacheReservation {
    fn drop(&mut self) {
        if !self.transferred {
            release_inflight(&self.inner, &self.key, self.reservation_id);
        }
    }
}

pub struct StreamCacheWriter {
    file: Option<tokio::io::BufWriter<tokio::fs::File>>,
    key: String,
    partial: PathBuf,
    paths: CachePaths,
    manifest: CacheManifest,
    expected_bytes: Option<u64>,
    written: u64,
    generation: u64,
    reservation_id: u64,
    inner: Arc<StreamCacheInner>,
    committed: bool,
    /// 整轨下载期间持有全局 permit；Drop 自动放行下一首。
    _slot: Option<tokio::sync::OwnedSemaphorePermit>,
    verification_key: String,
}

impl StreamCacheWriter {
    pub(crate) fn is_valid(&self) -> bool {
        self.inner.enabled.load(Ordering::Acquire)
            && self.inner.generation.load(Ordering::Acquire) == self.generation
            && self
                .inner
                .inflight
                .lock()
                .unwrap()
                .get(&self.key)
                .is_some_and(|reservation_id| *reservation_id == self.reservation_id)
    }

    /// 当前临时文件的路径。调用方只能另开只读句柄做可选分析，不能移动、删除或
    /// 复用 writer 持有的文件句柄；写入和提交的所有权仍完全留在这里。
    pub(crate) fn partial_path(&self) -> &Path {
        &self.partial
    }

    pub(crate) fn written_bytes(&self) -> u64 {
        self.written
    }

    /// 把 Tokio 的用户态写缓冲交给内核，供只读分析句柄看见稳定前缀。不是 fsync：
    /// 渐进波形随时可重算，不能为了展示把每个网络 chunk 都变成落盘同步。
    pub(crate) async fn flush_for_observer(&mut self) -> std::io::Result<bool> {
        if !self.is_valid() {
            return Ok(false);
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(false);
        };
        file.flush().await?;
        Ok(self.is_valid())
    }

    pub async fn write_chunk(&mut self, bytes: &[u8]) -> std::io::Result<bool> {
        if !self.is_valid() {
            self.cancel();
            return Ok(false);
        }
        let Some(file) = self.file.as_mut() else {
            return Ok(false);
        };
        file.write_all(bytes).await?;
        for byte in bytes {
            self.manifest.checksum ^= u64::from(*byte);
            self.manifest.checksum = self.manifest.checksum.wrapping_mul(0x100000001b3);
        }
        self.written = self.written.saturating_add(bytes.len() as u64);
        Ok(true)
    }

    pub async fn finish(&mut self) -> std::io::Result<bool> {
        if !self.is_valid()
            || self.written == 0
            || self
                .expected_bytes
                .is_some_and(|expected| expected != self.written)
        {
            self.cancel();
            return Ok(false);
        }
        let Some(mut file) = self.file.take() else {
            return Ok(false);
        };
        file.flush().await?;
        // 这是可校验、可重建的播放缓存，不是用户文档。强制 sync_data 会让每首歌
        // 都立即刷整轨到闪存；异常退出后下次 checksum 会淘汰坏缓存，无需为缓存 fsync。
        drop(file);
        if !self.is_valid() {
            self.cancel();
            return Ok(false);
        }

        // 旧 manifest 先撤下、media 再就位、manifest 最后提交。lookup 在 key
        // inflight 时看见无 manifest 只会 miss，不会删掉提交窗口里的 media。
        let _ = tokio::fs::remove_file(&self.paths.manifest).await;
        if tokio::fs::rename(&self.partial, &self.paths.media)
            .await
            .is_err()
        {
            let _ = tokio::fs::remove_file(&self.paths.media).await;
            tokio::fs::rename(&self.partial, &self.paths.media).await?;
        }
        if !self.is_valid() {
            let _ = tokio::fs::remove_file(&self.paths.media).await;
            return Ok(false);
        }
        self.manifest.bytes = self.written;
        let manifest = serde_json::to_vec(&self.manifest)
            .map_err(|error| std::io::Error::other(error.to_string()));
        let manifest = match manifest {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = tokio::fs::remove_file(&self.paths.media).await;
                return Err(error);
            }
        };
        let manifest_tmp =
            self.paths
                .root
                .join(format!("{}.tmp-{:016x}", self.key, rand::random::<u64>()));
        if let Err(error) = tokio::fs::write(&manifest_tmp, manifest).await {
            let _ = tokio::fs::remove_file(&self.paths.media).await;
            return Err(error);
        }
        if tokio::fs::rename(&manifest_tmp, &self.paths.manifest)
            .await
            .is_err()
        {
            // Windows 的 rename 不会覆盖目标；先删旧 manifest 再提交新版本。
            let _ = tokio::fs::remove_file(&self.paths.manifest).await;
            if let Err(error) = tokio::fs::rename(&manifest_tmp, &self.paths.manifest).await {
                let _ = tokio::fs::remove_file(&manifest_tmp).await;
                let _ = tokio::fs::remove_file(&self.paths.media).await;
                return Err(error);
            }
        }
        if !self.is_valid() {
            let _ = tokio::fs::remove_file(&self.paths.media).await;
            let _ = tokio::fs::remove_file(&self.paths.manifest).await;
            return Ok(false);
        }
        self.committed = true;
        self.inner
            .verified
            .lock()
            .unwrap()
            .insert(self.verification_key.clone());
        Ok(true)
    }

    pub fn cancel(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.partial);
    }
}

impl Drop for StreamCacheWriter {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = std::fs::remove_file(&self.partial);
        }
        release_inflight(&self.inner, &self.key, self.reservation_id);
    }
}

fn release_inflight(inner: &StreamCacheInner, key: &str, reservation_id: u64) {
    let mut inflight = inner.inflight.lock().unwrap();
    if inflight
        .get(key)
        .is_some_and(|current| *current == reservation_id)
    {
        inflight.remove(key);
    }
}

fn verification_key(root: &Path, key: &str) -> String {
    format!("{}\0{key}", root.to_string_lossy())
}

#[derive(Debug)]
struct CachePaths {
    root: PathBuf,
    media: PathBuf,
    manifest: PathBuf,
}

impl CachePaths {
    fn new(root: &Path, key: &str) -> Self {
        Self {
            root: root.to_path_buf(),
            media: root.join(format!("{key}{MEDIA_SUFFIX}")),
            manifest: root.join(format!("{key}{MANIFEST_SUFFIX}")),
        }
    }
}

async fn invalidate(paths: &CachePaths) {
    let _ = tokio::fs::remove_file(&paths.media).await;
    let _ = tokio::fs::remove_file(&paths.manifest).await;
}

async fn file_checksum(path: &Path) -> std::io::Result<u64> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0_u8; STREAM_CHECKSUM_CHUNK];
    let mut checksum = CHECKSUM_SEED;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok(checksum);
        }
        for byte in &buffer[..read] {
            checksum ^= u64::from(*byte);
            checksum = checksum.wrapping_mul(0x100000001b3);
        }
    }
}

const STREAM_CHECKSUM_CHUNK: usize = 256 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use kdj_core::models::Platform;

    fn source(key: &str) -> SongSource {
        SongSource {
            platform: Platform::Wyy,
            key: key.into(),
            title: key.into(),
            artists: vec![],
            album: String::new(),
            duration: Some(1.0),
            cover: String::new(),
            max_quality: Some(Quality::Q128),
            vip: false,
            payload: Default::default(),
        }
    }

    #[test]
    fn cache_keys_include_source_and_quality() {
        let a128 = StreamCache::key(&source("a"), Quality::Q128);
        let a320 = StreamCache::key(&source("a"), Quality::Q320);
        let b128 = StreamCache::key(&source("b"), Quality::Q128);
        assert_ne!(a128, a320);
        assert_ne!(a128, b128);
        assert_eq!(a128, StreamCache::key(&source("a"), Quality::Q128));
    }

    #[test]
    fn reservation_is_singleflight_and_clear_cannot_release_a_new_generation() {
        let cache = StreamCache::default();
        cache.set_enabled(true);
        let first = cache.reserve("same".into()).expect("first reservation");
        assert!(cache.reserve("same".into()).is_none());

        cache.cancel_writes();
        assert!(!first.is_valid());
        let second = cache
            .reserve("same".into())
            .expect("new reservation after clear");
        drop(first);
        assert!(
            cache.is_writing("same"),
            "old RAII drop must not erase the new id"
        );
        drop(second);
        assert!(!cache.is_writing("same"));
    }

    #[test]
    fn deferred_cache_is_singleflight_but_never_looks_like_an_active_write() {
        let cache = StreamCache::default();
        cache.set_enabled(true);
        let deferred = cache
            .defer_until_idle("bounded-range".into())
            .expect("first idle fallback");
        assert!(deferred.is_valid());
        assert!(cache.defer_until_idle("bounded-range".into()).is_none());
        assert!(
            !cache.is_writing("bounded-range"),
            "waiting for playback to become idle must not keep waveform polling active"
        );
        drop(deferred);
        assert!(cache.defer_until_idle("bounded-range".into()).is_some());
    }

    #[tokio::test]
    async fn completed_stream_is_committed_and_validated() {
        let root = std::env::temp_dir().join(format!(
            "kdj-stream-cache-test-{:016x}",
            rand::random::<u64>()
        ));
        let cache = StreamCache::default();
        cache.set_enabled(true);
        let source = source("full-song");
        let key = StreamCache::key(&source, Quality::Q320);
        let mut writer = cache
            .begin_write(
                &root,
                key.clone(),
                &source,
                Quality::Q320,
                "audio/mpeg".into(),
                Some(6),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(writer.write_chunk(b"abc").await.unwrap());
        assert!(writer.write_chunk(b"def").await.unwrap());
        assert!(writer.finish().await.unwrap());
        drop(writer);

        let hit = cache
            .lookup(&root, &key, &source, Quality::Q320)
            .await
            .expect("completed stream should be reusable");
        assert_eq!(hit.bytes, 6);
        assert_eq!(tokio::fs::read(hit.path).await.unwrap(), b"abcdef");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn truncated_stream_never_becomes_a_cache_hit() {
        let root = std::env::temp_dir().join(format!(
            "kdj-stream-cache-test-{:016x}",
            rand::random::<u64>()
        ));
        let cache = StreamCache::default();
        cache.set_enabled(true);
        let source = source("short-song");
        let key = StreamCache::key(&source, Quality::Q128);
        let mut writer = cache
            .begin_write(
                &root,
                key.clone(),
                &source,
                Quality::Q128,
                "audio/mpeg".into(),
                Some(6),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(writer.write_chunk(b"abc").await.unwrap());
        assert!(!writer.finish().await.unwrap());
        drop(writer);

        assert!(cache
            .lookup(&root, &key, &source, Quality::Q128)
            .await
            .is_none());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn background_verification_evicts_same_length_corruption() {
        let root = std::env::temp_dir().join(format!(
            "kdj-stream-cache-test-{:016x}",
            rand::random::<u64>()
        ));
        let source = source("corrupt-song");
        let key = StreamCache::key(&source, Quality::Q128);
        let writer_cache = StreamCache::default();
        writer_cache.set_enabled(true);
        let mut writer = writer_cache
            .begin_write(
                &root,
                key.clone(),
                &source,
                Quality::Q128,
                "audio/mpeg".into(),
                Some(6),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(writer.write_chunk(b"abcdef").await.unwrap());
        assert!(writer.finish().await.unwrap());
        drop(writer);

        let restarted_cache = StreamCache::default();
        restarted_cache.set_enabled(true);
        let hit = restarted_cache
            .lookup(&root, &key, &source, Quality::Q128)
            .await
            .expect("length-only lookup should stay off the playback critical path");
        tokio::fs::write(&hit.path, b"abcdeg").await.unwrap();
        assert!(!restarted_cache.verify(&root, &key).await);
        assert!(restarted_cache
            .lookup(&root, &key, &source, Quality::Q128)
            .await
            .is_none());
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
