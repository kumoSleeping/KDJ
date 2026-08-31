package app.tauri.nativeaudio

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask

data class LyricsOverlayWord(
    val startSec: Double,
    val endSec: Double,
    val text: String,
)

/** 一行歌词：主词 + 可选副行（翻译或罗马音，由前端按当前附加层选好）。 */
data class LyricsOverlayLine(
    val timeSec: Double,
    val endTimeSec: Double?,
    val text: String,
    val secondary: String,
    val words: List<LyricsOverlayWord>,
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

/**
 * 浏览器在线试听的外部时钟。流媒体不进 Rust coordinator，故不能复用本地曲目的
 * [NativeAudioRuntime] 镜像；每次前端校准后由这里按 elapsedRealtime 外推，WebView
 * 被降频时歌词也不会停在上一次 timeupdate。
 *
 * 只允许负 ID（临时流曲目）。本地曲目仍始终由 coordinator 时钟驱动。
 */
data class StreamLyricsPlaybackClock(
    val trackId: Long,
    val positionSec: Double,
    val durationSec: Double,
    val isPlaying: Boolean,
    val rate: Double,
    val stampedElapsedMs: Long,
) {
    fun snapshotNow(nowElapsedMs: Long = SystemClock.elapsedRealtime()): NativeAudioClock {
        val elapsedSec = (nowElapsedMs - stampedElapsedMs).coerceAtLeast(0L) / 1000.0
        val projected = if (isPlaying) positionSec + elapsedSec * rate else positionSec
        val position = if (durationSec > 0.0) {
            projected.coerceIn(0.0, durationSec)
        } else {
            projected.coerceAtLeast(0.0)
        }
        return NativeAudioClock(
            trackId = trackId,
            positionSec = position,
            durationSec = durationSec,
            isPlaying = isPlaying,
        )
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
 * 之后由这里读 [NativeAudioRuntime] 的本地播放时钟；浏览器试听则读单独的、
 * 限频校准后可外推的 [StreamLyricsPlaybackClock]，自己选行。
 *
 * Android 出声已切共享 Rust coordinator（CPAL/AAudio），本地曲目的时间镜像由
 * [NativeAudioRuntime] 提供；浏览器流不进 coordinator，改由外部流时钟提供。
 */
object LyricsOverlayRuntime {

    private val lock = Any()
    private val handler = Handler(Looper.getMainLooper())

    private var window: LyricsOverlayWindow? = null
    private var appContext: Context? = null
    private var timeline = LyricsOverlayTimeline.EMPTY
    /** 只服务负 ID 在线流；正 ID 时间线一定读 NativeAudioRuntime.coordinator 时钟。 */
    private var streamPlaybackClock: StreamLyricsPlaybackClock? = null
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
        synchronized(lock) {
            timeline = next
            // 切曲（含流 → 流）时不能留下上一首外部时钟。本地 / 空时间线也绝不
            // 应带着浏览器流时钟。
            val previousStreamTrackId = streamPlaybackClock?.trackId
            if (next.trackId == null || next.trackId >= 0L ||
                previousStreamTrackId != null && previousStreamTrackId != next.trackId
            ) {
                streamPlaybackClock = null
            }
        }
        val reserve = next.lines.isNotEmpty()
        runOnMain {
            ensureWindow(context).setReserveSecondary(reserve)
            renderOnce()
            scheduleTick()
        }
    }

    /** 前端限频推入浏览器试听的校准点；null 代表换曲或浮层隐藏时清空。 */
    fun setStreamPlaybackClock(next: StreamLyricsPlaybackClock?) {
        synchronized(lock) {
            // 防御性再限制一次：正 ID 只能属于 coordinator，不能走这条旁路。
            streamPlaybackClock = next?.takeIf { it.trackId < 0L }
        }
        runOnMain {
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
        synchronized(lock) {
            config = next
            // 显式隐藏也清理，避免前端被销毁时下一次打开还拿着旧流的外推位置。
            if (!next.visible) streamPlaybackClock = null
        }
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
            streamPlaybackClock = null
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
        val snapshotStreamPlaybackClock: StreamLyricsPlaybackClock?
        val snapshotConfig: LyricsOverlayConfig
        val overlay: LyricsOverlayWindow?
        synchronized(lock) {
            snapshotTimeline = timeline
            snapshotStreamPlaybackClock = streamPlaybackClock
            snapshotConfig = config
            overlay = window
        }
        if (overlay == null || !snapshotConfig.visible || !overlay.isAttached()) return 0L

        // 正 ID 本地曲目只读 coordinator 镜像；负 ID 浏览器试听只接外部流时钟。
        // 流时钟暂未到时宁可显示占位，绝不回退到上一首本地曲目的位置串词。
        val clock = if (snapshotTimeline.trackId != null && snapshotTimeline.trackId < 0L) {
            snapshotStreamPlaybackClock
                ?.takeIf { it.trackId == snapshotTimeline.trackId }
                ?.snapshotNow()
        } else {
            NativeAudioRuntime.clock()
        }
        val lines = snapshotTimeline.lines
        val stale = snapshotTimeline.trackId != null &&
            clock?.trackId != null &&
            snapshotTimeline.trackId != clock.trackId

        if (clock == null || lines.isEmpty() || stale) {
            overlay.setFrame(snapshotTimeline.placeholder, "", 0f, 0f, 0f, 0f)
            return SLOW_TICK_MS
        }

        val activeIndex = indexAt(lines, clock.positionSec)
        // 前奏可以预告第一句；平台明确给出的行间/尾奏空白必须清屏。
        if (activeIndex < 0 && clock.positionSec >= lines.first().timeSec) {
            overlay.setFrame("", "", 0f, 0f, 0f, 0f)
            return if (clock.isPlaying && isInteractive()) FAST_TICK_MS else SLOW_TICK_MS
        }
        val index = if (activeIndex < 0) 0 else activeIndex
        val line = lines[index]
        val fill = fillOf(lines, index, clock.positionSec)
        val synchronizedSecondary = line.secondary.isNotEmpty()
        val secondary = line.secondary.ifEmpty { lines.getOrNull(index + 1)?.text.orEmpty() }
        overlay.setFrame(
            line.text,
            secondary,
            fill,
            if (synchronizedSecondary) fill else 0f,
            fill,
            if (synchronizedSecondary) fill else 0f,
        )

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
        if (hit < 0) return -1
        val endTime = lines[hit].endTimeSec
        return if (endTime != null && positionSec >= endTime) -1 else hit
    }

    /**
     * 行内演唱进度 0..1。
     *
     * 有 YRC 时按平台逐字区间推进；只有行级 LRC 时使用本句到下一句/空白边界，
     * 不再按字数猜一个演唱速度。
     */
    private fun fillOf(
        lines: List<LyricsOverlayLine>,
        index: Int,
        positionSec: Double,
    ): Float {
        val line = lines[index]
        if (positionSec < line.timeSec) return 0f
        if (line.words.isEmpty()) {
            val endTime = line.endTimeSec
                ?: lines.getOrNull(index + 1)?.timeSec
                ?: (line.timeSec + FALLBACK_LINE_SEC)
            val span = endTime - line.timeSec
            if (span <= 0.0) return 1f
            return ((positionSec - line.timeSec) / span).coerceIn(0.0, 1.0).toFloat()
        }
        val total = line.words.sumOf { it.text.length }
        if (total <= 0) return 1f
        var completed = 0
        for (word in line.words) {
            val weight = word.text.length
            if (positionSec < word.startSec) return completed.toFloat() / total
            val span = word.endSec - word.startSec
            if (span > 0.0 && positionSec < word.endSec) {
                val within = ((positionSec - word.startSec) / span).coerceIn(0.0, 1.0)
                return ((completed + weight * within) / total).toFloat()
            }
            completed += weight
        }
        return 1f
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
    private const val FALLBACK_LINE_SEC = 6.0
}
