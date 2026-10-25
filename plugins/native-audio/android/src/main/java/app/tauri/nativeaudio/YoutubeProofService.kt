package app.tauri.nativeaudio

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.*
import android.webkit.*
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/** A separate, app-private WebView process/profile, never a Tauri window. No JavaScript interface
 * is installed. The only result channel is evaluateJavascript, read by our bound-service client. */
class YoutubeProofService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val reader = Executors.newSingleThreadExecutor()
    private var view: WebView? = null
    private var ready = false
    private var generation = 0
    private val waiting = mutableListOf<Message>()
    private val messenger = Messenger(Handler(Looper.getMainLooper()) { message ->
        val request = Message.obtain(message)
        when (request.what) {
            ENSURE -> ensure(request)
            EVAL -> evaluate(request)
            DESTROY -> { reset("YouTube proof 已关闭"); reply(request, "closed") }
            else -> reply(request, error = "无效的 YouTube proof 操作")
        }
        true
    })

    override fun onBind(intent: Intent) = messenger.binder

    private fun ensure(request: Message) {
        if (Build.VERSION.SDK_INT < 28) {
            reply(request, error = "YouTube 播放需要 Android 9 或更新版本")
            return
        }
        if (ready) { reply(request, "ready"); return }
        waiting.add(request)
        if (view != null) return
        val epoch = ++generation
        try {
            // Must precede every WebView API in this process. This directory never contains the
            // main renderer's cookies, login or localStorage. Remove a crashed session on startup.
            if (!profileInitialized) {
                java.io.File(applicationInfo.dataDir, "app_webview_kdj_proof").deleteRecursively()
                WebView.setDataDirectorySuffix("kdj_proof")
                profileInitialized = true
            }
            val web = WebView(this)
            view = web
            web.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_NO_CACHE
                userAgentString = USER_AGENT
                setSupportMultipleWindows(true)
            }
            CookieManager.getInstance().setAcceptCookie(false)
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
            web.webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(v: WebView?, dialog: Boolean, gesture: Boolean, result: Message?) = false
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            }
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = r.url.toString() != DOCUMENT
                override fun onPageStarted(v: WebView, url: String, icon: Bitmap?) {
                    if (url != DOCUMENT) reset("YouTube proof 导航被拒绝")
                }
                override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
                    if (allowed(r.url)) return null
                    return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                }
                override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                    if (r.isForMainFrame) reset("YouTube proof 网络文档加载失败")
                }
                override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, response: WebResourceResponse) {
                    if (r.isForMainFrame) reset("YouTube proof 网络文档返回 HTTP ${response.statusCode}")
                }
                override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                    reset("YouTube proof WebView 已退出")
                    return true
                }
                override fun onPageFinished(v: WebView, url: String) {
                    if (epoch != generation || v !== view || url != DOCUMENT) return
                    ready = true
                    val requests = waiting.toList(); waiting.clear()
                    requests.forEach { reply(it, "ready") }
                }
            }
            CookieManager.getInstance().removeAllCookies {
                if (epoch == generation && view === web) web.loadUrl(DOCUMENT)
            }
            main.postDelayed({ if (epoch == generation && !ready) reset("YouTube proof 加载超时") }, 15_000)
        } catch (_: Exception) {
            reset("无法创建 YouTube proof 隔离环境")
        }
    }

    private fun evaluate(request: Message) {
        @Suppress("DEPRECATION")
        val descriptor = request.data.getParcelable<ParcelFileDescriptor>("script")
        if (descriptor == null) { reply(request, error = "YouTube proof 脚本缺失"); return }
        val epoch = generation
        reader.execute {
            val script = runCatching {
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= MAX_SCRIPT)
                        output.write(buffer, 0, count)
                    }
                    output.toString("UTF-8")
                }
            }.getOrNull()
            main.post {
                val web = view
                if (script == null || !ready || epoch != generation || web == null) {
                    reply(request, error = "YouTube proof 环境已失效")
                } else {
                    web.evaluateJavascript(script) { value ->
                        if (epoch != generation || value.length > 64 * 1024) reply(request, error = "YouTube proof 返回数据无效")
                        else reply(request, value)
                    }
                }
            }
        }
    }

    private fun reset(error: String) {
        generation++
        ready = false
        view?.let { web ->
            web.stopLoading(); web.clearCache(true); web.clearHistory(); web.destroy()
        }
        view = null
        if (profileInitialized) {
            CookieManager.getInstance().removeAllCookies(null)
            WebStorage.getInstance().deleteAllData()
        }
        val requests = waiting.toList(); waiting.clear()
        requests.forEach { reply(it, error = error) }
    }

    override fun onDestroy() {
        reset("YouTube proof 服务已关闭")
        reader.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val ENSURE = 1
        const val EVAL = 2
        const val DESTROY = 3
        const val MAX_SCRIPT = 12 * 1024 * 1024
        private const val DOCUMENT = "https://www.youtube.com/robots.txt"
        private const val USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36(KHTML, like Gecko)"
        private var profileInitialized = false
        private fun allowed(uri: Uri): Boolean {
            if (uri.scheme != "https" || uri.port !in listOf(-1, 443) || uri.userInfo != null) return false
            return when (uri.host) {
                "www.youtube.com" -> uri.path == "/" || uri.toString() == DOCUMENT
                "www.google.com" -> uri.path?.matches(Regex("/js/th/[A-Za-z0-9_.-]+\\.js")) == true
                "jnn-pa.googleapis.com" -> uri.path == "/\$rpc/google.internal.waa.v1.Waa/GenerateIT"
                else -> false
            }
        }
        private fun reply(request: Message, value: String = "", error: String? = null) {
            runCatching {
                request.replyTo?.send(Message.obtain().apply {
                    arg1 = request.arg1
                    data = Bundle().apply { putString("value", value); putString("error", error) }
                })
            }
        }
    }
}
