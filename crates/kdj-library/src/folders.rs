//! 文件夹模式：把曲库映射到真实目录，并在真实目录上做移动 / 复制。
//!
//! 设计前提：**文件夹就是磁盘上的文件夹**，不是数据库里的虚拟分组。
//! DJ 出场前要把一套歌拷进 U 盘、要用别的软件（Rekordbox / Serato）再读一遍，
//! 虚拟分组到了那一步就没了。所以这里所有操作都落到文件系统上，
//! 数据库只是跟着改 path。
//!
//! 文件夹分类只操作真实的本地文件：移动原文件或复制出一份独立文件，
//! 不创建硬链接、符号链接或其它虚拟条目。
//!
//! 安全：dest 一律必须落在已配置的曲库根目录内，否则渲染进程就能借这个接口
//! 把文件挪到系统任意位置。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use kdj_core::models::{FolderNode, FolderTree};
use kdj_providers::tags::is_media_extension;
use serde::{Deserialize, Serialize};

/// 每个受管目录都把 KDJ 自己的文件收进 `.kdj/`，不再把 sidecar 散在歌曲旁边。
///
/// 为什么是“每个目录一份”而不是根目录一份大清单：清单要跟着文件夹走。
/// 出场前把 `温州/` 整个拷进 U 盘，顺序也一起过去；它也不能只存 SQLite，
/// 因为数据库在应用数据目录里，换台电脑就不会跟着音乐走。
pub const METADATA_DIR_NAME: &str = ".kdj";
pub const MANIFEST_NAME: &str = "manifest.json";
/// 歌词正文和附加歌词都落在曲库目录自己的 KDJ 元数据目录里。
pub const LYRICS_DIR_NAME: &str = "lyrics";
/// 前端侧栏「其他」用的哨兵路径：不是真实目录，只表示「落在所有曲库根之外」。
pub const OUTSIDE_FOLDER: &str = "__kd_outside__";
/// v0.2.8 及以前把清单直接放在歌曲旁边。升级时双读并安全搬进 `.kdj/`。
pub const LEGACY_MANIFEST_NAME: &str = ".kdj.json";
const LEGACY_BACKUP_NAME: &str = "legacy-manifest-v1.json";
const MANIFEST_VERSION: i64 = 1;
static ATOMIC_WRITE_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Default)]
pub struct StoredLyrics {
    pub lrc: String,
    pub word_lrc: String,
    pub translated_lrc: String,
    pub romaji_lrc: String,
    pub platform: String,
    pub key: String,
    pub title: String,
    pub artist: String,
    pub score: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredLyricsMetadata {
    #[serde(default)]
    platform: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    score: f64,
}

struct LyricsPaths {
    main: PathBuf,
    word: PathBuf,
    translated: PathBuf,
    romaji: PathBuf,
    metadata: PathBuf,
}

fn local_lyrics_stem(audio_path: &Path) -> Option<String> {
    let filename = audio_path.file_name()?.to_string_lossy();
    // FNV-1a 足够充当同一目录内的稳定文件名键；不把可能接近 255 字节的原文件名
    // 直接十六进制展开，否则长歌名会超过多数文件系统的单段长度上限。
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in filename.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("local-{hash:016x}"))
}

/// 有下载来源时沿用平台 + key；手动入库、没有来源的歌曲则按文件名生成稳定本地键。
/// 不使用数据库 track id，避免换库后歌词断链；文件移动/复制时 sidecar 会一起迁移。
fn lyrics_paths(audio_path: &Path, platform: &str, key: &str) -> Option<LyricsPaths> {
    let parent = audio_path.parent()?;
    let platform = platform.trim();
    let key = key.trim();
    let stem = if !platform.is_empty() && platform != "local" && !key.is_empty() {
        let encoded_key: String = key.bytes().map(|byte| format!("{byte:02x}")).collect();
        format!("{platform}-{encoded_key}")
    } else {
        local_lyrics_stem(audio_path)?
    };
    let dir = parent.join(METADATA_DIR_NAME).join(LYRICS_DIR_NAME);
    Some(LyricsPaths {
        main: dir.join(format!("{stem}.lrc")),
        word: dir.join(format!("{stem}.word.lrc")),
        translated: dir.join(format!("{stem}.trans.lrc")),
        romaji: dir.join(format!("{stem}.roma.lrc")),
        metadata: dir.join(format!("{stem}.meta.json")),
    })
}

fn write_text_atomic(path: &Path, text: &str) -> Result<()> {
    atomic_write(path, text.as_bytes())
        .with_context(|| format!("提交歌词文件失败：{}", path.display()))
}

fn write_optional_lyrics_file(path: &Path, text: &str) -> Result<()> {
    if text.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(path)
                .with_context(|| format!("清理旧歌词文件失败：{}", path.display()))?;
        }
    } else {
        write_text_atomic(path, text.trim())?;
    }
    Ok(())
}

/// 保存下载结果对应的 LRC。返回 false 表示没有主歌词，不创建空文件。
pub fn write_lyrics(
    audio_path: &Path,
    platform: &str,
    key: &str,
    lrc: &str,
    translated_lrc: &str,
    romaji_lrc: &str,
) -> Result<bool> {
    write_lyrics_cache(
        audio_path,
        platform,
        key,
        &StoredLyrics {
            lrc: lrc.to_string(),
            translated_lrc: translated_lrc.to_string(),
            romaji_lrc: romaji_lrc.to_string(),
            platform: platform.trim().to_string(),
            key: key.trim().to_string(),
            score: 1.0,
            ..StoredLyrics::default()
        },
    )
}

/// 保存完整歌词缓存。`storage_platform/key` 只决定 sidecar 放在哪里；歌词实际匹配到的
/// 平台与 key 记录在 `lyrics` 元数据里，不能借此把本地音频伪装成平台来源歌曲。
pub fn write_lyrics_cache(
    audio_path: &Path,
    storage_platform: &str,
    storage_key: &str,
    lyrics: &StoredLyrics,
) -> Result<bool> {
    let Some(paths) = lyrics_paths(audio_path, storage_platform, storage_key) else {
        return Ok(false);
    };
    if lyrics.lrc.trim().is_empty() {
        return Ok(false);
    }
    std::fs::create_dir_all(paths.main.parent().expect("歌词路径一定有父目录"))
        .with_context(|| format!("创建歌词目录失败：{}", paths.main.display()))?;
    write_text_atomic(&paths.main, lyrics.lrc.trim())?;
    write_optional_lyrics_file(&paths.word, &lyrics.word_lrc)?;
    write_optional_lyrics_file(&paths.translated, &lyrics.translated_lrc)?;
    write_optional_lyrics_file(&paths.romaji, &lyrics.romaji_lrc)?;
    let metadata = StoredLyricsMetadata {
        platform: lyrics.platform.trim().to_string(),
        key: lyrics.key.trim().to_string(),
        title: lyrics.title.trim().to_string(),
        artist: lyrics.artist.trim().to_string(),
        score: lyrics.score,
    };
    write_text_atomic(&paths.metadata, &serde_json::to_string(&metadata)?)?;
    Ok(true)
}

/// 读取下载时保存的歌词；只认有主 LRC 的完整条目。
pub fn read_lyrics(audio_path: &Path, platform: &str, key: &str) -> Result<Option<StoredLyrics>> {
    let Some(paths) = lyrics_paths(audio_path, platform, key) else {
        return Ok(None);
    };
    if !paths.main.is_file() {
        return Ok(None);
    }
    let lrc = std::fs::read_to_string(&paths.main)
        .with_context(|| format!("读取歌词失败：{}", paths.main.display()))?;
    if lrc.trim().is_empty() {
        return Ok(None);
    }
    let read_optional = |path: &Path| -> Result<String> {
        if !path.is_file() {
            return Ok(String::new());
        }
        Ok(std::fs::read_to_string(path)
            .with_context(|| format!("读取歌词附加文件失败：{}", path.display()))?)
    };
    let metadata = std::fs::read(&paths.metadata)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredLyricsMetadata>(&bytes).ok())
        .unwrap_or_default();
    Ok(Some(StoredLyrics {
        lrc,
        word_lrc: read_optional(&paths.word)?,
        translated_lrc: read_optional(&paths.translated)?,
        romaji_lrc: read_optional(&paths.romaji)?,
        platform: if metadata.platform.is_empty() {
            platform.trim().to_string()
        } else {
            metadata.platform
        },
        key: if metadata.key.is_empty() {
            key.trim().to_string()
        } else {
            metadata.key
        },
        title: metadata.title,
        artist: metadata.artist,
        score: if metadata.score > 0.0 {
            metadata.score
        } else if !platform.trim().is_empty() && !key.trim().is_empty() {
            1.0
        } else {
            0.0
        },
    }))
}

fn transfer_lyrics(
    source_audio: &Path,
    target_audio: &Path,
    platform: &str,
    key: &str,
    move_files: bool,
) -> Result<()> {
    let (Some(source), Some(target)) = (
        lyrics_paths(source_audio, platform, key),
        lyrics_paths(target_audio, platform, key),
    ) else {
        return Ok(());
    };
    for (from, to) in [
        (source.main, target.main),
        (source.word, target.word),
        (source.translated, target.translated),
        (source.romaji, target.romaji),
        (source.metadata, target.metadata),
    ] {
        if !from.is_file() {
            continue;
        }
        if to.exists() {
            if move_files {
                let _ = std::fs::remove_file(&from);
            }
            continue;
        }
        std::fs::create_dir_all(to.parent().expect("歌词路径一定有父目录"))
            .with_context(|| format!("创建目标歌词目录失败：{}", to.display()))?;
        if move_files {
            if let Err(err) = std::fs::rename(&from, &to) {
                std::fs::copy(&from, &to).with_context(|| {
                    format!("移动歌词失败（rename: {err}）：{}", from.display())
                })?;
                std::fs::remove_file(&from)
                    .with_context(|| format!("清理旧歌词文件失败：{}", from.display()))?;
            }
        } else {
            std::fs::copy(&from, &to)
                .with_context(|| format!("复制歌词失败：{}", from.display()))?;
        }
    }
    Ok(())
}

pub fn move_lyrics(
    source_audio: &Path,
    target_audio: &Path,
    platform: &str,
    key: &str,
) -> Result<()> {
    transfer_lyrics(source_audio, target_audio, platform, key, true)
}

pub fn copy_lyrics(
    source_audio: &Path,
    target_audio: &Path,
    platform: &str,
    key: &str,
) -> Result<()> {
    transfer_lyrics(source_audio, target_audio, platform, key, false)
}

/// 删除某个本地音频对应的歌词 sidecar；音频删除/撤回复制时使用。
pub fn remove_lyrics(audio_path: &Path, platform: &str, key: &str) -> Result<()> {
    let Some(paths) = lyrics_paths(audio_path, platform, key) else {
        return Ok(());
    };
    for path in [
        paths.main,
        paths.word,
        paths.translated,
        paths.romaji,
        paths.metadata,
    ] {
        if path.is_file() {
            std::fs::remove_file(&path)
                .with_context(|| format!("删除歌词失败：{}", path.display()))?;
        }
    }
    Ok(())
}

/// 扫描目录树的深度上限。DJ 的歌单目录一般 1~2 层，给到 6 层足够，
/// 同时挡住 node_modules 那种病态深度把 UI 卡死。
const MAX_DEPTH: usize = 6;
/// 单个目录下的子目录上限，防止误选了一个几万条目的目录
const MAX_CHILDREN: usize = 500;

const SKIP_DIRS: [&str; 6] = [
    ".git",
    ".svn",
    "node_modules",
    "__pycache__",
    ".Trash",
    ".partial",
];

/// 和 `service::normalize_path` 完全同一套归一化。
///
/// **不能**换成 `canonicalize`：那会解析符号链接，而入库的 path 没解析过；
/// 两边规则一旦不一致，文件夹树的计数就会全落到 `outside` 里。
fn norm(path: &Path) -> PathBuf {
    PathBuf::from(crate::service::normalize_path(path))
}

fn within(child: &Path, parent: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

/// 确认 dest 在某个曲库根目录里（含根目录本身），返回归一化后的绝对路径。
///
/// 没有这一步，`dest="/"` 或 `dest="../../.."` 就能把用户的音乐文件搬到任意位置。
/// 用路径分段比较而不是字符串前缀：后者会被 `/Users/me/Music-evil`
/// 这种同前缀的兄弟目录骗过去。
///
/// 归一化路径和 realpath **两道都要过**：前者挡 `..`，后者挡"曲库里放一个
/// 指向 /etc 的符号链接再往里搬文件"。只做前者会被符号链接绕过，
/// 只做后者又会和数据库里未解析的 path 对不上。
pub fn ensure_inside(dest: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = norm(dest);
    for root in roots {
        if !within(&target, root) {
            continue;
        }
        let real_target = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
        let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if within(&real_target, &real_root) {
            return Ok(target);
        }
        bail!("目标目录经符号链接指到了曲库之外：{}", target.display());
    }
    bail!("目标目录不在曲库范围内：{}", target.display())
}

/// 把设置里的曲库目录变成去重、存在、已归一化的根列表。
///
/// **互相包含的只留最外层那个**：如果 `~/git/djay` 和 `~/git/djay/温州` 都在列表里，
/// 温州会在树上同时以"根"和"djay 的子节点"两个身份出现，看着像凭空多了一份。
pub fn resolve_roots(dirs: &[String]) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    for item in dirs {
        if item.is_empty() {
            continue;
        }
        let path = norm(Path::new(item));
        if path.is_dir() && !seen.contains(&path) {
            seen.push(path);
        }
    }
    seen.iter()
        .filter(|path| {
            !seen
                .iter()
                .any(|other| other != *path && within(path, other))
        })
        .cloned()
        .collect()
}

/// 没配曲库目录时，从已入库的路径反推根目录。
///
/// 做法是"每个存歌的目录各自往上退一层"，**不是**"取全体的最近公共祖先"：
/// 实际的库常常横跨两棵树（下载目录 + 自己的 set 目录），
/// 取公共祖先会一路退到 `~`，等于把整个家目录当曲库根——又慢又危险。
pub fn infer_roots(track_paths: &[String]) -> Vec<PathBuf> {
    let parents: std::collections::HashSet<PathBuf> = track_paths
        .iter()
        .filter(|path| !path.is_empty())
        .filter_map(|path| Path::new(path).parent().map(norm))
        .collect();
    if parents.is_empty() {
        return Vec::new();
    }

    let home = kdj_core::config::home_dir();
    let blocked: Vec<PathBuf> = [
        PathBuf::from("/"),
        home.clone(),
        home.parent().map(Path::to_path_buf).unwrap_or_default(),
        PathBuf::from("/Volumes"),
        PathBuf::from("/tmp"),
    ]
    .into_iter()
    .collect();

    let mut candidates: Vec<PathBuf> = Vec::new();
    for parent in &parents {
        let up = parent.parent().map(Path::to_path_buf);
        let pick = match up {
            // 退到家目录、/Users、/Volumes、/ 这些就不再往上
            Some(up) if !blocked.contains(&up) && up.components().count() >= 4 => up,
            _ => parent.clone(),
        };
        if !candidates.contains(&pick) {
            candidates.push(pick);
        }
    }
    candidates.sort();
    candidates
        .iter()
        .filter(|node| {
            !candidates
                .iter()
                .any(|other| other != *node && within(node, other))
        })
        .filter(|node| node.is_dir())
        .cloned()
        .collect()
}

// ------------------------------------------------------------------ 目录清单

fn metadata_dir(directory: &Path) -> PathBuf {
    directory.join(METADATA_DIR_NAME)
}

fn manifest_path(directory: &Path) -> PathBuf {
    metadata_dir(directory).join(MANIFEST_NAME)
}

fn legacy_manifest_path(directory: &Path) -> PathBuf {
    directory.join(LEGACY_MANIFEST_NAME)
}

fn legacy_backup_path(directory: &Path) -> PathBuf {
    metadata_dir(directory).join(LEGACY_BACKUP_NAME)
}

fn read_manifest_file(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<serde_json::Value>(&text).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// 先读新位置；升级还没完成或新文件损坏时，继续认旧清单和迁移备份。
///
/// 清单只影响显示顺序，三份都读不出来才退回空清单，不能让一份坏 JSON
/// 把整棵文件夹树拖成白屏。
fn read_manifest(directory: &Path) -> serde_json::Map<String, serde_json::Value> {
    for path in [
        manifest_path(directory),
        legacy_manifest_path(directory),
        legacy_backup_path(directory),
    ] {
        if let Some(map) = read_manifest_file(&path) {
            return map;
        }
    }
    Default::default()
}

pub fn read_manifest_order(directory: &Path) -> Vec<String> {
    manifest_order(&read_manifest(directory))
}

fn manifest_order(manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    manifest
        .get("order")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 新旧任一清单存在都算“已有”。旧文件即使损坏也不能被初始化流程覆盖；
/// 用户还有机会从备份修它，自动写一份空顺序反而会掩盖问题。
pub fn has_manifest(directory: &Path) -> bool {
    manifest_path(directory).is_file() || legacy_manifest_path(directory).is_file()
}

/// 同目录写临时文件再 rename。进程被 kill 时最多留一份 `.partial`，
/// 永远不会把上一份好清单截成半个 JSON。
fn atomic_write(path: &Path, body: &[u8]) -> Result<()> {
    use std::io::Write as _;
    use std::sync::atomic::Ordering;

    if std::fs::read(path).is_ok_and(|current| current == body) {
        return Ok(());
    }
    let parent = path.parent().context("清单没有上级目录")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("创建 KDJ 元数据目录失败：{}", parent.display()))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    let mut temporary = None;
    for _ in 0..32 {
        let serial = ATOMIC_WRITE_SERIAL.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(
            ".{MANIFEST_NAME}.{}-{timestamp:x}-{serial:x}.partial",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        match options.open(&tmp) {
            Ok(file) => {
                temporary = Some((tmp, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("创建临时清单失败：{}", tmp.display()));
            }
        }
    }
    let (tmp, mut file) = temporary.context("无法分配唯一的清单临时文件")?;
    let write_result = (|| -> std::io::Result<()> {
        file.write_all(body)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(error).with_context(|| format!("写临时清单失败：{}", tmp.display()));
    }
    drop(file);
    if let Err(first) = std::fs::rename(&tmp, path) {
        // Windows 不能 rename 覆盖已有目标。先把完整旧文件挪到同目录备份；
        // 新文件提交失败就立刻还原，任何时刻至少有一份完整清单可恢复。
        #[cfg(windows)]
        if path.is_file() {
            let serial = ATOMIC_WRITE_SERIAL.fetch_add(1, Ordering::Relaxed);
            let rollback = parent.join(format!(
                ".{MANIFEST_NAME}.{}-{timestamp:x}-{serial:x}.rollback",
                std::process::id()
            ));
            std::fs::rename(path, &rollback)
                .with_context(|| format!("暂存旧清单失败：{}", path.display()))?;
            if let Err(second) = std::fs::rename(&tmp, path) {
                let _ = std::fs::rename(&rollback, path);
                let _ = std::fs::remove_file(&tmp);
                return Err(second).with_context(|| {
                    format!("提交清单失败：{}（首次错误：{first}）", path.display())
                });
            }
            let _ = std::fs::remove_file(rollback);
        }
        #[cfg(not(windows))]
        {
            let _ = std::fs::remove_file(&tmp);
            return Err(first).with_context(|| format!("提交清单失败：{}", path.display()));
        }
        #[cfg(windows)]
        if !path.is_file() {
            let _ = std::fs::remove_file(&tmp);
            return Err(first).with_context(|| format!("提交清单失败：{}", path.display()));
        }
    }
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn backup_legacy_manifest(directory: &Path) -> Result<()> {
    let legacy = legacy_manifest_path(directory);
    if !legacy.is_file() {
        return Ok(());
    }
    let backup = legacy_backup_path(directory);
    if !backup.is_file() {
        let body = std::fs::read(&legacy)
            .with_context(|| format!("读取旧清单失败：{}", legacy.display()))?;
        atomic_write(&backup, &body)?;
    }
    Ok(())
}

/// 把根目录旧 `.kdj.json` 搬进 `.kdj/manifest.json`。
/// 返回 true 表示本次真的完成了迁移；坏旧文件只备份、不删除。
fn migrate_legacy_manifest(directory: &Path) -> Result<bool> {
    let target = manifest_path(directory);
    if target.is_file() {
        return Ok(false);
    }
    let legacy = legacy_manifest_path(directory);
    if !legacy.is_file() {
        return Ok(false);
    }
    let body =
        std::fs::read(&legacy).with_context(|| format!("读取旧清单失败：{}", legacy.display()))?;
    backup_legacy_manifest(directory)?;
    if serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_none()
    {
        anyhow::bail!("旧清单损坏，已备份但不删除：{}", legacy.display());
    }
    atomic_write(&target, &body)?;
    anyhow::ensure!(
        read_manifest_file(&target).is_some(),
        "迁移后的清单校验失败：{}",
        target.display()
    );
    std::fs::remove_file(&legacy)
        .with_context(|| format!("新清单已写好，但旧清单删不掉：{}", legacy.display()))?;
    Ok(true)
}

/// 写新布局的清单。会保留将来版本添加的未知字段，并在成功提交后收掉旧 sidecar。
pub fn write_manifest(directory: &Path, order: &[String]) -> Result<()> {
    let mut payload = read_manifest(directory);
    payload.insert("version".into(), serde_json::Value::from(MANIFEST_VERSION));
    payload.insert("order".into(), serde_json::json!(order));
    let body =
        serde_json::to_vec_pretty(&serde_json::Value::Object(payload)).context("序列化清单失败")?;
    let target = manifest_path(directory);
    atomic_write(&target, &body)?;
    anyhow::ensure!(read_manifest_file(&target).is_some(), "写出的清单校验失败");
    backup_legacy_manifest(directory)?;
    let legacy = legacy_manifest_path(directory);
    if legacy.is_file() {
        std::fs::remove_file(&legacy)
            .with_context(|| format!("新清单已写好，但旧清单删不掉：{}", legacy.display()))?;
    }
    Ok(())
}

/// 这一层的子目录名，按大小写不敏感的字母序。
#[derive(Default)]
struct DirectorySnapshot {
    child_names: Vec<String>,
    media_files: i64,
}

/// 一次 readdir 同时拿子目录和本层媒体数。文件夹树原来为这两项各扫一遍目录，
/// 外置盘上每次刷新都会把目录 I/O 翻倍。
fn inspect_directory(directory: &Path) -> DirectorySnapshot {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return DirectorySnapshot::default();
    };
    let mut snapshot = DirectorySnapshot::default();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_dir() {
            if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                snapshot.child_names.push(name);
            }
        } else if kind.is_file()
            && !name.starts_with('.')
            && Path::new(&name)
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(is_media_extension)
        {
            snapshot.media_files += 1;
        }
    }
    snapshot.child_names.sort_by_key(|name| name.to_lowercase());
    snapshot
}

fn child_names(directory: &Path) -> Vec<String> {
    inspect_directory(directory).child_names
}

/// 这一层目录里有几个音频文件（不含子目录）。
///
/// 树上要同时显示"库里有几首"和"磁盘上有几个"：两者不一致就说明这个目录还没扫过。
/// 没有这个数，用户看到的是一个空文件夹，而歌明明就在里面。
pub fn count_audio_files(directory: &Path) -> i64 {
    inspect_directory(directory).media_files
}

/// 按清单里的顺序排列子目录名。
///
/// 清单里有、磁盘上没有的（被删/改名了）直接丢掉；
/// 磁盘上有、清单里没有的（新建的）按名字排在后面。
/// 两边都不强行同步回文件——只有用户真的调过顺序才写盘。
pub fn apply_order(directory: &Path, listed: &[String]) -> Vec<String> {
    apply_order_to_actual(child_names(directory), listed)
}

fn apply_order_to_actual(actual: Vec<String>, listed: &[String]) -> Vec<String> {
    let index: HashMap<&str, usize> = listed
        .iter()
        .enumerate()
        .map(|(position, name)| (name.as_str(), position))
        .collect();

    let mut known: Vec<String> = actual
        .iter()
        .filter(|name| index.contains_key(name.as_str()))
        .cloned()
        .collect();
    known.sort_by_key(|name| index[name.as_str()]);
    let fresh: Vec<String> = actual
        .into_iter()
        .filter(|name| !index.contains_key(name.as_str()))
        .collect();
    known.into_iter().chain(fresh).collect()
}

/// 给目录树里每一层补上 `.kdj/manifest.json`，并原地迁移旧 `.kdj.json`。
/// 已有顺序绝不覆盖。返回新建或迁移成功的目录数。
pub fn init_manifests(directory: &Path, roots: &[PathBuf]) -> Result<usize> {
    init_manifests_with_progress(directory, roots, |_, _, _| {})
}

/// 带进度的版本给升级任务使用。先收集目录再处理，total 从第一条事件起就是稳定的。
pub fn init_manifests_with_progress<F>(
    directory: &Path,
    roots: &[PathBuf],
    mut progress: F,
) -> Result<usize>
where
    F: FnMut(usize, usize, &Path),
{
    ensure_inside(directory, roots)?;
    let mut directories = Vec::new();
    collect_directories(directory, 0, &mut directories);
    let total = directories.len();
    let mut changed = 0;
    for (index, current) in directories.iter().enumerate() {
        if ensure_manifest(current)? {
            changed += 1;
        }
        progress(index + 1, total, current);
    }
    Ok(changed)
}

fn collect_directories(directory: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    out.push(directory.to_path_buf());
    if depth < MAX_DEPTH {
        for name in child_names(directory) {
            collect_directories(&directory.join(name), depth + 1, out);
        }
    }
}

fn ensure_manifest(directory: &Path) -> Result<bool> {
    if manifest_path(directory).is_file() {
        return Ok(false);
    }
    if legacy_manifest_path(directory).is_file() {
        return migrate_legacy_manifest(directory);
    }
    write_manifest(directory, &child_names(directory))?;
    Ok(true)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestUpgradeReport {
    pub changed: usize,
    pub failed: usize,
    /// 只留可展示的路径和原因；迁移是后台维护，单个只读目录不该拖停其他目录。
    pub errors: Vec<(String, String)>,
}

/// 升级全部曲库根。和手动初始化不同，这条会吞住单目录错误继续往后跑，
/// 最终把失败清单交给活动栏；旧文件在任何失败路径上都不会被删除。
pub fn upgrade_manifests<F>(roots: &[PathBuf], mut progress: F) -> ManifestUpgradeReport
where
    F: FnMut(usize, usize, &Path),
{
    let mut directories = Vec::new();
    for root in roots {
        collect_directories(root, 0, &mut directories);
    }
    directories.sort();
    directories.dedup();

    let total = directories.len();
    let mut report = ManifestUpgradeReport::default();
    for (index, directory) in directories.iter().enumerate() {
        match ensure_manifest(directory) {
            Ok(true) => report.changed += 1,
            Ok(false) => {}
            Err(err) => {
                report.failed += 1;
                report
                    .errors
                    .push((directory.to_string_lossy().into_owned(), format!("{err:#}")));
            }
        }
        progress(index + 1, total, directory);
    }
    report
}

/// 按设置里的曲库目录构建文件夹树，并统计每个目录下的曲目数。
///
/// 统计走**数据库里已有的路径**而不是再扫一次磁盘：树只需要知道
/// "库里这些歌分别躺在哪"，重新遍历文件系统既慢又会把没入库的文件算进来。
pub fn build_tree(dirs: &[String], track_paths: &[String]) -> FolderTree {
    let roots = resolve_roots(dirs);
    let mut counts: HashMap<String, i64> = HashMap::new();
    for path in track_paths {
        if let Some(parent) = Path::new(path).parent() {
            *counts
                .entry(parent.to_string_lossy().into_owned())
                .or_insert(0) += 1;
        }
    }

    let mut nodes: Vec<FolderNode> = roots.iter().map(|root| walk(root, &counts, 0)).collect();
    for node in nodes.iter_mut() {
        node.is_root = true;
    }
    let inside: i64 = nodes.iter().map(|node| node.total_count).sum();
    FolderTree {
        roots: nodes,
        outside: (track_paths.len() as i64 - inside).max(0),
    }
}

fn walk(directory: &Path, counts: &HashMap<String, i64>, depth: usize) -> FolderNode {
    // 清单和目录都只读一次：树刷新是外置曲库最常走的只读路径。
    let manifest = read_manifest(directory);
    let listed = manifest_order(&manifest);
    let managed = !manifest.is_empty();
    let snapshot = inspect_directory(directory);
    let files = snapshot.media_files;
    let mut children: Vec<FolderNode> = Vec::new();
    if depth < MAX_DEPTH {
        // 顺序由目录自己的清单决定，不是字母序：DJ 的 set 目录是按演出顺序排的，
        // 按字母排会把「5月 / 6yue / 7yue」打散成毫无意义的次序。
        for name in apply_order_to_actual(snapshot.child_names, &listed)
            .into_iter()
            .take(MAX_CHILDREN)
        {
            children.push(walk(&directory.join(name), counts, depth + 1));
        }
    }

    let direct = counts
        .get(&directory.to_string_lossy().into_owned())
        .copied()
        .unwrap_or(0);
    FolderNode {
        path: directory.to_string_lossy().into_owned(),
        name: directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| directory.to_string_lossy().into_owned()),
        parent: directory
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        track_count: direct,
        file_count: files,
        // 累计计数让人一眼看出哪个分支是空的，不用一层层点开
        total_count: direct + children.iter().map(|child| child.total_count).sum::<i64>(),
        // 未入库 = 磁盘上有、库里没有。负数没有意义（库里可能还留着已删文件的记录）
        pending_count: (files - direct).max(0)
            + children
                .iter()
                .map(|child| child.pending_count)
                .sum::<i64>(),
        children,
        is_root: false,
        managed,
    }
}

// ------------------------------------------------------------------ 目录操作

fn validate_name(name: &str) -> Result<String> {
    let clean = name.trim().trim_matches('/').to_string();
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.contains('/')
        || clean.contains('\\')
    {
        bail!("文件夹名不合法");
    }
    Ok(clean)
}

pub fn create_folder(parent: &Path, name: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let clean = validate_name(name)?;
    let base = ensure_inside(parent, roots)?;
    anyhow::ensure!(base.is_dir(), "上级目录不存在");
    let target = base.join(&clean);
    // 再验一次：clean 已经排除了分隔符，这里挡的是符号链接把 target 指到界外
    ensure_inside(&base, roots)?;
    anyhow::ensure!(!target.exists(), "同名文件夹已存在");
    std::fs::create_dir(&target).context("建目录失败")?;
    Ok(target)
}

pub fn rename_folder(path: &Path, name: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let clean = validate_name(name)?;
    let source = ensure_inside(path, roots)?;
    anyhow::ensure!(
        !roots.contains(&source),
        "曲库根目录不能在这里改名，去设置里改"
    );
    anyhow::ensure!(source.is_dir(), "文件夹不存在");
    let target = source.parent().context("没有上级目录")?.join(&clean);
    anyhow::ensure!(!target.exists(), "同名文件夹已存在");
    std::fs::rename(&source, &target).context("改名失败")?;
    Ok(target)
}

/// 把一整个文件夹搬进另一个文件夹，返回 `(旧路径, 新路径)`。
///
/// 三条必须挡住：根目录不能被搬；不能搬进自己或自己的子目录里（会把整棵子树搬没）；
/// 目标下同名已存在时**不合并**，直接报错——静默合并会让两批同名文件混在一起。
pub fn move_folder(
    source_path: &Path,
    dest_parent: &Path,
    roots: &[PathBuf],
) -> Result<(PathBuf, PathBuf)> {
    let source = ensure_inside(source_path, roots)?;
    let parent = ensure_inside(dest_parent, roots)?;
    anyhow::ensure!(!roots.contains(&source), "曲库根目录不能拖动，去设置里改");
    anyhow::ensure!(source.is_dir(), "文件夹不存在");
    anyhow::ensure!(parent.is_dir(), "目标不是文件夹");
    anyhow::ensure!(!within(&parent, &source), "不能把文件夹拖进它自己里面");

    let name = source.file_name().context("没有目录名")?;
    let target = parent.join(name);
    if target == source {
        return Ok((source.clone(), source));
    }
    anyhow::ensure!(
        !target.exists(),
        "「{}」下已经有同名文件夹了",
        parent.file_name().unwrap_or_default().to_string_lossy()
    );
    if std::fs::rename(&source, &target).is_err() {
        // rename 跨卷会报 EXDEV。用户完全可能把外置硬盘上的一个 set 拖进内置盘的
        // 曲库目录（两个都是已配置的曲库根），必须支持跨卷。
        move_dir_across_volumes(&source, &target)?;
    }
    Ok((source, target))
}

/// 跨卷搬目录：先整棵复制过去，**全部成功之后**才删源。
///
/// 中途失败就把半成品清掉、源目录原样留着——搬歌搬到一半两边都残缺是不可接受的。
fn move_dir_across_volumes(source: &Path, target: &Path) -> Result<()> {
    if let Err(err) = copy_dir_recursive(source, target) {
        let _ = std::fs::remove_dir_all(target);
        return Err(err.context("跨卷复制文件夹失败"));
    }
    std::fs::remove_dir_all(source).context("复制完成后删不掉源目录")
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target).with_context(|| format!("建目录失败：{}", target.display()))?;
    for entry in
        std::fs::read_dir(source).with_context(|| format!("读目录失败：{}", source.display()))?
    {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if kind.is_symlink() {
            // 符号链接照原样重建，不把它指向的内容复制一份（等同 shutil.move 的
            // symlinks=True）；跨卷时链接目标多半还在原来那个卷上，这是用户的意思。
            #[cfg(unix)]
            {
                let dest = std::fs::read_link(&from)?;
                std::os::unix::fs::symlink(dest, &to)?;
            }
            #[cfg(not(unix))]
            {
                std::fs::copy(&from, &to)?;
            }
        } else {
            std::fs::copy(&from, &to).with_context(|| format!("复制失败：{}", from.display()))?;
        }
    }
    Ok(())
}

/// 只删没有用户文件的目录。`.kdj/` 和旧 `.kdj.json` 是应用自己的元数据，
/// 不该让一个肉眼看起来为空的文件夹永远删不掉；但 `.kdj/` 里出现未知文件时仍拒绝。
pub fn delete_folder(path: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = ensure_inside(path, roots)?;
    anyhow::ensure!(
        !roots.contains(&target),
        "曲库根目录不能在这里删除，去设置里移除"
    );
    anyhow::ensure!(target.is_dir(), "文件夹不存在");

    for entry in std::fs::read_dir(&target).context("读文件夹失败")? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        anyhow::ensure!(
            name == METADATA_DIR_NAME || name == LEGACY_MANIFEST_NAME,
            "文件夹非空或删不掉"
        );
    }
    let meta = metadata_dir(&target);
    if meta.is_dir() {
        for entry in std::fs::read_dir(&meta).context("读 KDJ 元数据目录失败")? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == LYRICS_DIR_NAME {
                anyhow::ensure!(
                    entry.file_type()?.is_dir(),
                    "KDJ 歌词目录类型不正确，拒绝删除"
                );
                for lyric in std::fs::read_dir(entry.path()).context("读 KDJ 歌词目录失败")?
                {
                    let lyric = lyric?;
                    anyhow::ensure!(
                        lyric.file_type()?.is_file()
                            && (lyric.file_name().to_string_lossy().ends_with(".lrc")
                                || lyric.file_name().to_string_lossy().ends_with(".partial")),
                        "KDJ 歌词目录里有未知内容，拒绝删除"
                    );
                }
            } else {
                anyhow::ensure!(
                    entry.file_type()?.is_file()
                        && (name == MANIFEST_NAME
                            || name == LEGACY_BACKUP_NAME
                            || name.ends_with(".partial")),
                    "KDJ 元数据目录里有未知内容，拒绝删除"
                );
            }
        }
        std::fs::remove_dir_all(&meta).context("删除 KDJ 元数据失败")?;
    }
    let legacy = legacy_manifest_path(&target);
    if legacy.is_file() {
        std::fs::remove_file(legacy).context("删除旧 KDJ 清单失败")?;
    }
    std::fs::remove_dir(&target).context("文件夹非空或删不掉")?;
    Ok(target)
}

// ------------------------------------------------------------------ 文件操作

/// 同名时加 ` (2)`、` (3)`…… **不覆盖**已有文件。
///
/// 覆盖同名文件是不可逆的：DJ 的两个 set 里同名不同 mix 的文件很常见
/// （`Track - Artist.mp3` 可能是 radio edit 也可能是 extended），
/// 静默覆盖会直接丢掉一首歌。
pub fn unique_target(directory: &Path, filename: &str) -> Result<PathBuf> {
    let target = directory.join(filename);
    if !target.exists() {
        return Ok(target);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let suffix = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..1000 {
        let candidate = directory.join(format!("{stem} ({index}){suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    bail!("目标目录里同名文件太多")
}

pub fn move_file(source: &Path, directory: &Path) -> Result<PathBuf> {
    let name = source
        .file_name()
        .context("源文件没有文件名")?
        .to_string_lossy()
        .into_owned();
    let target = unique_target(directory, &name)?;
    // rename 跨卷会报 EXDEV，退回"复制 + 删除"。
    // 用户完全可能把外置硬盘上的歌拖进内置盘的文件夹里，必须支持跨卷。
    if std::fs::rename(source, &target).is_err() {
        std::fs::copy(source, &target).context("跨卷复制失败")?;
        std::fs::remove_file(source).context("复制后删除源文件失败")?;
    }
    Ok(target)
}

/// 真复制一份到目录（不共享 inode）。返回新路径。
pub fn copy_file(source: &Path, directory: &Path) -> Result<PathBuf> {
    let name = source
        .file_name()
        .context("源文件没有文件名")?
        .to_string_lossy()
        .into_owned();
    let target = unique_target(directory, &name)?;
    std::fs::copy(source, &target).context("复制失败")?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kdj-folders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // canonicalize 一次，免得 macOS 上 /var 与 /private/var 的差异干扰包含性判断
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn containment_blocks_escapes() {
        let root = scratch("contain");
        let roots = vec![root.clone()];
        assert!(ensure_inside(&root.join("sub"), &roots).is_ok());
        assert!(ensure_inside(&root, &roots).is_ok(), "根目录自己也算在内");
        assert!(ensure_inside(Path::new("/etc"), &roots).is_err());
        assert!(ensure_inside(&root.join("../.."), &roots).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn containment_is_not_fooled_by_a_sibling_with_the_same_prefix() {
        // 字符串前缀比较会把 Music-evil 当成 Music 的子目录
        let base = scratch("prefix");
        let root = base.join("Music");
        let evil = base.join("Music-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        let roots = vec![root];
        assert!(ensure_inside(&evil, &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_outside_the_library_is_rejected() {
        let base = scratch("symlink");
        let root = base.join("lib");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let roots = vec![root.clone()];
        // 词法上 lib/escape 在 lib 里，但 realpath 指到了界外
        assert!(ensure_inside(&root.join("escape"), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_roots_collapse_to_the_outermost() {
        let base = scratch("roots");
        let outer = base.join("djay");
        let inner = outer.join("wenzhou");
        std::fs::create_dir_all(&inner).unwrap();

        let roots = resolve_roots(&[
            outer.to_string_lossy().into_owned(),
            inner.to_string_lossy().into_owned(),
        ]);
        assert_eq!(roots, vec![outer], "内层根会让同一批歌在树上出现两次");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_directories_are_dropped_from_roots() {
        let base = scratch("missing-root");
        let roots = resolve_roots(&[
            base.to_string_lossy().into_owned(),
            base.join("nope").to_string_lossy().into_owned(),
            String::new(),
        ]);
        assert_eq!(roots, vec![base.clone()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_roundtrips_and_bad_json_degrades_to_empty() {
        let dir = scratch("manifest");
        assert!(!has_manifest(&dir));
        write_manifest(&dir, &["b".into(), "a".into()]).unwrap();
        assert!(has_manifest(&dir));
        assert_eq!(read_manifest_order(&dir), vec!["b", "a"]);
        assert!(manifest_path(&dir).is_file());
        assert!(!legacy_manifest_path(&dir).exists());

        // 坏清单不该让整棵树打不开
        std::fs::write(manifest_path(&dir), "{ not json").unwrap();
        assert_eq!(read_manifest_order(&dir), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_manifest_and_lyrics_do_not_rewrite_flash_files() {
        let dir = scratch("sidecar-noop");
        let order = vec!["b".to_string(), "a".to_string()];
        write_manifest(&dir, &order).unwrap();
        let manifest = manifest_path(&dir);
        let manifest_before = std::fs::metadata(&manifest).unwrap().modified().unwrap();

        let audio = dir.join("song.flac");
        std::fs::write(&audio, b"audio").unwrap();
        write_lyrics(&audio, "wyy", "42", "[00:01]词", "", "").unwrap();
        let lyric = lyrics_paths(&audio, "wyy", "42").unwrap().main;
        let lyric_before = std::fs::metadata(&lyric).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));

        write_manifest(&dir, &order).unwrap();
        write_lyrics(&audio, "wyy", "42", "[00:01]词", "", "").unwrap();

        assert_eq!(
            manifest_before,
            std::fs::metadata(manifest).unwrap().modified().unwrap()
        );
        assert_eq!(
            lyric_before,
            std::fs::metadata(lyric).unwrap().modified().unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lyrics_roundtrip_uses_source_key_not_track_id() {
        let dir = scratch("lyrics");
        let audio = dir.join("song.flac");
        std::fs::write(&audio, b"audio").unwrap();

        assert!(write_lyrics(
            &audio,
            "wyy",
            "123/abc",
            "[00:01.00]主歌词",
            "[00:01.00]翻译",
            "[00:01.00]romaji",
        )
        .unwrap());
        let stored = read_lyrics(&audio, "wyy", "123/abc").unwrap().unwrap();
        assert_eq!(stored.lrc, "[00:01.00]主歌词");
        assert!(stored.word_lrc.is_empty());
        assert_eq!(stored.translated_lrc, "[00:01.00]翻译");
        assert_eq!(stored.romaji_lrc, "[00:01.00]romaji");
        assert_eq!(stored.platform, "wyy");
        assert_eq!(stored.key, "123/abc");
        assert!(dir.join(".kdj/lyrics").is_dir());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_less_track_lyrics_roundtrip_under_a_local_stable_key() {
        let dir = scratch("local-lyrics");
        let audio = dir.join("没有来源的歌.flac");
        std::fs::write(&audio, b"audio").unwrap();
        let cached = StoredLyrics {
            lrc: "[00:01.00]主歌词".into(),
            word_lrc: "[1000,500](1000,500,0)逐字".into(),
            translated_lrc: "[00:01.00]翻译".into(),
            platform: "wyy".into(),
            key: "42".into(),
            title: "没有来源的歌".into(),
            artist: "歌手".into(),
            score: 0.92,
            ..StoredLyrics::default()
        };

        assert!(write_lyrics_cache(&audio, "local", "", &cached).unwrap());
        let stored = read_lyrics(&audio, "local", "").unwrap().unwrap();
        assert_eq!(stored.lrc, cached.lrc);
        assert_eq!(stored.word_lrc, cached.word_lrc);
        assert_eq!(stored.translated_lrc, cached.translated_lrc);
        assert_eq!(stored.platform, "wyy");
        assert_eq!(stored.key, "42");
        assert_eq!(stored.title, "没有来源的歌");
        assert_eq!(stored.artist, "歌手");
        assert_eq!(stored.score, 0.92);

        let paths = lyrics_paths(&audio, "local", "").unwrap();
        assert!(paths.main.is_file());
        assert!(paths.word.is_file());
        assert!(paths.metadata.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_manifest_is_read_then_migrated_without_losing_order() {
        let root = scratch("manifest-legacy");
        let legacy = legacy_manifest_path(&root);
        std::fs::write(
            &legacy,
            r#"{"version":1,"order":["二.mp3","一.mp3"],"future":"keep"}"#,
        )
        .unwrap();
        assert_eq!(read_manifest_order(&root), vec!["二.mp3", "一.mp3"]);

        let roots = vec![root.clone()];
        assert_eq!(init_manifests(&root, &roots).unwrap(), 1);
        assert!(!legacy.exists(), "校验成功后旧 sidecar 才能删除");
        assert!(manifest_path(&root).is_file());
        assert!(legacy_backup_path(&root).is_file());
        let migrated = read_manifest_file(&manifest_path(&root)).unwrap();
        assert_eq!(migrated["future"], "keep", "未知字段不能在升级时丢掉");
        assert_eq!(read_manifest_order(&root), vec!["二.mp3", "一.mp3"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_new_manifest_falls_back_to_the_legacy_copy() {
        let root = scratch("manifest-fallback");
        std::fs::create_dir_all(metadata_dir(&root)).unwrap();
        std::fs::write(manifest_path(&root), "{ broken").unwrap();
        std::fs::write(
            legacy_manifest_path(&root),
            r#"{"version":1,"order":["safe.mp3"]}"#,
        )
        .unwrap();
        assert_eq!(read_manifest_order(&root), vec!["safe.mp3"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_legacy_manifest_is_backed_up_but_never_deleted() {
        let root = scratch("manifest-corrupt-legacy");
        let legacy = legacy_manifest_path(&root);
        std::fs::write(&legacy, "{ broken").unwrap();
        let roots = vec![root.clone()];

        assert!(init_manifests(&root, &roots).is_err());
        assert!(legacy.is_file(), "坏旧文件必须原地保留");
        assert_eq!(
            std::fs::read_to_string(legacy_backup_path(&root)).unwrap(),
            "{ broken"
        );
        assert!(!manifest_path(&root).exists(), "不能拿空顺序掩盖损坏");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_order_keeps_listed_first_and_new_ones_after() {
        let dir = scratch("order");
        for name in ["5月", "6yue", "7yue", "brand-new"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        // 清单里还列了一个已经被删掉的目录
        let listed = vec![
            "7yue".to_string(),
            "5月".to_string(),
            "deleted".to_string(),
            "6yue".to_string(),
        ];
        let ordered = apply_order(&dir, &listed);
        assert_eq!(
            ordered,
            vec!["7yue", "5月", "6yue", "brand-new"],
            "清单顺序优先，新目录排后面，已删的丢掉"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_and_noisy_directories_are_skipped() {
        let dir = scratch("skip");
        for name in [".hidden", "node_modules", ".git", "real"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        assert_eq!(child_names(&dir), vec!["real"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_files_are_counted_by_extension_only_at_this_level() {
        let dir = scratch("count");
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        std::fs::write(dir.join("b.flac"), b"x").unwrap();
        std::fs::write(dir.join("c.txt"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.mp3"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/d.mp3"), b"x").unwrap();

        assert_eq!(
            count_audio_files(&dir),
            2,
            "只数本层、只数音频、跳过隐藏文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_files_count_as_library_media() {
        // 树上的"磁盘有几个"必须和扫描认的后缀是同一份，否则待入库数永远清不掉
        let dir = scratch("count-video");
        std::fs::write(dir.join("a.mkv"), b"x").unwrap();
        std::fs::write(dir.join("b.mov"), b"x").unwrap();
        std::fs::write(dir.join("c.mp3"), b"x").unwrap();
        std::fs::write(dir.join("d.jpg"), b"x").unwrap();
        assert_eq!(count_audio_files(&dir), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_manifest_is_not_reported_as_managed() {
        // 清单坏掉时树实际按名字排；这时报 managed=true 会让用户以为自己排的顺序丢了
        let base = scratch("managed");
        let root = base.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(metadata_dir(&root)).unwrap();
        std::fs::write(manifest_path(&root), "{ not json").unwrap();

        let tree = build_tree(&[root.to_string_lossy().into_owned()], &[]);
        assert!(!tree.roots[0].managed, "坏清单不算受管");

        write_manifest(&root, &[]).unwrap();
        let tree = build_tree(&[root.to_string_lossy().into_owned()], &[]);
        assert!(tree.roots[0].managed, "写过清单就是受管");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cross_volume_move_copies_the_whole_tree_then_drops_the_source() {
        // 真跨卷没法在测试里造，直接验搬运本身：整棵树过去、源目录清干净
        let base = scratch("xdev");
        let source = base.join("set1");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("a.mp3"), b"aaa").unwrap();
        std::fs::write(source.join("sub/b.mp3"), b"bbb").unwrap();

        let target = base.join("moved");
        move_dir_across_volumes(&source, &target).unwrap();

        assert!(!source.exists(), "源目录要清掉");
        assert_eq!(std::fs::read(target.join("a.mp3")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(target.join("sub/b.mp3")).unwrap(), b"bbb");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tree_counts_roll_up_and_report_pending() {
        let base = scratch("tree");
        let root = base.join("lib");
        let set = root.join("set1");
        std::fs::create_dir_all(&set).unwrap();
        // 磁盘上两个文件，库里只有一个 → pending = 1
        std::fs::write(set.join("a.mp3"), b"x").unwrap();
        std::fs::write(set.join("b.mp3"), b"x").unwrap();

        let tree = build_tree(
            &[root.to_string_lossy().into_owned()],
            &[set.join("a.mp3").to_string_lossy().into_owned()],
        );
        assert_eq!(tree.roots.len(), 1);
        let root_node = &tree.roots[0];
        assert!(root_node.is_root);
        assert_eq!(root_node.total_count, 1, "累计到根");
        assert_eq!(root_node.track_count, 0, "根目录本层没有歌");
        assert_eq!(root_node.pending_count, 1, "磁盘 2 个、库里 1 个");
        assert_eq!(tree.outside, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tracks_outside_every_root_are_counted_as_outside() {
        let base = scratch("outside");
        let root = base.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let tree = build_tree(
            &[root.to_string_lossy().into_owned()],
            &["/somewhere/else/a.mp3".to_string()],
        );
        assert_eq!(tree.outside, 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unique_target_never_overwrites() {
        let dir = scratch("unique");
        std::fs::write(dir.join("song.mp3"), b"first").unwrap();
        let target = unique_target(&dir, "song.mp3").unwrap();
        assert_eq!(target.file_name().unwrap(), "song (2).mp3");

        std::fs::write(&target, b"second").unwrap();
        let third = unique_target(&dir, "song.mp3").unwrap();
        assert_eq!(third.file_name().unwrap(), "song (3).mp3");
        // 原文件必须原封不动
        assert_eq!(std::fs::read(dir.join("song.mp3")).unwrap(), b"first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_names_are_validated() {
        assert!(validate_name("正常").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn a_folder_cannot_be_moved_into_itself() {
        let base = scratch("move-self");
        let root = base.join("lib");
        let set = root.join("set1");
        let sub = set.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let roots = vec![root];

        let err = move_folder(&set, &sub, &roots).unwrap_err().to_string();
        assert!(err.contains("它自己"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn moving_onto_an_existing_name_refuses_instead_of_merging() {
        let base = scratch("move-clash");
        let root = base.join("lib");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(a.join("set")).unwrap();
        std::fs::create_dir_all(b.join("set")).unwrap();
        let roots = vec![root];

        let err = move_folder(&a.join("set"), &b, &roots)
            .unwrap_err()
            .to_string();
        assert!(err.contains("同名"), "{err}");
        // 两边都还在，没被静默合并
        assert!(a.join("set").is_dir());
        assert!(b.join("set").is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn roots_are_protected_from_rename_move_and_delete() {
        let base = scratch("root-guard");
        let root = base.join("lib");
        std::fs::create_dir_all(root.join("other")).unwrap();
        let roots = vec![root.clone()];

        assert!(rename_folder(&root, "new", &roots).is_err());
        assert!(delete_folder(&root, &roots).is_err());
        assert!(move_folder(&root, &root.join("other"), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_only_removes_empty_folders() {
        let base = scratch("delete");
        let root = base.join("lib");
        let empty = root.join("empty");
        let full = root.join("full");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("a.mp3"), b"x").unwrap();
        let roots = vec![root];

        write_manifest(&empty, &[]).unwrap();
        assert!(
            delete_folder(&empty, &roots).is_ok(),
            "只有 .kdj 元数据仍算空目录"
        );
        assert!(!empty.exists());
        assert!(delete_folder(&full, &roots).is_err(), "非空目录不能删");
        assert!(full.join("a.mp3").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_file_creates_an_independent_local_file() {
        let base = scratch("copy");
        let source_dir = base.join("src");
        let dest_dir = base.join("dst");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        let source = source_dir.join("song.mp3");
        std::fs::write(&source, b"audio").unwrap();
        let target = copy_file(&source, &dest_dir).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"audio");
        std::fs::write(&target, b"changed").unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"audio");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn init_manifests_does_not_overwrite_existing_order() {
        let base = scratch("init");
        let root = base.join("lib");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        write_manifest(&root, &["b".into(), "a".into()]).unwrap();
        let roots = vec![root.clone()];

        let created = init_manifests(&root, &roots).unwrap();
        assert_eq!(created, 2, "只给 a、b 两个子目录新建");
        assert_eq!(read_manifest_order(&root), vec!["b", "a"], "已有顺序不动");
        let _ = std::fs::remove_dir_all(&base);
    }
}
