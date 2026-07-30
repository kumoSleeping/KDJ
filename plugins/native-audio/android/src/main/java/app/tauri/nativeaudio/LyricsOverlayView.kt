package app.tauri.nativeaudio

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.TypedValue
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * 悬浮歌词的绘制层。只画字，不碰窗口层级也不读播放器：
 * 帧数据由 [LyricsOverlayRuntime] 在主线程推进来。
 *
 * 视觉对齐桌面的 `.kd-desktop-lyrics`（白字 + 粗黑描边 + 投影），额外做了
 * 桌面那边 CSS 做不到的逐字填充：未唱部分压暗，已唱部分用强调色，
 * 分界线按行内进度水平推进。
 *
 * 字号在两处出现：`baseSize` 是配置算出来的基准，绘制时按 [squeeze] 收缩。
 * 每次 onMeasure / onDraw 都把 paint 的 textSize 显式设成当次要用的值，
 * 不做「用完还原」——那种写法一旦有一条分支漏了还原，字号就会逐帧漂移。
 */
class LyricsOverlayView(context: Context) : View(context) {

    private val primaryStroke = strokePaint()
    private val primaryDim = fillPaint()
    private val primaryLit = fillPaint()
    private val secondaryStroke = strokePaint()
    private val secondaryFill = fillPaint()

    private var primaryText = ""
    private var secondaryText = ""
    private var fill = 0f
    private var fontScale = 1f
    private var accentColor = Color.WHITE
    /** 整首歌都没有副行时不预留第二行高度，避免悬浮窗白占一条。 */
    private var reserveSecondary = false

    private var primaryBaseSize = 0f
    private var secondaryBaseSize = 0f

    /** 主行超出可用宽度时的收缩倍率；文本或宽度变化时才重算。 */
    private var squeeze = 1f
    private var layoutForWidth = -1
    private var layoutForText = ""
    private var layoutForScale = 0f

    init {
        setPadding(dp(18f).toInt(), dp(8f).toInt(), dp(18f).toInt(), dp(8f).toInt())
        applyTypography()
    }

    /** 换歌时调用：决定是否给副行预留高度，并触发一次重新测量。 */
    fun setReserveSecondary(reserve: Boolean) {
        if (reserveSecondary == reserve) return
        reserveSecondary = reserve
        requestLayout()
        invalidate()
    }

    fun setStyle(scale: Float, accent: Int) {
        val safeScale = scale.coerceIn(1f, 3f)
        if (fontScale == safeScale && accentColor == accent) return
        fontScale = safeScale
        accentColor = accent
        applyTypography()
        invalidateLayoutCache()
        requestLayout()
        invalidate()
    }

    /**
     * 推进一帧。播放中这是 60Hz 调用的，所以完全没变化时直接返回，
     * 让 View 不必进 onDraw。
     */
    fun setFrame(primary: String, secondary: String, progress: Float) {
        val nextFill = progress.coerceIn(0f, 1f)
        if (primaryText == primary && secondaryText == secondary && fill == nextFill) return
        val textChanged = primaryText != primary || secondaryText != secondary
        primaryText = primary
        secondaryText = secondary
        fill = nextFill
        if (textChanged) invalidateLayoutCache()
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        primaryDim.textSize = primaryBaseSize
        secondaryFill.textSize = secondaryBaseSize
        val secondaryHeight = if (reserveSecondary) secondaryFill.fontSpacing + dp(LINE_GAP_DP) else 0f
        val height = paddingTop + paddingBottom + primaryDim.fontSpacing + secondaryHeight
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), height.toInt())
    }

    override fun onDraw(canvas: Canvas) {
        if (primaryText.isEmpty()) return
        val available = (width - paddingLeft - paddingRight).toFloat()
        if (available <= 0f) return

        resolveSqueeze(available)

        val primarySize = primaryBaseSize * squeeze
        primaryStroke.textSize = primarySize
        primaryStroke.strokeWidth = primarySize * STROKE_RATIO
        primaryDim.textSize = primarySize
        primaryLit.textSize = primarySize

        val primaryWidth = primaryDim.measureText(primaryText)
        val centered = paddingLeft + max(0f, (available - primaryWidth) / 2f)
        val baseX = centered + overflowShift(primaryWidth, available)
        val baseY = paddingTop - primaryDim.ascent()

        canvas.drawText(primaryText, baseX, baseY, primaryStroke)
        canvas.drawText(primaryText, baseX, baseY, primaryDim)

        // 已唱部分：同一串字重画一遍，按行内进度裁出分界线。裁剪比渐变
        // shader 更好控制，CJK 与拉丁混排时也不会在字形内部糊掉。
        if (fill > 0f) {
            canvas.save()
            canvas.clipRect(0f, 0f, baseX + primaryWidth * fill, height.toFloat())
            canvas.drawText(primaryText, baseX, baseY, primaryLit)
            canvas.restore()
        }

        if (secondaryText.isEmpty()) return
        // 主行被压缩说明本来就放不下，副行同步收缩，否则两行宽度会打架。
        val secondarySize = secondaryBaseSize * squeeze
        secondaryStroke.textSize = secondarySize
        secondaryStroke.strokeWidth = secondarySize * STROKE_RATIO
        secondaryFill.textSize = secondarySize
        val secondaryWidth = secondaryFill.measureText(secondaryText)
        val secondaryX = paddingLeft + max(0f, (available - secondaryWidth) / 2f)
        val secondaryY = baseY + primaryDim.descent() + dp(LINE_GAP_DP) - secondaryFill.ascent()
        canvas.drawText(secondaryText, secondaryX, secondaryY, secondaryStroke)
        canvas.drawText(secondaryText, secondaryX, secondaryY, secondaryFill)
    }

    /** 长句先按可用宽度缩字号，缩到下限为止；再放不下交给 [overflowShift]。 */
    private fun resolveSqueeze(available: Float) {
        if (layoutForWidth == width && layoutForText == primaryText && layoutForScale == fontScale) {
            return
        }
        layoutForWidth = width
        layoutForText = primaryText
        layoutForScale = fontScale

        primaryDim.textSize = primaryBaseSize
        val natural = primaryDim.measureText(primaryText)
        squeeze = if (natural <= available || natural <= 0f) 1f else max(MIN_SQUEEZE, available / natural)
    }

    /**
     * 缩到下限还是放不下时，跟着填充点横向平移，保证正在唱的那几个字始终
     * 在屏幕里。省略号会把最该看的部分吃掉，所以不用截断。
     */
    private fun overflowShift(primaryWidth: Float, available: Float): Float {
        val overflow = primaryWidth - available
        if (overflow <= 0f) return 0f
        return -min(overflow, overflow * fill)
    }

    private fun invalidateLayoutCache() {
        layoutForWidth = -1
        layoutForText = ""
        layoutForScale = 0f
    }

    private fun applyTypography() {
        primaryBaseSize = sp(PRIMARY_SP) * fontScale
        secondaryBaseSize = sp(SECONDARY_SP) * fontScale
        val bold = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        for (paint in listOf(primaryStroke, primaryDim, primaryLit, secondaryStroke, secondaryFill)) {
            paint.typeface = bold
        }
        primaryDim.color = DIM_COLOR
        primaryLit.color = accentColor
        secondaryFill.color = SECONDARY_COLOR

        val shadow = dp(1.5f)
        primaryDim.setShadowLayer(shadow, 0f, shadow, SHADOW_COLOR)
        primaryLit.setShadowLayer(shadow, 0f, shadow, SHADOW_COLOR)
        secondaryFill.setShadowLayer(shadow, 0f, shadow, SHADOW_COLOR)
    }

    private fun strokePaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.BLACK
        strokeJoin = Paint.Join.ROUND
        textAlign = Paint.Align.LEFT
    }

    private fun fillPaint() = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.WHITE
        textAlign = Paint.Align.LEFT
    }

    private fun dp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    private fun sp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

    private companion object {
        const val PRIMARY_SP = 21f
        const val SECONDARY_SP = 13f
        const val STROKE_RATIO = 0.14f
        const val MIN_SQUEEZE = 0.62f
        const val LINE_GAP_DP = 2f
        val DIM_COLOR = Color.argb(0x9E, 0xFF, 0xFF, 0xFF)
        val SECONDARY_COLOR = Color.argb(0xF0, 0xFF, 0xFF, 0xFF)
        val SHADOW_COLOR = Color.argb(0xE6, 0x00, 0x00, 0x00)
    }
}
