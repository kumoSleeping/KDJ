package app.tauri.nativeaudio

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * A platform's own login page, opened for the user to log in on, and the cookies it leaves behind.
 *
 * It knows no platform: the caller gives the page, the cookies that mean "logged in", and the
 * addresses whose cookies are handed back (read from CookieManager, so HttpOnly ones too). It runs
 * in its own process with its own WebView profile, emptied before and after, so the app's renderer
 * never shares cookies with it and every login starts signed out. Links that leave the web for
 * another app (wtloginmqq://, weixin://, intent://) are not followed: the result could not come back.
 */
class WebLoginActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var doneCookies: List<String> = emptyList()
    private var cookieUrls: List<String> = emptyList()
    private var finishing = false

    private val watch = object : Runnable {
        override fun run() {
            if (finishing) return
            if (loggedIn()) {
                finishing = true
                // The cookies that come with the login (bili_jct, psrf_*, __csrf) are set in the
                // same round of redirects; give it a moment before reading them.
                main.postDelayed({ deliver() }, SETTLE_MS)
            } else {
                main.postDelayed(this, POLL_MS)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)
        doneCookies = intent.getStringArrayExtra(EXTRA_DONE)?.toList().orEmpty()
        cookieUrls = intent.getStringArrayExtra(EXTRA_COOKIE_URLS)?.toList().orEmpty()
        if (url.isNullOrBlank() || !url.startsWith("https://") || doneCookies.isEmpty() || cookieUrls.isEmpty()) {
            setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, "登录页参数不完整"))
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= 28 && !profileInitialized) {
            // Must precede every WebView call in this process: the login's own profile, never the app's.
            WebView.setDataDirectorySuffix("kdj_web_login")
            profileInitialized = true
        }

        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            // The phone's own user agent without the WebView's "; wv", or the one the site needs.
            userAgentString = intent.getStringExtra(EXTRA_USER_AGENT)?.takeIf { it.isNotBlank() }
                ?: userAgentString.replace(WEBVIEW_MARK, "")
        }
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        // QQ's login goes through ptlogin2 / graph.qq.com frames before it lands on y.qq.com.
        cookies.setAcceptThirdPartyCookies(view, intent.getBooleanExtra(EXTRA_THIRD_PARTY, true))
        view.webChromeClient = WebChromeClient()
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase()
                if (scheme == "https" || scheme == "http") return false
                if (request.isForMainFrame || request.hasGesture()) {
                    Toast.makeText(this@WebLoginActivity, "这里不能跳到别的 App 登录，请换一种方式", Toast.LENGTH_SHORT).show()
                }
                return true
            }

            override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) { title(v.url ?: url) }
            override fun onPageFinished(v: WebView, url: String) { title(v.url ?: url) }
        }

        setContentView(layout(view))
        lightBars()
        // Android 16 no longer calls onBackPressed for an app that targets it.
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        }
        if (savedInstanceState != null) {
            // The system ended this process while the user was away (reading a code in another
            // app): go on with the page and what it has set so far.
            if (view.restoreState(savedInstanceState) == null) view.loadUrl(url)
            main.postDelayed(watch, POLL_MS)
            return
        }
        // Every login starts signed out, whoever logged in here last time.
        WebStorage.getInstance().deleteAllData()
        cookies.removeAllCookies {
            if (!isFinishing) {
                view.loadUrl(url)
                main.postDelayed(watch, POLL_MS)
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web?.saveState(outState)
    }

    /** The bar is light: the status and navigation bars carry dark icons over it. */
    @Suppress("DEPRECATION")
    private fun lightBars() {
        window.statusBarColor = BAR_COLOR
        window.navigationBarColor = BAR_COLOR
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(light, light)
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
    }

    private lateinit var titleView: TextView

    private fun title(url: String) {
        if (::titleView.isInitialized) titleView.text = android.net.Uri.parse(url).host ?: ""
    }

    private fun layout(view: WebView): View {
        val dp = { value: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt() }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(BAR_COLOR)
            setPadding(dp(16), 0, dp(4), 0)
        }
        titleView = TextView(this).apply {
            setTextColor(Color.parseColor("#6B6B6B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        bar.addView(titleView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val close = TextView(this).apply {
            text = "取消"
            setTextColor(Color.parseColor("#1A1A1A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(dp(12), 0, dp(12), 0)
            isClickable = true
            setOnClickListener { cancel() }
        }
        bar.addView(close, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BAR_COLOR)
            addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
            addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        // Edge to edge from Android 15: keep the bar under the status bar and the page above the
        // gestures and the keyboard (adjustResize puts the keyboard in the system window insets).
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        return root
    }

    private fun loggedIn(): Boolean {
        val cookies = CookieManager.getInstance()
        return cookieUrls.any { url ->
            val names = cookies.getCookie(url)?.split(';')?.mapNotNull { pair ->
                val (name, value) = pair.split('=', limit = 2).let { it.getOrNull(0)?.trim() to it.getOrNull(1)?.trim() }
                name?.takeIf { !value.isNullOrEmpty() }
            }.orEmpty()
            doneCookies.any(names::contains)
        }
    }

    private fun deliver() {
        val cookies = CookieManager.getInstance()
        val found = ArrayList(cookieUrls.map { cookies.getCookie(it).orEmpty() })
        setResult(RESULT_OK, Intent().putStringArrayListExtra(EXTRA_COOKIES, found))
        close()
    }

    private fun cancel() {
        if (finishing) return
        finishing = true
        setResult(RESULT_CANCELED)
        close()
    }

    /** Nothing of this login stays in the WebView's profile: the app keeps its own copy. */
    private fun close() {
        main.removeCallbacksAndMessages(null)
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush() }
        finish()
    }

    /** Back goes back a page in the site; on its first page it leaves the login. */
    private fun back() {
        val view = web
        if (view != null && view.canGoBack()) view.goBack() else cancel()
    }

    @Deprecated("Activity.onBackPressed")
    override fun onBackPressed() = back()

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        web?.apply {
            stopLoading()
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        web = null
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_DONE = "doneCookies"
        const val EXTRA_COOKIE_URLS = "cookieUrls"
        const val EXTRA_USER_AGENT = "userAgent"
        const val EXTRA_THIRD_PARTY = "thirdPartyCookies"
        const val EXTRA_COOKIES = "cookies"
        const val EXTRA_ERROR = "error"
        private const val POLL_MS = 500L
        private const val SETTLE_MS = 1500L
        private val BAR_COLOR = Color.parseColor("#F2F2F2")
        private val WEBVIEW_MARK = Regex("; ?wv(?=[;)])")
        private var profileInitialized = false
    }
}
