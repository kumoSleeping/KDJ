//! 设置页的全局缓存统计与按类别清理。
//!
//! 这里只把“删掉后可以重建”的内容放进可清理类别。账号会话、设置、曲库索引、
//! 播放列表和目录清单统一归到只读的“其他”，避免一个泛化清理按钮误伤用户数据。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::state::AppState;
use crate::stream_cache::StreamCache;

const METADATA_DIR_NAME: &str = ".kdj";
const LYRICS_DIR_NAME: &str = "lyrics";
/// 只会由本地实验工具生成，不属于正式产品缓存；开发者可以自行保留做比对。
const DEVELOPMENT_ONLY_DIR_NAMES: &[&str] = &["stem-lab", "stem-debug"];
/// 当前正式运行时已经不再读取的可重建数据。启动时只清这些明确命名的目录，
/// 不碰数据库、设置、账号会话或迁移备份。
const RETIRED_CACHE_DIR_NAMES: &[&str] = &["stems", "waveform-onelibrary"];
/// 旧版在线试听留下的目录；现役媒体缓存统一由 stream-cache 管理。
const RETIRED_METADATA_DIR_NAMES: &[&str] = &["hls-preview"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CacheCategoryStats {
    pub files: u64,
    pub bytes: u64,
    pub items: u64,
    pub active: u64,
    pub deletable: bool,
    /// 基础信息按字段逻辑负载估算，不冒充 SQLite 文件的物理占用。
    pub estimated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CacheOverview {
    pub media: CacheCategoryStats,
    pub waveform: CacheCategoryStats,
    pub lyrics: CacheCategoryStats,
    pub basic: CacheCategoryStats,
    pub logs: CacheCategoryStats,
    pub other: CacheCategoryStats,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DiskUsage {
    files: u64,
    bytes: u64,
}

impl DiskUsage {
    fn add(&mut self, other: Self) {
        self.files = self.files.saturating_add(other.files);
        self.bytes = self.bytes.saturating_add(other.bytes);
    }
}

fn metadata_dirs(track_paths: &[String], download_dir: &Path) -> BTreeSet<PathBuf> {
    let mut dirs = BTreeSet::new();
    dirs.insert(download_dir.join(METADATA_DIR_NAME));
    for track in track_paths {
        if let Some(parent) = Path::new(track).parent() {
            dirs.insert(parent.join(METADATA_DIR_NAME));
        }
    }
    dirs
}

fn scan_tree(root: &Path, excluded: &BTreeSet<PathBuf>) -> DiskUsage {
    let mut usage = DiskUsage::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        if path != root && excluded.contains(&path) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            usage.files = usage.files.saturating_add(1);
            usage.bytes = usage.bytes.saturating_add(metadata.len());
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            stack.push(entry.path());
        }
    }
    usage
}

fn scan_roots(roots: impl IntoIterator<Item = PathBuf>) -> DiskUsage {
    let mut usage = DiskUsage::default();
    let excluded = BTreeSet::new();
    for root in roots {
        usage.add(scan_tree(&root, &excluded));
    }
    usage
}

fn lyric_usage(metadata: &BTreeSet<PathBuf>) -> DiskUsage {
    scan_roots(metadata.iter().map(|dir| dir.join(LYRICS_DIR_NAME)))
}

fn other_usage(
    data_dir: &Path,
    metadata: &BTreeSet<PathBuf>,
    media_roots: &[PathBuf],
    waveform_roots: &[PathBuf],
) -> DiskUsage {
    let mut excluded = BTreeSet::new();
    excluded.extend(media_roots.iter().cloned());
    excluded.extend(waveform_roots.iter().cloned());
    excluded.extend([
        data_dir.join("activity-logs"),
        data_dir.join("kdj.log"),
        data_dir.join("kdj.log.1"),
    ]);
    excluded.extend(
        DEVELOPMENT_ONLY_DIR_NAMES
            .iter()
            .chain(RETIRED_CACHE_DIR_NAMES)
            .map(|name| data_dir.join(name)),
    );
    let mut usage = scan_tree(data_dir, &excluded);

    for dir in metadata {
        let mut metadata_excluded = BTreeSet::new();
        metadata_excluded.insert(dir.join(LYRICS_DIR_NAME));
        metadata_excluded.insert(dir.join("stream-cache"));
        metadata_excluded.extend(RETIRED_METADATA_DIR_NAMES.iter().map(|name| dir.join(name)));
        usage.add(scan_tree(dir, &metadata_excluded));
    }
    usage
}

fn remove_owned_path(path: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(path)
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        Ok(())
    }
}

/// 清理已经退出正式架构的可重建目录。目标全部是 data_dir 下的固定子目录，
/// 不接受外部路径，也不跟随符号链接。
pub(crate) fn cleanup_retired_data(data_dir: &Path) {
    for name in RETIRED_CACHE_DIR_NAMES {
        let path = data_dir.join(name);
        if let Err(error) = remove_owned_path(&path) {
            eprintln!("KDJ: 清理退役缓存 {} 失败：{error}", path.display());
        }
    }
}

/// 曲目旁的旧版试听目录不再被任何现役路径读取；与根目录退役缓存使用相同边界，
/// 只删固定名称，不扫描或猜测用户自己的文件。
pub(crate) fn cleanup_retired_metadata(track_paths: &[String], download_dir: &Path) {
    for metadata in metadata_dirs(track_paths, download_dir) {
        for name in RETIRED_METADATA_DIR_NAMES {
            let path = metadata.join(name);
            if let Err(error) = remove_owned_path(&path) {
                eprintln!("KDJ: 清理退役缓存 {} 失败：{error}", path.display());
            }
        }
    }
}

fn media_roots(state: &AppState) -> Vec<PathBuf> {
    vec![
        StreamCache::cache_dir(&state.config),
        state.config.data_dir.join("audio-cache"),
        state.config.data_dir.join("video-cache"),
    ]
}

fn waveform_roots(state: &AppState) -> Vec<PathBuf> {
    vec![
        state.config.data_dir.join("waveform"),
        state.config.data_dir.join("stream-waveform-session"),
    ]
}

pub async fn stats(state: &AppState) -> Result<CacheOverview> {
    let track_paths = state.library.all_paths()?;
    let metadata = metadata_dirs(&track_paths, &state.config.download_dir());
    let media_roots = media_roots(state);
    let waveform_roots = waveform_roots(state);
    let active_writes = state.stream_cache.stats(&state.config).await.active_writes as u64;
    let basic = state.library.basic_analysis_cache_usage()?;
    let waveform_records = state.library.waveform_cache_record_count()?;
    let log_stats = state.activity_log.disk_stats();

    let data_dir = state.config.data_dir.clone();
    let metadata_for_scan = metadata.clone();
    let media_for_scan = media_roots.clone();
    let waveform_for_scan = waveform_roots.clone();
    let (media, waveform, lyrics, other) = tokio::task::spawn_blocking(move || {
        (
            scan_roots(media_for_scan.clone()),
            scan_roots(waveform_for_scan.clone()),
            lyric_usage(&metadata_for_scan),
            other_usage(
                &data_dir,
                &metadata_for_scan,
                &media_for_scan,
                &waveform_for_scan,
            ),
        )
    })
    .await?;

    Ok(CacheOverview {
        media: CacheCategoryStats {
            files: media.files,
            bytes: media.bytes,
            items: media.files,
            active: active_writes,
            deletable: true,
            estimated: false,
        },
        waveform: CacheCategoryStats {
            files: waveform.files,
            bytes: waveform.bytes,
            items: waveform_records.max(waveform.files),
            active: 0,
            deletable: true,
            estimated: false,
        },
        lyrics: CacheCategoryStats {
            files: lyrics.files,
            bytes: lyrics.bytes,
            items: lyrics.files,
            active: 0,
            deletable: true,
            estimated: false,
        },
        basic: CacheCategoryStats {
            files: 0,
            bytes: basic.bytes,
            items: basic.tracks,
            active: state.analysis.running() as u64,
            deletable: true,
            estimated: true,
        },
        logs: CacheCategoryStats {
            files: log_stats.files,
            bytes: log_stats.bytes,
            // 内存窗口只保留最近 2,000 条；不冒充磁盘中的完整行数。
            items: log_stats.recent_entries,
            active: 0,
            deletable: true,
            estimated: false,
        },
        other: CacheCategoryStats {
            files: other.files,
            bytes: other.bytes,
            items: other.files,
            active: 0,
            deletable: false,
            estimated: false,
        },
    })
}

async fn remove_owned_directory(path: PathBuf) {
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            let _ = tokio::fs::remove_file(path).await;
        }
        Ok(_) => {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
        Err(_) => {}
    }
}

pub async fn clear_media(state: &AppState) -> Result<()> {
    state.stream_waveforms.clear();
    state.stream_cache.clear(&state.config).await;
    for path in [
        state.config.data_dir.join("audio-cache"),
        state.config.data_dir.join("video-cache"),
    ] {
        remove_owned_directory(path).await;
    }
    Ok(())
}

pub async fn clear_waveform(state: &AppState) -> Result<()> {
    state.stream_waveforms.clear();
    for path in waveform_roots(state) {
        remove_owned_directory(path).await;
    }
    state.library.clear_waveform_cache_records()?;
    Ok(())
}

fn remove_lyrics(metadata: &BTreeSet<PathBuf>) {
    for dir in metadata.iter().map(|dir| dir.join(LYRICS_DIR_NAME)) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let is_lrc = path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("lrc"));
            let is_metadata = name.ends_with(".meta.json");
            let is_partial = name.ends_with(".lrc.partial");
            let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
            if (is_lrc || is_metadata || is_partial) && is_file {
                let _ = std::fs::remove_file(path);
            }
        }
        let _ = std::fs::remove_dir(&dir);
    }
}

pub async fn clear_lyrics(state: &AppState) -> Result<()> {
    let paths = state.library.all_paths()?;
    let metadata = metadata_dirs(&paths, &state.config.download_dir());
    tokio::task::spawn_blocking(move || remove_lyrics(&metadata)).await?;
    Ok(())
}

pub fn clear_basic(state: &AppState) -> Result<()> {
    state.analysis.cancel("");
    state.library.clear_basic_analysis_cache()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kdj-cache-overview-{name}-{:016x}",
            rand::random::<u64>()
        ))
    }

    #[test]
    fn scan_tree_counts_bytes_without_following_symlinks() {
        let root = scratch("scan");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("one.bin"), b"123").unwrap();
        std::fs::write(root.join("nested/two.bin"), b"12345").unwrap();
        let usage = scan_tree(&root, &BTreeSet::new());
        assert_eq!(usage, DiskUsage { files: 2, bytes: 8 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn other_usage_excludes_development_and_retired_data() {
        let root = scratch("other-exclusions");
        for name in DEVELOPMENT_ONLY_DIR_NAMES
            .iter()
            .chain(RETIRED_CACHE_DIR_NAMES)
        {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("ignored.bin"), b"ignored").unwrap();
        }
        std::fs::write(root.join("kept.bin"), b"keep").unwrap();

        let usage = other_usage(&root, &BTreeSet::new(), &[], &[]);
        assert_eq!(usage, DiskUsage { files: 1, bytes: 4 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn retired_cleanup_preserves_development_and_core_data() {
        let root = scratch("retired-cleanup");
        for name in RETIRED_CACHE_DIR_NAMES {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("old.bin"), b"old").unwrap();
        }
        std::fs::create_dir_all(root.join("stem-lab")).unwrap();
        std::fs::write(root.join("stem-lab/experiment.wav"), b"experiment").unwrap();
        std::fs::write(root.join("kumodeck.db"), b"database").unwrap();

        cleanup_retired_data(&root);

        for name in RETIRED_CACHE_DIR_NAMES {
            assert!(!root.join(name).exists());
        }
        assert!(root.join("stem-lab/experiment.wav").is_file());
        assert!(root.join("kumodeck.db").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lyric_clear_preserves_unknown_files() {
        let root = scratch("lyrics");
        let metadata = root.join(METADATA_DIR_NAME);
        let lyrics = metadata.join(LYRICS_DIR_NAME);
        std::fs::create_dir_all(&lyrics).unwrap();
        std::fs::write(lyrics.join("wyy-1.lrc"), b"lyrics").unwrap();
        std::fs::write(lyrics.join("wyy-1.meta.json"), b"{}").unwrap();
        std::fs::write(lyrics.join("keep.txt"), b"keep").unwrap();
        let dirs = BTreeSet::from([metadata]);
        remove_lyrics(&dirs);
        assert!(!lyrics.join("wyy-1.lrc").exists());
        assert!(!lyrics.join("wyy-1.meta.json").exists());
        assert_eq!(std::fs::read(lyrics.join("keep.txt")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(root);
    }
}
