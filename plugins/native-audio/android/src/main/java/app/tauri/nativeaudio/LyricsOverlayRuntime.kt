package app.tauri.nativeaudio

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import kotlin.math.max
import kotlin.math.min

/** 一行歌词：主词 + 可选副行（翻译或罗马音，由前端按当前附加层选好）。 */
data class LyricsOverlayLine(
    val timeSec: Double,
    val text: String,
    val secondary: String,
)

/**
 * 一首歌的完整时间轴。`trackId` 用来防串词：前端还没推新歌的词时，
 * 播放器已经换曲，此时宁可显示占位也不能把上一首的词继续滚下去。
 */
data class LyricsOverlayTimeline(
    val trackId: Long?,
    val durationSec: Double,
    val placeholder: String,
    val lines: List<LyricsOverlayLine>,
) {
    companion object {
        val EMPTY = LyricsOverlayTimeline(null, 0.0, "", emptyList())
    }
}

/** 黑 / 白 / 单色 / 渐变 / 无；与前端 `LyricsColorPaint` 对齐。 */
data class LyricsColorPaint(
    val gradient: Boolean,
    val start: Int,
    val end: Int,
    val none: Boolean = false,
) {
    companion object {
        fun parse(mode: String?, start: String?, end: String?, fallback: Int): LyricsColorPaint {
            return when (mode?.trim()?.lowercase()) {
                "none" -> LyricsColorPaint(false, Color.TRANSPARENT, Color.TRANSPARENT, none = true)
                "black" -> LyricsColorPaint(false, Color.BLACK, Color.BLACK)
                "white" -> LyricsColorPaint(false, Color.WHITE, Color.WHITE)
                "gray" -> LyricsColorPaint(false, Color.parseColor("#9E9E9E"), Color.parseColor("#9E9E9E"))
                "gradient" -> {
                    val parsedStart = parseColor(start, fallback)
                    LyricsColorPaint(true, parsedStart, parseColor(end, parsedStart))
                }
                else -> {
                    // solid / 未知：用色相线上的 start
                    val parsedStart = parseColor(start, fallback)
                    LyricsColorPaint(false, parsedStart, parsedStart)
                }
            }
        }

        fun parseColor(value: String?, fallback: Int): Int {
            val raw = value?.trim().orEmpty()
            if (raw.isEmpty()) return fallback
            return runCatching { Color.parseColor(raw) }.getOrDefault(fallback)
        }
    }
}

data class LyricsOverlayConfig(
    val visible: Boolean,
    val edge: LyricsOverlayEdge,
    val locked: Boolean,
    val fontScale: Float,
    val accent: LyricsColorPaint,
    val secondary: LyricsColorPaint,
    val dim: LyricsColorPaint,
    val stroke: LyricsColorPaint,
    val opacity: Float,
) {
    companion object {
        val DEFAULT = LyricsOverlayConfig(
            visible = false,
            edge = LyricsOverlayEdge.BOTTOM,
            locked = true,
            fontScale = 1f,
            accent = LyricsColorPaint(false, Color.WHITE, Color.WHITE),
            secondary = LyricsColorPaint(false, Color.argb(0xF0, 0xFF, 0xFF, 0xFF), Color.WHITE),
            dim = LyricsColorPaint(false, Color.argb(0x9E, 0xFF, 0xFF, 0xFF), Color.GRAY),
            stroke = LyricsColorPaint(false, Color.BLACK, Color.BLACK),
            opacity = 1f,
        )
    }
}

/**
 * 悬浮歌词的时间轴驱动。
 *
 * **时间轴由这里驱动，而不是由前端每帧推一行文字过来**，这是整个功能能用的前提：
 * 息屏或切到别的应用之后 WebView 会被冻结/降频，靠 JS 定时器推歌词会直接卡住，
 * 而那正是悬浮歌词唯一的使用场景。所以前端只在换歌或切附加层时推一次时间轴，
 * 之后由这里读 [NativeAudioRuntime] 的播放时钟自己选行。
 *
 * 注意：Android 出声已切共享 Rust coordinator（CPAL/AAudio），ExoPlayer 不再是
 * transport owner。悬浮歌词时钟需要后续接到 coordinator / 插件侧镜像进度，
 * 否则息屏歌词会停在旧 Exo 时钟上。
 */
object LyricsOverlayRuntime {

    private val lock = Any()
    private val handler = Handler(Looper.getMainLooper())

    private var window: LyricsOverlayWindow? = null
    private var appContext: Context? = null
    private var timeline = LyricsOverlayTimeline.EMPTY
    private var config = LyricsOverlayConfig.DEFAULT
    private var tickScheduled = false

    /** 拖动结束后回传给前端，写进 lyricsPrefs 的 desktopPositionY。 */
    @Volatile
    var onMoved: ((LyricsOverlayEdge, Int) -> Unit)? = null

    private val tickRunnable = object : Runnable {
        override fun run() {
            val delay = renderOnce()
            if (delay > 0L) {
                handler.postDelayed(this, delay)
            } else {
                synchronized(lock) { tickScheduled = false }
            }
        }
    }

    fun canDraw(context: Context): Boolean = ensureWindow(context).canDraw()

    fun isVisible(context: Context): Boolean =
        synchronized(lock) { config.visible } && ensureWindow(context).isAttached()

    fun setTimeline(context: Context, next: LyricsOverlayTimeline) {
        synchronized(lock) { timeline = next }
        val reserve = next.lines.isNotEmpty()
        runOnMain {
            ensureWindow(context).setReserveSecondary(reserve)
            renderOnce()
            scheduleTick()
        }
    }

    /**
     * 应用配置。返回是否真的挂上了悬浮窗——`false` 意味着「显示在其他应用上层」
     * 权限没给（或被 ROM 拦了），调用方需要据此去引导用户，而不是当作成功。
     *
     * `repositionY` 只在换边或重新打开时由调用方给值；平时传 null，
     * 否则每次改锁定或字号都会把用户拖出来的位置弹回默认吸附点。
     */
    fun setConfig(context: Context, next: LyricsOverlayConfig, repositionY: Int?): Boolean {
        synchronized(lock) { config = next }
        val overlay = ensureWindow(context)
        if (!next.visible) {
            runOnMain {
                overlay.detach()
                stopTick()
            }
            return true
        }
        if (!overlay.canDraw()) return false

        // addView / updateViewLayout 都必须在主线程，而插件命令跑在 IPC 线程。
        // 结果要同步回给前端，所以这里等主线程做完。
        return awaitOnMain {
            val attached = overlay.attach(
                edge = next.edge,
                y = repositionY,
                locked = next.locked,
                scale = next.fontScale,
                accent = next.accent,
                secondary = next.secondary,
                dim = next.dim,
                stroke = next.stroke,
                opacity = next.opacity,
            )
            if (attached) {
                overlay.applyPlacement(next.edge, repositionY, next.locked)
                overlay.applyStyle(
                    next.fontScale,
                    next.accent,
                    next.secondary,
                    next.dim,
                    next.stroke,
                    next.opacity,
                )
                renderOnce()
                scheduleTick()
            }
            attached
        }
    }

    fun dispose(context: Context) {
        synchronized(lock) {
            timeline = LyricsOverlayTimeline.EMPTY
            config = LyricsOverlayConfig.DEFAULT
        }
        runOnMain {
            ensureWindow(context).detach()
            stopTick()
        }
    }

    private fun ensureWindow(context: Context): LyricsOverlayWindow {
        synchronized(lock) {
            appContext = context.applicationContext
            window?.let { return it }
            val created = LyricsOverlayWindow(context)
            created.onMoved = { edge, y -> onMoved?.invoke(edge, y) }
            window = created
            return created
        }
    }

    private fun scheduleTick() {
        val shouldRun = synchronized(lock) {
            if (!config.visible || tickScheduled) return@synchronized false
            tickScheduled = true
            true
        }
        if (shouldRun) handler.post(tickRunnable)
    }

    private fun stopTick() {
        synchronized(lock) { tickScheduled = false }
        handler.removeCallbacks(tickRunnable)
    }

    /**
     * 渲染一帧，返回下一帧的间隔；返回 0 表示不必再排。
     *
     * 只在主线程调用。先出锁再读播放器，避免与 [NativeAudioRuntime] 的锁交叉。
     */
    private fun renderOnce(): Long {
        val snapshotTimeline: LyricsOverlayTimeline
        val snapshotConfig: LyricsOverlayConfig
        val overlay: LyricsOverlayWindow?
        synchronized(lock) {
            snapshotTimeline = timeline
            snapshotConfig = config
            overlay = window
        }
        if (overlay == null || !snapshotConfig.visible || !overlay.isAttached()) return 0L

        // 读 coordinator 镜像（含播放中外推），不碰 WebView / ExoPlayer。
        val clock = NativeAudioRuntime.clock()
        val lines = snapshotTimeline.lines
        val stale = snapshotTimeline.trackId != null &&
            clock?.trackId != null &&
            snapshotTimeline.trackId != clock.trackId

        if (clock == null || lines.isEmpty() || stale) {
            overlay.setFrame(snapshotTimeline.placeholder, "", 0f)
            return SLOW_TICK_MS
        }

        // 还没唱到第一句时停在第一句上，与桌面歌词窗口的行为一致。
        val index = max(0, indexAt(lines, clock.positionSec))
        val line = lines[index]
        val duration = if (snapshotTimeline.durationSec > 0.0) {
            snapshotTimeline.durationSec
        } else {
            clock.durationSec
        }
        val secondary = line.secondary.ifEmpty { lines.getOrNull(index + 1)?.text.orEmpty() }
        overlay.setFrame(line.text, secondary, fillOf(lines, index, duration, clock.positionSec))

        return if (clock.isPlaying && isInteractive()) FAST_TICK_MS else SLOW_TICK_MS
    }

    /** 当前播放位置对应的行下标；还没到第一句时返回 -1。 */
    private fun indexAt(lines: List<LyricsOverlayLine>, positionSec: Double): Int {
        var lo = 0
        var hi = lines.size - 1
        var hit = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (lines[mid].timeSec <= positionSec) {
                hit = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return hit
    }

    /**
     * 行内演唱进度 0..1。
     *
     * LRC 只有行级时间戳，行内只能线性推算。直接用「到下一行的间隔」当分母，
     * 遇到间奏（两句之间空十几秒）会让填充慢到看不出在动，所以再按字数估一个
     * 合理的演唱时长，取两者较小值：唱完就填满，剩下的时间停在满格等下一句。
     */
    private fun fillOf(
        lines: List<LyricsOverlayLine>,
        index: Int,
        durationSec: Double,
        positionSec: Double,
    ): Float {
        val line = lines[index]
        val nextTime = lines.getOrNull(index + 1)?.timeSec
            ?: durationSec.takeIf { it > line.timeSec }
            ?: (line.timeSec + TAIL_LINE_SEC)
        val gap = nextTime - line.timeSec
        if (gap <= 0.0) return 1f
        val estimated = max(MIN_FILL_SEC, line.text.length * PER_CHAR_SEC)
        val span = min(gap, estimated)
        return ((positionSec - line.timeSec) / span).coerceIn(0.0, 1.0).toFloat()
    }

    /**
     * 息屏时悬浮窗根本看不见，没必要还按 60Hz 重绘；降到慢速 tick，
     * 亮屏后第一次慢 tick 就会自己升回去，不用额外注册屏幕状态广播。
     */
    private fun isInteractive(): Boolean {
        val context = synchronized(lock) { appContext } ?: return true
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return power?.isInteractive ?: true
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
    }

    /** 插件命令跑在 IPC 线程，但 WindowManager 只能在主线程碰，且结果要同步回前端。 */
    private fun <T> awaitOnMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask(Callable { block() })
        handler.post(task)
        return task.get()
    }

    private const val FAST_TICK_MS = 16L
    private const val SLOW_TICK_MS = 250L
    private const val MIN_FILL_SEC = 1.2
    private const val PER_CHAR_SEC = 0.34
    private const val TAIL_LINE_SEC = 6.0
}
