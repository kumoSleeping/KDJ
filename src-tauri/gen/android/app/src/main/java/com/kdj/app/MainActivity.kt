package com.kdj.app

import app.tauri.nativeaudio.ExportForeground
import app.tauri.nativeaudio.NativeAudioRuntime
import android.Manifest
import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.util.Rational
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : TauriActivity() {
  companion object {
    private const val REQ_MEDIA_AUDIO = 4001
    private const val PREFS = "kdj-perms"
    private const val KEY_AUDIO_ASKED = "media-audio-asked"
    private val ndkContextInitialized = AtomicBoolean(false)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    Log.i("KDJ-JNI", "onCreate 开始，加载 kdj_app_lib")
    try {
      // Rust.kt 的 loadLibrary 只在 Rust 类首次初始化时执行，时机在 super.onCreate 之后；
      // 这里必须先加载，CPAL/AAudio 才能在上游拿到 JNI 上下文。
      System.loadLibrary("kdj_app_lib")
      // CPAL/AAudio 需要 JNI 上下文，必须在 Tauri setup（播放器线程）之前就位。
      // Rust 侧对应 Java_com_kdj_app_MainActivity_initNdkContext。
      if (ndkContextInitialized.compareAndSet(false, true)) {
        if (initNdkContext(this)) {
          Log.i("KDJ-JNI", "initNdkContext 返回")
        } else {
          ndkContextInitialized.set(false)
          Log.e("KDJ-JNI", "initNdkContext 未完成")
        }
      } else {
        Log.i("KDJ-JNI", "ndk-context 已在本进程初始化，跳过 Activity 重建调用")
      }
    } catch (err: Throwable) {
      ndkContextInitialized.set(false)
      Log.e("KDJ-JNI", "initNdkContext 失败", err)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 权限申请放最后：super.onCreate 之前调 requestPermissions，部分机型弹窗
    // 出不来直接静默拒绝（见下方注释）。
    requestMediaPermissionIfNeeded()
  }

  private var videoView: WebView? = null
  private var videoPipActive = false
  private var videoPlaying = false
  private var videoRatio = 16.0 / 9.0

  private fun pipAvailable() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  private fun updateVideoPip() {
    if (!pipAvailable()) return
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(Rational((videoRatio.coerceIn(0.42, 2.38) * 1000).toInt(), 1000))
    if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(videoPipActive && videoPlaying)
    runCatching { setPictureInPictureParams(builder.build()) }
  }

  private fun enterVideoPip() {
    if (!videoPipActive || !pipAvailable()) return
    updateVideoPip()
    runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder()
      .setAspectRatio(Rational((videoRatio.coerceIn(0.42, 2.38) * 1000).toInt(), 1000)).build()) }
      .onSuccess { if (!it) reportVideoPip(false) }
      .onFailure { reportVideoPip(false) }
  }

  private fun reportVideoPip(active: Boolean) {
    videoView?.evaluateJavascript("document.documentElement.toggleAttribute('data-android-pip', $active);window.dispatchEvent(new CustomEvent('kdj:android-pip',{detail:$active}));", null)
  }

  private var immersive = false

  /** The bars come back for a moment with a swipe from the edge, and hide again by themselves. */
  private fun applyImmersive() {
    WindowCompat.getInsetsController(window, window.decorView).apply {
      if (immersive) {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.systemBars())
      } else {
        show(WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Coming back to the app (or out of a dialog) shows the bars again; a fullscreen preview hides them.
    if (hasFocus && immersive) applyImmersive()
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT < 31 && videoPipActive && videoPlaying) enterVideoPip()
  }

  override fun onPictureInPictureModeChanged(active: Boolean, configuration: Configuration) {
    super.onPictureInPictureModeChanged(active, configuration)
    reportVideoPip(active)
    if (active) videoView?.onResume()
  }

  override fun onPause() {
    super.onPause()
    // Wry pauses its WebView with the Activity; PiP is still visible and must keep decoding,
    // and an export draws and encodes its frames in the WebView.
    if (isInPictureInPictureMode || NativeAudioRuntime.needsForeground() || ExportForeground.active) videoView?.onResume()
  }

  override fun onDestroy() {
    // The WebView that drew the export goes with the Activity; nothing will report its end.
    if (isFinishing) ExportForeground.idle(this)
    ExportForeground.onIdle = null
    super.onDestroy()
  }

  private external fun initNdkContext(activity: MainActivity): Boolean

  /**
   * edge-to-edge 下系统栏本身透明，底色就是页面底色；这里只让状态栏/导航栏图标的
   * 深浅跟随 Web 主题（调用端在 src/stores/appStore.ts 的 applyTheme）。
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    videoView = webView
    // The export ended while the app was away: let the WebView rest as wry meant it to.
    ExportForeground.onIdle = {
      runOnUiThread {
        if (!isDestroyed && !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && !isInPictureInPictureMode && !NativeAudioRuntime.needsForeground()) videoView?.onPause()
      }
    }
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun canVideoPip(): Boolean = pipAvailable()
      @JavascriptInterface
      fun configureVideoPip(active: Boolean, playing: Boolean, ratio: Double) = runOnUiThread {
        videoPipActive = active
        videoPlaying = playing
        videoRatio = if (ratio.isFinite() && ratio > 0) ratio else 16.0 / 9.0
        updateVideoPip()
      }
      @JavascriptInterface
      fun enterVideoPip() = runOnUiThread { this@MainActivity.enterVideoPip() }
      /** 返回键没有可收起的层时（src/lib/androidBack.ts）：像系统默认的返回一样退到后台。 */
      @JavascriptInterface
      fun leaveToBackground() = runOnUiThread { this@MainActivity.moveTaskToBack(true) }
      /** 可视化导出的进度、单个任务的结果、队列空了：见 [ExportForeground]。 */
      @JavascriptInterface
      fun exportProgress(title: String, fraction: Double, status: String) =
        ExportForeground.progress(this@MainActivity, title, fraction, status)
      @JavascriptInterface
      fun exportFinished(title: String, ok: Boolean, message: String, uri: String) =
        ExportForeground.finished(this@MainActivity, title, ok, message, uri)
      @JavascriptInterface
      fun exportIdle() = ExportForeground.idle(this@MainActivity)
      /** A preview's fullscreen (src/lib/windowFullscreen.ts): the app already fills the screen, so it hides the bars. */
      @JavascriptInterface
      fun setImmersive(on: Boolean) = runOnUiThread {
        immersive = on
        applyImmersive()
      }
      @JavascriptInterface
      fun setSystemBarsLight(light: Boolean) = runOnUiThread {
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = light
          isAppearanceLightNavigationBars = light
        }
      }
    }, "kdjAndroid")
  }

  /**
   * 曲库扫描公共目录需要媒体权限（Android 13+ READ_MEDIA_AUDIO/VIDEO，
   * 12- 为 READ_EXTERNAL_STORAGE；视频容器也是曲库媒体，所以 13+ 两个都要）。
   * 音乐曲库 App 的核心能力，启动时申请一次；拒绝后不再打扰——
   * 恢复入口在「添加音乐」的流程里（选目录读不到内容时会当场重新申请）。
   *
   * 必须在 super.onCreate 之后调：之前放在前面，部分机型上弹窗根本出不来，
   * 系统直接静默拒绝，而 asked 标记照样写下，权限就永远丢了。
   */
  private fun requestMediaPermissionIfNeeded() {
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (prefs.getBoolean(KEY_AUDIO_ASKED, false)) return
    val missing = mediaPermissions().filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_MEDIA_AUDIO)
    }
    prefs.edit().putBoolean(KEY_AUDIO_ASKED, true).apply()
  }

  /** 当前系统需要的媒体读取权限；无权限要求时返回空数组。 */
  private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 33 -> arrayOf(
      Manifest.permission.READ_MEDIA_AUDIO,
      Manifest.permission.READ_MEDIA_VIDEO,
    )
    Build.VERSION.SDK_INT >= 23 -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    else -> emptyArray()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == REQ_MEDIA_AUDIO) {
      val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
      Log.i("KDJ-JNI", "媒体权限结果：$granted")
    }
  }
}
