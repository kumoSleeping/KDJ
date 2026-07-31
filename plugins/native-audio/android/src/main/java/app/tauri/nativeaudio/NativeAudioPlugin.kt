package app.tauri.nativeaudio

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
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

@TauriPlugin
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
                    trackId = args.trackId?.takeIf { it > 0 },
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
