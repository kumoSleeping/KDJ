//! Small, cross-platform persistence primitives for configuration and credentials.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};

static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);

/// Atomically replace `path` with `body` and keep the file private to the current user.
///
/// The temporary file is created in the destination directory, flushed before replacement, and
/// opened with mode 0600 on Unix. Windows uses `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)` so a
/// second save replaces the existing destination instead of failing like `std::fs::rename`.
pub fn atomic_write_private(path: &Path, body: &[u8]) -> Result<()> {
    let parent = path.parent().context("目标文件没有上级目录")?;
    fs::create_dir_all(parent).with_context(|| format!("创建目录失败：{}", parent.display()))?;

    if fs::read(path).is_ok_and(|current| current == body) {
        protect_private(path)?;
        return Ok(());
    }

    let (tmp, mut file) = create_private_temp(parent, path.file_name())?;
    let result = (|| -> Result<()> {
        file.write_all(body)
            .with_context(|| format!("写临时文件失败：{}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("同步临时文件失败：{}", tmp.display()))?;
        drop(file);
        replace_file(&tmp, path).with_context(|| format!("提交文件失败：{}", path.display()))?;
        protect_private(path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn create_private_temp(
    parent: &Path,
    file_name: Option<&std::ffi::OsStr>,
) -> Result<(PathBuf, File)> {
    let name = file_name
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "kdj".into());
    for _ in 0..32 {
        let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(".{name}.{}.{nonce}.partial", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        match options.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(err).with_context(|| format!("创建临时文件失败：{}", tmp.display()))
            }
        }
    }
    anyhow::bail!("无法为 {} 创建唯一临时文件", parent.display())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn protect_private(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("保护私密文件失败：{}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn sync_parent(parent: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("同步目录失败：{}", parent.display()))?;
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("kdj-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn consecutive_writes_replace_existing_content() {
        let dir = scratch("replace");
        let path = dir.join("session.json");
        atomic_write_private(&path, b"first").unwrap();
        atomic_write_private(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = scratch("permissions");
        let path = dir.join("session.json");
        atomic_write_private(&path, b"secret").unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
