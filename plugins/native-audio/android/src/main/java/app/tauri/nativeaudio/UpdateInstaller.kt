package app.tauri.nativeaudio

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 应用内更新：把 Release 里签好名的 APK 下到应用自己的缓存目录，再交给系统安装器。
 * 签名校验、覆盖升级和数据保留都由系统完成；这里只保证下的是本仓库 Release 里的、
 * 包名与本应用相同的安装包。不静默安装：最后一步总是系统自己的安装页面。
 */
object UpdateInstaller {
    private const val RELEASE_PREFIX = "https://github.com/kumoSleeping/KDJ/releases/download/"
    private const val PROGRESS_INTERVAL_MS = 200L
    private val busy = AtomicBoolean(false)

    /** 外部缓存在 FileProvider 已有的 external-path 下；没有外部存储时退回内部缓存。 */
    private fun folder(activity: Activity): File =
        File(activity.externalCacheDir ?: activity.cacheDir, "updates")

    private fun samePackage(activity: Activity, apk: File): Boolean = runCatching {
        @Suppress("DEPRECATION")
        activity.packageManager.getPackageArchiveInfo(apk.path, 0)?.packageName == activity.packageName
    }.getOrDefault(false)

    /** 下载（已下完的同版本包直接复用），返回完整的 APK。 */
    fun download(activity: Activity, url: String, version: String, onProgress: (Long, Long?) -> Unit): File {
        require(url.startsWith(RELEASE_PREFIX) && url.endsWith(".apk")) { "更新地址不是 KDJ 的 Release 安装包" }
        val safe = version.replace(Regex("[^0-9A-Za-z._-]"), "")
        require(safe.isNotEmpty()) { "版本号无效" }
        if (!busy.compareAndSet(false, true)) throw IllegalStateException("更新正在下载")
        try {
            val dir = folder(activity)
            dir.mkdirs()
            val target = File(dir, "KDJ-$safe.apk")
            if (target.isFile && target.length() > 0 && samePackage(activity, target)) {
                onProgress(target.length(), target.length())
                return target
            }
            // 旧版本的包、上次没下完的半截文件，一并清掉。
            dir.listFiles()?.forEach { it.delete() }
            val partial = File(dir, "KDJ-$safe.apk.part")
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 20_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = true
                connection.setRequestProperty("User-Agent", "KDJ-Android")
                val status = connection.responseCode
                if (status !in 200..299) throw IllegalStateException("下载更新失败：HTTP $status")
                val total = connection.contentLengthLong.takeIf { it > 0 }
                var done = 0L
                var reported = 0L
                connection.inputStream.use { input ->
                    partial.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            done += read
                            val now = SystemClock.elapsedRealtime()
                            if (now - reported >= PROGRESS_INTERVAL_MS) {
                                reported = now
                                onProgress(done, total)
                            }
                        }
                    }
                }
                if (total != null && done != total) throw IllegalStateException("下载更新不完整")
                onProgress(done, total)
            } finally {
                connection.disconnect()
            }
            if (!samePackage(activity, partial)) {
                partial.delete()
                throw IllegalStateException("下载到的不是 KDJ 安装包")
            }
            if (!partial.renameTo(target)) throw IllegalStateException("保存更新包失败")
            return target
        } finally {
            busy.set(false)
        }
    }

    /**
     * 打开系统安装页，返回 true。没有「安装未知应用」授权时返回 false；[askPermission] 为真时
     * 先打开这个应用的授权页，用户允许后再调一次即可（包已下好，不会重下）。
     */
    fun install(activity: Activity, apk: File, askPermission: Boolean): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            if (askPermission) {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return false
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        return true
    }
}
