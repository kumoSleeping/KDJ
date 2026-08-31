package app.tauri.nativeaudio

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentUris
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Point
import android.net.Uri
import android.provider.MediaStore
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import androidx.core.content.FileProvider
import java.io.File
import java.net.URLConnection

/** 把曲库真实路径包装成 Android 跨窗口拖放接受的 content URI。 */
internal object FileDragHelper {
    fun start(activity: Activity, paths: List<String>, label: String): Boolean {
        require(paths.isNotEmpty()) { "没有可拖动的文件" }
        require(paths.size <= 2_000) { "一次最多拖动 2000 个文件" }

        val items = paths.distinct().map { path -> path to uriForPath(activity, path) }
        val uris = items.map { (_, uri) -> uri }
        val mimeTypes = items
            .map { (path, uri) -> mimeType(activity, uri, path) }
            .distinct()
            .ifEmpty { listOf("application/octet-stream") }
            .toTypedArray()
        val description = ClipDescription(label, mimeTypes)
        val clip = ClipData(description, ClipData.Item(uris.first()))
        uris.drop(1).forEach { uri -> clip.addItem(ClipData.Item(uri)) }

        // 必须由仍在接收触摸序列的已挂载 View 发起。decorView 覆盖 Tauri WebView，
        // 又不会把任意 DOM 节点的生命周期带进 Android 原生拖放会话。
        val source = activity.window.decorView
        val flags = View.DRAG_FLAG_GLOBAL or View.DRAG_FLAG_GLOBAL_URI_READ
        return source.startDragAndDrop(
            clip,
            FileDragShadowBuilder(source, label, uris.size),
            null,
            flags,
        )
    }

    private fun uriForPath(activity: Activity, raw: String): Uri {
        val trimmed = raw.trim()
        require(trimmed.isNotEmpty()) { "拖动路径为空" }
        if (trimmed.startsWith("content://")) return Uri.parse(trimmed)

        val file = when {
            trimmed.startsWith("file://") -> File(requireNotNull(Uri.parse(trimmed).path))
            else -> File(trimmed)
        }
        require(file.isAbsolute) { "拖动路径不是绝对路径：$trimmed" }
        require(file.isFile) { "拖动文件不存在：$trimmed" }

        // 主存储直接走已有 FileProvider。可移动存储不在 <external-path> 根下时，
        // 从 MediaStore 找同一个文件的系统 URI，避免扩大 provider 到整个 /storage。
        return runCatching {
            FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file,
            )
        }.getOrElse {
            mediaStoreUri(activity, file)
                ?: throw IllegalStateException("系统无法共享这个文件：${file.absolutePath}")
        }
    }

    @Suppress("DEPRECATION")
    private fun mediaStoreUri(activity: Activity, file: File): Uri? {
        val collection = MediaStore.Files.getContentUri("external")
        val projection = arrayOf(MediaStore.Files.FileColumns._ID)
        val selection = "${MediaStore.Files.FileColumns.DATA}=?"
        activity.contentResolver.query(
            collection,
            projection,
            selection,
            arrayOf(file.absolutePath),
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID))
            return ContentUris.withAppendedId(collection, id)
        }
        return null
    }

    private fun mimeType(activity: Activity, uri: Uri, path: String): String {
        activity.contentResolver.getType(uri)?.takeIf { it.isNotBlank() }?.let { return it }
        return URLConnection.guessContentTypeFromName(path) ?: "application/octet-stream"
    }
}

/** 小而清楚的系统拖动影子；不会截整张 KDJ 窗口当预览。 */
private class FileDragShadowBuilder(
    source: View,
    label: String,
    count: Int,
) : View.DragShadowBuilder(source) {
    private val density = source.resources.displayMetrics.density
    private val width = (220 * density).toInt()
    private val height = (54 * density).toInt()
    private val radius = 12 * density
    private val background = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(38, 40, 46) }
    private val accent = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(92, 190, 255) }
    private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 14 * density
    }
    private val countPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(210, 255, 255, 255)
        textSize = 11 * density
    }
    private val displayLabel = TextUtils.ellipsize(
        label.ifBlank { "本地文件" },
        titlePaint,
        width - 68 * density,
        TextUtils.TruncateAt.END,
    ).toString()
    private val countLabel = if (count > 1) "$count 个文件" else "本地文件"

    override fun onProvideShadowMetrics(outShadowSize: Point, outShadowTouchPoint: Point) {
        outShadowSize.set(width, height)
        outShadowTouchPoint.set((22 * density).toInt(), height / 2)
    }

    override fun onDrawShadow(canvas: Canvas) {
        canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), radius, radius, background)
        canvas.drawCircle(27 * density, 27 * density, 15 * density, accent)
        titlePaint.textAlign = Paint.Align.CENTER
        titlePaint.textSize = 20 * density
        canvas.drawText("♪", 27 * density, 34 * density, titlePaint)

        titlePaint.textAlign = Paint.Align.LEFT
        titlePaint.textSize = 14 * density
        canvas.drawText(displayLabel, 52 * density, 23 * density, titlePaint)
        canvas.drawText(countLabel, 52 * density, 41 * density, countPaint)
    }
}
