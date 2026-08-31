//! 桌面历史数据的无感自愈。
//!
//! 旧 Windows 正式版用 `rename(tmp, settings.json)` 覆盖文件；Unix 会原子替换，
//! Windows 却返回 AlreadyExists。旧调用方又吞掉了错误，所以设置/登录在当次运行
//! 看似正常，更新重启后才突然回到很早的磁盘副本。本模块不猜某一个发布渠道：
//! 它合并所有确实存在的历史目录，并从仍在的曲库路径重建缺失根目录。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use kdj_core::AppConfig;
use serde::{Deserialize, Serialize};

const JOURNAL_NAME: &str = ".data-recovery-v2.json";
const BACKUP_DIR_NAME: &str = ".data-recovery-v2-backups";
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RecoveryReport {
    pub sources: usize,
    pub databases: usize,
    pub sessions: usize,
    pub settings: usize,
    pub files: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RecoveryJournal {
    #[serde(default)]
    pending: Vec<PendingSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingSource {
    source: String,
    backup: String,
    #[serde(default)]
    quarantined: bool,
    #[serde(default)]
    verified_launches: u8,
}

fn fnv1a(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn unique_temp(path: &Path, label: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let serial = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{name}.{label}-{}-{serial}", std::process::id()))
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<()> {
    let parent = path.parent().context("恢复文件没有父目录")?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = None;
    for _ in 0..32 {
        let candidate = unique_temp(path, "recovery-tmp");
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    let (tmp, mut file) = temporary.context("无法分配恢复临时文件")?;
    let result = (|| -> Result<()> {
        file.write_all(body)?;
        file.sync_all()?;
        drop(file);
        commit_temp(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

#[cfg(not(windows))]
fn commit_temp(tmp: &Path, target: &Path) -> Result<()> {
    std::fs::rename(tmp, target).with_context(|| format!("提交恢复文件失败：{}", target.display()))
}

#[cfg(windows)]
fn commit_temp(tmp: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return std::fs::rename(tmp, target)
            .with_context(|| format!("提交恢复文件失败：{}", target.display()));
    }
    anyhow::ensure!(
        std::fs::symlink_metadata(target)?.file_type().is_file(),
        "恢复目标不是普通文件：{}",
        target.display()
    );
    let backup = unique_temp(target, "recovery-rollback");
    std::fs::rename(target, &backup)?;
    if let Err(error) = std::fs::rename(tmp, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(error.into());
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

fn read_json_object(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_JSON_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .as_object()
        .cloned()
}

fn json_has_payload(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        serde_json::Value::String(value) => !value.trim().is_empty(),
        serde_json::Value::Array(values) => values.iter().any(json_has_payload),
        serde_json::Value::Object(values) => values.values().any(json_has_payload),
    }
}

fn logical_session_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.strip_suffix(".json.tmp")
        .map(|stem| format!("{stem}.json"))
        .unwrap_or_else(|| name.to_string())
}

fn valid_session_as(path: &Path, logical_name: &str) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_JSON_BYTES {
        return false;
    }
    if !logical_name.to_ascii_lowercase().ends_with(".json") {
        return true;
    }
    let Some(value) = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return false;
    };
    if logical_name.eq_ignore_ascii_case("netease.json") {
        return value
            .get("cookies")
            .and_then(|cookies| cookies.get("MUSIC_U"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|token| !token.trim().is_empty());
    }
    if logical_name.eq_ignore_ascii_case("qqmusic.json") {
        let key = value
            .get("musickey")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|token| !token.trim().is_empty());
        let id = value
            .get("musicid")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|id| id != 0);
        return key && id;
    }
    json_has_payload(&value)
}

fn valid_session(path: &Path) -> bool {
    valid_session_as(path, &logical_session_name(path))
}

fn copy_file_new(source: &Path, target: &Path) -> Result<bool> {
    if target.exists() {
        return Ok(false);
    }
    let metadata = std::fs::symlink_metadata(source)?;
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    let parent = target.parent().context("恢复目标没有父目录")?;
    std::fs::create_dir_all(parent)?;
    let mut output = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let result = (|| -> Result<()> {
        let mut input = std::fs::File::open(source)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        drop(output);
        let _ = std::fs::remove_file(target);
    }
    result.map(|_| true)
}

fn backup_invalid_file(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    for _ in 0..32 {
        let backup = unique_temp(path, "invalid-before-recovery-v2");
        if backup.exists() {
            continue;
        }
        std::fs::rename(path, backup)?;
        return Ok(());
    }
    anyhow::bail!("无法隔离损坏文件：{}", path.display())
}

/// Windows 旧版会把最新登录态写进 `*.json.tmp`，随后因无法覆盖正式文件而失败；
/// 与 settings 不同，它没有删除 tmp。当前正式文件若较新（用户已重新登录）就保留，
/// 否则把较新的有效 tmp 原子提升，校验成功后才删临时副本。
fn promote_current_session_temps(current: &Path) -> Result<usize> {
    let sessions = current.join("sessions");
    if !sessions.is_dir() {
        return Ok(0);
    }
    let mut promoted = 0;
    for entry in std::fs::read_dir(&sessions)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let source = entry.path();
        let source_name = entry.file_name().to_string_lossy().into_owned();
        if !source_name.to_ascii_lowercase().ends_with(".json.tmp") {
            continue;
        }
        let logical_name = logical_session_name(&source);
        if !valid_session_as(&source, &logical_name) {
            continue;
        }
        let target = sessions.join(&logical_name);
        if valid_session(&target) && modified_key(&target) >= modified_key(&source) {
            std::fs::remove_file(&source)?;
            continue;
        }
        let body = std::fs::read(&source)?;
        write_atomic(&target, &body)?;
        anyhow::ensure!(
            valid_session_as(&target, &logical_name),
            "提升后的登录凭证校验失败：{logical_name}"
        );
        std::fs::remove_file(&source)?;
        promoted += 1;
    }
    Ok(promoted)
}

fn merge_sessions(current: &Path, source: &Path) -> Result<usize> {
    let source_dir = source.join("sessions");
    if !source_dir.is_dir() {
        return Ok(0);
    }
    let target_dir = current.join("sessions");
    std::fs::create_dir_all(&target_dir)?;
    let mut copied = 0;
    let mut candidates = std::fs::read_dir(source_dir)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(modified_key(&entry.path())));
    let mut handled = HashSet::new();
    for entry in candidates {
        let logical_name = logical_session_name(&entry.path());
        // 较新的空壳或损坏文件不能抢占名额；继续向后找最近的有效凭证。
        if !valid_session_as(&entry.path(), &logical_name) || !handled.insert(logical_name.clone())
        {
            continue;
        }
        let target = target_dir.join(&logical_name);
        if valid_session(&target) {
            continue; // 用户已经在新版本重新登录：当前凭证永远优先。
        }
        let body = std::fs::read(entry.path())?;
        write_atomic(&target, &body)?;
        anyhow::ensure!(
            valid_session_as(&target, &logical_name),
            "补回的登录凭证校验失败：{logical_name}"
        );
        copied += 1;
    }
    Ok(copied)
}

fn settings_candidates(data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data_dir.join(kdj_core::config::SETTINGS_FILENAME)];
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return paths;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.starts_with(".settings.json.backup-")
            || name.starts_with(".settings.json.tmp-")
            || name == "settings.json.tmp"
            || name.contains("before-legacy-migration"))
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            paths.push(entry.path());
        }
    }
    paths
}

fn modified_key(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
}

/// 一次性比较全部历史副本，避免逐目录写回后“刚恢复的文件时间最新”，反过来压住
/// 另一个真正更新的旧副本。普通字段以最后一次有效写入为准；曲库目录永远做并集，
/// 且用户在当前版本刚重新添加的目录排在前面。
fn merge_settings(current: &Path, sources: &[PathBuf]) -> Result<usize> {
    let target = current.join(kdj_core::config::SETTINGS_FILENAME);
    let current_map = read_json_object(&target);
    let mut dirs = current_map
        .as_ref()
        .and_then(|map| map.get("library_dirs"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut dir_keys: HashSet<String> = dirs
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|path| kdj_core::paths::path_identity(Path::new(path)))
        .collect();

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for data_dir in std::iter::once(current).chain(sources.iter().map(PathBuf::as_path)) {
        for path in settings_candidates(data_dir) {
            let identity = kdj_core::paths::path_identity(&path);
            if !seen.insert(identity.clone()) {
                continue;
            }
            let Some(map) = read_json_object(&path) else {
                continue;
            };
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            // 同一时间戳（老 FAT/网络盘精度很低）时，失败提交留下的 tmp 是用户
            // 本来想写入的下一版；当前正式文件又应压过同刻的其他旧产品目录。
            let tie_priority =
                if name == "settings.json.tmp" || name.starts_with(".settings.json.tmp-") {
                    2_u8
                } else if path == target {
                    1_u8
                } else {
                    0_u8
                };
            candidates.push((modified_key(&path), tie_priority, identity, map));
        }
    }
    candidates.sort_by(|left, right| {
        (left.0, left.1, left.2.as_str()).cmp(&(right.0, right.1, right.2.as_str()))
    });

    let mut merged = serde_json::Map::new();
    for (_, _, _, source_map) in candidates {
        for (name, value) in source_map {
            if name == "library_dirs" {
                if let Some(source_dirs) = value.as_array() {
                    for value in source_dirs {
                        let Some(path) = value.as_str().filter(|path| !path.trim().is_empty())
                        else {
                            continue;
                        };
                        if dir_keys.insert(kdj_core::paths::path_identity(Path::new(path))) {
                            dirs.push(serde_json::Value::String(path.to_string()));
                        }
                    }
                }
            } else if !value.is_null() {
                merged.insert(name, value);
            }
        }
    }
    if !dirs.is_empty() {
        merged.insert("library_dirs".into(), serde_json::Value::Array(dirs));
    }
    if merged.is_empty() || current_map.as_ref() == Some(&merged) {
        return Ok(0);
    }
    if target.exists() && current_map.is_none() {
        backup_invalid_file(&target)?;
    }
    let mut body = serde_json::to_vec_pretty(&serde_json::Value::Object(merged))?;
    body.push(b'\n');
    write_atomic(&target, &body)?;
    anyhow::ensure!(
        read_json_object(&target).is_some(),
        "恢复后的 settings.json 校验失败"
    );
    Ok(1)
}

fn settings_files_are_valid(data_dir: &Path) -> bool {
    settings_candidates(data_dir).into_iter().all(|path| {
        !std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0)
            || read_json_object(&path).is_some()
    })
}

fn is_database_name(name: &str) -> bool {
    matches!(
        name,
        "kdj.db"
            | "kumodeck.db"
            | "kdj.db-wal"
            | "kumodeck.db-wal"
            | "kdj.db-shm"
            | "kumodeck.db-shm"
    )
}

fn copy_other_missing(source: &Path, target: &Path) -> Result<usize> {
    let mut copied = 0;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "sessions"
            || name == kdj_core::config::SETTINGS_FILENAME
            || name == "runtime.json"
            || name == JOURNAL_NAME
            || name == BACKUP_DIR_NAME
            || is_database_name(&name)
            || name.starts_with(".settings.json")
            || name.starts_with(".legacy-data")
            || name.starts_with(".retired-labs")
        {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            std::fs::create_dir_all(&destination)?;
            copied += copy_other_missing(&entry.path(), &destination)?;
        } else if kind.is_file() && copy_file_new(&entry.path(), &destination)? {
            copied += 1;
        }
    }
    Ok(copied)
}

fn data_dir_has_value(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    if ["kumodeck.db", "kdj.db", "settings.json"]
        .iter()
        .any(|name| std::fs::metadata(path.join(name)).is_ok_and(|meta| meta.len() > 0))
        || path.join("sessions").is_dir()
        || settings_candidates(path)
            .into_iter()
            .any(|candidate| std::fs::metadata(candidate).is_ok_and(|metadata| metadata.len() > 0))
    {
        return true;
    }
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
}

fn read_journal(current: &Path) -> RecoveryJournal {
    std::fs::read(current.join(JOURNAL_NAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn persist_journal(current: &Path, journal: &RecoveryJournal) -> Result<()> {
    let path = current.join(JOURNAL_NAME);
    if journal.pending.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    let mut body = serde_json::to_vec_pretty(journal)?;
    body.push(b'\n');
    write_atomic(&path, &body)
}

fn pending_source(current: &Path, source: &Path) -> PendingSource {
    let source_text = source.to_string_lossy().into_owned();
    let label = source
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().replace(['/', '\\'], "_"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "legacy".into());
    let backup = current
        .join(BACKUP_DIR_NAME)
        .join(format!("{label}-{:016x}", fnv1a(&source_text)));
    PendingSource {
        source: source_text,
        backup: backup.to_string_lossy().into_owned(),
        quarantined: false,
        verified_launches: 0,
    }
}

/// 合并所有当前用户配置根下真实存在的历史数据。单个旧目录损坏不会阻止应用启动；
/// 成功的源会进入两次启动确认的清理队列。
pub(crate) fn recover_desktop_data(current: &Path, candidates: &[PathBuf]) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    if let Err(error) = std::fs::create_dir_all(current) {
        report.errors.push(format!("创建当前数据目录失败：{error}"));
        return report;
    }
    let mut journal = read_journal(current);
    let mut seen = HashSet::new();
    seen.insert(kdj_core::paths::path_identity(current));

    let mut sources = Vec::new();
    for source in candidates {
        let identity = kdj_core::paths::path_identity(source);
        if !seen.insert(identity) || !data_dir_has_value(source) {
            continue;
        }
        report.sources += 1;
        sources.push(source.clone());
    }
    let settings_merged = match merge_settings(current, &sources) {
        Ok(changed) => {
            report.settings += changed;
            true
        }
        Err(error) => {
            report
                .errors
                .push(format!("恢复 settings.json 失败：{error:#}"));
            false
        }
    };

    // 这类临时文件就在当前数据目录里，即使没有找到任何历史目录也必须恢复。
    // Windows 旧版登录态覆盖失败后，最完整的一份往往正是 `*.json.tmp`。
    match promote_current_session_temps(current) {
        Ok(changed) => report.sessions += changed,
        Err(error) => report
            .errors
            .push(format!("恢复当前临时登录凭证失败：{error:#}")),
    }

    for source in &sources {
        let recovered = (|| -> Result<()> {
            anyhow::ensure!(
                settings_merged
                    || settings_candidates(source)
                        .iter()
                        .all(|path| !path.exists()),
                "settings.json 尚未安全合并"
            );
            anyhow::ensure!(
                settings_files_are_valid(source),
                "历史 settings.json 损坏，保留原目录等待后续恢复"
            );
            report.sessions += merge_sessions(current, source)?;
            let canonical = current.join(kdj_core::config::DB_FILENAME);
            for name in [kdj_core::config::DB_FILENAME, "kdj.db"] {
                let legacy = source.join(name);
                if !std::fs::metadata(&legacy).is_ok_and(|meta| meta.len() > 0) {
                    continue;
                }
                kdj_library::db::merge_legacy_database(&canonical, &legacy)?;
                let missing = kdj_library::db::missing_legacy_database_paths(&canonical, &legacy)?;
                anyhow::ensure!(missing == 0, "数据库合并后仍缺 {missing} 条路径");
                report.databases += 1;
            }
            report.files += copy_other_missing(source, current)?;
            Ok(())
        })();
        match recovered {
            Ok(()) => {
                let source_text = source.to_string_lossy();
                if !journal.pending.iter().any(|entry| {
                    kdj_core::paths::paths_equivalent(
                        Path::new(&entry.source),
                        Path::new(source_text.as_ref()),
                    )
                }) {
                    journal.pending.push(pending_source(current, source));
                }
            }
            Err(error) => report
                .errors
                .push(format!("恢复 {} 失败：{error:#}", source.display())),
        }
    }
    if let Err(error) = persist_journal(current, &journal) {
        report.errors.push(format!("记录恢复进度失败：{error:#}"));
    }
    report
}

/// 只有内嵌服务已成功启动后才调用。第一次成功把旧目录原子挪进当前数据目录的隔离
/// 备份；第二次成功启动再删备份。任何一步失败都保留原件并在下次重试。
pub(crate) fn finalize_recovery_cleanup(current: &Path) {
    let mut journal = read_journal(current);
    let mut keep = Vec::new();
    for mut entry in journal.pending {
        let source = PathBuf::from(&entry.source);
        let backup = PathBuf::from(&entry.backup);
        if !entry.quarantined {
            if !source.exists() && backup.exists() {
                entry.quarantined = true;
            } else if source.exists() {
                if let Some(parent) = backup.parent() {
                    if let Err(error) = std::fs::create_dir_all(parent) {
                        tracing::warn!("创建历史数据隔离目录失败：{error}");
                        keep.push(entry);
                        continue;
                    }
                }
                match std::fs::rename(&source, &backup) {
                    Ok(()) => entry.quarantined = true,
                    Err(error) => {
                        tracing::warn!("隔离历史数据失败 {}：{error}", source.display());
                        keep.push(entry);
                        continue;
                    }
                }
            } else {
                continue;
            }
        }

        entry.verified_launches = entry.verified_launches.saturating_add(1);
        if entry.verified_launches >= 2 {
            match std::fs::remove_dir_all(&backup) {
                Ok(()) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!("清理已验证的历史数据失败 {}：{error}", backup.display())
                }
            }
        }
        keep.push(entry);
    }
    journal.pending = keep;
    if let Err(error) = persist_journal(current, &journal) {
        tracing::warn!("更新历史数据清理进度失败：{error:#}");
    }
}

fn is_hard_forbidden_root(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(
        name.as_str(),
        "windows" | "program files" | "program files (x86)" | "programdata" | "appdata"
    )
}

fn is_split_boundary(path: &Path) -> bool {
    if path.parent().is_none() || path.components().count() <= 1 {
        return true;
    }
    let home = kdj_core::config::home_dir();
    if kdj_core::paths::paths_equivalent(path, &home)
        || home
            .parent()
            .is_some_and(|parent| kdj_core::paths::paths_equivalent(path, parent))
    {
        return true;
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(
        name.as_str(),
        "users" | "documents and settings" | "volumes" | "mnt" | "media"
    )
}

fn common_ancestor(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut common = paths.first()?.clone();
    while !paths
        .iter()
        .all(|path| kdj_core::paths::is_within(&common, path))
    {
        if !common.pop() {
            return None;
        }
    }
    Some(common)
}

fn immediate_child(base: &Path, path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        let parent = current.parent()?;
        if kdj_core::paths::paths_equivalent(parent, base) {
            return Some(current);
        }
        current = parent.to_path_buf();
    }
}

fn safe_group_roots(paths: &[PathBuf], depth: usize) -> Vec<PathBuf> {
    if paths.is_empty() || depth > 8 {
        return Vec::new();
    }
    let Some(common) = common_ancestor(paths) else {
        return Vec::new();
    };
    if is_hard_forbidden_root(&common) {
        return Vec::new();
    }
    if !is_split_boundary(&common) {
        return common.is_dir().then_some(common).into_iter().collect();
    }
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for path in paths {
        let Some(child) = immediate_child(&common, path) else {
            continue;
        };
        groups
            .entry(kdj_core::paths::path_identity(&child))
            .or_default()
            .push(path.clone());
    }
    groups
        .into_values()
        .flat_map(|group| safe_group_roots(&group, depth + 1))
        .collect()
}

fn highest_manifest_root(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    let mut found = None;
    loop {
        if is_hard_forbidden_root(&current) || is_split_boundary(&current) {
            break;
        }
        if kdj_library::folders::has_manifest(&current) {
            found = Some(current.clone());
        }
        if !current.pop() {
            break;
        }
    }
    found
}

fn inferred_roots(configured: &[String], track_paths: &[String]) -> Vec<PathBuf> {
    let configured_paths: Vec<PathBuf> = configured
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(|path| kdj_core::paths::normalize_path(&kdj_core::config::expand_user(path)))
        .collect();
    let mut parents = Vec::new();
    let mut seen = HashSet::new();
    for path in track_paths {
        let Some(parent) = Path::new(path).parent() else {
            continue;
        };
        let parent = kdj_core::paths::normalize_path(parent);
        if !parent.is_dir()
            || configured_paths
                .iter()
                .any(|root| kdj_core::paths::is_within(root, &parent))
        {
            continue;
        }
        if seen.insert(kdj_core::paths::path_identity(&parent)) {
            parents.push(parent);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut unresolved = Vec::new();
    for parent in parents {
        if let Some(root) = highest_manifest_root(&parent) {
            if !roots
                .iter()
                .any(|existing| kdj_core::paths::paths_equivalent(existing, &root))
            {
                roots.push(root);
            }
        } else {
            unresolved.push(parent);
        }
    }
    if !unresolved.is_empty() {
        // 不同盘符/UNC 根分组，避免共同祖先退成空路径。
        let mut anchors: HashMap<String, Vec<PathBuf>> = HashMap::new();
        for path in unresolved {
            let anchor = path
                .components()
                .next()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .unwrap_or_default();
            anchors.entry(anchor.to_lowercase()).or_default().push(path);
        }
        for group in anchors.into_values() {
            roots.extend(safe_group_roots(&group, 0));
        }
    }
    roots.truncate(64);
    roots
}

/// 从仍在 SQLite 里的真实文件路径补回旧 Windows 版没有成功落盘的 `library_dirs`。
/// 已由用户在新版本添加的根优先保留；只追加尚未覆盖的路径，随后走 AppConfig 的
/// 原子提交，保证“当前运行看得到”和“下次启动仍存在”是同一件事。
pub(crate) fn repair_library_roots(config: &AppConfig) -> Result<usize> {
    if !config.db_path().is_file() {
        return Ok(0);
    }
    let database = kdj_library::db::Database::open(&config.db_path())?;
    let service = kdj_library::service::LibraryService::new(database);
    let paths = service.all_paths()?;
    if paths.is_empty() {
        return Ok(0);
    }
    let mut settings = config.to_settings();
    let additions = inferred_roots(&settings.library_dirs, &paths);
    let mut added = 0;
    for root in additions {
        if settings.library_dirs.iter().any(|existing| {
            let existing = kdj_core::config::expand_user(existing);
            kdj_core::paths::is_within(&existing, &root)
        }) {
            continue;
        }
        settings
            .library_dirs
            .push(root.to_string_lossy().into_owned());
        added += 1;
    }
    if added > 0 {
        config.apply_settings(settings)?;
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "kdj-recovery-{name}-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn insert_track(db: &Path, path: &str, rating: i64) {
        let database = kdj_library::db::Database::open(db).unwrap();
        database
            .conn()
            .unwrap()
            .execute(
                "INSERT INTO tracks (path, filename, rating, added_at, modified_at) \
                 VALUES (?, 'a.mp3', ?, 'now', 'now')",
                (path, rating),
            )
            .unwrap();
    }

    #[test]
    fn recovery_unions_readded_folders_and_preserves_current_sessions() {
        let root = scratch("merge");
        let current = root.join("com.kdj.app/data");
        let legacy = root.join("kdj/data");
        std::fs::create_dir_all(current.join("sessions")).unwrap();
        std::fs::create_dir_all(legacy.join("sessions")).unwrap();
        std::fs::write(
            current.join("settings.json"),
            br#"{"library_dirs":["/newly-readded"],"theme":"light"}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("settings.json"),
            br#"{"library_dirs":["/old-root"],"concurrent_downloads":7}"#,
        )
        .unwrap();
        // Windows 旧版覆盖失败时，用户刚提交的完整设置会留在这个临时文件里。
        std::fs::write(
            current.join("settings.json.tmp"),
            br#"{"library_dirs":["/newly-readded"],"theme":"dark"}"#,
        )
        .unwrap();
        std::fs::write(
            current.join("sessions/qqmusic.json"),
            br#"{"musickey":"current","musicid":1}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("sessions/qqmusic.json"),
            br#"{"musickey":"legacy","musicid":2}"#,
        )
        .unwrap();
        // 合法 JSON 不等于有效登录态：没有 MUSIC_U 的空壳必须允许旧凭证补回。
        std::fs::write(
            current.join("sessions/netease.json"),
            br#"{"cookies":{"__csrf":"only"},"profile":{"nickname":"stale"}}"#,
        )
        .unwrap();
        std::fs::write(
            current.join("sessions/netease.json.tmp"),
            br#"{"cookies":{"MUSIC_U":"newest-windows-temp"}}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("sessions/netease.json"),
            br#"{"cookies":{"MUSIC_U":"restored"}}"#,
        )
        .unwrap();
        insert_track(&legacy.join("kumodeck.db"), "/old-root/a.mp3", 5);

        let report = recover_desktop_data(&current, std::slice::from_ref(&legacy));

        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.databases, 1);
        assert_eq!(report.sessions, 1);
        let settings = read_json_object(&current.join("settings.json")).unwrap();
        let dirs = settings["library_dirs"].as_array().unwrap();
        assert!(dirs.iter().any(|value| value == "/newly-readded"));
        assert!(dirs.iter().any(|value| value == "/old-root"));
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["concurrent_downloads"], 7);
        assert_eq!(
            std::fs::read(current.join("sessions/qqmusic.json")).unwrap(),
            br#"{"musickey":"current","musicid":1}"#
        );
        assert!(valid_session(&current.join("sessions/netease.json")));
        assert_eq!(
            std::fs::read(current.join("sessions/netease.json")).unwrap(),
            br#"{"cookies":{"MUSIC_U":"newest-windows-temp"}}"#
        );
        assert!(!current.join("sessions/netease.json.tmp").exists());
        assert_eq!(
            kdj_library::db::missing_legacy_database_paths(
                &current.join("kumodeck.db"),
                &legacy.join("kumodeck.db")
            )
            .unwrap(),
            0
        );

        finalize_recovery_cleanup(&current);
        assert!(!legacy.exists(), "第一次成功启动后旧位置应被隔离");
        let journal = read_journal(&current);
        assert_eq!(journal.pending.len(), 1);
        assert!(Path::new(&journal.pending[0].backup).exists());
        finalize_recovery_cleanup(&current);
        assert!(read_journal(&current).pending.is_empty());
        assert!(!Path::new(&journal.pending[0].backup).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn roots_are_reconstructed_from_existing_database_paths() {
        let root = scratch("roots");
        let library = root.join("Music");
        std::fs::create_dir_all(library.join("Artist/Album")).unwrap();
        std::fs::create_dir_all(library.join("Another/Album")).unwrap();
        let song = library.join("Artist/Album/a.mp3");
        let second = library.join("Another/Album/b.mp3");
        std::fs::write(&song, b"audio").unwrap();
        std::fs::write(&second, b"audio").unwrap();
        let data = root.join("data");
        insert_track(
            &data.join(kdj_core::config::DB_FILENAME),
            &song.to_string_lossy(),
            0,
        );
        insert_track(
            &data.join(kdj_core::config::DB_FILENAME),
            &second.to_string_lossy(),
            0,
        );
        let config = AppConfig::create(data, root.join("downloads"), 0);

        let added = repair_library_roots(&config).unwrap();

        assert_eq!(added, 1);
        assert_eq!(
            config.to_settings().library_dirs,
            vec![library.to_string_lossy().into_owned()]
        );
        let reopened = AppConfig::create(config.data_dir.clone(), root.join("fallback"), 0);
        assert_eq!(
            reopened.to_settings().library_dirs,
            vec![library.to_string_lossy().into_owned()]
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
