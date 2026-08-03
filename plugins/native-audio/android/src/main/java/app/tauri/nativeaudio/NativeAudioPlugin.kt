package app.tauri.nativeaudio

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.math.max

private const val EVENT_STATE = "native_audio_state"
private const val EVENT_OVERLAY_MOVED = "native_lyrics_overlay_moved"
private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 9512

data class NativeAudioState(
    val id: Long? = null,
    val status: String,
    val currentTime: Double,
    val duration: Double,
    val isPlaying: Boolean,
    val buffering: Boolean,
    val rate: Double,
    val error: String? = null,
)

data class NativeAudioProgressCheckpoint(
    val id: Long,
    val currentTime: Double,
    val updatedAtMs: Long,
    val status: String? = null,
)

/**
 * 悬浮歌词的时间轴只需要这三个值。单独开一个读取口是为了不走 [NativeAudioRuntime.getState]：
 * 那个会 `ensure` 出播放器，而歌词侧被 60Hz 调用，不该有副作用。
 */
data class NativeAudioClock(
    val trackId: Long?,
    val positionSec: Double,
    val durationSec: Double,
    val isPlaying: Boolean,
)

@InvokeArg
class SetSourceArgs {
    var src: String? = null
    var id: Long? = null
    var title: String? = null
    var artist: String? = null
    var album: String? = null
    var artworkUrl: String? = null
}

@InvokeArg
class SetQueueArgs {
    var items: Array<SetSourceArgs>? = null
}

@InvokeArg
class SeekToArgs {
    var position: Double? = null
}

@InvokeArg
class SetRateArgs {
    var rate: Double? = null
}

@InvokeArg
class SetVolumeArgs {
    var volume: Double? = null
}

@InvokeArg
class ApplyPlaybackSnapshotArgs {
    var sequence: Long? = null
    var phase: String? = null
    var trackId: Long? = null
    var title: String? = null
    var artist: String? = null
    var album: String? = null
    var artworkUrl: String? = null
    var currentTime: Double? = null
    var duration: Double? = null
    var desiredPlaying: Boolean? = null
    var isPlaying: Boolean? = null
    var buffering: Boolean? = null
    var rate: Double? = null
    var volume: Double? = null
    var error: String? = null
}

@InvokeArg
class LyricsLineArgs {
    var time: Double? = null
    var text: String? = null
    /** 翻译或罗马音，由前端按当前附加层选好，原生侧不必懂这层语义。 */
    var secondary: String? = null
}

@InvokeArg
class SetLyricsTimelineArgs {
    var trackId: Long? = null
    var duration: Double? = null
    /** 搜词中 / 没有歌词时显示的兜底文案。 */
    var placeholder: String? = null
    var lines: Array<LyricsLineArgs>? = null
}

/** 浏览器试听的限频时钟镜像；只有负 ID 临时流允许走这条旁路。 */
@InvokeArg
class SetLyricsPlaybackClockArgs {
    var trackId: Long? = null
    var position: Double? = null
    var duration: Double? = null
    var playing: Boolean? = null
    var rate: Double? = null
}

@InvokeArg
class SetLyricsOverlayArgs {
    var visible: Boolean? = null
    var position: String? = null
    var locked: Boolean? = null
    var fontScale: Double? = null
    var accent: String? = null
    var accentEnd: String? = null
    var accentMode: String? = null
    var secondaryAccent: String? = null
    var secondaryAccentEnd: String? = null
    var secondaryMode: String? = null
    var dim: String? = null
    var dimEnd: String? = null
    var dimMode: String? = null
    var stroke: String? = null
    var strokeEnd: String? = null
    var strokeMode: String? = null
    var opacity: Double? = null
    /** 只有换边或重新打开时才吸附，避免抹掉用户拖出来的位置。 */
    var reposition: Boolean? = null
    var y: Int? = null
}

@InvokeArg
class SavePngToGalleryArgs {
    var platform: String? = null
    var label: String? = null
    var image: String? = null
}

@InvokeArg
class OpenLocalPathArgs {
    var path: String? = null
}

@TauriPlugin(
    permissions = [
        // 13+ 细粒度媒体权限：曲库扫描把音频和视频容器都当媒体，两个都要。
        Permission(
            strings = [Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.READ_MEDIA_VIDEO],
            alias = "libraryMedia",
        ),
        // ≤12 旧存储权限（manifest 里 maxSdkVersion=32，只在 ≤32 的设备上声明）。
        Permission(
            strings = [Manifest.permission.READ_EXTERNAL_STORAGE],
            alias = "legacyStorage",
        ),
    ],
)
class NativeAudioPlugin(private val activity: Activity) : Plugin(activity) {

    init {
        activeInstance = this
        // 悬浮窗被拖动后把新位置回传前端，写进 lyricsPrefs（与桌面共用一套字段）。
        LyricsOverlayRuntime.onMoved = { edge, y ->
            val payload = JSObject().apply {
                put("position", edge.wire)
                put("y", y)
            }
            activity.runOnUiThread { trigger(EVENT_OVERLAY_MOVED, payload) }
        }
    }

    @Command
    fun initialize(invoke: Invoke) {
        requestNotificationPermission()
        runCatching {
            NativeAudioRuntime.initialize(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "initialize failed")
        }
    }

    /**
     * Rust coordinator 镜像入口。驱动 MediaSession / FGS / 焦点 / 歌词时钟，
     * 不走 WebView，息屏仍可用。
     */
    @Command
    fun applyPlaybackSnapshot(invoke: Invoke) {
        val args = invoke.parseArgs(ApplyPlaybackSnapshotArgs::class.java)
        runCatching {
            NativeAudioRuntime.applySnapshot(activity.applicationContext, args)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "applyPlaybackSnapshot failed")
        }
    }

    @Command
    fun register_listener(invoke: Invoke) {
        invoke.resolve()
    }

    @Command
    fun remove_listener(invoke: Invoke) {
        invoke.resolve()
    }

    @Command
    fun setSource(invoke: Invoke) {
        val args = invoke.parseArgs(SetSourceArgs::class.java)
        val src = args.src?.trim().orEmpty()
        if (src.isEmpty()) {
            invoke.reject("src is required")
            return
        }

        runCatching {
            NativeAudioRuntime.setSource(
                activity.applicationContext,
                src,
                args.id,
                args.title,
                args.artist,
                args.album,
                args.artworkUrl,
            )
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setSource failed")
        }
    }

    @Command
    fun setQueue(invoke: Invoke) {
        val args = invoke.parseArgs(SetQueueArgs::class.java)
        val items = args.items?.toList().orEmpty()
        if (items.isEmpty()) {
            invoke.reject("items are required")
            return
        }

        runCatching {
            NativeAudioRuntime.setQueue(activity.applicationContext, items)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setQueue failed")
        }
    }

    @Command
    fun play(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.play(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "play failed")
        }
    }

    @Command
    fun pause(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.pause(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "pause failed")
        }
    }

    @Command
    fun seekTo(invoke: Invoke) {
        val args = invoke.parseArgs(SeekToArgs::class.java)
        val position = args.position
        if (position == null || !position.isFinite()) {
            invoke.reject("position is required")
            return
        }

        runCatching {
            NativeAudioRuntime.seekTo(activity.applicationContext, position)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "seekTo failed")
        }
    }

    @Command
    fun setRate(invoke: Invoke) {
        val args = invoke.parseArgs(SetRateArgs::class.java)
        val rate = args.rate
        if (rate == null || !rate.isFinite() || rate <= 0) {
            invoke.reject("rate must be > 0")
            return
        }

        runCatching {
            NativeAudioRuntime.setRate(activity.applicationContext, rate)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setRate failed")
        }
    }

    @Command
    fun setVolume(invoke: Invoke) {
        val args = invoke.parseArgs(SetVolumeArgs::class.java)
        val volume = args.volume
        if (volume == null || !volume.isFinite()) {
            invoke.reject("volume is required")
            return
        }

        runCatching {
            NativeAudioRuntime.setVolume(activity.applicationContext, volume)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setVolume failed")
        }
    }

    @Command
    fun getState(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.getState(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(it))
        }.onFailure {
            invoke.reject(it.message ?: "getState failed")
        }
    }

    @Command
    fun getProgressCheckpoint(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.getProgressCheckpoint(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(it?.let { checkpoint -> toJsObject(checkpoint) })
        }.onFailure {
            invoke.reject(it.message ?: "getProgressCheckpoint failed")
        }
    }

    @Command
    fun clearProgressCheckpoint(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.clearProgressCheckpoint(activity.applicationContext)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "clearProgressCheckpoint failed")
        }
    }

    /**
     * 推入整首歌的歌词时间轴。**前端只在换歌或切附加层时调一次**，
     * 之后由 [LyricsOverlayRuntime] 读 coordinator 镜像位置自己滚——WebView 被冻结时
     * 悬浮歌词照样走，见该类注释。
     */
    @Command
    fun setLyricsTimeline(invoke: Invoke) {
        val args = invoke.parseArgs(SetLyricsTimelineArgs::class.java)
        val lines = args.lines.orEmpty().mapNotNull { line ->
            val time = line.time ?: return@mapNotNull null
            val text = line.text?.trim().orEmpty()
            if (!time.isFinite() || text.isEmpty()) return@mapNotNull null
            LyricsOverlayLine(
                timeSec = max(0.0, time),
                text = text,
                secondary = line.secondary?.trim().orEmpty(),
            )
        }.sortedBy { it.timeSec }

        runCatching {
            LyricsOverlayRuntime.setTimeline(
                activity.applicationContext,
                LyricsOverlayTimeline(
                    // 正 ID 是曲库，本地 coordinator 用；负 ID 是浏览器在线试听。
                    // 这里仅保留身份用于防串词，不让它进入 NativeAudioRuntime。
                    trackId = args.trackId?.takeIf { it != 0L },
                    durationSec = args.duration?.takeIf { it.isFinite() && it > 0 } ?: 0.0,
                    placeholder = args.placeholder?.trim().orEmpty(),
                    lines = lines,
                ),
            )
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "setLyricsTimeline failed")
        }
    }

    /**
     * 浏览器试听不经过 Rust coordinator，Android 原生悬浮歌词需要它的独立时钟。
     * 正 ID 一律清空：本地曲目必须继续由 [NativeAudioRuntime.clock] 胜出。
     */
    @Command
    fun setLyricsPlaybackClock(invoke: Invoke) {
        val args = invoke.parseArgs(SetLyricsPlaybackClockArgs::class.java)
        val trackId = args.trackId?.takeIf { it < 0L }
        val position = args.position?.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: 0.0
        val duration = args.duration?.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: 0.0
        val rate = args.rate?.takeIf { it.isFinite() && it > 0.0 } ?: 1.0

        runCatching {
            LyricsOverlayRuntime.setStreamPlaybackClock(
                trackId?.let {
                    StreamLyricsPlaybackClock(
                        trackId = it,
                        positionSec = position,
                        durationSec = duration,
                        isPlaying = args.playing == true,
                        rate = rate,
                        stampedElapsedMs = SystemClock.elapsedRealtime(),
                    )
                },
            )
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "setLyricsPlaybackClock failed")
        }
    }

    /**
     * 开关与样式。返回 `{ visible, granted }`：`granted=false` 表示「显示在其他
     * 应用上层」权限没到位，前端要据此去引导，而不能把开关当成已经打开。
     */
    @Command
    fun setLyricsOverlay(invoke: Invoke) {
        val args = invoke.parseArgs(SetLyricsOverlayArgs::class.java)
        val config = LyricsOverlayConfig(
            visible = args.visible == true,
            edge = LyricsOverlayEdge.parse(args.position),
            locked = args.locked != false,
            fontScale = args.fontScale?.takeIf { it.isFinite() }?.toFloat() ?: 1f,
            accent = LyricsColorPaint.parse(args.accentMode, args.accent, args.accentEnd, Color.WHITE),
            secondary = LyricsColorPaint.parse(
                args.secondaryMode,
                args.secondaryAccent,
                args.secondaryAccentEnd,
                Color.argb(0xF0, 0xFF, 0xFF, 0xFF),
            ),
            dim = LyricsColorPaint.parse(
                args.dimMode,
                args.dim,
                args.dimEnd,
                Color.argb(0x9E, 0xFF, 0xFF, 0xFF),
            ),
            stroke = LyricsColorPaint.parse(args.strokeMode, args.stroke, args.strokeEnd, Color.BLACK),
            opacity = args.opacity?.takeIf { it.isFinite() }?.toFloat() ?: 1f,
        )
        val repositionY = if (args.reposition == true) args.y else null

        runCatching {
            LyricsOverlayRuntime.setConfig(activity.applicationContext, config, repositionY)
        }.onSuccess { attached ->
            invoke.resolve(
                JSObject().apply {
                    put("visible", config.visible && attached)
                    put("granted", LyricsOverlayRuntime.canDraw(activity.applicationContext))
                },
            )
        }.onFailure {
            invoke.reject(it.message ?: "setLyricsOverlay failed")
        }
    }

    @Command
    fun checkOverlayPermission(invoke: Invoke) {
        invoke.resolve(
            JSObject().apply {
                put("granted", LyricsOverlayRuntime.canDraw(activity.applicationContext))
            },
        )
    }

    /**
     * 拉起系统的「在其他应用上层显示」设置页。
     *
     * 这里不用 `startActivityForResult`：那个页面回来时不带结果码，拿到回调
     * 也还得重新查一次 `canDrawOverlays`。所以只管打开，由前端回到前台后
     * 轮询 [checkOverlayPermission]，少一条容易出错的回调链路。
     */
    @Command
    fun requestOverlayPermission(invoke: Invoke) {
        if (LyricsOverlayRuntime.canDraw(activity.applicationContext)) {
            invoke.resolve(JSObject().apply { put("granted", true) })
            return
        }
        runCatching {
            activity.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${activity.packageName}"),
                ),
            )
        }.onSuccess {
            invoke.resolve(JSObject().apply { put("granted", false) })
        }.onFailure {
            // 少数 ROM 不认带包名的 Intent，退回不带包名的总开关页。
            runCatching {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
            }.onSuccess {
                invoke.resolve(JSObject().apply { put("granted", false) })
            }.onFailure { error ->
                invoke.reject(error.message ?: "requestOverlayPermission failed")
            }
        }
    }

    @Command
    fun dispose(invoke: Invoke) {
        runCatching {
            LyricsOverlayRuntime.dispose(activity.applicationContext)
            NativeAudioRuntime.dispose(activity.applicationContext)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "dispose failed")
        }
    }

    /**
     * 把 PNG data URL 写进系统相册（MediaStore / Pictures/KDJ）。
     * 返回 content URI（path）+ 用户可读路径（displayPath），location 固定 pictures。
     */
    @Command
    fun savePngToGallery(invoke: Invoke) {
        val args = invoke.parseArgs(SavePngToGalleryArgs::class.java)
        val image = args.image?.trim().orEmpty()
        if (image.isEmpty()) {
            invoke.reject("image is required")
            return
        }
        runCatching {
            GalleryHelper.savePngDataUrl(
                activity,
                args.platform?.trim().orEmpty().ifEmpty { "login" },
                args.label?.trim().orEmpty(),
                image,
            )
        }.onSuccess { (uri, displayPath) ->
            invoke.resolve(
                JSObject().apply {
                    put("path", uri)
                    put("displayPath", displayPath)
                    put("location", "pictures")
                },
            )
        }.onFailure {
            invoke.reject(it.message ?: "savePngToGallery failed")
        }
    }

    /** 用系统查看器打开本地文件或 content URI（登录二维码、曲库「显示所在位置」）。 */
    @Command
    fun openLocalPath(invoke: Invoke) {
        val args = invoke.parseArgs(OpenLocalPathArgs::class.java)
        val path = args.path?.trim().orEmpty()
        if (path.isEmpty()) {
            invoke.reject("path is required")
            return
        }
        runCatching {
            GalleryHelper.openLocalPath(activity, path)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "openLocalPath failed")
        }
    }

    /** 等待权限结果的选目录请求；同一时刻只有一个（系统选择器是模态的）。 */
    private data class PendingFolderPick(val treeUri: Uri, val path: String)

    private var pendingFolderPick: PendingFolderPick? = null

    /**
     * 调起系统文件夹选择器（ACTION_OPEN_DOCUMENT_TREE），把选中目录解析成
     * 可被 Rust 曲库扫描的真实路径。取消时 path 为 null，不 reject。
     */
    @Command
    fun pickLibraryFolder(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "pickLibraryFolderResult")
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法打开系统文件夹选择器")
        }
    }

    @ActivityCallback
    fun pickLibraryFolderResult(invoke: Invoke, result: ActivityResult) {
        when (result.resultCode) {
            Activity.RESULT_CANCELED -> {
                invoke.resolve(JSObject().apply { put("path", null as String?) })
            }
            Activity.RESULT_OK -> {
                val uri = result.data?.data
                if (uri == null) {
                    invoke.resolve(JSObject().apply { put("path", null as String?) })
                    return
                }
                val takeFlags =
                    (result.data?.flags ?: 0) and
                        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                runCatching {
                    activity.contentResolver.takePersistableUriPermission(
                        uri,
                        takeFlags or Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                }
                val path = FolderPickerHelper.treeUriToFilesystemPath(uri)
                if (path.isNullOrBlank()) {
                    invoke.reject(
                        "无法把所选文件夹解析为可扫描路径。请选择内部共享存储里的目录（如 Music、Download），不要选应用私有或云盘虚拟目录。",
                    )
                    return
                }
                // SAF 授权只覆盖 content://；曲库扫描走 std::fs 裸路径，能不能读
                // 取决于媒体运行时权限——两者互不相干。先验证再交还路径，不能把
                // 读不了的目录当成功交出去（否则就是「授权完文件夹是空的」）。
                Thread { verifyPickedFolder(invoke, uri, path) }.start()
            }
            else -> invoke.reject("选择文件夹失败")
        }
    }

    /** 探测选中的目录；读不到媒体时先尝试在场景里补权限，再不行给出明确原因。 */
    private fun verifyPickedFolder(invoke: Invoke, treeUri: Uri, path: String) {
        val probe = FolderPickerHelper.probeFilesystemDir(path)
        if (probe.visibleMedia > 0 || (probe.readable && probe.truncated)) {
            resolvePickedFolder(invoke, path)
            return
        }
        if (!mediaPermissionHeld()) {
            // 在场景里当场申请：启动时那一次申请被拒后系统不再主动弹，
            // 用户是在「添加音乐」这个动作里最清楚为什么需要它。
            pendingFolderPick = PendingFolderPick(treeUri, path)
            activity.runOnUiThread {
                runCatching {
                    requestPermissionForAlias(mediaPermissionAlias(), invoke, "libraryMediaPermissionResult")
                }.onFailure { error ->
                    pendingFolderPick = null
                    invoke.reject("无法申请媒体读取权限：${error.message}")
                }
            }
            return
        }
        rejectUnreadableFolder(invoke, treeUri, path, probe)
    }

    @PermissionCallback
    fun libraryMediaPermissionResult(invoke: Invoke) {
        val pending = pendingFolderPick
        pendingFolderPick = null
        if (pending == null) {
            invoke.reject("文件夹选择状态已丢失，请重新选择")
            return
        }
        Thread {
            val probe = FolderPickerHelper.probeFilesystemDir(pending.path)
            if (probe.visibleMedia > 0 || (probe.readable && probe.truncated)) {
                resolvePickedFolder(invoke, pending.path)
            } else {
                rejectUnreadableFolder(invoke, pending.treeUri, pending.path, probe)
            }
        }.start()
    }

    private fun resolvePickedFolder(invoke: Invoke, path: String) {
        invoke.resolve(JSObject().apply { put("path", path) })
    }

    /**
     * 文件 API 看不到东西时用 SAF 授权视角交叉验证，区分
     * 「真没歌」「没权限」「文件还没进系统媒体库」，各给各的指引。
     */
    private fun rejectUnreadableFolder(
        invoke: Invoke,
        treeUri: Uri,
        path: String,
        probe: FolderPickerHelper.DirProbe,
    ) {
        when (FolderPickerHelper.safTreeHasMedia(activity.contentResolver, treeUri)) {
            true ->
                if (!mediaPermissionHeld()) {
                    invoke.reject(
                        "已授权访问该文件夹，但系统仍未允许 KDJ 读取存储里的文件。" +
                            "请到 系统设置 → 应用 → KDJ → 权限 中允许「音乐和音频」，再重新添加。",
                    )
                } else {
                    invoke.reject(
                        "文件夹里的媒体文件暂时无法直接读取（可能还没被系统媒体库收录）。" +
                            "稍等片刻重试，或重启手机后再添加。",
                    )
                }
            false ->
                invoke.reject("所选文件夹（含子文件夹）里没有可导入的音乐或视频文件。")
            // SAF 树走不完 / 查不动：不挡路，目录可读就把路径交出去让扫描自己试
            null ->
                if (probe.readable) {
                    resolvePickedFolder(invoke, path)
                } else {
                    invoke.reject("无法读取所选文件夹（可能已断开或受系统保护），请换一个目录。")
                }
        }
    }

    /** 曲库扫描需要的运行时权限是否已授予（音频为主，≤12 看旧存储权限）。 */
    private fun mediaPermissionHeld(): Boolean {
        val permissions = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        return permissions.any {
            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun mediaPermissionAlias(): String =
        if (Build.VERSION.SDK_INT >= 33) "libraryMedia" else "legacyStorage"

    override fun onDestroy() {
        if (activeInstance === this) {
            activeInstance = null
            LyricsOverlayRuntime.onMoved = null
        }
        // 悬浮窗不在这里摘掉：Activity 销毁后前台播放服务仍可能在放歌，
        // 那种情况下歌词本就该继续挂着。真正的收尾在 dispose 命令里。
        super.onDestroy()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST_CODE,
        )
    }

    private fun emitState(state: NativeAudioState) {
        val payload = toJsObject(state)
        activity.runOnUiThread {
            trigger(EVENT_STATE, payload)
        }
    }

    private fun toJsObject(state: NativeAudioState): JSObject {
        val payload = JSObject()
        state.id?.let { payload.put("id", it) }
        payload.put("status", state.status)
        payload.put("currentTime", state.currentTime)
        payload.put("duration", state.duration)
        payload.put("isPlaying", state.isPlaying)
        payload.put("buffering", state.buffering)
        payload.put("rate", state.rate)
        if (!state.error.isNullOrBlank()) payload.put("error", state.error)
        return payload
    }

    private fun toJsObject(checkpoint: NativeAudioProgressCheckpoint): JSObject {
        val payload = JSObject()
        payload.put("id", checkpoint.id)
        payload.put("currentTime", checkpoint.currentTime)
        payload.put("updatedAtMs", checkpoint.updatedAtMs)
        if (!checkpoint.status.isNullOrBlank()) payload.put("status", checkpoint.status)
        return payload
    }

    companion object {
        @Volatile
        private var activeInstance: NativeAudioPlugin? = null

        internal fun emitToActive(state: NativeAudioState) {
            activeInstance?.emitState(state)
        }
    }
}
