package com.kdj.app

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
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
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  private external fun initNdkContext(activity: MainActivity)
}
