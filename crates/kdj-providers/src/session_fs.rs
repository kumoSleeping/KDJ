//! 登录态文件的统一安全落盘工具。

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};

/// 账号状态刷新可能并发触发多次落盘。一次会话写入本来只有几 KB，串行化远比让
/// 两个提交互相抢临时文件安全；唯一临时文件再负责隔离异常启动的第二个进程。
static SESSION_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn ensure_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("创建会话目录失败：{}", path.display()))?;
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("校验会话目录失败：{}", path.display()))?;
    if !metadata.file_type().is_dir() {
        bail!("会话目录不是普通目录：{}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("保护会话目录失败：{}", path.display()))?;
    }
    Ok(())
}

pub(crate) fn protect_existing_private_file(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("校验会话文件失败：{}", path.display()))
        }
    };
    if !metadata.file_type().is_file() {
        bail!("会话文件不是普通文件：{}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("保护会话文件失败：{}", path.display()))?;
    }
    Ok(())
}

fn create_private_temp(path: &Path) -> Result<(PathBuf, fs::File)> {
    let parent = path.parent().context("会话文件缺少父目录")?;
    let name = path
        .file_name()
        .context("会话文件缺少文件名")?
        .to_string_lossy();
    for _ in 0..32 {
        let candidate = parent.join(format!(".{name}.tmp-{:016x}", rand::random::<u64>()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("创建会话临时文件失败：{}", candidate.display()))
            }
        }
    }
    bail!("无法为会话文件分配唯一临时文件：{}", path.display())
}

#[cfg(windows)]
fn commit_private_temp(tmp: &Path, path: &Path) -> Result<()> {
    if !path.exists() {
        return fs::rename(tmp, path)
            .with_context(|| format!("提交会话文件失败：{}", path.display()));
    }

    // Windows 的 rename 不能覆盖现有文件。先把旧凭证移到同目录备份；新文件提交
    // 失败时立即恢复，绝不能像旧实现那样先删正式文件、再发现临时文件不可用。
    let parent = path.parent().context("会话文件缺少父目录")?;
    let name = path
        .file_name()
        .context("会话文件缺少文件名")?
        .to_string_lossy();
    let backup = (0..32)
        .map(|_| parent.join(format!(".{name}.backup-{:016x}", rand::random::<u64>())))
        .find(|candidate| !candidate.exists())
        .context("无法为旧会话分配临时备份")?;
    fs::rename(path, &backup).with_context(|| format!("暂存旧会话文件失败：{}", path.display()))?;
    if let Err(commit_error) = fs::rename(tmp, path) {
        if let Err(restore_error) = fs::rename(&backup, path) {
            bail!(
                "提交新会话失败：{commit_error}；恢复旧会话也失败：{restore_error}；旧会话保留在 {}",
                backup.display()
            );
        }
        return Err(commit_error).with_context(|| format!("提交会话文件失败：{}", path.display()));
    }
    // 新文件已经成为正式会话后，备份清理失败只会留下一个私有残留文件，不能再把
    // 整次提交报成失败；否则调用方会保留旧内存状态，而磁盘其实已经是新状态。
    if let Err(error) = fs::remove_file(&backup) {
        tracing::warn!("清理旧会话备份失败 {}：{error}", backup.display());
    }
    Ok(())
}

#[cfg(not(windows))]
fn commit_private_temp(tmp: &Path, path: &Path) -> Result<()> {
    // Unix rename 会原子替换目标；失败时旧目标保持原样，绝不主动删除。
    fs::rename(tmp, path).with_context(|| format!("提交会话文件失败：{}", path.display()))
}

/// 在私有目录内以私有权限创建唯一临时文件，再原子提交。
pub(crate) fn write_private_atomic(path: &Path, body: &[u8]) -> Result<()> {
    let _write_guard = SESSION_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = path.parent().context("会话文件缺少父目录")?;
    ensure_private_dir(parent)?;
    let (tmp, mut file) = create_private_temp(path)?;
    let write_result = file
        .write_all(body)
        .and_then(|_| file.sync_all())
        .with_context(|| format!("写入会话临时文件失败：{}", tmp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    protect_existing_private_file(&tmp)?;
    if let Err(error) = commit_private_temp(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    protect_existing_private_file(path)?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        if let Err(error) = directory.sync_all() {
            // 正式文件已经原子替换；这里报失败会让调用方保留旧内存凭证，反而分叉。
            tracing::warn!("同步会话目录失败 {}：{error}", parent.display());
        }
    }
    Ok(())
}

/// 串行删除会话文件。文件不存在视为已经清理成功；其他错误必须交给调用方，
/// 由调用方决定是否保留内存登录态，不能向用户伪报“已退出”。
pub(crate) fn remove_private_file(path: &Path) -> Result<bool> {
    let _write_guard = SESSION_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("删除会话文件失败：{}", path.display())),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn private_write_hardens_existing_directory_and_file() {
        let root = std::env::temp_dir().join(format!(
            "kdj-private-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let path = root.join("provider.json");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private_atomic(&path, b"new").unwrap();

        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn session_paths_reject_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "kdj-session-symlink-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let real_dir = root.join("real");
        fs::create_dir_all(&real_dir).unwrap();
        let linked_dir = root.join("sessions");
        symlink(&real_dir, &linked_dir).unwrap();
        assert!(ensure_private_dir(&linked_dir).is_err());

        let real_file = real_dir.join("outside.json");
        fs::write(&real_file, b"outside").unwrap();
        let linked_file = root.join("linked.json");
        symlink(&real_file, &linked_file).unwrap();
        assert!(protect_existing_private_file(&linked_file).is_err());
        assert_eq!(fs::read(&real_file).unwrap(), b"outside");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_private_writes_never_delete_or_truncate_the_session() {
        use std::sync::{Arc, Barrier};

        let root = std::env::temp_dir().join(format!(
            "kdj-concurrent-session-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = Arc::new(root.join("provider.json"));
        let bodies = Arc::new(
            (0..16)
                .map(|index| {
                    let mut body = format!("writer-{index:02}:").into_bytes();
                    body.resize(64 * 1024, b'a' + index as u8);
                    body
                })
                .collect::<Vec<_>>(),
        );
        let barrier = Arc::new(Barrier::new(bodies.len()));
        let handles = bodies
            .iter()
            .cloned()
            .map(|body| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..4 {
                        write_private_atomic(&path, &body)?;
                    }
                    Result::<()>::Ok(())
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let final_body = fs::read(path.as_ref()).unwrap();
        assert!(bodies.iter().any(|body| body == &final_body));
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(|entry| entry.ok())
                .count(),
            1,
            "成功提交后不应残留临时文件"
        );
        assert_eq!(
            fs::metadata(path.as_ref()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(root);
    }
}
