package app.tauri.nativeaudio

import android.content.*
import android.os.*
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.util.concurrent.Executors

/** Binder carries only a read-only script FD and a bounded JSON result, never an 8 MiB player
 * script (Binder's transaction budget is much smaller). Only Rust calls this plugin command. */
internal object YoutubeProofClient {
    private val main = Handler(Looper.getMainLooper())
    private val writer = Executors.newSingleThreadExecutor()
    private var nextId = 0
    private var remote: Messenger? = null
    private var binding = false
    private data class Pending(val invoke: Invoke, val message: Message, val fd: ParcelFileDescriptor?)
    private val pending = mutableMapOf<Int, Pending>()
    private val reply = Messenger(Handler(Looper.getMainLooper()) { message ->
        val call = pending.remove(message.arg1)
        if (call != null) {
            val error = message.data.getString("error")
            if (error != null) call.invoke.reject(error)
            else call.invoke.resolve(JSObject().apply { put("value", message.data.getString("value") ?: "") })
        }
        true
    })
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            remote = Messenger(binder)
            pending.values.toList().forEach(::send)
        }
        override fun onServiceDisconnected(name: ComponentName) {
            remote = null
            failAll("YouTube proof 服务连接已断开")
        }
        override fun onNullBinding(name: ComponentName) {
            disconnect("YouTube proof 服务未提供连接")
        }
        override fun onBindingDied(name: ComponentName) {
            remote = null
            failAll("YouTube proof 服务已退出")
            context?.let { runCatching { it.unbindService(this) } }
            binding = false
        }
    }
    private var context: Context? = null

    fun execute(ctx: Context, operation: String, javascript: String, invoke: Invoke) {
        val action = when (operation) {
            "ensure" -> YoutubeProofService.ENSURE
            "eval" -> YoutubeProofService.EVAL
            "destroy" -> YoutubeProofService.DESTROY
            else -> { invoke.reject("无效的 YouTube proof 操作"); return }
        }
        if (javascript.length > YoutubeProofService.MAX_SCRIPT) { invoke.reject("YouTube proof 脚本过大"); return }
        writer.execute {
            var descriptor: ParcelFileDescriptor? = null
            try {
                if (action == YoutubeProofService.EVAL) {
                    val file = File.createTempFile("youtube-proof-", ".js", ctx.cacheDir)
                    try {
                        file.writeText(javascript)
                        descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                    } finally { file.delete() }
                }
                val fd = descriptor
                main.post {
                    context = ctx.applicationContext
                    val id = ++nextId
                    val message = Message.obtain().apply {
                        what = action; arg1 = id; replyTo = reply
                        data = Bundle().apply { if (fd != null) putParcelable("script", fd) }
                    }
                    val call = Pending(invoke, message, fd)
                    pending[id] = call
                    main.postDelayed({
                        if (pending.containsKey(id)) disconnect("YouTube proof 服务响应超时")
                    }, 40_000)
                    if (remote != null) send(call)
                    else if (!binding) {
                        binding = true
                        val bound = runCatching {
                            ctx.applicationContext.bindService(Intent(ctx, YoutubeProofService::class.java), connection, Context.BIND_AUTO_CREATE)
                        }.getOrDefault(false)
                        if (!bound) { binding = false; failAll("无法启动 YouTube proof 服务") }
                    }
                }
            } catch (_: Exception) {
                descriptor?.close()
                invoke.reject("无法传递 YouTube proof 脚本")
            }
        }
    }

    private fun send(call: Pending) {
        try { remote?.send(call.message) }
        catch (_: RemoteException) {
            pending.remove(call.message.arg1)
            call.invoke.reject("YouTube proof 服务调用失败")
        } finally { call.fd?.close() }
    }
    private fun disconnect(error: String) {
        failAll(error)
        remote = null
        if (binding) context?.let { runCatching { it.unbindService(connection) } }
        binding = false
    }

    private fun failAll(error: String) {
        val calls = pending.values.toList(); pending.clear()
        calls.forEach { it.fd?.close(); it.invoke.reject(error) }
    }
}
