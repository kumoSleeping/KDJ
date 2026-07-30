package app.tauri.nativeaudio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import kotlin.math.abs
import kotlin.math.roundToInt

/** 悬浮窗贴近屏幕上沿还是下沿，与前端 `DesktopLyricsPosition` 同名同义。 */
enum class LyricsOverlayEdge(val wire: String) {
    TOP("top"),
    BOTTOM("bottom"),
    ;

    companion object {
        fun parse(value: String?): LyricsOverlayEdge =
            if (value?.lowercase() == "top") TOP else BOTTOM
    }
}

/**
 * 系统级歌词悬浮窗的窗口层：负责 [WindowManager] 里的那一个 View，
 * 以及它的层级、穿透、垂直位置和位置持久化。不认识歌词，也不认识播放器。
 *
 * 用 `TYPE_APPLICATION_OVERLAY` 而不是 Tauri 的窗口 API：Tauri 移动端的
 * 「多窗口」是 Activity Embedding，每个窗口都是全屏 Activity，做不出浮层，
 * 插件也不允许改 view hierarchy。所以这条路只能自己走原生。
 *
 * 宽度固定 `MATCH_PARENT`、只允许垂直拖动：手机屏幕本来就窄，满宽居中最好读，
 * 也不会被拖到屏幕外找不回来。
 */
class LyricsOverlayWindow(context: Context) {

    private val appContext = context.applicationContext
    private val windowManager =
        appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private var view: LyricsOverlayView? = null
    private var params: WindowManager.LayoutParams? = null
    private var edge = LyricsOverlayEdge.BOTTOM
    private var locked = true

    /** 拖动结束后回传，让前端把位置写进 lyricsPrefs（与桌面同一套字段）。 */
    var onMoved: ((edge: LyricsOverlayEdge, y: Int) -> Unit)? = null

    fun canDraw(): Boolean = Settings.canDrawOverlays(appContext)

    fun isAttached(): Boolean = view != null

    /**
     * 挂上悬浮窗。没有「显示在其他应用上层」权限时直接返回 false，
     * 让上层去引导授权而不是抛给用户一个崩溃。
     */
    fun attach(edge: LyricsOverlayEdge, y: Int?, locked: Boolean, scale: Float, accent: Int, opacity: Float): Boolean {
        if (view != null) {
            applyPlacement(edge, y, locked)
            applyStyle(scale, accent, opacity)
            return true
        }
        if (!canDraw()) return false

        this.edge = edge
        this.locked = locked
        val overlay = LyricsOverlayView(appContext)
        val layout = WindowManager.LayoutParams().apply {
            type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            format = PixelFormat.TRANSLUCENT
            width = WindowManager.LayoutParams.MATCH_PARENT
            height = WindowManager.LayoutParams.WRAP_CONTENT
            gravity = gravityOf(edge)
            flags = flagsOf(locked)
            this.y = clampY(resolveY(edge, y))
        }

        return runCatching {
            windowManager.addView(overlay, layout)
            view = overlay
            params = layout
            overlay.alpha = opacity.coerceIn(MIN_OPACITY, 1f)
            overlay.setStyle(scale, accent)
            bindDrag(overlay)
            true
        }.onFailure { error ->
            // 国产 ROM 即便 canDrawOverlays() 为 true 也可能在这里拦下来。
            Log.w(TAG, "overlay addView failed", error)
        }.getOrDefault(false)
    }

    fun detach() {
        val overlay = view ?: return
        view = null
        params = null
        runCatching { windowManager.removeViewImmediate(overlay) }
            .onFailure { Log.w(TAG, "overlay removeView failed", it) }
    }

    fun applyStyle(scale: Float, accent: Int, opacity: Float) {
        val overlay = view ?: return
        overlay.alpha = opacity.coerceIn(MIN_OPACITY, 1f)
        overlay.setStyle(scale, accent)
    }

    /**
     * `y` 只在调用方明确要求重新吸附时才生效（换边、重新打开）。锁定开关
     * 这类无关操作不能把用户拖出来的位置抹掉——桌面窗口的 `reposition` 同义。
     */
    fun applyPlacement(edge: LyricsOverlayEdge, y: Int?, locked: Boolean) {
        val layout = params ?: return
        val overlay = view ?: return
        var dirty = false

        if (this.edge != edge) {
            this.edge = edge
            layout.gravity = gravityOf(edge)
            layout.y = clampY(resolveY(edge, y))
            dirty = true
        } else if (y != null && y != layout.y) {
            layout.y = clampY(y)
            dirty = true
        }

        if (this.locked != locked) {
            this.locked = locked
            layout.flags = flagsOf(locked)
            dirty = true
        }

        if (!dirty) return
        runCatching { windowManager.updateViewLayout(overlay, layout) }
            .onFailure { Log.w(TAG, "overlay updateViewLayout failed", it) }
    }

    fun setFrame(primary: String, secondary: String, fill: Float) {
        view?.setFrame(primary, secondary, fill)
    }

    fun setReserveSecondary(reserve: Boolean) {
        view?.setReserveSecondary(reserve)
    }

    /** 当前边与偏移，供上层回写前端偏好。 */
    fun placement(): Pair<LyricsOverlayEdge, Int> = edge to (params?.y ?: 0)

    @SuppressLint("ClickableViewAccessibility")
    private fun bindDrag(overlay: LyricsOverlayView) {
        var downRawY = 0f
        var startY = 0
        var dragging = false

        overlay.setOnTouchListener { _, event ->
            val layout = params ?: return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawY = event.rawY
                    startY = layout.y
                    dragging = false
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val delta = event.rawY - downRawY
                    if (!dragging && abs(delta) < touchSlop()) return@setOnTouchListener true
                    dragging = true
                    // 贴下沿时 y 是「离底边多远」，手指往下拖等于这个值变小。
                    val signed = if (edge == LyricsOverlayEdge.BOTTOM) -delta else delta
                    val next = clampY(startY + signed.roundToInt())
                    if (next != layout.y) {
                        layout.y = next
                        runCatching { windowManager.updateViewLayout(overlay, layout) }
                    }
                    true
                }

                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        persistY(edge, layout.y)
                        onMoved?.invoke(edge, layout.y)
                    }
                    dragging = false
                    true
                }

                else -> false
            }
        }
    }

    private fun resolveY(edge: LyricsOverlayEdge, requested: Int?): Int {
        if (requested != null) return requested
        val stored = prefs.getInt(yKey(edge), Int.MIN_VALUE)
        if (stored != Int.MIN_VALUE) return stored
        return dp(if (edge == LyricsOverlayEdge.TOP) DEFAULT_TOP_DP else DEFAULT_BOTTOM_DP)
    }

    private fun persistY(edge: LyricsOverlayEdge, y: Int) {
        prefs.edit().putInt(yKey(edge), y).apply()
    }

    /** 旋屏或字号变化后旧偏移可能越界，夹回屏幕内，别让歌词消失在屏幕外。 */
    private fun clampY(y: Int): Int {
        val screenHeight = appContext.resources.displayMetrics.heightPixels
        val room = (screenHeight - (view?.height ?: 0)).coerceAtLeast(0)
        return y.coerceIn(0, room)
    }

    private fun gravityOf(edge: LyricsOverlayEdge): Int =
        Gravity.CENTER_HORIZONTAL or
            if (edge == LyricsOverlayEdge.TOP) Gravity.TOP else Gravity.BOTTOM

    /**
     * `NOT_FOCUSABLE` 让底下的应用继续拿键盘焦点，`NOT_TOUCH_MODAL` 让浮层
     * 之外的触摸照常穿到下层。锁定时再加 `NOT_TOUCHABLE`，连浮层本身也穿透。
     */
    private fun flagsOf(locked: Boolean): Int {
        var flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        if (locked) flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        return flags
    }

    private fun touchSlop(): Float = dp(TOUCH_SLOP_DP).toFloat()

    private fun dp(value: Float): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        value,
        appContext.resources.displayMetrics,
    ).roundToInt()

    private fun yKey(edge: LyricsOverlayEdge): String = "$KEY_Y_PREFIX${edge.wire}"

    private companion object {
        const val TAG = "plugin/native-audio"
        const val PREFS_NAME = "tauri_native_audio_overlay"
        const val KEY_Y_PREFIX = "overlay_y_"
        const val DEFAULT_TOP_DP = 96f
        const val DEFAULT_BOTTOM_DP = 148f
        const val TOUCH_SLOP_DP = 4f
        const val MIN_OPACITY = 0.2f
    }
}
