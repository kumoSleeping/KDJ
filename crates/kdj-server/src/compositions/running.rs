//! What a running render needs beside its FFmpeg: a clock of when it last moved on, and a note
//! of the FFmpeg itself while it runs. A render ends as stuck only when it stops moving, never
//! for its length; and an FFmpeg that outlives its app (a crash, a forced quit, the dev build
//! restarting) is adopted by the system and would go on taking the CPU from the next start.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a render may go without moving on before it counts as stuck. Not a limit on its
/// length: a long export on a slow machine runs as long as it keeps going.
pub(super) const STALL: Duration = Duration::from_secs(5 * 60);

/// When a render last moved on (`moved`); `stalled` resolves once it has not for `STALL`.
#[derive(Clone)]
pub(super) struct Liveness(Arc<Mutex<Instant>>);
impl Liveness {
    pub(super) fn new() -> Self {
        Self(Arc::new(Mutex::new(Instant::now())))
    }
    pub(super) fn moved(&self) {
        *self.0.lock().unwrap() = Instant::now();
    }
    pub(super) async fn stalled(&self) {
        loop {
            let since = self.0.lock().unwrap().elapsed();
            if since >= STALL {
                return;
            }
            tokio::time::sleep(STALL - since).await;
        }
    }
}

/// Where each render's FFmpeg is written down while it runs: `<pid>.json`, its owner (this
/// process) and the output it writes. Unset (nothing written down) until `track`.
static NOTES: OnceLock<PathBuf> = OnceLock::new();

/// One FFmpeg written down; the note goes when this does (the FFmpeg has ended or been killed).
pub(super) struct Running(Option<PathBuf>);
impl Running {
    pub(super) fn note(pid: Option<u32>, output: &str) -> Self {
        let (Some(dir), Some(pid)) = (NOTES.get(), pid) else {
            return Self(None);
        };
        let path = dir.join(format!("{pid}.json"));
        let note = serde_json::json!({"owner": std::process::id(), "output": output});
        Self(std::fs::write(&path, note.to_string()).is_ok().then_some(path))
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A note read back: the FFmpeg's pid, its owner's and the output it was started for.
fn read(path: &Path) -> Option<(u32, u32, String)> {
    let pid = path.file_stem()?.to_str()?.parse().ok()?;
    let note: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some((pid, u32::try_from(note["owner"].as_u64()?).ok()?, note["output"].as_str()?.to_owned()))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use sysinfo::System;

/// The mobile builds run no FFmpeg and have no process table to read: nothing is killed there,
/// and every owner counts as running, so nothing of theirs is removed.
#[cfg(any(target_os = "android", target_os = "ios"))]
struct System;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn processes() -> System {
    let mut system = System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn processes() -> System {
    System
}

/// Kills `pid` only while it is still the FFmpeg that was written down: its command line names
/// that output. A pid the system has since given to something else is left alone.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn kill(system: &System, pid: u32, output: &str) -> bool {
    system.process(sysinfo::Pid::from_u32(pid)).is_some_and(|process| {
        process.cmd().iter().any(|arg| arg.to_string_lossy() == output) && process.kill()
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn kill(_: &System, _: u32, _: &str) -> bool {
    false
}

/// Whether `pid` is a KDJ still running (another build sharing this data directory may be
/// rendering): its executable is named for KDJ.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn kdj_running(system: &System, pid: u32) -> bool {
    system.process(sysinfo::Pid::from_u32(pid)).is_some_and(|process| {
        process.name().to_string_lossy().to_ascii_lowercase().contains("kdj")
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn kdj_running(_: &System, _: u32) -> bool {
    true
}

/// Starts writing renders down in `dir`, first stopping the FFmpeg an earlier run left: one
/// whose owner no longer runs. Answers how many were stopped.
pub fn track(dir: PathBuf) -> usize {
    if std::fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    let system = processes();
    let me = std::process::id();
    let mut stopped = 0;
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = entry.path();
        match read(&path) {
            Some((_, owner, _)) if owner != me && kdj_running(&system, owner) => continue,
            Some((pid, _, output)) => stopped += usize::from(kill(&system, pid, &output)),
            None => {}
        }
        let _ = std::fs::remove_file(&path);
    }
    let _ = NOTES.set(dir);
    if stopped > 0 {
        crate::diagnostics::record("warn", "render", "orphans", &format!("停止了上次退出时留下的 {stopped} 个合成进程"));
    }
    stopped
}

/// Stops every FFmpeg this process is running for a render: on quitting, before the runtime
/// that would have killed them with their tasks is torn down without dropping them.
pub fn stop_all() {
    let Some(dir) = NOTES.get() else { return };
    let system = processes();
    let me = std::process::id();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if let Some((pid, owner, output)) = read(&path) {
            if owner == me {
                kill(&system, pid, &output);
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pid no process has: far above any the system hands out.
    const GONE: u32 = 3_999_999_999;

    #[test]
    fn notes_of_ffmpeg_that_is_gone_are_dropped_and_a_live_note_is_kept_until_it_ends() {
        let dir = tempfile::tempdir().unwrap();
        let note = |pid: u32, owner: u32| {
            let path = dir.path().join(format!("{pid}.json"));
            std::fs::write(&path, serde_json::json!({"owner": owner, "output": "/nowhere/render.mp4"}).to_string()).unwrap();
            path
        };
        let stale = note(GONE, GONE);
        assert_eq!(track(dir.path().to_path_buf()), 0, "nothing of that name runs, so nothing is killed");
        assert!(!stale.exists());
        if NOTES.get().is_some_and(|notes| notes == dir.path()) {
            let running = Running::note(Some(GONE), "/nowhere/render.mp4");
            assert!(dir.path().join(format!("{GONE}.json")).exists());
            drop(running);
            assert!(!dir.path().join(format!("{GONE}.json")).exists());
        }
    }
}
