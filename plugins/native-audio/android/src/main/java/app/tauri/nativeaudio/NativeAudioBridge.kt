package app.tauri.nativeaudio

import android.util.Log

/**
 * Kotlin → Rust 远程键通道。息屏/通知栏时 WebView 可能冻结，不能依赖前端
 * `playback_command`，必须走 JNI 进 `submit_platform`。
 *
 * 符号落在 Tauri 主库 `libkdj_app_lib.so`（见 src-tauri `android_media.rs`）。
 */
object NativeAudioBridge {
    private const val TAG = "NativeAudioBridge"

    @Volatile
    private var libraryReady = false

    @Synchronized
    fun ensureLoaded() {
        if (libraryReady) return
        try {
            System.loadLibrary("kdj_app_lib")
        } catch (error: UnsatisfiedLinkError) {
            // Tauri 启动时通常已经 load 过同名 cdylib；再次 load 会抛，可忽略。
            Log.d(TAG, "loadLibrary skipped: ${error.message}")
        }
        libraryReady = true
    }

    @JvmStatic
    external fun submitRemote(action: String, position: Double)

    fun play() = dispatch("play", 0.0)

    fun pause() = dispatch("pause", 0.0)

    fun toggle() = dispatch("toggle", 0.0)

    fun seek(positionSec: Double) = dispatch("seek", positionSec)

    fun seekBy(deltaSec: Double) = dispatch("seekBy", deltaSec)

    fun next() = dispatch("next", 0.0)

    fun previous() = dispatch("previous", 0.0)

    private fun dispatch(action: String, position: Double) {
        ensureLoaded()
        runCatching { submitRemote(action, position) }
            .onFailure { Log.w(TAG, "submitRemote($action) failed", it) }
    }
}
