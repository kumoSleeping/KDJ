package com.kdj.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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

  private external fun initNdkContext(activity: MainActivity): Boolean

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
