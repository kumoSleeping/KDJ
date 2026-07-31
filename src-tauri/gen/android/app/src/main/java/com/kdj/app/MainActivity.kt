package com.kdj.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  companion object {
    private const val REQ_MEDIA_AUDIO = 4001
    private const val PREFS = "kdj-perms"
    private const val KEY_AUDIO_ASKED = "media-audio-asked"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    Log.i("KDJ-JNI", "onCreate 开始，加载 kdj_app_lib")
    try {
      // Rust.kt 的 loadLibrary 只在 Rust 类首次初始化时执行，时机在 super.onCreate 之后；
      // 这里必须先加载，CPAL/AAudio 才能在上游拿到 JNI 上下文。
      System.loadLibrary("kdj_app_lib")
      // CPAL/AAudio 需要 JNI 上下文，必须在 Tauri setup（播放器线程）之前就位。
      // Rust 侧对应 Java_com_kdj_app_MainActivity_initNdkContext。
      initNdkContext(this)
      Log.i("KDJ-JNI", "initNdkContext 返回")
    } catch (err: Throwable) {
      Log.e("KDJ-JNI", "initNdkContext 失败", err)
    }
    requestMediaPermissionIfNeeded()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  private external fun initNdkContext(activity: MainActivity)

  /**
   * 曲库扫描公共 Music 目录需要媒体权限（Android 13+ READ_MEDIA_AUDIO，
   * 12- 为 READ_EXTERNAL_STORAGE）。音乐曲库 App 的核心能力，启动时申请一次；
   * 拒绝后可在系统设置里手动开启（前端扫描不到公共目录时会提示）。
   */
  private fun requestMediaPermissionIfNeeded() {
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (prefs.getBoolean(KEY_AUDIO_ASKED, false)) return
    val needed = mediaPermission() ?: return
    if (ContextCompat.checkSelfPermission(this, needed) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(needed), REQ_MEDIA_AUDIO)
    }
    prefs.edit().putBoolean(KEY_AUDIO_ASKED, true).apply()
  }

  /** 当前系统需要的媒体读取权限；无权限要求时返回 null。 */
  private fun mediaPermission(): String? = when {
    Build.VERSION.SDK_INT >= 33 -> Manifest.permission.READ_MEDIA_AUDIO
    Build.VERSION.SDK_INT >= 23 -> Manifest.permission.READ_EXTERNAL_STORAGE
    else -> null
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
