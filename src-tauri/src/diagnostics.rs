//! Bounded desktop logs, available before Tauri/WebView/backend initialization.
//! Rust panic reports are persisted even when Windows has no attached console.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    limit: u64,
}

impl RotatingLog {
    fn open(path: PathBuf, limit: u64) -> io::Result<Self> {
        let file = open_append(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes,
            limit,
        })
    }

    fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        // Bound even a single pathological diagnostic; rotation retains one previous segment.
        let bytes = &bytes[..bytes.len().min(self.limit as usize)];
        if self.bytes.saturating_add(bytes.len() as u64) > self.limit {
            // Windows cannot rename an open file without the appropriate sharing flags.
            self.file.take();
            let previous = self.path.with_extension("previous.log");
            match std::fs::remove_file(&previous) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            std::fs::rename(&self.path, previous)?;
            self.bytes = 0;
        }
        if self.file.is_none() {
            self.file = Some(open_append(&self.path)?);
        }
        if let Some(file) = &mut self.file {
            file.write_all(bytes)?;
            self.bytes += bytes.len() as u64;
        }
        Ok(())
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[derive(Clone)]
pub struct DiagnosticWriter(Option<Arc<Mutex<RotatingLog>>>);

impl Write for DiagnosticWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Preserve terminal diagnostics during development; a missing console/file must not fail
        // playback. Never poison the application's state just because diagnostics are unavailable.
        let _ = io::stderr().write_all(bytes);
        if let Some(log) = &self.0 {
            if let Ok(mut log) = log.lock() {
                let _ = log.append(bytes);
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(()) // File writes are unbuffered.
    }
}

fn log_directory() -> Option<PathBuf> {
    if let Some(data) = std::env::var_os("KDJ_DATA_DIR") {
        return Some(PathBuf::from(data).join("logs"));
    }
    #[cfg(windows)]
    return std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(|base| PathBuf::from(base).join("com.kdj.app").join("logs"));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME")
        .map(|base| PathBuf::from(base).join("Library/Logs/com.kdj.app"));
    #[cfg(not(any(windows, target_os = "macos")))]
    return std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|base| PathBuf::from(base).join(".local/state")))
        .map(|base| base.join("kdj/logs"));
}

fn open_directory(directory: &Path) -> io::Result<RotatingLog> {
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    RotatingLog::open(directory.join("kdj.log"), MAX_LOG_BYTES)
}

pub fn initialize() -> (DiagnosticWriter, Option<PathBuf>) {
    let log = log_directory()
        .and_then(|directory| open_directory(&directory).ok())
        .or_else(|| open_directory(&std::env::temp_dir().join("kdj-logs")).ok());
    let path = log.as_ref().map(|log| log.path.clone());
    let log = log.map(|log| Arc::new(Mutex::new(log)));
    let panic_log = log.clone();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = &panic_log {
            // A panic during logging must not deadlock by trying to lock the same writer again.
            if let Ok(mut log) = log.try_lock() {
                let report = format!(
                    "\nRust panic: {info}\n{}\n",
                    std::backtrace::Backtrace::force_capture()
                );
                let _ = log.append(report.as_bytes());
            }
        }
        previous(info);
    }));
    (DiagnosticWriter(log), path)
}

pub fn startup_failed(error: &dyn std::fmt::Display, log_path: Option<&Path>, gui: bool) {
    let log_hint = log_path
        .map(|path| format!("\n\n日志：{}", path.display()))
        .unwrap_or_default();
    let message = format!("KDJ 启动失败：{error}{log_hint}");
    tracing::error!("{message}");
    #[cfg(windows)]
    if gui {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message
            .replace('\0', " ")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let title: Vec<u16> = "KDJ 启动失败".encode_utf16().chain(Some(0)).collect();
        // No AppHandle is needed: this also reports WebView2 / Tauri build failures.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = gui;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_closed_files_and_bounds_both_segments() {
        let directory = std::env::temp_dir().join(format!(
            "kdj-diagnostics-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("kdj.log");
        {
            let mut log = RotatingLog::open(path.clone(), 16).unwrap();
            log.append(b"first diagnostic").unwrap();
            log.append(b"next").unwrap();
            assert_eq!(
                std::fs::read(path.with_extension("previous.log")).unwrap(),
                b"first diagnostic"
            );
            assert_eq!(std::fs::read(&path).unwrap(), b"next");
            log.append(&[b'x'; 64]).unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().len(), 16);
            assert_eq!(
                std::fs::read(path.with_extension("previous.log")).unwrap(),
                b"next"
            );
        }
        // Existing logs survive another launch and rotate rather than growing indefinitely.
        {
            let mut log = RotatingLog::open(path.clone(), 16).unwrap();
            log.append(b"restarted").unwrap();
            assert_eq!(
                std::fs::metadata(path.with_extension("previous.log"))
                    .unwrap()
                    .len(),
                16
            );
            assert_eq!(std::fs::read(&path).unwrap(), b"restarted");
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
