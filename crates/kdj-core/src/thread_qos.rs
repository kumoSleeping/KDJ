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
#[must_use = "the thread returns to its normal priority when this is dropped"]
pub struct BackgroundPriority(());

impl Drop for BackgroundPriority {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            let _ =
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_DEFAULT, 0);
        }
        // Linux and Android: an unprivileged thread cannot lower its nice value again.
        #[cfg(windows)]
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
        }
    }
}

/// Full-file waveform and BPM/key analysis. Must not steal the live Deck.
pub fn prefer_background() -> BackgroundPriority {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    unsafe {
        let _ = libc::nice(10);
    }
    #[cfg(windows)]
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
    BackgroundPriority(())
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
