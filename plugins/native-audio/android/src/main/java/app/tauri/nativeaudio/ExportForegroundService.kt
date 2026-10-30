package app.tauri.nativeaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

private const val TAG = "KDJ-Export"
private const val PROGRESS_ID = 9601
private const val DONE_ID_BASE = 9700
private const val PROGRESS_CHANNEL = ".export_progress"
private const val DONE_CHANNEL = ".export_done"
/** Renewed by every progress report: a WebView that stops reporting cannot hold the CPU for long. */
private const val WAKE_LEASE_MS = 10 * 60_000L

/**
 * 可视化导出跑在 WebView 里（worker 画帧 + WebCodecs 编码）和本进程的 Rust 服务里（封装）。
 * 切到后台或锁屏后三件事会让它停下：Activity onPause 时 wry 调 WebView.onPause()；
 * 进程没有前台服务，几秒后进入 cached 状态被系统冻结（Android 14+ 的 freezer）或回收；
 * 屏幕关闭后 CPU 休眠。这里用一个带进度通知的前台服务保住进程，持一把有租期的
 * PARTIAL_WAKE_LOCK；WebView 由 MainActivity 在 [active] 时重新 onResume。
 *
 * 前端只报三件事（经 MainActivity 的 kdjAndroid 接口）：进度、单个任务结束、队列空了。
 * 服务只在第一次进度时从前台启动，之后只更新通知——Android 12+ 不许后台再起前台服务，
 * 所以队列里的下一个任务沿用同一个服务，直到 [idle]。
 */
object ExportForeground {
    @Volatile var active = false
        private set
    /** MainActivity 在队列空了、自己又不在前台时让 WebView 回到暂停。 */
    @Volatile var onIdle: (() -> Unit)? = null
    private var title = ""
    private var status = ""
    private var permille = 0
    private var wakeLock: PowerManager.WakeLock? = null
    private var doneCount = 0

    @Synchronized
    fun progress(context: Context, title: String, fraction: Double, status: String) {
        val app = context.applicationContext
        this.title = title
        this.status = status
        permille = if (fraction.isFinite()) (fraction.coerceIn(0.0, 1.0) * 1000).toInt() else 0
        holdWakeLock(app)
        if (!active) {
            active = true
            val intent = Intent(app, ExportForegroundService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
            }.onFailure {
                // 从后台起不了前台服务（Android 12+）：导出照常进行，只是没有保护。
                Log.w(TAG, "startForegroundService failed", it)
            }
        } else {
            notifier(app).notify(PROGRESS_ID, progressNotification(app))
        }
    }

    /** 一个任务结束：发一条留在通知栏的结果，点它打开成品（成功）或回到应用（失败）。 */
    @Synchronized
    fun finished(context: Context, title: String, ok: Boolean, message: String, uri: String) {
        val app = context.applicationContext
        ensureChannels(app)
        val open = if (ok && uri.isNotBlank()) viewIntent(uri) else null
        val id = DONE_ID_BASE + (doneCount++ % 50)
        val notification = builder(app, DONE_CHANNEL)
            .setContentTitle(if (ok) "导出完成" else "导出失败")
            .setContentText(listOf(title, message).filter { it.isNotBlank() }.joinToString(" · "))
            .setStyle(Notification.BigTextStyle().bigText(listOf(title, message).filter { it.isNotBlank() }.joinToString("\n")))
            .setContentIntent(pending(app, open ?: launchIntent(app), id))
            .setAutoCancel(true)
            .setCategory(if (ok) Notification.CATEGORY_STATUS else Notification.CATEGORY_ERROR)
            .build()
        notifier(app).notify(id, notification)
    }

    /** 队列里没有要导出的了：撤掉前台服务和进度通知，放开 CPU。 */
    @Synchronized
    fun idle(context: Context) {
        if (!active) return
        active = false
        val app = context.applicationContext
        app.stopService(Intent(app, ExportForegroundService::class.java))
        notifier(app).cancel(PROGRESS_ID)
        wakeLock?.let { if (it.isHeld) it.release() }
        onIdle?.invoke()
    }

    private fun holdWakeLock(context: Context) {
        val held = wakeLock ?: (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KDJ:export")
            .apply { setReferenceCounted(false) }.also { wakeLock = it }
        held.acquire(WAKE_LEASE_MS)
    }

    @Synchronized
    internal fun progressNotification(context: Context): Notification {
        ensureChannels(context)
        return builder(context, PROGRESS_CHANNEL)
            .setContentTitle(title.ifBlank { "正在导出视频" })
            .setContentText(listOf(status, "${permille / 10}%").filter { it.isNotBlank() }.joinToString(" · "))
            .setProgress(1000, permille, permille == 0)
            .setContentIntent(pending(context, launchIntent(context), PROGRESS_ID))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .build()
    }

    private fun builder(context: Context, channel: String): Notification.Builder {
        val icon = context.resources.getIdentifier("ic_notification", "drawable", context.packageName)
        return (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, context.packageName + channel)
        else @Suppress("DEPRECATION") Notification.Builder(context))
            .setSmallIcon(if (icon != 0) icon else android.R.drawable.stat_sys_download)
            .setShowWhen(false)
    }

    private fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = notifier(context)
        if (manager.getNotificationChannel(context.packageName + PROGRESS_CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(context.packageName + PROGRESS_CHANNEL, "视频导出进度", NotificationManager.IMPORTANCE_LOW)
                .apply { setShowBadge(false) })
        }
        if (manager.getNotificationChannel(context.packageName + DONE_CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(context.packageName + DONE_CHANNEL, "视频导出结果", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    private fun notifier(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun launchIntent(context: Context): Intent =
        (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)

    /** 成品在相册（content://media/…）里：交给系统的视频查看器。 */
    private fun viewIntent(uri: String): Intent =
        Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(uri), "video/mp4")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun pending(context: Context, intent: Intent, code: Int): PendingIntent =
        PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

class ExportForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService 之后必须 startForeground，哪怕队列在这之前已经空了。
        val notification = ExportForeground.progressNotification(this)
        // Android 15 给转码用的 mediaProcessing；14 用 dataSync；更早的不必声明类型。
        when {
            Build.VERSION.SDK_INT >= 35 -> startForeground(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> startForeground(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else -> startForeground(PROGRESS_ID, notification)
        }
        if (!ExportForeground.active) stopSelf()
        // 导出属于这个进程的 WebView；进程没了，服务也不该自己复活。
        return START_NOT_STICKY
    }

    /** 从最近任务里划掉：Activity 和它的 WebView 跟着销毁，导出已经停了，前端也没机会说一声。 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        ExportForeground.idle(this)
        super.onTaskRemoved(rootIntent)
    }

    /** Android 15：mediaProcessing / dataSync 每 24 小时最多跑 6 小时，到点必须退出前台。 */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "foreground service timed out")
        stopSelf()
    }
}
