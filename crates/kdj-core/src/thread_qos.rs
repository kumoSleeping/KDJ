//! Best-effort scheduling hints so live decode/WSOLA outranks waveform and analysis.
//!
//! Failures are ignored: a worker that cannot change its own niceness must still run.

/// The audible decode/WSOLA path. CoreAudio/AAudio already own the callback;
/// this only lifts the worker that fills the short output ring.
pub fn prefer_live_audio() {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INITIATED, 0);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    unsafe {
        let _ = libc::nice(-5);
    }
    #[cfg(windows)]
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
    }
}

/// Held for the length of a background task; the thread gets its normal priority back when it
/// is dropped.
///
/// Background work mostly runs on shared blocking-pool threads, and the next task on the same
/// thread is often interactive: a playback command, a library query, a cover. A demotion that
/// outlived its task left those running at background priority behind the analysis workers.
///
/// Linux and Android: `nice` is relative, so a pool thread that ran a background task twice was at
/// 19, and every later task on it (a cover, the visualizer's analysis the listener waits for) ran
/// there too. The level is set absolutely and the one before it put back; a desktop Linux thread
/// that may not raise itself again stays at 10, never lower.
#[must_use = "the thread returns to its normal priority when this is dropped"]
pub struct BackgroundPriority(#[allow(dead_code)] Option<i32>);

impl Drop for BackgroundPriority {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            let _ =
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_DEFAULT, 0);
        }
        // Android lets an app raise its own threads again; desktop Linux refuses, which is ignored.
        #[cfg(all(unix, not(target_os = "macos")))]
        if let Some(previous) = self.0 {
            unsafe {
                let _ = libc::setpriority(libc::PRIO_PROCESS, 0, previous);
            }
        }
        #[cfg(windows)]
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
        }
    }
}

/// Full-file waveform and BPM/key analysis. Must not steal the live Deck.
pub fn prefer_background() -> BackgroundPriority {
    BackgroundPriority(lower_to_background())
}

/// The level the thread had before, where it can be put back.
#[cfg(target_os = "macos")]
fn lower_to_background() -> Option<i32> {
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn lower_to_background() -> Option<i32> {
    const BACKGROUND_NICE: i32 = 10;
    // Who 0 is the calling thread on Linux. -1 is also the error value: then nothing is changed
    // rather than a level guessed at.
    let previous = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
    if previous == -1 || previous >= BACKGROUND_NICE {
        return None;
    }
    unsafe {
        let _ = libc::setpriority(libc::PRIO_PROCESS, 0, BACKGROUND_NICE);
    }
    Some(previous)
}

#[cfg(windows)]
fn lower_to_background() -> Option<i32> {
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
    None
}

#[cfg(not(any(unix, windows)))]
fn lower_to_background() -> Option<i32> {
    None
}

/// Set the child's priority without changing a Tokio runtime thread's QoS.
pub fn background_command(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { command.pre_exec(|| { libc::setpriority(libc::PRIO_PROCESS, 0, 10); Ok(()) }); }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000); // NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
    }
}

#[cfg(windows)]
const THREAD_PRIORITY_ABOVE_NORMAL: i32 = 1;
#[cfg(windows)]
const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
#[cfg(windows)]
const THREAD_PRIORITY_NORMAL: i32 = 0;

#[cfg(windows)]
unsafe extern "system" {
    fn GetCurrentThread() -> *mut core::ffi::c_void;
    fn SetThreadPriority(thread: *mut core::ffi::c_void, priority: i32) -> i32;
}
