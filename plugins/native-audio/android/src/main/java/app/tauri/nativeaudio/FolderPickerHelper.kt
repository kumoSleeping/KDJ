package app.tauri.nativeaudio

import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import java.io.File
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * 把系统文件夹选择器（ACTION_OPEN_DOCUMENT_TREE）返回的 tree URI
 * 尽量还原成 Rust 曲库扫描能用的真实路径。
 *
 * 曲库层走 `std::fs`，读不了 content://；主存储 / 可移动卷在 DocumentProvider
 * 下通常能映射回 `/storage/...`。映射失败就让上层提示用户改选共享目录。
 */
internal object FolderPickerHelper {
    fun treeUriToFilesystemPath(uri: Uri): String? {
        if (uri.scheme != "content") return uri.path?.takeIf { it.isNotBlank() }
        val docId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
            ?: return null
        return documentIdToPath(docId)?.let(::normalizeExistingDir)
    }

    private fun documentIdToPath(docId: String): String? {
        val decoded = runCatching {
            URLDecoder.decode(docId, StandardCharsets.UTF_8.name())
        }.getOrDefault(docId)
        val separator = decoded.indexOf(':')
        if (separator < 0) return null
        val volume = decoded.substring(0, separator)
        val relative = decoded.substring(separator + 1)
            .trim('/')
            .replace('/', File.separatorChar)
        val root = volumeRoot(volume) ?: return null
        return if (relative.isEmpty()) root else root + File.separator + relative
    }

    private fun volumeRoot(volume: String): String? {
        if (volume.equals("primary", ignoreCase = true)) {
            @Suppress("DEPRECATION")
            return Environment.getExternalStorageDirectory()?.absolutePath
                ?: "/storage/emulated/0"
        }
        // 可移动存储：XXXX-XXXX → /storage/XXXX-XXXX
        if (volume.matches(Regex("^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$"))) {
            return "/storage/$volume"
        }
        val candidate = File("/storage", volume)
        return if (candidate.isDirectory) candidate.absolutePath else null
    }

    private fun normalizeExistingDir(path: String): String? {
        val file = File(path)
        return if (file.isDirectory) file.absolutePath else null
    }
}
