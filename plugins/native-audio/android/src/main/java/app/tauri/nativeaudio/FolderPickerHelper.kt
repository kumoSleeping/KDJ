package app.tauri.nativeaudio

import android.content.ContentResolver
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
 *
 * **SAF 授权 ≠ 文件系统访问**：takePersistableUriPermission 只覆盖 content://，
 * 裸路径能不能读取决于媒体运行时权限（13+ READ_MEDIA_AUDIO/VIDEO，≤12
 * READ_EXTERNAL_STORAGE）。所以这里还提供两个探测：文件 API 视角的
 * [probeFilesystemDir] 和 SAF 视角的 [safTreeHasMedia]，调用方用它们区分
 * 「真没歌」「没权限」「文件不可见」，而不是把空结果直接当成成功。
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

    // ---------------------------------------------------------------- 可读性探测

    /** 曲库认的媒体后缀，与 Rust 侧 `is_media_extension` 逐项一致（音频 ∪ 视频）。 */
    private val MEDIA_EXTENSIONS = setOf(
        "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif",
        "mp4", "m4v", "mov", "webm", "mkv",
    )

    /** 目录探测结果：文件 API 能不能读、能读到几个媒体文件。 */
    data class DirProbe(
        /** 根目录 readdir 是否成功（false = 权限被挡 / 目录已断开）。 */
        val readable: Boolean,
        /** 文件 API 可见的媒体文件数（找到第一个就提前结束，只保证下界）。 */
        val visibleMedia: Int,
        /** 遍历被上限截断（目录极大）且还没见到媒体文件，结果不确定。 */
        val truncated: Boolean,
    )

    private const val PROBE_MAX_DIRS = 5000
    private const val PROBE_MAX_DEPTH = 16

    /**
     * 以 Rust 扫描**完全相同的视角**（`std::fs` 裸路径）探测目录：
     * 递归找媒体文件，找到第一个就停。权限被 FUSE 过滤时表现为
     * readable=true 但 visibleMedia=0，和真空目录分不清——那种情况
     * 交给 [safTreeHasMedia] 交叉验证。
     */
    fun probeFilesystemDir(path: String): DirProbe {
        val root = File(path)
        val first = root.listFiles() ?: return DirProbe(readable = false, visibleMedia = 0, truncated = false)
        var media = 0
        var dirsVisited = 0
        var truncated = false
        val stack = ArrayDeque<Pair<Array<File>, Int>>()
        stack.addLast(first to 1)
        while (stack.isNotEmpty() && media == 0) {
            val (entries, depth) = stack.removeLast()
            if (++dirsVisited > PROBE_MAX_DIRS) {
                truncated = true
                break
            }
            for (entry in entries) {
                val name = entry.name
                if (name.startsWith('.')) continue
                if (entry.isDirectory) {
                    if (depth < PROBE_MAX_DEPTH) {
                        val children = entry.listFiles() ?: continue
                        stack.addLast(children to depth + 1)
                    }
                } else if (entry.extension.lowercase() in MEDIA_EXTENSIONS) {
                    media += 1
                    break
                }
            }
        }
        return DirProbe(readable = true, visibleMedia = media, truncated = truncated)
    }

    // ---------------------------------------------------------------- SAF 交叉验证

    private const val SAF_MAX_DOCS = 2000
    private const val SAF_MAX_DEPTH = 16

    /**
     * SAF 授权视角里这棵树有没有媒体文件。
     * true/false = 确定；null = 不确定（查询失败或树太大走不完）。
     *
     * 文件 API 看不到、SAF 看得到 = 文件存在但被 scoped storage 挡住
     * （没权限 / 未进媒体库）；两边都看不到 = 文件夹真的没歌。
     */
    fun safTreeHasMedia(resolver: ContentResolver, treeUri: Uri): Boolean? {
        return runCatching {
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            )
            var visited = 0
            val stack = ArrayDeque<Pair<String, Int>>()
            stack.addLast(DocumentsContract.getTreeDocumentId(treeUri) to 0)
            while (stack.isNotEmpty()) {
                val (docId, depth) = stack.removeLast()
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
                val cursor = resolver.query(childrenUri, projection, null, null, null)
                    ?: return null
                cursor.use {
                    while (it.moveToNext()) {
                        if (++visited > SAF_MAX_DOCS) return null
                        val childId = it.getString(0) ?: continue
                        val mime = it.getString(1).orEmpty()
                        val name = it.getString(2).orEmpty()
                        if (name.startsWith('.')) continue
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            if (depth < SAF_MAX_DEPTH) stack.addLast(childId to depth + 1)
                        } else if (
                            mime.startsWith("audio/") ||
                            mime.startsWith("video/") ||
                            name.substringAfterLast('.', "").lowercase() in MEDIA_EXTENSIONS
                        ) {
                            return true
                        }
                    }
                }
            }
            false
        }.getOrNull()
    }
}
