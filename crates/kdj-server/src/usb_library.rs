//! 可移动存储识别与 OneLibrary 便携导出。
//!
//! 本地播放列表始终只是数据库引用；只有用户点了导出，才把音频复制到 U 盘。
//! OneLibrary 的数据库读写由精确钉住的 rbox 0.1.5 完成（最后一个 MIT/Apache
//! 版本），这里负责挂载点边界、文件复制、增量复用和失败回滚。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

use anyhow::{Context, Result};
use kdj_core::models::{
    CuePoint, OneLibraryCapacityPlan, OneLibraryPlaylist, OneLibraryTrack, PlaylistExportResult,
    RemovableDevice, Track,
};
use kdj_core::musical_key::parse_musical_key;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::one_library_analysis::{preserve_external_cue_sections, AnalysisBundle, LocalAnalysis};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use diesel::{Connection, RunQueryDsl};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use rbox::one_library::{FileType, NewContent, OneLibrary};

const DB_RELATIVE: [&str; 3] = ["PIONEER", "rekordbox", "exportLibrary.db"];
/// OneLibrary baseline link mask used by both Rekordbox exports and rows created by djay.
const ONE_LIBRARY_CONTENT_LINK: i32 = 788_224;
/// 挂载卷根目录里的标记。只有 Tauri 壳创建的 KDJ 镜像会写它；不能只看卷名，
/// 否则用户碰巧把内置分区命名成 KDJ 时也会被当作导出目标。
pub const VIRTUAL_DISK_MARKER: &str = ".kdj-virtual-disk";

/// Tauri 负责镜像生命周期，server 负责 OneLibrary 写入。两者在同一进程，
/// 只共享当前挂载点即可；这样 Windows VHD 即使被 sysinfo 归类为 fixed disk，
/// 也能进入与真实 U 盘完全相同的导出边界检查。
static MANAGED_VIRTUAL_DISK: RwLock<Option<PathBuf>> = RwLock::new(None);
/// 用户通过右侧 OneLibrary 面板明确选择过的卷。部分 USB SSD 在 Windows/macOS
/// 会被 sysinfo 标成 fixed；显式选择后仍应作为真实移动存储出现。
static AUTHORIZED_REMOVABLE_DISKS: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileRevision {
    exists: bool,
    len: u64,
    modified_ns: u128,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OneLibraryRevision {
    database: FileRevision,
    wal: FileRevision,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Clone)]
struct CachedCoverSource {
    image: Option<PathBuf>,
    audio: PathBuf,
}

/// 波形缓存身份只使用 OneLibrary 内部相对路径/内容属性，不含 `/Volumes/...` 或盘符。
/// 同一张软盘换挂载点后仍命中；legacy_cache_id 只用于接住 0.2.39 的旧本机缓存。
#[derive(Debug, Clone)]
pub(crate) struct OneLibraryContentFile {
    pub path: PathBuf,
    pub cache_id: i64,
    pub legacy_cache_id: i64,
    pub portable_waveform_dir: Option<PathBuf>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct CachedOneLibraryRead {
    revision: OneLibraryRevision,
    playlists: Option<Vec<OneLibraryPlaylist>>,
    tracks: HashMap<i32, Vec<OneLibraryTrack>>,
    content_files: HashMap<i32, OneLibraryContentFile>,
    cover_sources: HashMap<i32, CachedCoverSource>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl CachedOneLibraryRead {
    fn new(revision: OneLibraryRevision) -> Self {
        Self {
            revision,
            playlists: None,
            tracks: HashMap::new(),
            content_files: HashMap::new(),
            cover_sources: HashMap::new(),
        }
    }
}

/// 只缓存反序列化后的只读快照，不缓存 SQLCipher 连接。djay 写 WAL 后 revision
/// 改变，下一轮自动丢弃旧快照；这样保留跨进程刷新，又不会每三秒重开加密库。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static ONE_LIBRARY_READ_CACHE: LazyLock<RwLock<HashMap<PathBuf, CachedOneLibraryRead>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// schema 只会在数据库文件被替换时变化。creation time 在 macOS ExFAT 与 Windows
/// VHD 上都稳定，不会像 mtime 一样被普通曲目写入反复打掉。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static DJAY_SCHEMA_CHECKED: LazyLock<RwLock<HashMap<PathBuf, Option<u128>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// 旧 KDJ 导出可能没有 `analysisDataFilePath`。每个数据库文件只扫描一次；新导出
/// 从创建时就带占位 ANLZ，不需要靠轮询反复检查。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static ANALYSIS_PATHS_CHECKED: LazyLock<RwLock<HashMap<PathBuf, Option<u128>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

pub fn set_managed_virtual_disk_mount(path: Option<PathBuf>) {
    *MANAGED_VIRTUAL_DISK
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
}

fn managed_virtual_disk_mount() -> Option<PathBuf> {
    MANAGED_VIRTUAL_DISK
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .filter(|path| path.is_dir() && path.join(VIRTUAL_DISK_MARKER).is_file())
}

fn authorized_removable_mounts() -> Vec<PathBuf> {
    AUTHORIZED_REMOVABLE_DISKS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn same_mount(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn one_library_db(root: &Path) -> PathBuf {
    root.join(DB_RELATIVE[0])
        .join(DB_RELATIVE[1])
        .join(DB_RELATIVE[2])
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cache_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn file_revision(path: &Path) -> FileRevision {
    let Ok(metadata) = path.metadata() else {
        return FileRevision {
            exists: false,
            len: 0,
            modified_ns: 0,
        };
    };
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    FileRevision {
        exists: true,
        len: metadata.len(),
        modified_ns,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_revision(db_path: &Path) -> OneLibraryRevision {
    OneLibraryRevision {
        database: file_revision(db_path),
        wal: file_revision(&PathBuf::from(format!("{}-wal", db_path.to_string_lossy()))),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn schema_created_ns(db_path: &Path) -> Option<u128> {
    db_path
        .metadata()
        .ok()?
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn invalidate_one_library_read_cache(db_path: &Path) {
    ONE_LIBRARY_READ_CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&cache_key(db_path));
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn invalidate_one_library_schema_cache(db_path: &Path) {
    let key = cache_key(db_path);
    DJAY_SCHEMA_CHECKED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&key);
    ANALYSIS_PATHS_CHECKED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&key);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cached_playlists(
    db_path: &Path,
    revision: OneLibraryRevision,
) -> Option<Vec<OneLibraryPlaylist>> {
    let cache = ONE_LIBRARY_READ_CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = cache.get(&cache_key(db_path))?;
    (entry.revision == revision)
        .then(|| entry.playlists.clone())
        .flatten()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cached_playlist_tracks(
    db_path: &Path,
    revision: OneLibraryRevision,
    playlist_id: i32,
) -> Option<Vec<OneLibraryTrack>> {
    let cache = ONE_LIBRARY_READ_CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = cache.get(&cache_key(db_path))?;
    (entry.revision == revision)
        .then(|| entry.tracks.get(&playlist_id).cloned())
        .flatten()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cached_content_file(
    db_path: &Path,
    revision: OneLibraryRevision,
    content_id: i32,
) -> Option<OneLibraryContentFile> {
    let cache = ONE_LIBRARY_READ_CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = cache.get(&cache_key(db_path))?;
    (entry.revision == revision)
        .then(|| entry.content_files.get(&content_id).cloned())
        .flatten()
}

fn positive_cache_id(parts: &[&[u8]]) -> i64 {
    let value = stable_hash(parts) & i64::MAX as u64;
    i64::try_from(value.max(1)).unwrap_or(1)
}

fn one_library_content_file_snapshot(
    root: &Path,
    writable: bool,
    content_id: i32,
    content_path: &str,
    file_size: Option<i32>,
    audio: PathBuf,
) -> OneLibraryContentFile {
    let normalized_path = content_path.replace('\\', "/");
    let size = i64::from(file_size.unwrap_or_default()).to_le_bytes();
    let id = content_id.to_le_bytes();
    OneLibraryContentFile {
        // 新身份不含挂载点；同一 OneLibrary 卷改名、换盘符或重挂载仍能复用。
        cache_id: positive_cache_id(&[normalized_path.as_bytes(), &size, &id]),
        // 0.2.39 使用绝对路径。保留一轮只读兼容，命中后 coordinator 会原子转存。
        legacy_cache_id: positive_cache_id(&[audio.to_string_lossy().as_bytes(), &id]),
        path: audio,
        portable_waveform_dir: writable.then(|| root.join(".kdj/onelibrary-waveform")),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cached_cover_source(
    db_path: &Path,
    revision: OneLibraryRevision,
    content_id: i32,
) -> Option<CachedCoverSource> {
    let cache = ONE_LIBRARY_READ_CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = cache.get(&cache_key(db_path))?;
    (entry.revision == revision)
        .then(|| entry.cover_sources.get(&content_id).cloned())
        .flatten()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn update_read_cache(
    db_path: &Path,
    revision: OneLibraryRevision,
    update: impl FnOnce(&mut CachedOneLibraryRead),
) {
    let key = cache_key(db_path);
    let mut cache = ONE_LIBRARY_READ_CACHE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() >= 16 && !cache.contains_key(&key) {
        cache.clear();
    }
    let entry = cache
        .entry(key)
        .or_insert_with(|| CachedOneLibraryRead::new(revision));
    if entry.revision != revision {
        *entry = CachedOneLibraryRead::new(revision);
    }
    update(entry);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn file_signature(path: &Path) -> (u64, u128) {
    let Ok(metadata) = path.metadata() else {
        return (0, 0);
    };
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    (metadata.len(), modified_ns)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_one_library(db_path: &Path) -> Result<OneLibrary> {
    // djay 与 KDJ 会交替读写同一份 SQLCipher/WAL 数据库。长期缓存 r2d2 池会让
    // KDJ 在界面轮询结束后仍持有 db/wal/shm；djay 随后的拖入操作可能因此拿不到
    // 它需要的写入窗口并静默失败。每个 HTTP 数据库任务只保留这一枚短连接，任务
    // 返回即关闭；外部应用下一次写入无需等待 KDJ 的三秒刷新周期。
    repair_djay_schema(db_path)?;
    repair_missing_kdj_analysis_bundles(db_path)?;
    OneLibrary::new(db_path).context("OneLibrary 数据库无法读取")
}

fn supported_file_system(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "exfat"
            | "fat"
            | "fat16"
            | "fat32"
            | "msdos"
            | "msdosfs"
            | "vfat"
            | "hfs"
            | "hfs+"
            | "hfsplus"
    )
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn removable_devices() -> Vec<RemovableDevice> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let managed = managed_virtual_disk_mount();
    let authorized = authorized_removable_mounts();
    let mut devices: Vec<RemovableDevice> = disks
        .list()
        .iter()
        .filter(|disk| {
            disk.is_removable()
                || authorized
                    .iter()
                    .any(|path| same_mount(disk.mount_point(), path))
                || managed
                    .as_deref()
                    .is_some_and(|path| same_mount(disk.mount_point(), path))
        })
        .filter_map(|disk| {
            let path = disk.mount_point();
            if !path.is_absolute() || !path.exists() {
                return None;
            }
            let is_virtual = managed
                .as_deref()
                .is_some_and(|managed| same_mount(path, managed));
            let file_system = disk.file_system().to_string_lossy().into_owned();
            let name = disk.name().to_string_lossy().trim().to_owned();
            Some(RemovableDevice {
                path: path.to_string_lossy().into_owned(),
                name: if is_virtual {
                    "KDJ".to_owned()
                } else if name.is_empty() {
                    path.file_name()
                        .map(|part| part.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "可移动存储".to_owned())
                } else {
                    name
                },
                file_system: file_system.clone(),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
                read_only: disk.is_read_only(),
                one_library_file_system: supported_file_system(&file_system),
                has_one_library: one_library_db(path).is_file(),
                is_virtual,
            })
        })
        .collect();
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    devices.dedup_by(|a, b| a.path == b.path);
    devices
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn authorize_removable_device(requested: &str) -> Result<RemovableDevice> {
    let requested = Path::new(requested)
        .canonicalize()
        .with_context(|| format!("选择的移动存储不可访问：{requested}"))?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| {
            disk.mount_point().is_absolute()
                && requested.starts_with(disk.mount_point())
                && disk.mount_point().exists()
        })
        .max_by_key(|disk| disk.mount_point().components().count())
        .context("选择的位置不在已挂载的磁盘卷上")?;
    let mount = disk.mount_point().to_path_buf();
    #[cfg(not(target_os = "windows"))]
    anyhow::ensure!(mount != Path::new("/"), "不能把系统磁盘授权为 OneLibrary");
    #[cfg(target_os = "windows")]
    if let Some(system_drive) = std::env::var_os("SystemDrive") {
        let system_root = PathBuf::from(format!("{}\\", system_drive.to_string_lossy()));
        anyhow::ensure!(
            !same_mount(&mount, &system_root),
            "不能把 Windows 系统磁盘授权为 OneLibrary"
        );
    }
    let file_system = disk.file_system().to_string_lossy().into_owned();
    anyhow::ensure!(
        supported_file_system(&file_system),
        "OneLibrary 只支持 exFAT、FAT32 或 HFS+；当前文件系统是 {}",
        if file_system.is_empty() {
            "未知"
        } else {
            &file_system
        }
    );
    anyhow::ensure!(!disk.is_read_only(), "选择的移动存储是只读的");
    drop(disks);

    {
        let mut authorized = AUTHORIZED_REMOVABLE_DISKS
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !authorized.iter().any(|path| same_mount(path, &mount)) {
            authorized.push(mount.clone());
        }
    }
    removable_devices()
        .into_iter()
        .find(|device| same_mount(Path::new(&device.path), &mount))
        .context("移动存储已授权，但重新枚举时没有找到该卷")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn removable_devices() -> Vec<RemovableDevice> {
    Vec::new()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn authorize_removable_device(_requested: &str) -> Result<RemovableDevice> {
    anyhow::bail!("移动端不支持授权 OneLibrary 外置存储")
}

/// 每次写入前重新枚举，前端五秒前看到的 U 盘可能已经被拔掉。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn current_device(requested: &str, require_writable: bool) -> Result<RemovableDevice> {
    let requested = Path::new(requested);
    let requested = requested
        .canonicalize()
        .with_context(|| format!("U 盘已经断开或挂载点不可用：{}", requested.display()))?;
    let device = removable_devices()
        .into_iter()
        .find(|device| {
            Path::new(&device.path)
                .canonicalize()
                .map(|path| path == requested)
                .unwrap_or(false)
        })
        .context("拒绝写入：目标不是当前检测到的可移动存储根目录")?;
    if require_writable {
        anyhow::ensure!(!device.read_only, "这个 OneLibrary 存储是只读的");
    }
    anyhow::ensure!(
        device.one_library_file_system,
        "OneLibrary 只支持 exFAT、FAT32 或 HFS+；当前文件系统是 {}",
        if device.file_system.is_empty() {
            "未知"
        } else {
            &device.file_system
        }
    );
    Ok(device)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn checked_device(requested: &str) -> Result<RemovableDevice> {
    current_device(requested, true)
}

fn safe_component(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.trim().chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim_matches([' ', '.']).trim();
    let mut clipped: String = out.chars().take(120).collect();
    if clipped.is_empty() {
        clipped = fallback.to_owned();
    }
    clipped
}

fn one_library_key_name(music_key: &str, camelot: &str) -> String {
    let raw = if music_key.trim().is_empty() {
        camelot.trim()
    } else {
        music_key.trim()
    };
    parse_musical_key(raw)
        .map(|key| key.one_library_name())
        // OneLibrary key.name 是自由文本；识别不了的第三方调式必须原样保留。
        .unwrap_or_else(|| raw.to_owned())
}

fn stable_hash(parts: &[&[u8]]) -> u64 {
    // FNV-1a：不拿 DefaultHasher（其输出不承诺跨 Rust 版本稳定）做落盘路径。
    let mut hash = 0xcbf29ce484222325u64;
    for part in parts {
        for &byte in *part {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn usb_track_path(track: &Track, file_size: u64) -> (String, PathBuf) {
    let filename = safe_component(&track.filename, "track");
    let size = file_size.to_le_bytes();
    let hash = stable_hash(&[track.path.as_bytes(), &size]);
    let relative = PathBuf::from("Contents")
        .join("KDJ")
        .join(format!("{hash:016x}-{filename}"));
    let database_path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
    (database_path, relative)
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<u64> {
    let parent = destination.parent().context("U 盘曲目目标缺少父目录")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("创建 U 盘音乐目录失败：{}", parent.display()))?;
    let temp = destination.with_extension(format!(
        "{}.kdj-part",
        destination
            .extension()
            .map(|value| value.to_string_lossy())
            .unwrap_or_default()
    ));
    let _ = fs::remove_file(&temp);
    let copied = fs::copy(source, &temp).with_context(|| {
        format!(
            "复制曲目到 U 盘失败：{} → {}",
            source.display(),
            destination.display()
        )
    })?;
    // 不对每首歌 sync_all：这会把一次顺序导出拆成 N 次强制闪存刷写，是 U 盘
    // 发热和 Windows 卡顿的主要放大器。安全弹出会统一 flush；partial + rename
    // 仍保证应用异常时不会把半首歌冒充成成品。
    fs::rename(&temp, destination)
        .with_context(|| format!("提交 U 盘曲目失败：{}", destination.display()))?;
    Ok(copied)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_analysis_bundle(
    root: &Path,
    bundle: AnalysisBundle,
    preserve_existing_cues: bool,
    created_files: &mut Vec<PathBuf>,
    replaced_files: &mut Vec<(PathBuf, Vec<u8>)>,
) -> Result<bool> {
    let mut changed = false;
    for file in bundle.files {
        let path = root.join(&file.relative_path);
        let previous = fs::read(&path).ok();
        let body = if preserve_existing_cues {
            previous
                .as_deref()
                .map(|existing| preserve_external_cue_sections(&file.body, existing))
                .unwrap_or(file.body)
        } else {
            file.body
        };
        if previous.as_deref() == Some(body.as_slice()) {
            continue;
        }
        let parent = path.parent().context("OneLibrary 分析文件缺少父目录")?;
        fs::create_dir_all(parent)?;
        let temp = path.with_extension(format!(
            "{}.kdj-part",
            path.extension()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default()
        ));
        let _ = fs::remove_file(&temp);
        fs::write(&temp, &body)
            .with_context(|| format!("写 OneLibrary 分析临时文件失败：{}", temp.display()))?;
        if let Err(first) = fs::rename(&temp, &path) {
            if previous.is_some() && path.is_file() {
                let disk_rollback = path.with_extension(format!(
                    "{}.kdj-rollback",
                    path.extension()
                        .map(|value| value.to_string_lossy())
                        .unwrap_or_default()
                ));
                let _ = fs::remove_file(&disk_rollback);
                fs::rename(&path, &disk_rollback).with_context(|| {
                    format!("暂存旧 OneLibrary 分析文件失败：{}", path.display())
                })?;
                if let Err(second) = fs::rename(&temp, &path) {
                    let _ = fs::rename(&disk_rollback, &path);
                    let _ = fs::remove_file(&temp);
                    return Err(second).with_context(|| {
                        format!(
                            "提交 OneLibrary 分析文件失败：{}（首次错误：{first}）",
                            path.display()
                        )
                    });
                }
                let _ = fs::remove_file(disk_rollback);
            } else {
                let _ = fs::remove_file(&temp);
                return Err(first)
                    .with_context(|| format!("提交 OneLibrary 分析文件失败：{}", path.display()));
            }
        }
        match previous {
            Some(body) => replaced_files.push((path, body)),
            None => created_files.push(path),
        }
        changed = true;
    }
    Ok(changed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_missing_analysis_bundle(
    root: &Path,
    bundle: AnalysisBundle,
    created_files: &mut Vec<PathBuf>,
) -> Result<bool> {
    let mut changed = false;
    for file in bundle.files {
        let path = root.join(file.relative_path);
        if path.is_file() {
            continue;
        }
        let parent = path.parent().context("OneLibrary 分析文件缺少父目录")?;
        fs::create_dir_all(parent)?;
        let temp = path.with_extension(format!(
            "{}.kdj-part",
            path.extension()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default()
        ));
        let _ = fs::remove_file(&temp);
        fs::write(&temp, file.body)
            .with_context(|| format!("写 OneLibrary 占位分析文件失败：{}", temp.display()))?;
        if let Err(error) = fs::rename(&temp, &path) {
            if path.is_file() {
                let _ = fs::remove_file(&temp);
                continue;
            }
            let _ = fs::remove_file(&temp);
            return Err(error)
                .with_context(|| format!("提交 OneLibrary 占位分析文件失败：{}", path.display()));
        }
        created_files.push(path);
        changed = true;
    }
    Ok(changed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn file_type(path: &Path) -> Result<i32> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    FileType::try_from_extension(extension)
        .map(|kind| kind as i32)
        .map_err(anyhow::Error::msg)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn backup_database(db_path: &Path) -> Result<Option<PathBuf>> {
    if !db_path.exists() {
        return Ok(None);
    }
    // 调用方即将写库；先丢只读快照，失败恢复时也不能把旧响应继续交给界面。
    invalidate_one_library_read_cache(db_path);
    let root = db_path
        .ancestors()
        .nth(3)
        .context("OneLibrary 数据库路径不完整")?;
    let backup_dir = root.join("KDJ").join("Backups");
    fs::create_dir_all(&backup_dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let backup = backup_dir.join(format!("exportLibrary-{stamp}.db"));
    fs::copy(db_path, &backup).context("备份现有 OneLibrary 数据库失败")?;
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()));
        if source.exists() {
            fs::copy(
                &source,
                PathBuf::from(format!("{}{suffix}", backup.to_string_lossy())),
            )?;
        }
    }
    Ok(Some(backup))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_database(db_path: &Path, backup: Option<&Path>) {
    invalidate_one_library_read_cache(db_path);
    invalidate_one_library_schema_cache(db_path);
    for suffix in ["", "-wal", "-shm"] {
        let target = PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()));
        let _ = fs::remove_file(&target);
        if let Some(backup) = backup {
            let source = PathBuf::from(format!("{}{suffix}", backup.to_string_lossy()));
            if source.exists() {
                let _ = fs::copy(source, target);
            }
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(diesel::QueryableByName)]
struct SqlCount {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn schema_column_count(
    conn: &mut rbox::one_library::DbConn,
    table: &str,
    predicate: &str,
) -> Result<i64> {
    let query =
        format!("SELECT COUNT(*) AS count FROM pragma_table_info('{table}') WHERE {predicate}");
    Ok(diesel::sql_query(query).get_result::<SqlCount>(conn)?.count)
}

/// 修复诊断日志确认会阻断 djay 5.6.7 的 rbox 0.1.5 建库差异：
/// `image.path`、`content.dateCreated/dateAdded` 被错设为 NOT NULL，且 `content`
/// 缺少 djay 插入语句使用的 `djPlayCount`。旧 KDJ 行还把 `contentLink` 和三个
/// 更新计数错误初始化为 0，与官方 OneLibrary 基线不一致。同时补齐官方默认的
/// Hot Cue 自动载入标记。只迁移缺失项；官方/djay 所建的
/// 兼容库检测通过后不写。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn repair_djay_schema(db_path: &Path) -> Result<bool> {
    let key = cache_key(db_path);
    let created_ns = schema_created_ns(db_path);
    if DJAY_SCHEMA_CHECKED
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        == Some(&created_ns)
    {
        return Ok(false);
    }

    // SQLCipher 的连接初始化远比这几条 pragma 贵。必须在同一连接上完成全部检查，
    // 不能为四个字段各开一次连接。
    let mut check_conn = rbox::one_library::establish_connection(
        db_path
            .to_str()
            .context("OneLibrary 数据库路径不是有效的 UTF-8")?,
    )?;
    let image_path_required = schema_column_count(
        &mut check_conn,
        "image",
        "name = 'path' AND \"notnull\" <> 0",
    )? > 0;
    let dj_play_count_missing =
        schema_column_count(&mut check_conn, "content", "name = 'djPlayCount'")? == 0;
    let date_created_required = schema_column_count(
        &mut check_conn,
        "content",
        "name = 'dateCreated' AND \"notnull\" <> 0",
    )? > 0;
    let date_added_required = schema_column_count(
        &mut check_conn,
        "content",
        "name = 'dateAdded' AND \"notnull\" <> 0",
    )? > 0;
    let legacy_content_defaults_missing = diesel::sql_query(
        "SELECT COUNT(*) AS count FROM content \
         WHERE isHotCueAutoLoadOn IS NULL OR masterDbId IS NULL \
            OR contentLink IS NULL OR contentLink = 0 \
            OR cueUpdateCount = 0 OR analysisDataUpdateCount = 0 \
            OR informationUpdateCount = 0",
    )
    .get_result::<SqlCount>(&mut check_conn)?
    .count
        > 0;
    if !image_path_required
        && !dj_play_count_missing
        && !date_created_required
        && !date_added_required
        && !legacy_content_defaults_missing
    {
        DJAY_SCHEMA_CHECKED
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, created_ns);
        return Ok(false);
    }
    let has_compat_id = schema_column_count(&mut check_conn, "image", "name = 'id'")? > 0;
    drop(check_conn);
    let backup = backup_database(db_path)?;
    let result = (|| -> Result<()> {
        let mut conn = rbox::one_library::establish_connection(
            db_path
                .to_str()
                .context("OneLibrary 数据库路径不是有效的 UTF-8")?,
        )?;
        diesel::sql_query("PRAGMA foreign_keys = OFF").execute(&mut conn)?;
        let migration = conn.transaction::<_, anyhow::Error, _>(|conn| {
            if image_path_required {
                if has_compat_id {
                    diesel::sql_query(
                        "CREATE TABLE image_kdj_nullable (image_id INTEGER PRIMARY KEY, path TEXT, id INTEGER)",
                    )
                    .execute(conn)?;
                    diesel::sql_query(
                        "INSERT INTO image_kdj_nullable (image_id, path, id) SELECT image_id, path, id FROM image",
                    )
                    .execute(conn)?;
                } else {
                    diesel::sql_query(
                        "CREATE TABLE image_kdj_nullable (image_id INTEGER PRIMARY KEY, path TEXT)",
                    )
                    .execute(conn)?;
                    diesel::sql_query(
                        "INSERT INTO image_kdj_nullable (image_id, path) SELECT image_id, path FROM image",
                    )
                    .execute(conn)?;
                }
                diesel::sql_query("DROP TABLE image").execute(conn)?;
                diesel::sql_query("ALTER TABLE image_kdj_nullable RENAME TO image")
                    .execute(conn)?;
                if has_compat_id {
                    diesel::sql_query("CREATE UNIQUE INDEX kdj_image_foreign_id ON image(id)")
                        .execute(conn)?;
                    diesel::sql_query(
                        "CREATE TRIGGER kdj_image_foreign_id_insert AFTER INSERT ON image \
                         WHEN NEW.id IS NULL BEGIN UPDATE image SET id = NEW.image_id \
                         WHERE image_id = NEW.image_id; END",
                    )
                    .execute(conn)?;
                }
            }
            if dj_play_count_missing {
                diesel::sql_query("ALTER TABLE content ADD COLUMN djPlayCount INTEGER")
                    .execute(conn)?;
            }
            for (required, column, old_column) in [
                (
                    date_created_required,
                    "dateCreated",
                    "kdj_dateCreated_required",
                ),
                (
                    date_added_required,
                    "dateAdded",
                    "kdj_dateAdded_required",
                ),
            ] {
                if !required {
                    continue;
                }
                diesel::sql_query(format!(
                    "ALTER TABLE content RENAME COLUMN {column} TO {old_column}"
                ))
                .execute(conn)?;
                diesel::sql_query(format!(
                    "ALTER TABLE content ADD COLUMN {column} TEXT"
                ))
                .execute(conn)?;
                diesel::sql_query(format!(
                    "UPDATE content SET {column} = {old_column}"
                ))
                .execute(conn)?;
                diesel::sql_query(format!(
                    "ALTER TABLE content DROP COLUMN {old_column}"
                ))
                .execute(conn)?;
            }
            if legacy_content_defaults_missing {
                diesel::sql_query(format!(
                    "UPDATE content SET \
                         isHotCueAutoLoadOn = COALESCE(isHotCueAutoLoadOn, 1), \
                         masterDbId = COALESCE(masterDbId, 0), \
                         contentLink = CASE \
                             WHEN contentLink IS NULL OR contentLink = 0 \
                             THEN {ONE_LIBRARY_CONTENT_LINK} ELSE contentLink END, \
                         cueUpdateCount = NULLIF(cueUpdateCount, 0), \
                         analysisDataUpdateCount = NULLIF(analysisDataUpdateCount, 0), \
                         informationUpdateCount = NULLIF(informationUpdateCount, 0) \
                     WHERE isHotCueAutoLoadOn IS NULL OR masterDbId IS NULL \
                        OR contentLink IS NULL OR contentLink = 0 \
                        OR cueUpdateCount = 0 OR analysisDataUpdateCount = 0 \
                        OR informationUpdateCount = 0"
                ))
                .execute(conn)?;
            }
            Ok(())
        });
        let enable = diesel::sql_query("PRAGMA foreign_keys = ON").execute(&mut conn);
        migration?;
        enable?;
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(db_path, backup.as_deref());
        return Err(error).context("修复 djay OneLibrary 数据结构失败，已恢复原数据库");
    }
    DJAY_SCHEMA_CHECKED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cache_key(db_path), schema_created_ns(db_path));
    Ok(true)
}

/// 0.2.39 只在 djay 自己完成分析后才可能得到 `analysisDataFilePath`。但 djay 的
/// Cue 持久化目标正是 ANLZ；没有路径时 Cue 只留在当前 deck，另一 deck 立即读不到。
/// 为旧 KDJ 曲目补最小可写 bundle，不伪造 beatgrid/波形，也绝不替换已有分析文件。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn repair_missing_kdj_analysis_bundles(db_path: &Path) -> Result<bool> {
    let key = cache_key(db_path);
    let created_ns = schema_created_ns(db_path);
    if ANALYSIS_PATHS_CHECKED
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .is_some_and(|cached| *cached == created_ns)
    {
        return Ok(false);
    }

    let root = db_path
        .ancestors()
        .nth(3)
        .context("OneLibrary 数据库路径不完整")?
        .to_path_buf();
    let library = OneLibrary::new(db_path).context("扫描旧 KDJ 分析路径失败")?;
    let missing: Vec<_> = library
        .get_contents()?
        .into_iter()
        .filter(|content| {
            if !content
                .path
                .replace('\\', "/")
                .starts_with("/Contents/KDJ/")
            {
                return false;
            }
            let expected = AnalysisBundle::placeholder(&content.path);
            let has_expected_path = content
                .analysis_data_file_path
                .as_deref()
                .is_some_and(|path| path == expected.database_path);
            content
                .analysis_data_file_path
                .as_deref()
                .is_none_or(str::is_empty)
                || (has_expected_path
                    && expected
                        .files
                        .iter()
                        .any(|file| !root.join(&file.relative_path).is_file()))
        })
        .collect();
    drop(library);
    if missing.is_empty() {
        ANALYSIS_PATHS_CHECKED
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, created_ns);
        return Ok(false);
    }

    let backup = backup_database(db_path)?;
    let mut created_files = Vec::new();
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(db_path).context("修复旧 KDJ 分析路径失败")?;
        for mut content in missing {
            let bundle = AnalysisBundle::placeholder(&content.path);
            let database_path = bundle.database_path.clone();
            write_missing_analysis_bundle(&root, bundle, &mut created_files)?;
            content.analysis_data_file_path = Some(database_path);
            content.analysed_bits.get_or_insert(0);
            content.is_hot_cue_auto_load_on.get_or_insert(1);
            content.master_db_id.get_or_insert(0);
            if content.content_link.unwrap_or_default() == 0 {
                content.content_link = Some(ONE_LIBRARY_CONTENT_LINK);
            }
            content.information_update_count = Some(
                content
                    .information_update_count
                    .unwrap_or_default()
                    .saturating_add(1),
            );
            library.update_content(content)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(db_path, backup.as_deref());
        for path in created_files {
            let _ = fs::remove_file(path);
        }
        return Err(error).context("补齐旧 KDJ Cue 存储失败，已恢复原数据库");
    }
    invalidate_one_library_read_cache(db_path);
    ANALYSIS_PATHS_CHECKED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, schema_created_ns(db_path));
    Ok(true)
}

/// rbox 0.1.5 的首版建库 migration 有两组拼写问题：`originalartist_id` 与 ORM
/// 字段名不一致，而且外键引用了各 lookup 表里不存在的 `id` 列。读取现成的官方
/// OneLibrary 不受影响；只有 KDJ 新建库时要补这层兼容列/触发器。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn repair_new_rbox_schema(db_path: &Path) -> Result<()> {
    let mut conn = rbox::one_library::establish_connection(
        db_path
            .to_str()
            .context("OneLibrary 数据库路径不是有效的 UTF-8")?,
    )?;
    diesel::sql_query("PRAGMA foreign_keys = OFF").execute(&mut conn)?;
    diesel::sql_query(
        "ALTER TABLE content RENAME COLUMN originalartist_id TO artist_id_originalArtist",
    )
    .execute(&mut conn)?;
    for (table, primary) in [
        ("artist", "artist_id"),
        ("album", "album_id"),
        ("genre", "genre_id"),
        ("label", "label_id"),
        ("key", "key_id"),
        ("color", "color_id"),
        ("image", "image_id"),
    ] {
        diesel::sql_query(format!("ALTER TABLE \"{table}\" ADD COLUMN id INTEGER"))
            .execute(&mut conn)?;
        diesel::sql_query(format!(
            "UPDATE \"{table}\" SET id = \"{primary}\" WHERE id IS NULL"
        ))
        .execute(&mut conn)?;
        diesel::sql_query(format!(
            "CREATE UNIQUE INDEX kdj_{table}_foreign_id ON \"{table}\"(id)"
        ))
        .execute(&mut conn)?;
        diesel::sql_query(format!(
            "CREATE TRIGGER kdj_{table}_foreign_id_insert AFTER INSERT ON \"{table}\" \
             WHEN NEW.id IS NULL BEGIN UPDATE \"{table}\" SET id = NEW.\"{primary}\" \
             WHERE \"{primary}\" = NEW.\"{primary}\"; END"
        ))
        .execute(&mut conn)?;
    }
    diesel::sql_query("PRAGMA foreign_keys = ON").execute(&mut conn)?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn open_or_create_library(db_path: &Path) -> Result<OneLibrary> {
    if db_path.is_file() {
        repair_djay_schema(db_path)?;
        repair_missing_kdj_analysis_bundles(db_path)?;
        return OneLibrary::new(db_path).context("现有 OneLibrary 数据库无法读取");
    }
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let created = OneLibrary::create(db_path, 0).context("创建 OneLibrary 数据库失败")?;
    drop(created);
    repair_new_rbox_schema(db_path).context("初始化 OneLibrary 兼容结构失败")?;
    OneLibrary::new(db_path).context("重新打开 OneLibrary 数据库失败")
}

/// rbox 0.1.5 把 `playlist_content.sequenceNo` 当成从 0 开始，但 djay 按
/// OneLibrary 的 1-based 顺序读取，并会把两首歌的 `0, 1` 判成缺少序号 2。
/// 所有写操作结束后统一改成每个列表内连续的 `1..=N`；相同旧序号再按 content id
/// 排序，以便顺便修复旧版写出的重复/断档数据。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn normalize_playlist_content_sequences(db_path: &Path) -> Result<usize> {
    let mut conn = rbox::one_library::establish_connection(
        db_path
            .to_str()
            .context("OneLibrary 数据库路径不是有效的 UTF-8")?,
    )?;
    conn.transaction::<usize, diesel::result::Error, _>(|conn| {
        diesel::sql_query(
            r#"WITH ordered AS (
                SELECT playlist_id, content_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY playlist_id
                           ORDER BY sequenceNo, content_id
                       ) AS new_seq
                FROM playlist_content
            )
            UPDATE playlist_content
            SET sequenceNo = (
                SELECT new_seq FROM ordered
                WHERE ordered.playlist_id = playlist_content.playlist_id
                  AND ordered.content_id = playlist_content.content_id
            )
            WHERE sequenceNo <> (
                SELECT new_seq FROM ordered
                WHERE ordered.playlist_id = playlist_content.playlist_id
                  AND ordered.content_id = playlist_content.content_id
            )"#,
        )
        .execute(conn)
    })
    .context("修复 OneLibrary 曲目顺序失败")
}

fn checked_one_library_name(name: &str) -> Result<String> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "OneLibrary 列表名称不能为空");
    anyhow::ensure!(
        name.chars().count() <= 120,
        "OneLibrary 列表名称不能超过 120 个字符"
    );
    anyhow::ensure!(
        !name.chars().any(char::is_control),
        "OneLibrary 列表名称不能包含控制字符"
    );
    Ok(name.to_owned())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn one_library_playlists(requested_device: &str) -> Result<Vec<OneLibraryPlaylist>> {
    let device = current_device(requested_device, false)?;
    let db_path = one_library_db(Path::new(&device.path));
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let revision = one_library_revision(&db_path);
    if let Some(playlists) = cached_playlists(&db_path, revision) {
        return Ok(playlists);
    }
    let library = read_one_library(&db_path)?;
    let mut playlists = Vec::new();
    for playlist in library.get_playlists()? {
        let track_count = if playlist.attribute == 0 {
            library.get_playlist_contents(playlist.id)?.len()
        } else {
            0
        };
        playlists.push(OneLibraryPlaylist {
            device_path: device.path.clone(),
            id: playlist.id,
            seq: playlist.seq,
            name: playlist.name,
            attribute: playlist.attribute,
            parent_id: playlist.parent_id,
            track_count,
        });
    }
    playlists.sort_by_key(|playlist| (playlist.parent_id, playlist.seq, playlist.id));
    if one_library_revision(&db_path) == revision {
        update_read_cache(&db_path, revision, |entry| {
            entry.playlists = Some(playlists.clone());
        });
    }
    Ok(playlists)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cue_time_ms(usec: Option<i32>, frame_150: Option<i32>) -> Option<i64> {
    if let Some(usec) = usec.filter(|value| *value >= 0) {
        return Some((i64::from(usec) + 500) / 1_000);
    }
    frame_150
        .filter(|value| *value >= 0)
        .map(|frame| (i64::from(frame) * 1_000 + 75) / 150)
}

/// 一次读完整张 cue/color 表再按 content 分组，避免列表中每首歌各占一次加密库连接。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_cue_points(library: &OneLibrary) -> Result<HashMap<i32, Vec<CuePoint>>> {
    let colors: HashMap<i32, String> = library
        .get_colors()?
        .into_iter()
        .map(|color| (color.id, color.name))
        .collect();
    let mut by_content: HashMap<i32, Vec<CuePoint>> = HashMap::new();
    for cue in library.get_cues()? {
        let Some(start_ms) = cue_time_ms(cue.in_usec, cue.in150_frame_per_sec) else {
            continue;
        };
        let end_ms =
            cue_time_ms(cue.out_usec, cue.out150_frame_per_sec).filter(|end_ms| *end_ms > start_ms);
        let color_index = cue.color_table_index.filter(|index| *index > 0);
        let color = color_index
            .and_then(|index| colors.get(&index))
            .cloned()
            .unwrap_or_default();
        by_content
            .entry(cue.content_id)
            .or_default()
            .push(CuePoint {
                id: cue.id,
                hot_cue: cue.kind.filter(|kind| *kind > 0),
                start_ms,
                end_ms,
                color_index,
                color,
                comment: cue.cue_comment.unwrap_or_default(),
                active_loop: cue.is_active_loop.is_some_and(|value| value != 0),
            });
    }
    for cue_points in by_content.values_mut() {
        cue_points.sort_by_key(|cue| (cue.start_ms, cue.hot_cue.unwrap_or_default(), cue.id));
    }
    Ok(by_content)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn managed_cues_equal(existing: &[CuePoint], managed: &[CuePoint]) -> bool {
    let normalize = |cues: &[CuePoint]| {
        let mut values: Vec<_> = cues
            .iter()
            .filter(|cue| {
                cue.start_ms >= 0
                    && cue.end_ms.is_none_or(|end_ms| end_ms > cue.start_ms)
                    && cue.hot_cue.is_none_or(|slot| (1..=8).contains(&slot))
            })
            .map(|cue| {
                (
                    cue.hot_cue,
                    cue.start_ms,
                    cue.end_ms,
                    cue.color_index.filter(|value| (1..=8).contains(value)),
                    cue.comment.trim().to_owned(),
                    cue.active_loop,
                )
            })
            .collect();
        values.sort();
        values
    };
    normalize(existing) == normalize(managed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cue_frame_150(ms: i64) -> i32 {
    i32::try_from(ms.saturating_mul(150).saturating_add(500) / 1_000).unwrap_or(i32::MAX)
}

/// 同步 OneLibrary 标准 cue 表。ANLZ 负责播放器加载，数据库负责列表交换与颜色/备注；
/// Engine DJ 一样维护两份，不能只写其中一边。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn replace_one_library_cues(
    db_path: &Path,
    content_id: i32,
    cues: &[CuePoint],
    bpm: Option<f64>,
) -> Result<()> {
    use diesel::sql_types::{Integer, Nullable, Text};

    let mut conn = rbox::one_library::establish_connection(
        db_path
            .to_str()
            .context("OneLibrary 数据库路径不是 UTF-8")?,
    )?;
    conn.transaction::<(), diesel::result::Error, _>(|conn| {
        diesel::sql_query(
            "DELETE FROM hotCueBankList_cue WHERE cue_id IN \
             (SELECT cue_id FROM cue WHERE content_id = ?)",
        )
        .bind::<Integer, _>(content_id)
        .execute(conn)?;
        diesel::sql_query("DELETE FROM cue WHERE content_id = ?")
            .bind::<Integer, _>(content_id)
            .execute(conn)?;

        for cue in cues.iter().filter(|cue| {
            cue.start_ms >= 0
                && cue.end_ms.is_none_or(|end_ms| end_ms > cue.start_ms)
                && cue.hot_cue.is_none_or(|slot| (1..=8).contains(&slot))
        }) {
            let start_usec = i32::try_from(cue.start_ms.saturating_mul(1_000)).ok();
            let end_usec = cue
                .end_ms
                .and_then(|end_ms| i32::try_from(end_ms.saturating_mul(1_000)).ok());
            let end_frame = cue.end_ms.map(cue_frame_150).unwrap_or(-1);
            let (loop_numerator, loop_denominator) = cue
                .end_ms
                .zip(bpm)
                .and_then(|(end_ms, bpm)| {
                    let beats = (end_ms - cue.start_ms) as f64 * bpm / 60_000.0;
                    let rounded = beats.round();
                    (bpm.is_finite()
                        && bpm > 0.0
                        && beats.is_finite()
                        && (1.0..=f64::from(i32::MAX)).contains(&rounded)
                        && (beats - rounded).abs() <= 0.02)
                        .then_some((rounded as i32, 1))
                })
                .unzip();
            diesel::sql_query(
                "INSERT INTO cue (content_id, kind, colorTableIndex, cueComment, isActiveLoop, \
                 beatLoopNumerator, beatLoopDenominator, inUsec, outUsec, \
                 in150FramePerSec, out150FramePerSec) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind::<Integer, _>(content_id)
            .bind::<Integer, _>(cue.hot_cue.unwrap_or_default())
            .bind::<Nullable<Integer>, _>(cue.color_index.filter(|value| (1..=8).contains(value)))
            .bind::<Text, _>(cue.comment.trim())
            .bind::<Integer, _>(i32::from(cue.active_loop))
            .bind::<Nullable<Integer>, _>(loop_numerator)
            .bind::<Nullable<Integer>, _>(loop_denominator)
            .bind::<Nullable<Integer>, _>(start_usec)
            .bind::<Nullable<Integer>, _>(end_usec)
            .bind::<Integer, _>(cue_frame_150(cue.start_ms))
            .bind::<Integer, _>(end_frame)
            .execute(conn)?;
        }
        diesel::sql_query(
            "UPDATE content SET cueUpdateCount = COALESCE(cueUpdateCount, 0) + 1 \
             WHERE content_id = ?",
        )
        .bind::<Integer, _>(content_id)
        .execute(conn)?;
        Ok(())
    })?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn one_library_playlist_tracks(
    requested_device: &str,
    playlist_id: i32,
) -> Result<Vec<OneLibraryTrack>> {
    let device = current_device(requested_device, false)?;
    let root = Path::new(&device.path);
    let db_path = one_library_db(root);
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let revision = one_library_revision(&db_path);
    if let Some(tracks) = cached_playlist_tracks(&db_path, revision, playlist_id) {
        return Ok(tracks);
    }
    let library = read_one_library(&db_path)?;
    let playlist = library
        .get_playlist_by_id(playlist_id)?
        .context("OneLibrary 列表不存在")?;
    anyhow::ensure!(playlist.attribute == 0, "这个 OneLibrary 节点不是普通列表");
    let cue_points = one_library_cue_points(&library)?;
    // lookup 表一次读完。逐曲 get_* 会把一个 1000 首列表放大成约 5000 次查询。
    let artists: HashMap<i32, String> = library
        .get_artists()?
        .into_iter()
        .map(|value| (value.id, value.name))
        .collect();
    let albums: HashMap<i32, String> = library
        .get_albums()?
        .into_iter()
        .map(|value| (value.id, value.name))
        .collect();
    let keys: HashMap<i32, String> = library
        .get_keys()?
        .into_iter()
        .map(|value| (value.id, value.name))
        .collect();
    let genres: HashMap<i32, String> = library
        .get_genres()?
        .into_iter()
        .map(|value| (value.id, value.name))
        .collect();
    let images: HashMap<i32, Option<String>> = library
        .get_images()?
        .into_iter()
        .map(|value| (value.id, value.path))
        .collect();
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("OneLibrary 存储根目录不可访问：{}", root.display()))?;
    let contents = library.get_playlist_contents(playlist_id)?;
    let mut tracks = Vec::with_capacity(contents.len());
    let mut content_files = HashMap::new();
    let mut cover_sources = HashMap::new();

    for (sequence, content) in contents.into_iter().enumerate() {
        let artist = content
            .artist_id
            .and_then(|id| artists.get(&id))
            .cloned()
            .unwrap_or_default();
        let album = content
            .album_id
            .and_then(|id| albums.get(&id))
            .cloned()
            .unwrap_or_default();
        let music_key = content
            .key_id
            .and_then(|id| keys.get(&id))
            .cloned()
            .unwrap_or_default();
        let normalized_key = parse_musical_key(&music_key);
        let genre = content
            .genre_id
            .and_then(|id| genres.get(&id))
            .cloned()
            .unwrap_or_default();
        let unresolved = one_library_relative_path(root, &content.path)?;
        let audio = if unresolved.exists() {
            one_library_existing_path_from_root(&canonical_root, root, &content.path)?
        } else {
            unresolved
        };
        let (cover_version, image_path) = if let Some(image_id) = content.image_id {
            match images.get(&image_id) {
                Some(Some(path)) if !path.is_empty() => match one_library_relative_path(root, path)
                {
                    Ok(unresolved_image) => {
                        let (len, modified_ns) = file_signature(&unresolved_image);
                        let resolved = if unresolved_image.exists() {
                            one_library_existing_path_from_root(&canonical_root, root, path).ok()
                        } else {
                            None
                        };
                        (format!("image-{image_id}-{len}-{modified_ns}"), resolved)
                    }
                    Err(_) => (format!("image-{image_id}-invalid"), None),
                },
                Some(_) => (format!("image-{image_id}-empty"), None),
                None => (format!("image-{image_id}-missing"), None),
            }
        } else {
            let (len, modified_ns) = file_signature(&audio);
            (format!("embedded-{len}-{modified_ns}"), None)
        };
        let filename = content.file_name.clone().unwrap_or_else(|| {
            Path::new(&content.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_owned()
        });
        let local_track_id = content
            .path
            .replace('\\', "/")
            .starts_with("/Contents/KDJ/")
            .then_some(content.master_content_id)
            .flatten()
            .filter(|id| *id > 0)
            .map(i64::from);
        if audio.is_file() {
            content_files.insert(
                content.id,
                one_library_content_file_snapshot(
                    root,
                    !device.read_only,
                    content.id,
                    &content.path,
                    content.file_size,
                    audio.clone(),
                ),
            );
        }
        cover_sources.insert(
            content.id,
            CachedCoverSource {
                image: image_path,
                audio: audio.clone(),
            },
        );
        tracks.push(OneLibraryTrack {
            content_id: content.id,
            sequence: i32::try_from(sequence).unwrap_or(i32::MAX),
            local_track_id,
            external_modified: content.has_modified == Some(1),
            external_update_count: content.information_update_count.unwrap_or_default(),
            title: content.title.unwrap_or_else(|| filename.clone()),
            artist,
            album,
            genre,
            year: content
                .release_year
                .map(|value| value.to_string())
                .unwrap_or_default(),
            bpm: content.bpmx100.map(|value| f64::from(value) / 100.0),
            music_key,
            camelot: normalized_key
                .as_ref()
                .map(|key| key.camelot.clone())
                .unwrap_or_default(),
            open_key: normalized_key.map(|key| key.open_key).unwrap_or_default(),
            duration: content.length.map(i64::from),
            bitrate: content.bitrate.map(i64::from),
            samplerate: content.sampling_rate.map(i64::from),
            size: content.file_size.map(i64::from).unwrap_or_default(),
            rating: content.rating.map(i64::from).unwrap_or_default(),
            comment: content.dj_comment.unwrap_or_default(),
            cover_version,
            cue_points: cue_points.get(&content.id).cloned().unwrap_or_default(),
            path: audio.to_string_lossy().into_owned(),
            filename,
        });
    }

    if one_library_revision(&db_path) == revision {
        update_read_cache(&db_path, revision, |entry| {
            entry.tracks.insert(playlist_id, tracks.clone());
            entry.content_files.extend(content_files);
            entry.cover_sources.extend(cover_sources);
        });
    }
    Ok(tracks)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_relative_path(root: &Path, value: &str) -> Result<PathBuf> {
    let relative = Path::new(value.trim_start_matches(['/', '\\']));
    anyhow::ensure!(
        relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_))),
        "OneLibrary 路径越过了存储根目录"
    );
    Ok(root.join(relative))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_existing_path(root: &Path, value: &str) -> Result<PathBuf> {
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("OneLibrary 存储根目录不可访问：{}", root.display()))?;
    one_library_existing_path_from_root(&canonical_root, root, value)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_existing_path_from_root(
    canonical_root: &Path,
    root: &Path,
    value: &str,
) -> Result<PathBuf> {
    let path = one_library_relative_path(root, value)?;
    let canonical_path = path
        .canonicalize()
        .with_context(|| format!("OneLibrary 文件不可访问：{}", path.display()))?;
    anyhow::ensure!(
        canonical_path.starts_with(&canonical_root),
        "OneLibrary 路径越过了存储根目录"
    );
    Ok(canonical_path)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn one_library_content_file(
    requested_device: &str,
    content_id: i32,
) -> Result<OneLibraryContentFile> {
    anyhow::ensure!(content_id > 0, "OneLibrary 曲目无效");
    let device = current_device(requested_device, false)?;
    let root = Path::new(&device.path);
    let db_path = one_library_db(root);
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let revision = one_library_revision(&db_path);
    if let Some(file) = cached_content_file(&db_path, revision, content_id) {
        anyhow::ensure!(file.path.is_file(), "外置音频文件已丢失");
        return Ok(file);
    }
    let library = read_one_library(&db_path)?;
    let content = library
        .get_content_by_id(content_id)?
        .context("OneLibrary 曲目不存在")?;
    let path = one_library_existing_path(root, &content.path)?;
    anyhow::ensure!(path.is_file(), "外置音频文件已丢失");
    let result = one_library_content_file_snapshot(
        root,
        !device.read_only,
        content.id,
        &content.path,
        content.file_size,
        path,
    );
    if one_library_revision(&db_path) == revision {
        update_read_cache(&db_path, revision, |entry| {
            entry.content_files.insert(content_id, result.clone());
        });
    }
    Ok(result)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn cover_extension_and_mime(data: &[u8]) -> Result<(&'static str, String)> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png".into()))
    } else if data.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg".into()))
    } else {
        anyhow::bail!("封面只支持 JPEG / PNG")
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_one_library_cover_source(source: &CachedCoverSource) -> Result<(Vec<u8>, String)> {
    if let Some(image_path) = &source.image {
        if let Ok(data) = fs::read(image_path) {
            if let Ok((_, mime)) = cover_extension_and_mime(&data) {
                return Ok((data, mime));
            }
        }
    }
    kdj_providers::tags::read_cover(&source.audio).context("没有封面")
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn one_library_cover(requested_device: &str, content_id: i32) -> Result<(Vec<u8>, String)> {
    anyhow::ensure!(content_id > 0, "OneLibrary 曲目无效");
    let device = current_device(requested_device, false)?;
    let root = Path::new(&device.path);
    let db_path = one_library_db(root);
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let revision = one_library_revision(&db_path);
    if let Some(source) = cached_cover_source(&db_path, revision, content_id) {
        return read_one_library_cover_source(&source);
    }
    let library = read_one_library(&db_path)?;
    let content = library
        .get_content_by_id(content_id)?
        .context("OneLibrary 曲目不存在")?;
    let audio = one_library_existing_path(root, &content.path)?;
    let mut image_path = None;
    if let Some(image_id) = content.image_id {
        if let Some(image) = library.get_image_by_id(image_id)? {
            if let Some(path) = image.path.as_deref().filter(|path| !path.is_empty()) {
                let unresolved = one_library_relative_path(root, path)?;
                if unresolved.exists() {
                    image_path = Some(one_library_existing_path(root, path)?);
                }
            }
        }
    }
    let source = CachedCoverSource {
        image: image_path,
        audio,
    };
    if one_library_revision(&db_path) == revision {
        update_read_cache(&db_path, revision, |entry| {
            entry.cover_sources.insert(content_id, source.clone());
        });
    }
    read_one_library_cover_source(&source)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn set_one_library_cover(
    requested_device: &str,
    content_id: i32,
    data: &[u8],
) -> Result<Option<i64>> {
    let device = checked_device(requested_device)?;
    let root = Path::new(&device.path);
    let db_path = one_library_db(root);
    let library = read_one_library(&db_path)?;
    let local_track_id = library
        .get_content_by_id(content_id)?
        .filter(|content| {
            content
                .path
                .replace('\\', "/")
                .starts_with("/Contents/KDJ/")
        })
        .and_then(|content| content.master_content_id)
        .filter(|id| *id > 0)
        .map(i64::from);
    drop(library);
    set_one_library_cover_at_root(root, content_id, data)?;
    Ok(local_track_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn set_one_library_cover_at_root(root: &Path, content_id: i32, data: &[u8]) -> Result<()> {
    anyhow::ensure!(content_id > 0, "OneLibrary 曲目无效");
    let (extension, _) = cover_extension_and_mime(data)?;
    let db_path = one_library_db(root);
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
    let content = library
        .get_content_by_id(content_id)?
        .context("OneLibrary 曲目不存在")?;
    let audio = one_library_existing_path(root, &content.path)?;
    anyhow::ensure!(audio.is_file(), "外置音频文件已丢失");
    drop(library);

    let hash = stable_hash(&[
        root.to_string_lossy().as_bytes(),
        &content_id.to_le_bytes(),
        data,
    ]);
    let image_relative = PathBuf::from("Artwork")
        .join("KDJ")
        .join(format!("content-{content_id}-{hash:016x}.{extension}"));
    let image_db_path = format!("/{}", image_relative.to_string_lossy().replace('\\', "/"));
    let image_path = root.join(&image_relative);
    let image_previous = fs::read(&image_path).ok();
    let db_backup = backup_database(&db_path)?;
    let nonce = stable_hash(&[
        audio.to_string_lossy().as_bytes(),
        &std::process::id().to_le_bytes(),
        &hash.to_le_bytes(),
    ]);
    let audio_backup = audio.with_file_name(format!(
        ".{}.kdj-cover-{nonce:016x}.backup",
        audio
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("track")
    ));
    fs::copy(&audio, &audio_backup)
        .with_context(|| format!("创建外置音频回滚副本失败：{}", audio.display()))?;

    let result = (|| -> Result<()> {
        kdj_providers::tags::write_cover(&audio, data)?;
        if let Some(parent) = image_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let image_tmp = image_path.with_extension(format!("{extension}.partial-{nonce:016x}"));
        fs::write(&image_tmp, data)?;
        if image_path.exists() {
            fs::remove_file(&image_path)?;
        }
        fs::rename(&image_tmp, &image_path)?;

        let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
        let mut content = library
            .get_content_by_id(content_id)?
            .context("OneLibrary 曲目不存在")?;
        let image = match library.get_image_by_path(&image_db_path)? {
            Some(image) => image,
            None => library.create_image(image_db_path.clone())?,
        };
        content.image_id = Some(image.id);
        content.information_update_count = Some(
            content
                .information_update_count
                .unwrap_or_default()
                .saturating_add(1),
        );
        content.has_modified = Some(1);
        library.update_content(content)?;
        Ok(())
    })();

    if let Err(error) = result {
        restore_database(&db_path, db_backup.as_deref());
        let _ = fs::copy(&audio_backup, &audio);
        match image_previous {
            Some(previous) => {
                let _ = fs::write(&image_path, previous);
            }
            None => {
                let _ = fs::remove_file(&image_path);
            }
        }
        let _ = fs::remove_file(&audio_backup);
        return Err(error);
    }
    let _ = fs::remove_file(&audio_backup);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn set_one_library_rating(
    requested_device: &str,
    content_id: i32,
    rating: i32,
) -> Result<Option<i64>> {
    let device = checked_device(requested_device)?;
    let root = Path::new(&device.path);
    let db_path = one_library_db(root);
    let library = read_one_library(&db_path)?;
    let local_track_id = library
        .get_content_by_id(content_id)?
        .filter(|content| {
            content
                .path
                .replace('\\', "/")
                .starts_with("/Contents/KDJ/")
        })
        .and_then(|content| content.master_content_id)
        .filter(|id| *id > 0)
        .map(i64::from);
    drop(library);
    set_one_library_rating_at_root(root, content_id, rating)?;
    Ok(local_track_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn set_one_library_rating_at_root(root: &Path, content_id: i32, rating: i32) -> Result<()> {
    anyhow::ensure!(content_id > 0, "OneLibrary 曲目无效");
    anyhow::ensure!((0..=5).contains(&rating), "评分必须在 0 到 5 星之间");
    let db_path = one_library_db(root);
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
        let mut content = library
            .get_content_by_id(content_id)?
            .context("OneLibrary 曲目不存在")?;
        if content.rating == Some(rating) {
            return Ok(());
        }
        content.rating = Some(rating);
        content.information_update_count = Some(
            content
                .information_update_count
                .unwrap_or_default()
                .saturating_add(1),
        );
        content.has_modified = Some(1);
        library.update_content(content)?;
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(&db_path, backup.as_deref());
        return Err(error);
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn linked_one_library_content_ids(root: &Path, local_track_id: i64) -> Result<Vec<i32>> {
    let Some(master_id) = i32::try_from(local_track_id).ok() else {
        return Ok(Vec::new());
    };
    let db_path = one_library_db(root);
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let library = read_one_library(&db_path)?;
    Ok(library
        .get_contents()?
        .into_iter()
        .filter(|content| {
            content.master_content_id == Some(master_id)
                && content
                    .path
                    .replace('\\', "/")
                    .starts_with("/Contents/KDJ/")
        })
        .map(|content| content.id)
        .collect())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sync_local_rating_to_one_libraries(local_track_id: i64, rating: i32) -> Result<()> {
    let mut errors = Vec::new();
    for device in removable_devices()
        .into_iter()
        .filter(|device| !device.read_only && device.has_one_library)
    {
        let root = Path::new(&device.path);
        match linked_one_library_content_ids(root, local_track_id) {
            Ok(ids) => {
                for content_id in ids {
                    if let Err(error) = set_one_library_rating_at_root(root, content_id, rating) {
                        errors.push(format!("{}: {error:#}", device.name));
                    }
                }
            }
            Err(error) => errors.push(format!("{}: {error:#}", device.name)),
        }
    }
    anyhow::ensure!(errors.is_empty(), "{}", errors.join("；"));
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sync_local_cover_to_one_libraries(local_track_id: i64, data: &[u8]) -> Result<()> {
    let mut errors = Vec::new();
    for device in removable_devices()
        .into_iter()
        .filter(|device| !device.read_only && device.has_one_library)
    {
        let root = Path::new(&device.path);
        match linked_one_library_content_ids(root, local_track_id) {
            Ok(ids) => {
                for content_id in ids {
                    if let Err(error) = set_one_library_cover_at_root(root, content_id, data) {
                        errors.push(format!("{}: {error:#}", device.name));
                    }
                }
            }
            Err(error) => errors.push(format!("{}: {error:#}", device.name)),
        }
    }
    anyhow::ensure!(errors.is_empty(), "{}", errors.join("；"));
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn move_one_library_playlist(
    requested_device: &str,
    playlist_id: i32,
    parent_id: i32,
    sequence: Option<i32>,
) -> Result<Vec<OneLibraryPlaylist>> {
    let device = checked_device(requested_device)?;
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
        let playlist = library
            .get_playlist_by_id(playlist_id)?
            .context("OneLibrary 列表不存在")?;
        anyhow::ensure!(playlist.attribute != 4, "智能列表不能移动");
        anyhow::ensure!(parent_id != playlist_id, "不能把列表移进自己");
        if let Some(sequence) = sequence {
            anyhow::ensure!(sequence >= 0, "OneLibrary 列表顺序不能是负数");
        }

        // rbox 会维护同层连续序号，但不会替调用方解释树语义。这里先挡掉
        // “把文件夹放进自己的后代”以及“把列表放进普通播放列表”。
        let mut cursor = parent_id;
        while cursor != 0 {
            anyhow::ensure!(cursor != playlist_id, "不能把列表文件夹移进自己的后代");
            let parent = library
                .get_playlist_by_id(cursor)?
                .context("目标 OneLibrary 文件夹不存在")?;
            anyhow::ensure!(parent.attribute == 1, "曲目列表不能包含子列表");
            cursor = parent.parent_id;
        }

        library.move_playlist(playlist_id, Some(&parent_id), sequence)?;
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(&db_path, backup.as_deref());
        return Err(error);
    }
    one_library_playlists(requested_device)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn copy_one_library_playlist_tracks(
    source_device_path: &str,
    source_playlist_id: i32,
    target_device_path: &str,
    target_playlist_id: i32,
    content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    anyhow::ensure!(!content_ids.is_empty(), "没有选中要加入的曲目");
    let mut seen = std::collections::HashSet::new();
    let requested: std::collections::HashSet<i32> = content_ids
        .into_iter()
        .filter(|id| seen.insert(*id))
        .collect();

    let source_device = current_device(source_device_path, false)?;
    let target_device = checked_device(target_device_path)?;
    if same_mount(
        Path::new(&source_device.path),
        Path::new(&target_device.path),
    ) {
        if source_playlist_id == target_playlist_id {
            return one_library_playlist_tracks(source_device_path, source_playlist_id);
        }
        let db_path = one_library_db(Path::new(&source_device.path));
        let backup = backup_database(&db_path)?;
        let result = (|| -> Result<()> {
            let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
            let source = library
                .get_playlist_by_id(source_playlist_id)?
                .context("来源 OneLibrary 列表不存在")?;
            let target = library
                .get_playlist_by_id(target_playlist_id)?
                .context("目标 OneLibrary 列表不存在")?;
            anyhow::ensure!(
                source.attribute == 0 && target.attribute == 0,
                "只能在普通列表之间加入曲目"
            );
            let source_order: Vec<i32> = library
                .get_playlist_contents(source_playlist_id)?
                .into_iter()
                .map(|content| content.id)
                .collect();
            let source_set: std::collections::HashSet<i32> = source_order.iter().copied().collect();
            anyhow::ensure!(
                requested.is_subset(&source_set),
                "部分曲目不在来源 OneLibrary 列表中"
            );
            let mut linked: std::collections::HashSet<i32> = library
                .get_playlist_contents(target_playlist_id)?
                .into_iter()
                .map(|content| content.id)
                .collect();
            for content_id in source_order {
                if requested.contains(&content_id) && linked.insert(content_id) {
                    library.create_playlist_content(target_playlist_id, content_id, None)?;
                }
            }
            drop(library);
            normalize_playlist_content_sequences(&db_path)?;
            Ok(())
        })();
        if let Err(error) = result {
            restore_database(&db_path, backup.as_deref());
            return Err(error);
        }
        return one_library_playlist_tracks(target_device_path, target_playlist_id);
    }

    // 跨设备时不能直接复用 content_id；把来源卷上的真实文件作为一次普通
    // OneLibrary 增量写入。目标端仍按稳定路径和大小去重，不会复制已有文件。
    let source_tracks = one_library_playlist_tracks(source_device_path, source_playlist_id)?;
    let tracks: Vec<Track> = source_tracks
        .into_iter()
        .filter(|track| requested.contains(&track.content_id))
        .map(|track| {
            let format = Path::new(&track.filename)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let folder = Path::new(&track.path)
                .parent()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            Track {
                id: i64::from(track.content_id),
                path: track.path,
                filename: track.filename,
                title: track.title,
                artist: track.artist,
                album: track.album,
                genre: track.genre,
                year: track.year,
                duration: track.duration.map(|value| value as f64),
                bitrate: track.bitrate,
                samplerate: track.samplerate,
                format,
                size: track.size,
                bpm: track.bpm,
                music_key: track.music_key,
                rating: track.rating,
                comment: track.comment,
                source_platform: "onelibrary".to_owned(),
                source_key: format!("{}:{}", source_device.path, track.content_id),
                folder,
                ..Track::default()
            }
        })
        .collect();
    anyhow::ensure!(
        tracks.len() == requested.len(),
        "部分曲目不在来源 OneLibrary 列表中"
    );
    let target_db = one_library_db(Path::new(&target_device.path));
    let target_library = OneLibrary::new(&target_db).context("目标 OneLibrary 数据库无法读取")?;
    let target = target_library
        .get_playlist_by_id(target_playlist_id)?
        .context("目标 OneLibrary 列表不存在")?;
    anyhow::ensure!(target.attribute == 0, "不能把曲目写入 OneLibrary 文件夹");
    let target_name = target.name;
    drop(target_library);
    export_playlist_to_device(
        target_device,
        Some(target_playlist_id),
        &target_name,
        tracks,
        None,
    )?;
    one_library_playlist_tracks(target_device_path, target_playlist_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn reorder_one_library_contents(
    library: &OneLibrary,
    playlist_id: i32,
    content_ids: &[i32],
) -> Result<()> {
    let current: Vec<i32> = library
        .get_playlist_contents(playlist_id)?
        .into_iter()
        .map(|content| content.id)
        .collect();
    let current_set: std::collections::HashSet<i32> = current.iter().copied().collect();
    let requested_set: std::collections::HashSet<i32> = content_ids.iter().copied().collect();
    anyhow::ensure!(
        content_ids.len() == current.len()
            && requested_set.len() == content_ids.len()
            && requested_set == current_set,
        "排序请求必须包含列表中的全部曲目且不能重复"
    );
    for (sequence, content_id) in content_ids.iter().enumerate() {
        library.move_playlist_content(
            playlist_id,
            *content_id,
            Some(i32::try_from(sequence).context("列表过长，无法写入顺序")?),
        )?;
    }
    let written: Vec<i32> = library
        .get_playlist_contents(playlist_id)?
        .into_iter()
        .map(|content| content.id)
        .collect();
    anyhow::ensure!(written == content_ids, "OneLibrary 曲目顺序写入后校验失败");
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn reorder_one_library_playlist_tracks(
    requested_device: &str,
    playlist_id: i32,
    content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    let device = checked_device(requested_device)?;
    anyhow::ensure!(!device.read_only, "这个存储是只读的");
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
        reorder_one_library_contents(&library, playlist_id, &content_ids)?;
        drop(library);
        normalize_playlist_content_sequences(&db_path)?;
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(&db_path, backup.as_deref());
        return Err(error);
    }
    one_library_playlist_tracks(requested_device, playlist_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn remove_one_library_playlist_tracks(
    requested_device: &str,
    playlist_id: i32,
    content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    let device = checked_device(requested_device)?;
    anyhow::ensure!(!device.read_only, "这个存储是只读的");
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
        let current: Vec<i32> = library
            .get_playlist_contents(playlist_id)?
            .into_iter()
            .map(|content| content.id)
            .collect();
        let current_set: std::collections::HashSet<i32> = current.iter().copied().collect();
        let mut seen = std::collections::HashSet::new();
        for content_id in content_ids {
            if !seen.insert(content_id) {
                continue;
            }
            anyhow::ensure!(
                current_set.contains(&content_id),
                "曲目不在这个 OneLibrary 列表中"
            );
            library.delete_playlist_content(playlist_id, content_id)?;
        }
        let remaining: Vec<i32> = current
            .into_iter()
            .filter(|content_id| !seen.contains(content_id))
            .collect();
        reorder_one_library_contents(&library, playlist_id, &remaining)?;
        drop(library);
        normalize_playlist_content_sequences(&db_path)?;
        Ok(())
    })();
    if let Err(error) = result {
        restore_database(&db_path, backup.as_deref());
        return Err(error);
    }
    one_library_playlist_tracks(requested_device, playlist_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn create_one_library_playlist(
    requested_device: &str,
    name: &str,
    parent_id: Option<i32>,
    folder: bool,
) -> Result<OneLibraryPlaylist> {
    let device = checked_device(requested_device)?;
    let name = checked_one_library_name(name)?;
    let db_path = one_library_db(Path::new(&device.path));
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<OneLibraryPlaylist> {
        let library = open_or_create_library(&db_path)?;
        let playlist = if folder {
            library.create_playlist_folder(name, parent_id, None)?
        } else {
            library.create_playlist(name, parent_id, None)?
        };
        Ok(OneLibraryPlaylist {
            device_path: device.path.clone(),
            id: playlist.id,
            seq: playlist.seq,
            name: playlist.name,
            attribute: playlist.attribute,
            parent_id: playlist.parent_id,
            track_count: 0,
        })
    })();
    if result.is_err() {
        restore_database(&db_path, backup.as_deref());
    }
    result
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn rename_one_library_playlist(
    requested_device: &str,
    playlist_id: i32,
    name: &str,
) -> Result<()> {
    let device = checked_device(requested_device)?;
    let name = checked_one_library_name(name)?;
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path)?;
        anyhow::ensure!(
            library.get_playlist_by_id(playlist_id)?.is_some(),
            "OneLibrary 列表不存在"
        );
        library.rename_playlist(playlist_id, &name)?;
        Ok(())
    })();
    if result.is_err() {
        restore_database(&db_path, backup.as_deref());
    }
    result
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn delete_one_library_playlist(requested_device: &str, playlist_id: i32) -> Result<()> {
    let device = checked_device(requested_device)?;
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let backup = backup_database(&db_path)?;
    let result = (|| -> Result<()> {
        let library = OneLibrary::new(&db_path)?;
        anyhow::ensure!(
            library.get_playlist_by_id(playlist_id)?.is_some(),
            "OneLibrary 列表不存在"
        );
        library.delete_playlist(playlist_id)?;
        Ok(())
    })();
    if result.is_err() {
        restore_database(&db_path, backup.as_deref());
    }
    result
}

fn write_m3u(root: &Path, playlist_name: &str, entries: &[(Track, PathBuf)]) -> Result<()> {
    let dir = root.join("KDJ").join("Playlists");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{}.m3u8",
        safe_component(playlist_name, "Playlist")
    ));
    let mut body = Vec::new();
    writeln!(&mut body, "#EXTM3U")?;
    for (track, relative) in entries {
        let duration = track.duration.unwrap_or(-1.0).round() as i64;
        writeln!(
            &mut body,
            "#EXTINF:{duration},{} - {}",
            track.artist.replace(['\r', '\n'], " "),
            (if track.title.is_empty() {
                &track.filename
            } else {
                &track.title
            })
            .replace(['\r', '\n'], " ")
        )?;
        writeln!(
            &mut body,
            "../../{}",
            relative.to_string_lossy().replace('\\', "/")
        )?;
    }
    if fs::read(&path).is_ok_and(|current| current == body) {
        return Ok(());
    }
    let temp = path.with_extension("m3u8.kdj-part");
    let mut file = fs::File::create(&temp)?;
    file.write_all(&body)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn one_library_image_is_readable(
    root: &Path,
    library: &OneLibrary,
    image_id: Option<i32>,
) -> Result<bool> {
    let Some(image_id) = image_id else {
        return Ok(false);
    };
    let Some(image) = library.get_image_by_id(image_id)? else {
        return Ok(false);
    };
    let Some(image_path) = image.path.as_deref().filter(|path| !path.is_empty()) else {
        return Ok(false);
    };
    let Ok(path) = one_library_relative_path(root, image_path) else {
        return Ok(false);
    };
    let Ok(data) = fs::read(path) else {
        return Ok(false);
    };
    Ok(cover_extension_and_mime(&data).is_ok())
}

/// 把音频内嵌封面变成 OneLibrary 的显式 image 记录。djay 浏览 OneLibrary 时只看
/// 这个关联，不会像 KDJ 自己的封面端点一样回退读取音频标签。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn export_embedded_cover(
    root: &Path,
    source: &Path,
    content_path: &str,
    library: &OneLibrary,
    created_files: &mut Vec<PathBuf>,
    warnings: &mut Vec<String>,
) -> Result<Option<i32>> {
    let Some((data, _)) = kdj_providers::tags::read_cover(source) else {
        return Ok(None);
    };
    let (extension, _) = match cover_extension_and_mime(&data) {
        Ok(kind) => kind,
        Err(_) => {
            warnings.push(format!(
                "已跳过非 JPEG/PNG 的内嵌封面：{}",
                source.display()
            ));
            return Ok(None);
        }
    };
    let hash = stable_hash(&[content_path.as_bytes(), &data]);
    let relative = PathBuf::from("Artwork")
        .join("KDJ")
        .join(format!("track-{hash:016x}.{extension}"));
    let db_path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
    let path = root.join(&relative);
    if path.exists() {
        anyhow::ensure!(
            fs::read(&path).is_ok_and(|current| current == data),
            "OneLibrary 封面路径发生哈希冲突：{}",
            path.display()
        );
    } else {
        let parent = path.parent().context("OneLibrary 封面目标缺少父目录")?;
        fs::create_dir_all(parent)?;
        let temp = path.with_extension(format!("{extension}.kdj-part"));
        let _ = fs::remove_file(&temp);
        fs::write(&temp, &data)?;
        fs::rename(&temp, &path)?;
        created_files.push(path);
    }
    let image = match library.get_image_by_path(&db_path)? {
        Some(image) => image,
        None => library.create_image(db_path)?,
    };
    Ok(Some(image.id))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn existing_kdj_content_paths(db_path: &Path) -> Result<HashMap<i64, String>> {
    if !db_path.is_file() {
        return Ok(HashMap::new());
    }
    let library = OneLibrary::new(db_path).context("OneLibrary 数据库无法读取")?;
    let mut selected: HashMap<i64, ((i32, i32, i32), String)> = HashMap::new();
    for content in library.get_contents()? {
        if !content
            .path
            .replace('\\', "/")
            .starts_with("/Contents/KDJ/")
        {
            continue;
        }
        let Some(local_id) = content.master_content_id.map(i64::from) else {
            continue;
        };
        // 旧版本可能在本地文件大小或路径变化后为同一 track id 插入重复 content。
        // 优先继续使用已被 djay 修改、修订号更高的原记录，避免新副本绕开其 Cue。
        let score = (
            content.has_modified.unwrap_or_default(),
            content
                .cue_update_count
                .unwrap_or_default()
                .saturating_add(content.analysis_data_update_count.unwrap_or_default())
                .saturating_add(content.information_update_count.unwrap_or_default()),
            -content.id,
        );
        match selected.entry(local_id) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((score, content.path));
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if score > entry.get().0 {
                    entry.insert((score, content.path));
                }
            }
        }
    }
    Ok(selected
        .into_iter()
        .map(|(id, (_, path))| (id, path))
        .collect())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn export_playlist_to_device(
    device: RemovableDevice,
    target_playlist_id: Option<i32>,
    playlist_name: &str,
    tracks: Vec<Track>,
    analysis_cache_dir: Option<&Path>,
) -> Result<PlaylistExportResult> {
    anyhow::ensure!(!tracks.is_empty(), "播放列表是空的，无法导出");
    let root = PathBuf::from(&device.path);
    let db_path = one_library_db(&root);
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    struct Prepared {
        track: Track,
        db_path: String,
        relative: PathBuf,
        file_size: u64,
        exported_file_size: u64,
        reuse_existing_audio: bool,
        file_type: i32,
        analysis: Option<LocalAnalysis>,
    }

    if db_path.is_file() {
        repair_djay_schema(&db_path)?;
        repair_missing_kdj_analysis_bundles(&db_path)?;
    }
    let existing_paths = existing_kdj_content_paths(&db_path)?;
    let mut prepared = Vec::new();
    let mut warnings = Vec::new();
    for track in tracks {
        let source = Path::new(&track.path);
        if !source.is_file() {
            warnings.push(format!("已跳过不存在的文件：{}", track.path));
            continue;
        }
        let kind = match file_type(source) {
            Ok(value) => value,
            Err(_) => {
                warnings.push(format!(
                    "已跳过 OneLibrary 不支持的格式：{}",
                    track.filename
                ));
                continue;
            }
        };
        let file_size = source.metadata()?.len();
        if file_size > i32::MAX as u64 {
            warnings.push(format!("已跳过超过 2 GB 的文件：{}", track.filename));
            continue;
        }
        let (database_path, relative, stable_existing_path) =
            if let Some(database_path) = existing_paths.get(&track.id) {
                let absolute = one_library_relative_path(&root, database_path)?;
                let relative = absolute
                    .strip_prefix(&root)
                    .context("OneLibrary 曲目路径不在存储根目录内")?
                    .to_path_buf();
                (database_path.clone(), relative, true)
            } else {
                let (database_path, relative) = usb_track_path(&track, file_size);
                (database_path, relative, false)
            };
        let destination_size = root
            .join(&relative)
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let reuse_existing_audio = stable_existing_path && destination_size.is_some();
        let analysis = analysis_cache_dir
            .and_then(|cache_dir| crate::waveform::load_cached_default(track.id, source, cache_dir))
            .and_then(|waveform| LocalAnalysis::from_local(&track, waveform));
        prepared.push(Prepared {
            track,
            db_path: database_path,
            relative,
            file_size,
            exported_file_size: destination_size.unwrap_or(file_size),
            reuse_existing_audio,
            file_type: kind,
            analysis,
        });
    }
    anyhow::ensure!(
        !prepared.is_empty(),
        "没有可写入 OneLibrary 的受支持音频文件"
    );

    let required: u64 = prepared
        .iter()
        .filter(|item| !root.join(&item.relative).is_file())
        .map(|item| item.file_size)
        .sum();
    anyhow::ensure!(
        required <= device.available_bytes,
        "U 盘空间不足：还需要约 {:.1} MB，可用约 {:.1} MB",
        required as f64 / 1_048_576.0,
        device.available_bytes as f64 / 1_048_576.0
    );

    let backup = backup_database(&db_path)?;
    let mut created_files = Vec::new();
    let mut replaced_files = Vec::new();
    let result = (|| -> Result<PlaylistExportResult> {
        let mut copied_tracks = 0usize;
        let mut reused_tracks = 0usize;
        let mut copied_bytes = 0u64;
        let mut exported_analysis = 0usize;
        for item in &prepared {
            let destination = root.join(&item.relative);
            if item.reuse_existing_audio
                || destination
                    .metadata()
                    .map(|meta| meta.len() == item.file_size)
                    .unwrap_or(false)
            {
                reused_tracks += 1;
            } else {
                copied_bytes += copy_atomic(Path::new(&item.track.path), &destination)?;
                copied_tracks += 1;
                created_files.push(destination);
            }
        }

        let library = open_or_create_library(&db_path)?;
        let existing_cues_by_content = one_library_cue_points(&library)?;
        let mut existing_content: HashMap<String, _> = library
            .get_contents()?
            .into_iter()
            .map(|content| (content.path.clone(), content))
            .collect();
        // 一次性把维表拉进内存。逐曲 get_*_by_name 会让 N 首歌产生约 4N 次
        // U 盘 SQLite 查询；低速 Windows 机器上这些随机读比音频顺序复制更卡。
        let mut artist_ids: HashMap<String, i32> = library
            .get_artists()?
            .into_iter()
            .map(|item| (item.name, item.id))
            .collect();
        let mut album_ids: HashMap<String, i32> = library
            .get_albums()?
            .into_iter()
            .map(|item| (item.name, item.id))
            .collect();
        let mut genre_ids: HashMap<String, i32> = library
            .get_genres()?
            .into_iter()
            .map(|item| (item.name, item.id))
            .collect();
        let mut key_ids: HashMap<String, i32> = library
            .get_keys()?
            .into_iter()
            .map(|item| (item.name, item.id))
            .collect();
        let mut content_ids = Vec::with_capacity(prepared.len());

        for item in &prepared {
            let artist_name = item.track.artist.trim();
            let artist_id = if artist_name.is_empty() {
                None
            } else if let Some(id) = artist_ids.get(artist_name) {
                Some(*id)
            } else {
                let id = library.create_artist(artist_name)?.id;
                artist_ids.insert(artist_name.to_owned(), id);
                Some(id)
            };
            let album_name = item.track.album.trim();
            let album_id = if album_name.is_empty() {
                None
            } else if let Some(id) = album_ids.get(album_name) {
                Some(*id)
            } else {
                let id = library.create_album(album_name, artist_id, None)?.id;
                album_ids.insert(album_name.to_owned(), id);
                Some(id)
            };
            let genre_name = item.track.genre.trim();
            let genre_id = if genre_name.is_empty() {
                None
            } else if let Some(id) = genre_ids.get(genre_name) {
                Some(*id)
            } else {
                let id = library.create_genre(genre_name)?.id;
                genre_ids.insert(genre_name.to_owned(), id);
                Some(id)
            };
            // OneLibrary 只存一份自由文本 key.name。统一写 djay 原生的 `F# M` / `F# m`
            // 形状；旧库里的 Camelot 或 KDJ 长音名都会在这个 IO 边界规范化。
            let key_name = one_library_key_name(&item.track.music_key, &item.track.camelot);
            let key_id = if key_name.is_empty() {
                None
            } else if let Some(id) = key_ids.get(&key_name) {
                Some(*id)
            } else {
                let id = library.create_key(&key_name)?.id;
                key_ids.insert(key_name, id);
                Some(id)
            };
            let title = if item.track.title.trim().is_empty() {
                item.track.filename.clone()
            } else {
                item.track.title.clone()
            };
            let release_year = item
                .track
                .year
                .get(..4)
                .and_then(|value| value.parse::<i32>().ok());
            let managed_cues = item
                .track
                .cue_points_managed
                .then_some(item.track.cue_points.as_slice());
            let (analysis_path, analysis_changed, has_local_analysis) =
                if let Some(local) = item.analysis.as_ref() {
                    let bundle = local.bundle_with_cues(
                        &item.db_path,
                        managed_cues.unwrap_or_default(),
                        item.track.bpm,
                    );
                    let database_path = bundle.database_path.clone();
                    let changed = write_analysis_bundle(
                        &root,
                        bundle,
                        managed_cues.is_none(),
                        &mut created_files,
                        &mut replaced_files,
                    )?;
                    exported_analysis += 1;
                    (database_path, changed, true)
                } else {
                    let bundle = AnalysisBundle::placeholder_with_cues(
                        &item.db_path,
                        managed_cues.unwrap_or_default(),
                        item.track.bpm,
                    );
                    let database_path = bundle.database_path.clone();
                    let changed = if managed_cues.is_some() {
                        write_analysis_bundle(
                            &root,
                            bundle,
                            false,
                            &mut created_files,
                            &mut replaced_files,
                        )?
                    } else {
                        write_missing_analysis_bundle(&root, bundle, &mut created_files)?
                    };
                    (database_path, changed, false)
                };
            let content_id = if let Some(mut content) = existing_content.remove(&item.db_path) {
                let previous = content.clone();
                if !one_library_image_is_readable(&root, &library, content.image_id)? {
                    content.image_id = export_embedded_cover(
                        &root,
                        Path::new(&item.track.path),
                        &item.db_path,
                        &library,
                        &mut created_files,
                        &mut warnings,
                    )?
                    .or(content.image_id);
                }
                content.title = Some(title);
                content.title_for_search = content.title.clone();
                content.bpmx100 = item.track.bpm.map(|value| (value * 100.0).round() as i32);
                content.length = item.track.duration.map(|value| value.round() as i32);
                content.artist_id = artist_id;
                content.album_id = album_id;
                content.genre_id = genre_id;
                content.key_id = key_id;
                content.dj_comment = Some(item.track.comment.clone());
                content.rating = Some(item.track.rating.clamp(0, 5) as i32);
                content.release_year = release_year;
                content.is_hot_cue_auto_load_on.get_or_insert(1);
                content.file_name = Some(item.track.filename.clone());
                content.file_size = Some(item.exported_file_size as i32);
                content.file_type = Some(item.file_type);
                content.bitrate = item.track.bitrate.map(|value| value as i32);
                content.sampling_rate = item.track.samplerate.map(|value| value as i32);
                content.analysis_data_file_path = Some(analysis_path.clone());
                if has_local_analysis {
                    content.analysed_bits = Some(41);
                    if analysis_changed {
                        content.analysis_data_update_count = Some(
                            content
                                .analysis_data_update_count
                                .unwrap_or_default()
                                .saturating_add(1),
                        );
                    }
                } else {
                    content.analysed_bits.get_or_insert(0);
                }
                if content.image_id != previous.image_id {
                    content.has_modified = Some(1);
                }
                if content == previous {
                    content.id
                } else {
                    content.information_update_count = Some(
                        content
                            .information_update_count
                            .unwrap_or_default()
                            .saturating_add(1),
                    );
                    library.update_content(content)?.id
                }
            } else {
                let image_id = export_embedded_cover(
                    &root,
                    Path::new(&item.track.path),
                    &item.db_path,
                    &library,
                    &mut created_files,
                    &mut warnings,
                )?;
                let mut content = NewContent::new(item.db_path.clone());
                content.title = Some(title.clone());
                content.title_for_search = Some(title);
                content.bpmx100 = item.track.bpm.map(|value| (value * 100.0).round() as i32);
                content.length = item.track.duration.map(|value| value.round() as i32);
                content.artist_id = artist_id;
                content.album_id = album_id;
                content.genre_id = genre_id;
                content.key_id = key_id;
                content.image_id = image_id;
                content.dj_comment = Some(item.track.comment.clone());
                content.rating = Some(item.track.rating.clamp(0, 5) as i32);
                content.release_year = release_year;
                content.is_hot_cue_auto_load_on = Some(1);
                content.file_name = Some(item.track.filename.clone());
                content.file_size = Some(item.exported_file_size as i32);
                content.file_type = Some(item.file_type);
                content.bitrate = item.track.bitrate.map(|value| value as i32);
                content.sampling_rate = item.track.samplerate.map(|value| value as i32);
                content.master_db_id = Some(0);
                content.master_content_id = i32::try_from(item.track.id).ok();
                content.analysis_data_file_path = Some(analysis_path);
                content.analysed_bits = Some(if has_local_analysis { 41 } else { 0 });
                content.content_link = Some(ONE_LIBRARY_CONTENT_LINK);
                content.has_modified = Some(0);
                library.insert_content(content)?.id
            };
            if let Some(cues) = managed_cues {
                let existing = existing_cues_by_content
                    .get(&content_id)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if analysis_changed || !managed_cues_equal(existing, cues) {
                    replace_one_library_cues(&db_path, content_id, cues, item.track.bpm)?;
                }
            }
            content_ids.push(content_id);
        }

        let target_playlist = if let Some(id) = target_playlist_id {
            let playlist = library
                .get_playlist_by_id(id)?
                .context("OneLibrary 列表不存在")?;
            anyhow::ensure!(playlist.attribute == 0, "不能把曲目写入 OneLibrary 文件夹");
            playlist
        } else {
            match library
                .get_playlists()?
                .into_iter()
                .find(|candidate| candidate.parent_id == 0 && candidate.name == playlist_name)
            {
                Some(playlist) => playlist,
                None => library.create_playlist(playlist_name, None, None)?,
            }
        };
        let mut linked: std::collections::HashSet<i32> = library
            .get_playlist_contents(target_playlist.id)?
            .into_iter()
            .map(|content| content.id)
            .collect();
        for content_id in &content_ids {
            if linked.insert(*content_id) {
                library.create_playlist_content(target_playlist.id, *content_id, None)?;
            }
        }
        drop(library);
        normalize_playlist_content_sequences(&db_path)?;

        let m3u_entries: Vec<(Track, PathBuf)> = prepared
            .iter()
            .map(|item| (item.track.clone(), item.relative.clone()))
            .collect();
        write_m3u(&root, playlist_name, &m3u_entries)?;

        if let Some(path) = &backup {
            warnings.push(format!("写入前的数据库备份保存在 {}", path.display()));
        }
        Ok(PlaylistExportResult {
            playlist_id: i64::from(target_playlist.id),
            playlist_name: playlist_name.to_owned(),
            device_path: device.path.clone(),
            copied_tracks,
            reused_tracks,
            skipped_tracks: warnings
                .iter()
                .filter(|message| message.starts_with("已跳过"))
                .count(),
            copied_bytes,
            database_path: db_path.to_string_lossy().into_owned(),
            analysis_note: if exported_analysis == prepared.len() {
                format!(
                    "已复用 {exported_analysis} 首本地分析并写入 OneLibrary 波形、beatgrid、BPM 与 Key；目标软件无需重新分析这些曲目。"
                )
            } else if exported_analysis > 0 {
                format!(
                    "已复用 {exported_analysis} 首本地分析并写入 OneLibrary 波形、beatgrid、BPM 与 Key；其余未具备完整缓存的曲目由目标软件按需分析。"
                )
            } else {
                "未找到可完整复用的本地分析缓存；目标软件会按原有流程分析这些曲目。".to_owned()
            },
            warnings,
        })
    })();

    if result.is_err() {
        restore_database(&db_path, backup.as_deref());
        for path in created_files {
            let _ = fs::remove_file(path);
        }
        for (path, body) in replaced_files.into_iter().rev() {
            let _ = fs::write(path, body);
        }
    }
    result
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn add_one_library_playlist_tracks(
    requested_device: &str,
    playlist_id: i32,
    tracks: Vec<Track>,
    analysis_cache_dir: Option<&Path>,
) -> Result<PlaylistExportResult> {
    let device = checked_device(requested_device)?;
    let db_path = one_library_db(Path::new(&device.path));
    anyhow::ensure!(db_path.is_file(), "这个存储上还没有 OneLibrary");
    let library = OneLibrary::new(&db_path).context("OneLibrary 数据库无法读取")?;
    let playlist = library
        .get_playlist_by_id(playlist_id)?
        .context("OneLibrary 列表不存在")?;
    anyhow::ensure!(playlist.attribute == 0, "不能把曲目写入 OneLibrary 文件夹");
    let name = playlist.name;
    drop(library);
    export_playlist_to_device(device, Some(playlist_id), &name, tracks, analysis_cache_dir)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn one_library_capacity_plan(
    requested_device: &str,
    tracks: &[Track],
) -> Result<OneLibraryCapacityPlan> {
    let device = checked_device(requested_device)?;
    let root = Path::new(&device.path);
    let existing_paths = existing_kdj_content_paths(&one_library_db(root))?;
    let mut seen = std::collections::HashSet::new();
    let mut required_bytes = 16 * 1024 * 1024u64; // SQLite/WAL、M3U 与目录结构余量。
    for track in tracks {
        let source = Path::new(&track.path);
        if !source.is_file() || !seen.insert(track.id) {
            continue;
        }
        let file_size = source.metadata()?.len();
        let destination = if let Some(path) = existing_paths.get(&track.id) {
            one_library_relative_path(root, path)?
        } else {
            let (_, relative) = usb_track_path(track, file_size);
            root.join(relative)
        };
        if !destination.is_file() {
            required_bytes = required_bytes.saturating_add(file_size);
        }
    }
    Ok(OneLibraryCapacityPlan {
        required_bytes,
        available_bytes: device.available_bytes,
        sufficient: required_bytes <= device.available_bytes,
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn one_library_playlists(_requested_device: &str) -> Result<Vec<OneLibraryPlaylist>> {
    Ok(Vec::new())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn one_library_cover(_requested_device: &str, _content_id: i32) -> Result<(Vec<u8>, String)> {
    anyhow::bail!("移动端暂不支持读取 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn one_library_content_file(
    _requested_device: &str,
    _content_id: i32,
) -> Result<OneLibraryContentFile> {
    anyhow::bail!("移动端暂不支持读取 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn set_one_library_cover(
    _requested_device: &str,
    _content_id: i32,
    _data: &[u8],
) -> Result<Option<i64>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn set_one_library_rating(
    _requested_device: &str,
    _content_id: i32,
    _rating: i32,
) -> Result<Option<i64>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn sync_local_rating_to_one_libraries(_local_track_id: i64, _rating: i32) -> Result<()> {
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn sync_local_cover_to_one_libraries(_local_track_id: i64, _data: &[u8]) -> Result<()> {
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn one_library_playlist_tracks(
    _requested_device: &str,
    _playlist_id: i32,
) -> Result<Vec<OneLibraryTrack>> {
    Ok(Vec::new())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn move_one_library_playlist(
    _requested_device: &str,
    _playlist_id: i32,
    _parent_id: i32,
    _sequence: Option<i32>,
) -> Result<Vec<OneLibraryPlaylist>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn copy_one_library_playlist_tracks(
    _source_device_path: &str,
    _source_playlist_id: i32,
    _target_device_path: &str,
    _target_playlist_id: i32,
    _content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn reorder_one_library_playlist_tracks(
    _requested_device: &str,
    _playlist_id: i32,
    _content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn remove_one_library_playlist_tracks(
    _requested_device: &str,
    _playlist_id: i32,
    _content_ids: Vec<i32>,
) -> Result<Vec<OneLibraryTrack>> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn create_one_library_playlist(
    _requested_device: &str,
    _name: &str,
    _parent_id: Option<i32>,
    _folder: bool,
) -> Result<OneLibraryPlaylist> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn rename_one_library_playlist(
    _requested_device: &str,
    _playlist_id: i32,
    _name: &str,
) -> Result<()> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn delete_one_library_playlist(_requested_device: &str, _playlist_id: i32) -> Result<()> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn add_one_library_playlist_tracks(
    _requested_device: &str,
    _playlist_id: i32,
    _tracks: Vec<Track>,
    _analysis_cache_dir: Option<&Path>,
) -> Result<PlaylistExportResult> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn one_library_capacity_plan(
    _requested_device: &str,
    _tracks: &[Track],
) -> Result<OneLibraryCapacityPlan> {
    anyhow::bail!("移动端暂不支持写入 OneLibrary")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_keys_use_djay_notation_without_dropping_unknown_modes() {
        assert_eq!(one_library_key_name("F# major", "2B"), "F# M");
        assert_eq!(one_library_key_name("", "11A"), "F# m");
        assert_eq!(one_library_key_name("custom mode", ""), "custom mode");
    }

    #[test]
    fn waveform_cache_identity_survives_a_mount_path_change() {
        let first = one_library_content_file_snapshot(
            Path::new("/Volumes/KDJ"),
            true,
            42,
            "/Contents/KDJ/song.mp3",
            Some(12_345),
            PathBuf::from("/Volumes/KDJ/Contents/KDJ/song.mp3"),
        );
        let remounted = one_library_content_file_snapshot(
            Path::new("/Volumes/SET"),
            true,
            42,
            "/Contents/KDJ/song.mp3",
            Some(12_345),
            PathBuf::from("/Volumes/SET/Contents/KDJ/song.mp3"),
        );
        assert_eq!(first.cache_id, remounted.cache_id);
        assert_ne!(first.legacy_cache_id, remounted.legacy_cache_id);
        assert_eq!(
            remounted.portable_waveform_dir,
            Some(PathBuf::from("/Volumes/SET/.kdj/onelibrary-waveform"))
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[derive(diesel::QueryableByName)]
    struct PlaylistContentSequence {
        #[diesel(sql_type = diesel::sql_types::Integer)]
        sequence_no: i32,
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn playlist_content_sequences(db_path: &Path, playlist_id: i32) -> Vec<i32> {
        let mut conn = rbox::one_library::establish_connection(db_path.to_str().unwrap()).unwrap();
        diesel::sql_query(
            "SELECT sequenceNo AS sequence_no FROM playlist_content \
             WHERE playlist_id = ? ORDER BY sequenceNo, content_id",
        )
        .bind::<diesel::sql_types::Integer, _>(playlist_id)
        .load::<PlaylistContentSequence>(&mut conn)
        .unwrap()
        .into_iter()
        .map(|row| row.sequence_no)
        .collect()
    }

    fn test_wav_bytes() -> Vec<u8> {
        const RATE: u32 = 8_000;
        let data_len = RATE * 2;
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
        data
    }

    fn test_png_bytes() -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        png.extend_from_slice(&[
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
        ]);
        png.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]);
        png
    }

    #[test]
    fn sanitizes_cross_platform_path_characters() {
        assert_eq!(safe_component("  A/B:C?.mp3  ", "x"), "A_B_C_.mp3");
        assert_eq!(safe_component("...", "Playlist"), "Playlist");
    }

    #[test]
    fn file_system_allowlist_matches_onelibrary_desktop_contract() {
        for value in ["exFAT", "FAT32", "vfat", "HFS+"] {
            assert!(supported_file_system(value), "{value}");
        }
        for value in ["NTFS", "APFS", "ext4", ""] {
            assert!(!supported_file_system(value), "{value}");
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn read_snapshot_cache_invalidates_for_database_and_wal_changes() {
        let root = std::env::temp_dir().join(format!(
            "kdj-onelibrary-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("exportLibrary.db");
        std::fs::write(&db_path, b"db").unwrap();
        let first = one_library_revision(&db_path);
        update_read_cache(&db_path, first, |entry| {
            entry.playlists = Some(vec![OneLibraryPlaylist {
                id: 7,
                ..OneLibraryPlaylist::default()
            }]);
        });
        assert_eq!(cached_playlists(&db_path, first).unwrap()[0].id, 7);

        std::fs::write(&db_path, b"database changed").unwrap();
        let database_changed = one_library_revision(&db_path);
        assert_ne!(database_changed, first);
        assert!(cached_playlists(&db_path, database_changed).is_none());

        update_read_cache(&db_path, database_changed, |entry| {
            entry.playlists = Some(Vec::new());
        });
        std::fs::write(format!("{}-wal", db_path.to_string_lossy()), b"wal").unwrap();
        let wal_changed = one_library_revision(&db_path);
        assert_ne!(wal_changed, database_changed);
        assert!(cached_playlists(&db_path, wal_changed).is_none());

        invalidate_one_library_read_cache(&db_path);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn usb_track_path_is_stable_and_root_relative() {
        let track = Track {
            path: "/Music/A.mp3".into(),
            filename: "A.mp3".into(),
            ..Track::default()
        };
        let first = usb_track_path(&track, 42);
        let second = usb_track_path(&track, 42);
        assert_eq!(first, second);
        assert!(first.0.starts_with("/Contents/KDJ/"));
        assert!(!first.1.is_absolute());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn reads_standard_one_library_memory_hot_and_loop_cues() {
        let root = std::env::temp_dir().join(format!(
            "kdj-one-cues-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db_path = one_library_db(&root);
        let library = open_or_create_library(&db_path).unwrap();
        let content = library
            .insert_content(NewContent::new("/Contents/song.mp3"))
            .unwrap();
        drop(library);

        let mut conn = rbox::one_library::establish_connection(db_path.to_str().unwrap()).unwrap();
        diesel::sql_query(
            "INSERT INTO cue (cue_id, content_id, kind, colorTableIndex, cueComment, \
             isActiveLoop, inUsec, outUsec, in150FramePerSec, out150FramePerSec) \
             VALUES (1, ?, 2, 7, 'Drop', 1, 1234567, 3000000, NULL, NULL)",
        )
        .bind::<diesel::sql_types::Integer, _>(content.id)
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO cue (cue_id, content_id, kind, colorTableIndex, cueComment, \
             isActiveLoop, inUsec, outUsec, in150FramePerSec, out150FramePerSec) \
             VALUES (2, ?, 0, NULL, NULL, 0, NULL, -1, 300, -1)",
        )
        .bind::<diesel::sql_types::Integer, _>(content.id)
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        let library = OneLibrary::new(&db_path).unwrap();
        let points = one_library_cue_points(&library).unwrap();
        assert_eq!(
            points.get(&content.id).unwrap(),
            &vec![
                CuePoint {
                    id: 1,
                    hot_cue: Some(2),
                    start_ms: 1_235,
                    end_ms: Some(3_000),
                    color_index: Some(7),
                    color: "Blue".into(),
                    comment: "Drop".into(),
                    active_loop: true,
                },
                CuePoint {
                    id: 2,
                    hot_cue: None,
                    start_ms: 2_000,
                    end_ms: None,
                    color_index: None,
                    color: String::new(),
                    comment: String::new(),
                    active_loop: false,
                },
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn repairs_missing_kdj_analysis_path_or_files_with_a_writable_cue_bundle() {
        let root = std::env::temp_dir().join(format!(
            "kdj-one-cue-bundle-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db_path = one_library_db(&root);
        let library = open_or_create_library(&db_path).unwrap();
        let content = library
            .insert_content(NewContent::new("/Contents/KDJ/song.mp3"))
            .unwrap();
        let missing_files_bundle = AnalysisBundle::placeholder("/Contents/KDJ/missing-files.mp3");
        let mut missing_files = NewContent::new("/Contents/KDJ/missing-files.mp3");
        missing_files.analysis_data_file_path = Some(missing_files_bundle.database_path.clone());
        let missing_files = library.insert_content(missing_files).unwrap();
        drop(library);

        repair_djay_schema(&db_path).unwrap();
        assert!(repair_missing_kdj_analysis_bundles(&db_path).unwrap());
        let library = OneLibrary::new(&db_path).unwrap();
        let repaired = library.get_content_by_id(content.id).unwrap().unwrap();
        let dat = repaired
            .analysis_data_file_path
            .as_deref()
            .expect("旧曲目必须得到 Cue 存储路径");
        assert_eq!(repaired.analysed_bits, Some(0));
        let directory = root
            .join(dat.trim_start_matches('/'))
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(directory.join("ANLZ0000.DAT").is_file());
        assert!(directory.join("ANLZ0000.EXT").is_file());
        assert!(directory.join("ANLZ0000.2EX").is_file());
        let repaired_files = library
            .get_content_by_id(missing_files.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            repaired_files.analysis_data_file_path,
            Some(missing_files_bundle.database_path)
        );
        for file in missing_files_bundle.files {
            assert!(root.join(file.relative_path).is_file());
        }
        drop(library);
        assert!(!repair_missing_kdj_analysis_bundles(&db_path).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn repairs_old_kdj_rows_without_overriding_an_explicit_hot_cue_setting() {
        let root = std::env::temp_dir().join(format!(
            "kdj-one-cue-autoload-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db_path = one_library_db(&root);
        let library = open_or_create_library(&db_path).unwrap();
        let content = library
            .insert_content(NewContent::new("/Contents/KDJ/song.mp3"))
            .unwrap();
        drop(library);
        let mut conn = rbox::one_library::establish_connection(db_path.to_str().unwrap()).unwrap();
        diesel::sql_query(
            "INSERT INTO cue (cue_id, content_id, kind, isActiveLoop, inUsec, outUsec) \
             VALUES (1, ?, 1, 1, 1000000, 2000000)",
        )
        .bind::<diesel::sql_types::Integer, _>(content.id)
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        assert!(repair_djay_schema(&db_path).unwrap());
        let library = OneLibrary::new(&db_path).unwrap();
        let repaired = library.get_content_by_id(content.id).unwrap().unwrap();
        assert_eq!(repaired.is_hot_cue_auto_load_on, Some(1));
        assert_eq!(repaired.master_db_id, Some(0));
        assert_eq!(repaired.content_link, Some(ONE_LIBRARY_CONTENT_LINK));
        assert_eq!(repaired.cue_update_count, None);
        assert_eq!(repaired.analysis_data_update_count, None);
        assert_eq!(repaired.information_update_count, None);
        assert_eq!(library.get_cues().unwrap().len(), 1, "修复不能删除已有 Cue");

        let mut disabled = repaired;
        disabled.is_hot_cue_auto_load_on = Some(0);
        disabled.content_link = Some(853_760);
        disabled.cue_update_count = Some(1);
        library.update_content(disabled).unwrap();
        drop(library);
        invalidate_one_library_schema_cache(&db_path);
        assert!(!repair_djay_schema(&db_path).unwrap());
        let library = OneLibrary::new(&db_path).unwrap();
        let unchanged = library.get_content_by_id(content.id).unwrap().unwrap();
        assert_eq!(unchanged.is_hot_cue_auto_load_on, Some(0));
        assert_eq!(unchanged.content_link, Some(853_760));
        assert_eq!(unchanged.cue_update_count, Some(1));
        drop(library);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn one_library_content_paths_cannot_escape_the_device_root() {
        let base = std::env::temp_dir().join(format!(
            "kdj-one-path-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        let inside = root.join("Contents/song.mp3");
        fs::create_dir_all(inside.parent().unwrap()).unwrap();
        fs::write(&inside, b"audio").unwrap();

        assert!(one_library_relative_path(&root, "../outside.mp3").is_err());
        assert_eq!(
            one_library_existing_path(&root, "/Contents/song.mp3").unwrap(),
            inside.canonicalize().unwrap()
        );

        #[cfg(unix)]
        {
            let outside = base.join("outside");
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("song.mp3"), b"outside").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            assert!(
                one_library_existing_path(&root, "/linked/song.mp3").is_err(),
                "卷内符号链接也不能把波形/封面读取带到卷外"
            );
        }
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn one_library_cover_updates_audio_and_database_image_together() {
        let root = std::env::temp_dir().join(format!(
            "kdj-one-cover-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let audio_relative = PathBuf::from("Contents/KDJ/song.wav");
        let audio = root.join(&audio_relative);
        fs::create_dir_all(audio.parent().unwrap()).unwrap();
        fs::write(&audio, test_wav_bytes()).unwrap();
        let db_path = one_library_db(&root);
        let library = open_or_create_library(&db_path).unwrap();
        let mut content = NewContent::new(format!(
            "/{}",
            audio_relative.to_string_lossy().replace('\\', "/")
        ));
        content.file_name = Some("song.wav".into());
        let content = library.insert_content(content).unwrap();
        drop(library);

        let png = test_png_bytes();
        set_one_library_cover_at_root(&root, content.id, &png).unwrap();
        assert_eq!(kdj_providers::tags::read_cover(&audio).unwrap().0, png);
        let library = OneLibrary::new(&db_path).unwrap();
        let written = library.get_content_by_id(content.id).unwrap().unwrap();
        let image = library
            .get_image_by_id(written.image_id.expect("content 应关联 image"))
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(one_library_relative_path(&root, image.path.as_deref().unwrap()).unwrap())
                .unwrap(),
            png
        );
        assert_eq!(written.has_modified, Some(1));
        drop(library);

        let before = fs::read(&audio).unwrap();
        assert!(set_one_library_cover_at_root(&root, content.id, b"GIF89a").is_err());
        assert_eq!(
            fs::read(&audio).unwrap(),
            before,
            "非法图片不能碰音频或数据库"
        );

        let library = OneLibrary::new(&db_path).unwrap();
        let image_id_before = library
            .get_content_by_id(content.id)
            .unwrap()
            .unwrap()
            .image_id;
        drop(library);
        fs::remove_dir_all(root.join("Artwork")).unwrap();
        fs::write(root.join("Artwork"), b"not-a-directory").unwrap();
        let mut alternate_png = png.clone();
        alternate_png.push(0);
        assert!(set_one_library_cover_at_root(&root, content.id, &alternate_png).is_err());
        assert_eq!(
            fs::read(&audio).unwrap(),
            before,
            "数据库侧失败时必须恢复音频文件"
        );
        let library = OneLibrary::new(&db_path).unwrap();
        assert_eq!(
            library
                .get_content_by_id(content.id)
                .unwrap()
                .unwrap()
                .image_id,
            image_id_before,
            "失败不能留下新的 content.image_id"
        );
        drop(library);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn portable_export_links_embedded_cover_for_new_and_reused_content() {
        let base = std::env::temp_dir().join(format!(
            "kdj-export-cover-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        fs::create_dir_all(&root).unwrap();
        let source = base.join("song.wav");
        fs::write(&source, test_wav_bytes()).unwrap();
        let png = test_png_bytes();
        kdj_providers::tags::write_cover(&source, &png).unwrap();
        let track = Track {
            id: 77,
            path: source.to_string_lossy().into_owned(),
            filename: "song.wav".into(),
            title: "Cover Song".into(),
            ..Track::default()
        };
        let device = RemovableDevice {
            path: root.to_string_lossy().into_owned(),
            name: "Test USB".into(),
            file_system: "exFAT".into(),
            available_bytes: 4 * 1024 * 1024,
            one_library_file_system: true,
            ..RemovableDevice::default()
        };

        let exported =
            export_playlist_to_device(device.clone(), None, "Covers", vec![track.clone()], None)
                .unwrap();
        let db_path = one_library_db(&root);
        let library = OneLibrary::new(&db_path).unwrap();
        let mut content = library
            .get_playlist_contents(exported.playlist_id as i32)
            .unwrap()
            .remove(0);
        let image = library
            .get_image_by_id(content.image_id.expect("首次导出应关联封面"))
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(one_library_relative_path(&root, image.path.as_deref().unwrap()).unwrap())
                .unwrap(),
            png
        );

        content.image_id = None;
        library.update_content(content).unwrap();
        drop(library);
        export_playlist_to_device(device, None, "Covers", vec![track], None).unwrap();
        let library = OneLibrary::new(&db_path).unwrap();
        let repaired = library.get_contents().unwrap().remove(0);
        assert!(repaired.image_id.is_some(), "增量复用也应补回 image 关联");
        drop(library);
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn one_library_rating_updates_only_the_database_content() {
        let root = std::env::temp_dir().join(format!(
            "kdj-one-rating-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db_path = one_library_db(&root);
        let library = open_or_create_library(&db_path).unwrap();
        let content = library
            .insert_content(NewContent::new("/Contents/KDJ/song.mp3"))
            .unwrap();
        drop(library);

        set_one_library_rating_at_root(&root, content.id, 4).unwrap();
        let library = OneLibrary::new(&db_path).unwrap();
        let written = library.get_content_by_id(content.id).unwrap().unwrap();
        assert_eq!(written.rating, Some(4));
        assert_eq!(written.has_modified, Some(1));
        drop(library);
        assert!(set_one_library_rating_at_root(&root, content.id, 6).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identical_m3u_is_not_rewritten() {
        let root = std::env::temp_dir().join(format!("kdj-m3u-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let playlist_name = "Set";
        let entries = vec![(
            Track {
                title: "Song".into(),
                artist: "Artist".into(),
                duration: Some(120.0),
                ..Default::default()
            },
            PathBuf::from("Contents/KDJ/song.mp3"),
        )];
        write_m3u(&root, playlist_name, &entries).unwrap();
        let path = root.join("KDJ/Playlists/Set.m3u8");
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        write_m3u(&root, playlist_name, &entries).unwrap();
        assert_eq!(before, fs::metadata(path).unwrap().modified().unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn portable_export_creates_a_readable_encrypted_onelibrary() {
        let base = std::env::temp_dir().join(format!(
            "kdj-onelibrary-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        fs::create_dir_all(&root).unwrap();
        let source = base.join("source.mp3");
        fs::write(&source, b"not-real-audio-but-valid-export-payload").unwrap();
        let track = Track {
            id: 42,
            path: source.to_string_lossy().into_owned(),
            filename: "source.mp3".into(),
            title: "Test Track".into(),
            artist: "KDJ".into(),
            album: "Interop".into(),
            genre: "House".into(),
            music_key: "Am".into(),
            bpm: Some(128.0),
            duration: Some(120.0),
            bitrate: Some(320),
            samplerate: Some(44_100),
            ..Default::default()
        };
        let device = RemovableDevice {
            path: root.to_string_lossy().into_owned(),
            name: "Test USB".into(),
            file_system: "exFAT".into(),
            available_bytes: 1024 * 1024,
            one_library_file_system: true,
            ..Default::default()
        };

        let export_name = "KDJ · Software Set";
        let first =
            export_playlist_to_device(device.clone(), None, export_name, vec![track.clone()], None)
                .expect("首次导出");
        assert_eq!(first.copied_tracks, 1);
        assert_eq!(first.reused_tracks, 0);
        assert!(Path::new(&first.database_path).is_file());
        assert!(root.join("KDJ/Playlists/KDJ · Software Set.m3u8").is_file());

        let library = OneLibrary::new(one_library_db(&root)).expect("rbox 应能重新打开导出库");
        let playlists = library.get_playlists().unwrap();
        let exported = playlists
            .iter()
            .find(|item| item.name == "KDJ · Software Set")
            .expect("导出的播放列表");
        let contents = library.get_playlist_contents(exported.id).unwrap();
        assert_eq!(contents.len(), 1);
        let original_content_id = contents[0].id;
        let original_content_path = contents[0].path.clone();
        assert_eq!(contents[0].title.as_deref(), Some("Test Track"));
        assert_eq!(contents[0].bpmx100, Some(12_800));
        assert!(contents[0].path.starts_with("/Contents/KDJ/"));
        let placeholder_path = contents[0]
            .analysis_data_file_path
            .as_deref()
            .expect("未分析曲目也必须预留 Cue 存储");
        assert!(root
            .join(placeholder_path.trim_start_matches('/'))
            .is_file());
        assert_eq!(contents[0].analysed_bits, Some(0));
        assert_eq!(contents[0].is_hot_cue_auto_load_on, Some(1));
        assert_eq!(contents[0].master_db_id, Some(0));
        assert_eq!(contents[0].content_link, Some(ONE_LIBRARY_CONTENT_LINK));
        assert_eq!(contents[0].cue_update_count, None);
        assert_eq!(contents[0].analysis_data_update_count, None);
        assert_eq!(contents[0].information_update_count, None);
        drop(library);

        // 音频标签编辑会改变文件大小；track id 没变时仍必须复用原 content 与
        // 原 ANLZ 路径，否则 djay 保存的 Cue 会留在旧副本上。
        fs::write(
            &source,
            b"not-real-audio-but-valid-export-payload-after-tag-edit",
        )
        .unwrap();
        let second = export_playlist_to_device(device, None, export_name, vec![track], None)
            .expect("增量导出");
        assert_eq!(second.copied_tracks, 0);
        assert_eq!(second.reused_tracks, 1);
        assert!(second
            .warnings
            .iter()
            .any(|warning| warning.contains("数据库备份")));
        let library = OneLibrary::new(one_library_db(&root)).expect("增量写入后数据库仍可读");
        let exported = library
            .get_playlists()
            .unwrap()
            .into_iter()
            .find(|item| item.name == export_name)
            .unwrap();
        let contents = library.get_playlist_contents(exported.id).unwrap();
        assert_eq!(
            contents.len(),
            1,
            "重复拖入必须复用 playlist_content，不能在 OneLibrary 中复制条目"
        );
        assert_eq!(contents[0].id, original_content_id);
        assert_eq!(contents[0].path, original_content_path);
        assert_eq!(library.get_contents().unwrap().len(), 1);
        drop(library);
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn portable_export_round_trips_managed_hot_loops_and_explicit_clear() {
        let base = std::env::temp_dir().join(format!(
            "kdj-onelibrary-cue-export-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        fs::create_dir_all(&root).unwrap();
        let source = base.join("cues.mp3");
        fs::write(&source, b"cue-export-payload").unwrap();
        let cues = vec![CuePoint {
            id: -2,
            hot_cue: Some(2),
            start_ms: 4_000,
            end_ms: Some(8_000),
            color_index: Some(2),
            color: "red".into(),
            comment: "Drop".into(),
            active_loop: true,
        }];
        let mut track = Track {
            id: 92,
            path: source.to_string_lossy().into_owned(),
            filename: "cues.mp3".into(),
            title: "Managed Cues".into(),
            duration: Some(120.0),
            cue_points: cues.clone(),
            cue_points_managed: true,
            ..Track::default()
        };
        let device = RemovableDevice {
            path: root.to_string_lossy().into_owned(),
            name: "Test USB".into(),
            file_system: "exFAT".into(),
            available_bytes: 1024 * 1024,
            one_library_file_system: true,
            ..RemovableDevice::default()
        };

        export_playlist_to_device(device.clone(), None, "Cues", vec![track.clone()], None).unwrap();
        let db_path = one_library_db(&root);
        let library = OneLibrary::new(&db_path).unwrap();
        let content = library.get_contents().unwrap().remove(0);
        let exported = one_library_cue_points(&library).unwrap();
        assert!(managed_cues_equal(
            exported.get(&content.id).unwrap(),
            &cues
        ));
        assert_eq!(content.cue_update_count, Some(1));
        let analysis_path = content.analysis_data_file_path.unwrap();
        drop(library);
        let dat = fs::read(root.join(analysis_path.trim_start_matches('/'))).unwrap();
        let hot = dat
            .windows(24)
            .position(|window| window.starts_with(b"PCOB") && window[15] == 1)
            .unwrap();
        assert_eq!(
            u16::from_be_bytes(dat[hot + 18..hot + 20].try_into().unwrap()),
            1
        );
        assert_eq!(&dat[hot + 24..hot + 28], b"PCPT");

        track.cue_points.clear();
        export_playlist_to_device(device, None, "Cues", vec![track], None).unwrap();
        let library = OneLibrary::new(&db_path).unwrap();
        let content = library.get_contents().unwrap().remove(0);
        assert!(one_library_cue_points(&library)
            .unwrap()
            .get(&content.id)
            .is_none_or(Vec::is_empty));
        assert_eq!(content.cue_update_count, Some(2));
        drop(library);
        let dat = fs::read(root.join(analysis_path.trim_start_matches('/'))).unwrap();
        let hot = dat
            .windows(24)
            .position(|window| window.starts_with(b"PCOB") && window[15] == 1)
            .unwrap();
        assert_eq!(
            u16::from_be_bytes(dat[hot + 18..hot + 20].try_into().unwrap()),
            0
        );
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn portable_export_reuses_cached_local_analysis_without_decoding_audio() {
        let base = std::env::temp_dir().join(format!(
            "kdj-onelibrary-analysis-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        let cache = base.join("waveform");
        fs::create_dir_all(&root).unwrap();
        let source = base.join("cached.mp3");
        // 刻意不是可解码音频：测试若通过，就能证明拖放只读缓存，没有暗中重分析。
        fs::write(&source, b"cached-analysis-only").unwrap();
        let track = Track {
            id: 77,
            path: source.to_string_lossy().into_owned(),
            filename: "cached.mp3".into(),
            title: "Cached Analysis".into(),
            artist: "KDJ".into(),
            bpm: Some(124.0),
            first_beat: Some(0.125),
            music_key: "Gm".into(),
            duration: Some(4.0),
            analyzed_at: Some("2026-01-01T00:00:00Z".into()),
            ..Track::default()
        };
        crate::waveform::write_cached_default_for_test(
            track.id,
            &source,
            &cache,
            &kdj_core::models::Waveform {
                track_id: track.id,
                duration: 4.0,
                amp: vec![0.0, 0.4, 1.0, 0.3],
                r: vec![0, 255, 64, 32],
                g: vec![0, 64, 255, 64],
                b: vec![0, 32, 64, 255],
            },
        )
        .unwrap();
        let device = RemovableDevice {
            path: root.to_string_lossy().into_owned(),
            name: "Test USB".into(),
            file_system: "exFAT".into(),
            available_bytes: 1024 * 1024,
            one_library_file_system: true,
            ..Default::default()
        };

        let result = export_playlist_to_device(
            device.clone(),
            None,
            "Analyzed",
            vec![track.clone()],
            Some(&cache),
        )
        .unwrap();
        assert!(result.analysis_note.contains("无需重新分析"));

        let library = OneLibrary::new(one_library_db(&root)).unwrap();
        let content = library.get_contents().unwrap().pop().unwrap();
        let analysis_path = content.analysis_data_file_path.expect("应关联本地分析文件");
        assert_eq!(content.analysed_bits, Some(41));
        assert_eq!(content.is_hot_cue_auto_load_on, Some(1));
        assert_eq!(content.master_db_id, Some(0));
        assert_eq!(content.content_link, Some(ONE_LIBRARY_CONTENT_LINK));
        assert_eq!(content.cue_update_count, None);
        assert_eq!(content.analysis_data_update_count, None);
        assert_eq!(content.information_update_count, None);
        assert!(root.join(analysis_path.trim_start_matches('/')).is_file());
        let directory = root
            .join(analysis_path.trim_start_matches('/'))
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(directory.join("ANLZ0000.EXT").is_file());
        assert!(directory.join("ANLZ0000.2EX").is_file());
        drop(library);

        // 模拟 djay 把 Hot Cue 写入现有 PCOB。增量导出只能更新波形/beatgrid，
        // 不能把这个外部 Cue 段重新写成空列表。
        let dat_path = directory.join("ANLZ0000.DAT");
        let mut external = fs::read(&dat_path).unwrap();
        let hot_cue = external
            .windows(4)
            .position(|window| window == b"PCOB")
            .expect("DAT 应包含 Hot Cue PCOB");
        assert_eq!(
            u32::from_be_bytes(external[hot_cue + 12..hot_cue + 16].try_into().unwrap()),
            1
        );
        external[hot_cue + 18..hot_cue + 20].copy_from_slice(&1u16.to_be_bytes());
        fs::write(&dat_path, &external).unwrap();

        export_playlist_to_device(device, None, "Analyzed", vec![track], Some(&cache)).unwrap();
        let preserved = fs::read(&dat_path).unwrap();
        assert_eq!(
            &preserved[hot_cue..hot_cue + 24],
            &external[hot_cue..hot_cue + 24],
            "再次导出必须保留 djay 写入的 Cue 段"
        );
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn one_library_writes_djay_compatible_playlist_content_sequences() {
        let base = std::env::temp_dir().join(format!(
            "kdj-onelibrary-reorder-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let root = base.join("USB");
        fs::create_dir_all(&root).unwrap();
        let mut tracks = Vec::new();
        for id in 1..=3 {
            let source = base.join(format!("{id}.mp3"));
            fs::write(&source, format!("track-{id}")).unwrap();
            tracks.push(Track {
                id,
                path: source.to_string_lossy().into_owned(),
                filename: format!("{id}.mp3"),
                title: format!("Track {id}"),
                ..Track::default()
            });
        }
        let device = RemovableDevice {
            path: root.to_string_lossy().into_owned(),
            name: "Test USB".into(),
            file_system: "exFAT".into(),
            available_bytes: 1024 * 1024,
            one_library_file_system: true,
            ..Default::default()
        };
        let exported = export_playlist_to_device(device, None, "Order", tracks, None).unwrap();
        let db_path = one_library_db(&root);
        let playlist_id = i32::try_from(exported.playlist_id).unwrap();
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![1, 2, 3],
            "djay 要求 playlist_content.sequenceNo 从 1 开始且不能断档"
        );

        // 旧版 KDJ 正是写出 0,1,2；挂载后运行同一个修复器应原位升级为 1,2,3。
        let mut conn = rbox::one_library::establish_connection(db_path.to_str().unwrap()).unwrap();
        diesel::sql_query(
            "UPDATE playlist_content SET sequenceNo = sequenceNo - 1 WHERE playlist_id = ?",
        )
        .bind::<diesel::sql_types::Integer, _>(playlist_id)
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![0, 1, 2]
        );
        normalize_playlist_content_sequences(&db_path).unwrap();
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![1, 2, 3]
        );

        let library = OneLibrary::new(&db_path).unwrap();
        let original: Vec<i32> = library
            .get_playlist_contents(playlist_id)
            .unwrap()
            .into_iter()
            .map(|content| content.id)
            .collect();
        let reversed: Vec<i32> = original.iter().rev().copied().collect();
        reorder_one_library_contents(&library, playlist_id, &reversed).unwrap();
        drop(library);
        normalize_playlist_content_sequences(&db_path).unwrap();
        let library = OneLibrary::new(&db_path).unwrap();
        let written: Vec<i32> = library
            .get_playlist_contents(playlist_id)
            .unwrap()
            .into_iter()
            .map(|content| content.id)
            .collect();
        assert_eq!(written, reversed);
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![1, 2, 3]
        );
        assert!(reorder_one_library_contents(&library, playlist_id, &reversed[..2]).is_err());

        // rbox 0.1.5 的 playlist_content 重排 SQL 多绑定了一个参数，并且只按
        // playlist_id 回填序号：删除会报 Column index out of range；即使删成也会把
        // 剩余行写成同一个序号。删除中间一首覆盖这两个回归，同时确认只删列表引用。
        let removed_id = reversed[1];
        let removed_content = library.get_content_by_id(removed_id).unwrap().unwrap();
        let removed_path = one_library_relative_path(&root, &removed_content.path).unwrap();
        assert_eq!(
            library
                .delete_playlist_content(playlist_id, removed_id)
                .unwrap(),
            1
        );
        let remaining: Vec<i32> = library
            .get_playlist_contents(playlist_id)
            .unwrap()
            .into_iter()
            .map(|content| content.id)
            .collect();
        assert_eq!(remaining, vec![reversed[0], reversed[2]]);
        assert!(library.get_content_by_id(removed_id).unwrap().is_some());
        assert!(removed_path.is_file(), "从列表移除不能删除媒体文件");
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![0, 1]
        );
        drop(library);
        normalize_playlist_content_sequences(&db_path).unwrap();
        assert_eq!(
            playlist_content_sequences(&db_path, playlist_id),
            vec![1, 2]
        );
        let _ = fs::remove_dir_all(base);
    }
}
