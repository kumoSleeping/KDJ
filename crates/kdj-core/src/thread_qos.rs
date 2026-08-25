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

/// Full-file waveform and BPM/key analysis. Must not steal the live Deck.
pub fn prefer_background() {
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
}

#[cfg(windows)]
const THREAD_PRIORITY_ABOVE_NORMAL: i32 = 1;
#[cfg(windows)]
const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;

#[cfg(windows)]
unsafe extern "system" {
    fn GetCurrentThread() -> *mut core::ffi::c_void;
    fn SetThreadPriority(thread: *mut core::ffi::c_void, priority: i32) -> i32;
}
