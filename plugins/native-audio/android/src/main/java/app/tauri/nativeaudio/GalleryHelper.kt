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
