package app.tauri.nativeaudio

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File

/**
 * 登录二维码这类「要出现在系统相册、再用另一台手机扫」的图：
 * 不能靠 Rust 直写 `/storage/emulated/0/Pictures/...`——scoped storage 下
 * 要么写失败，要么写进去了 MediaStore 也不知道，相册就是空的。
 */
internal object GalleryHelper {
    private const val RELATIVE_DIR = "Pictures/KDJ"
    private const val VIDEO_DIR = "Movies/KDJ"

    fun savePngDataUrl(activity: Activity, platform: String, label: String, image: String): Pair<String, String> {
        val png = decodePngDataUrl(image)
        val displayName = "KDJ-登录二维码-${sanitizeFilename(label.ifBlank { platform })}.png"
        val resolver = activity.contentResolver
        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }

        deleteExisting(activity, collection, displayName)

        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_DIR)
                put(MediaStore.Images.Media.IS_PENDING, 1)
            } else {
                @Suppress("DEPRECATION")
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "KDJ")
                if (!dir.exists() && !dir.mkdirs()) {
                    throw IllegalStateException("无法创建相册目录：${dir.absolutePath}")
                }
                @Suppress("DEPRECATION")
                put(MediaStore.Images.Media.DATA, File(dir, displayName).absolutePath)
            }
        }

        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("写入系统相册失败")
        try {
            resolver.openOutputStream(uri)?.use { it.write(png) }
                ?: throw IllegalStateException("打开相册写入流失败")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val done = ContentValues().apply {
                    put(MediaStore.Images.Media.IS_PENDING, 0)
                }
                resolver.update(uri, done, null, null)
            }
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }

        // 给前端的 path：优先 content URI（打开时最稳），附带用户能认的目录说明。
        return uri.toString() to "/storage/emulated/0/$RELATIVE_DIR/$displayName"
    }

    /**
     * 导出的视频从应用私有目录（Android/data/…，相册和文件管理器都看不见）挪进
     * 系统相册 Movies/KDJ：MediaStore 写入、写完撤掉 IS_PENDING，成功后删掉私有那份。
     * 同名时 MediaStore 自己改名，返回的是它最终用的名字。
     * 返回 content URI + 用户可读路径。
     */
    fun publishVideo(activity: Activity, source: String, name: String): Pair<String, String> {
        val file = File(source)
        if (!file.isFile) throw IllegalStateException("成品不存在：$source")
        val displayName = sanitizeFilename(name.ifBlank { file.name }).let { if (it.endsWith(".mp4", true)) it else "$it.mp4" }
        val resolver = activity.contentResolver
        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Video.Media.RELATIVE_PATH, VIDEO_DIR)
                put(MediaStore.Video.Media.IS_PENDING, 1)
            } else {
                @Suppress("DEPRECATION")
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "KDJ")
                if (!dir.exists() && !dir.mkdirs()) {
                    throw IllegalStateException("无法创建视频目录：${dir.absolutePath}")
                }
                var target = File(dir, displayName)
                var n = 2
                while (target.exists()) target = File(dir, displayName.removeSuffix(".mp4") + " ($n).mp4").also { n++ }
                @Suppress("DEPRECATION")
                put(MediaStore.Video.Media.DATA, target.absolutePath)
            }
        }
        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("写入系统相册失败")
        try {
            resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out, 1 shl 20) } }
                ?: throw IllegalStateException("打开相册写入流失败")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
            }
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
        val finalName = resolver.query(uri, arrayOf(MediaStore.Video.Media.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: displayName
        file.delete()
        @Suppress("DEPRECATION")
        val root = Environment.getExternalStorageDirectory()?.absolutePath ?: "/storage/emulated/0"
        return uri.toString() to "$root/$VIDEO_DIR/$finalName"
    }

    fun openLocalPath(activity: Activity, path: String) {
        val trimmed = path.trim()
        if (trimmed.isEmpty()) throw IllegalArgumentException("路径为空")

        val uri: Uri = when {
            trimmed.startsWith("content://") || trimmed.startsWith("file://") -> Uri.parse(trimmed)
            else -> {
                val file = File(trimmed)
                if (!file.exists()) throw IllegalStateException("文件不存在：$trimmed")
                FileProvider.getUriForFile(
                    activity,
                    "${activity.packageName}.fileprovider",
                    file,
                )
            }
        }

        val mime = activity.contentResolver.getType(uri)
            ?: if (trimmed.endsWith(".png", ignoreCase = true)) "image/png" else "*/*"

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }

    private fun deleteExisting(activity: Activity, collection: Uri, displayName: String) {
        val resolver = activity.contentResolver
        val projection = arrayOf(MediaStore.Images.Media._ID)
        // RELATIVE_PATH 在各家 ROM 上尾斜杠不一致，按文件名 + 路径包含 KDJ 清理。
        val selection: String
        val args: Array<String>
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            selection =
                "${MediaStore.Images.Media.DISPLAY_NAME}=? AND ${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?"
            args = arrayOf(displayName, "%KDJ%")
        } else {
            selection = "${MediaStore.Images.Media.DISPLAY_NAME}=?"
            args = arrayOf(displayName)
        }
        resolver.query(collection, projection, selection, args, null)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idIndex)
                resolver.delete(ContentUris.withAppendedId(collection, id), null, null)
            }
        }
    }

    private fun decodePngDataUrl(image: String): ByteArray {
        val payload = when {
            image.startsWith("data:image/png;base64,", ignoreCase = true) ->
                image.substring("data:image/png;base64,".length)
            image.startsWith("data:image/PNG;base64,") ->
                image.substring("data:image/PNG;base64,".length)
            else -> throw IllegalArgumentException("二维码不是 PNG 图片")
        }
        return Base64.decode(payload, Base64.DEFAULT)
    }

    private fun sanitizeFilename(raw: String): String {
        val cleaned = raw.map { ch ->
            when (ch) {
                '/', '\\', ':', '*', '?', '"', '<', '>', '|' -> '-'
                else -> if (ch.isISOControl()) '-' else ch
            }
        }.joinToString("")
        val trimmed = cleaned.trim().trim('.')
        return trimmed.ifEmpty { "login" }
    }
}
