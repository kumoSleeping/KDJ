package app.tauri.nativeaudio

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.media.AudioAttributes as FrameworkAudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import kotlin.math.max

private const val TAG = "plugin/native-audio"
private const val PROGRESS_PERSIST_THROTTLE_MS = 1_000L
private const val PROGRESS_NEAR_START_EPSILON_SEC = 0.25
private const val PROGRESS_PERSIST_EPSILON_SEC = 0.05
private const val PROGRESS_PREFS_NAME = "tauri_native_audio_progress"
private const val PROGRESS_KEY_STORY_ID = "story_id"
private const val PROGRESS_KEY_CURRENT_TIME = "current_time"
private const val PROGRESS_KEY_UPDATED_AT_MS = "updated_at_ms"
private const val PROGRESS_KEY_STATUS = "status"

/**
 * Android MediaSession / FGS / 焦点 / 歌词时钟宿主。
 *
 * 出声与 seek 状态归 Rust `PlaybackCoordinator`；本对象只镜像 snapshot，
 * 并把系统远程键经 [NativeAudioBridge] 送回 platform 命令通道。
 */
object NativeAudioRuntime {
    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var appContext: Context? = null
    private var mediaSession: MediaSession? = null
    private var sessionPlayer: CoordinatorSessionPlayer? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var holdsAudioFocus = false
    private var noisyRegistered = false

    private var mirrorTrackId: Long? = null
    private var mirrorTitle: String = ""
    private var mirrorArtist: String = ""
    private var mirrorAlbum: String = ""
    private var mirrorArtworkUrl: String? = null
    private var mirrorPositionSec: Double = 0.0
    private var mirrorDurationSec: Double = 0.0
    private var mirrorDesiredPlaying: Boolean = false
    private var mirrorIsPlaying: Boolean = false
    private var mirrorBuffering: Boolean = false
    private var mirrorEnded: Boolean = false
    private var mirrorRate: Double = 1.0
    private var mirrorError: String? = null
    private var mirrorPhase: String = "idle"
    private var mirrorStampedElapsedMs: Long = 0L
    private var lastProgressPersistedAtMs = 0L
    private var lastProgressPersistedStoryId: Long? = null
    private var lastProgressPersistedTimeSec: Double? = null

    private val focusChangeListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            -> NativeAudioBridge.pause()
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // CPAL 侧音量由 coordinator 管；焦点短暂丢失时直接暂停更稳妥。
                NativeAudioBridge.pause()
            }
            else -> Unit
        }
    }

    private val becomingNoisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                NativeAudioBridge.pause()
            }
        }
    }

    fun ensure(context: Context) {
        synchronized(lock) {
            ensureLocked(context.applicationContext)
        }
    }

    fun initialize(context: Context) {
        ensure(context)
        emitState()
    }

    fun applySnapshot(context: Context, args: ApplyPlaybackSnapshotArgs) {
        val ctx = context.applicationContext
        var shouldStartService = false
        var shouldStopService = false
        synchronized(lock) {
            ensureLocked(ctx)
            mirrorTrackId = args.trackId?.takeIf { it > 0 }
            mirrorTitle = args.title?.trim().orEmpty()
            mirrorArtist = args.artist?.trim().orEmpty()
            mirrorAlbum = args.album?.trim().orEmpty()
            mirrorArtworkUrl = args.artworkUrl?.trim()?.takeIf { it.isNotEmpty() }
            mirrorPositionSec = args.currentTime?.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: 0.0
            mirrorDurationSec = args.duration?.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: 0.0
            mirrorDesiredPlaying = args.desiredPlaying == true
            mirrorIsPlaying = args.isPlaying == true
            mirrorBuffering = args.buffering == true
            mirrorEnded = args.phase.equals("ended", ignoreCase = true)
            mirrorRate = args.rate?.takeIf { it.isFinite() && it > 0 } ?: 1.0
            mirrorError = args.error?.trim()?.takeIf { it.isNotEmpty() }
            mirrorPhase = args.phase?.trim()?.ifEmpty { null } ?: "idle"
            mirrorStampedElapsedMs = SystemClock.elapsedRealtime()

            if (mirrorDesiredPlaying || mirrorIsPlaying) {
                requestAudioFocusLocked(ctx)
                registerNoisyReceiverLocked(ctx)
                shouldStartService = true
            } else {
                abandonAudioFocusLocked()
                unregisterNoisyReceiverLocked(ctx)
                if (mirrorPhase.equals("idle", ignoreCase = true) ||
                    mirrorPhase.equals("ended", ignoreCase = true) ||
                    mirrorTrackId == null
                ) {
                    shouldStopService = true
                }
            }

            persistProgressCheckpointLocked(ctx, snapshotLocked(), force = false)
            val player = sessionPlayer
            mainHandler.post { player?.publish() }
        }
        if (shouldStartService) startService(ctx)
        if (shouldStopService) stopService(ctx)
        emitState()
    }

    fun startService(context: Context) {
        val serviceIntent = Intent(context.applicationContext, NativeAudioService::class.java)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.applicationContext.startForegroundService(serviceIntent)
            } else {
                context.applicationContext.startService(serviceIntent)
            }
        }.onFailure { error ->
            Log.w(TAG, "startService failed", error)
        }
    }

    fun stopService(context: Context) {
        val serviceIntent = Intent(context.applicationContext, NativeAudioService::class.java)
        context.applicationContext.stopService(serviceIntent)
    }

    /** 旧 JS transport 入口：Android 出声已切 coordinator，转发为 platform 命令。 */
    fun play(context: Context) {
        ensure(context)
        NativeAudioBridge.play()
    }

    fun pause(context: Context) {
        ensure(context)
        NativeAudioBridge.pause()
    }

    fun seekTo(context: Context, position: Double) {
        ensure(context)
        NativeAudioBridge.seek(position)
    }

    fun setSource(
        context: Context,
        src: String,
        storyId: Long?,
        title: String?,
        artist: String?,
        album: String?,
        artworkUrl: String?,
    ) {
        // 保留签名给 iOS 同插件面的 JS API；Android 上 Load 由 playback_command 完成。
        ensure(context)
        Log.d(TAG, "setSource ignored on coordinator path (src=$src id=$storyId)")
        emitState()
    }

    fun setQueue(context: Context, items: List<SetSourceArgs>) {
        ensure(context)
        Log.d(TAG, "setQueue ignored on coordinator path (items=${items.size})")
        emitState()
    }

    fun setRate(context: Context, rate: Double) {
        ensure(context)
        Log.d(TAG, "setRate ignored on coordinator path (rate=$rate)")
        emitState()
    }

    fun setVolume(context: Context, volume: Double) {
        ensure(context)
        NativeAudioBridge.ensureLoaded()
        runCatching {
            NativeAudioBridge.submitRemote("setVolume", volume.coerceIn(0.0, 1.0))
        }.onFailure { Log.w(TAG, "setVolume bridge failed", it) }
        emitState()
    }

    fun getState(context: Context): NativeAudioState {
        synchronized(lock) {
            ensureLocked(context.applicationContext)
            return snapshotLocked()
        }
    }

    /**
     * 悬浮歌词时钟：读 coordinator 镜像，播放中按 stamp 外推，避免 100ms 级
     * snapshot 间隔造成卡顿。
     */
    fun clock(): NativeAudioClock? {
        synchronized(lock) {
            val trackId = mirrorTrackId ?: return null
            return NativeAudioClock(
                trackId = trackId,
                positionSec = positionSecNowLocked(),
                durationSec = mirrorDurationSec,
                isPlaying = mirrorIsPlaying,
            )
        }
    }

    fun getProgressCheckpoint(context: Context): NativeAudioProgressCheckpoint? {
        val prefs = progressPrefs(context.applicationContext)
        val storyId = prefs.getLong(PROGRESS_KEY_STORY_ID, 0L)
        if (storyId <= 0L) return null
        val currentTime = prefs.getFloat(PROGRESS_KEY_CURRENT_TIME, 0f).toDouble()
        val updatedAtMs = prefs.getLong(PROGRESS_KEY_UPDATED_AT_MS, 0L)
        if (!currentTime.isFinite() || currentTime <= 0.0 || updatedAtMs <= 0L) return null
        val status = prefs.getString(PROGRESS_KEY_STATUS, null)
        return NativeAudioProgressCheckpoint(
            id = storyId,
            currentTime = currentTime,
            updatedAtMs = updatedAtMs,
            status = status,
        )
    }

    fun clearProgressCheckpoint(context: Context) {
        synchronized(lock) {
            progressPrefs(context.applicationContext).edit()
                .remove(PROGRESS_KEY_STORY_ID)
                .remove(PROGRESS_KEY_CURRENT_TIME)
                .remove(PROGRESS_KEY_UPDATED_AT_MS)
                .remove(PROGRESS_KEY_STATUS)
                .apply()
            lastProgressPersistedAtMs = 0L
            lastProgressPersistedStoryId = null
            lastProgressPersistedTimeSec = null
        }
    }

    fun dispose(context: Context) {
        synchronized(lock) {
            persistProgressCheckpointLocked(context.applicationContext, snapshotLocked(), force = true)
            abandonAudioFocusLocked()
            unregisterNoisyReceiverLocked(context.applicationContext)

            val player = sessionPlayer
            sessionPlayer = null
            mediaSession?.release()
            mediaSession = null
            mainHandler.post { player?.release() }

            mirrorTrackId = null
            mirrorTitle = ""
            mirrorArtist = ""
            mirrorAlbum = ""
            mirrorArtworkUrl = null
            mirrorPositionSec = 0.0
            mirrorDurationSec = 0.0
            mirrorDesiredPlaying = false
            mirrorIsPlaying = false
            mirrorBuffering = false
            mirrorEnded = false
            mirrorError = null
            mirrorPhase = "idle"
            appContext = null
        }
        stopService(context)
        emitState()
    }

    fun mediaSession(): MediaSession? {
        synchronized(lock) {
            return mediaSession
        }
    }

    fun mediaSessionPlayer(): Player? {
        synchronized(lock) {
            return sessionPlayer
        }
    }

    private fun ensureLocked(ctx: Context) {
        if (sessionPlayer != null && mediaSession != null) {
            appContext = ctx
            return
        }
        appContext = ctx
        audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        NativeAudioBridge.ensureLoaded()

        val player = CoordinatorSessionPlayer(Looper.getMainLooper()) {
            synchronized(lock) { mirrorForPlayerLocked() }
        }
        sessionPlayer = player

        val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val pendingIntent = launchIntent?.let {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
            PendingIntent.getActivity(ctx, 0, it, flags)
        }

        mediaSession = MediaSession.Builder(ctx, player)
            .apply {
                if (pendingIntent != null) setSessionActivity(pendingIntent)
            }
            .build()
    }

    private fun mirrorForPlayerLocked(): CoordinatorSessionPlayer.Mirror {
        val durationMs = if (mirrorDurationSec > 0) (mirrorDurationSec * 1000.0).toLong() else 0L
        return CoordinatorSessionPlayer.Mirror(
            trackId = mirrorTrackId,
            title = mirrorTitle,
            artist = mirrorArtist,
            album = mirrorAlbum,
            artworkUrl = mirrorArtworkUrl,
            // 给 MediaSession 的是 stamp 原值；播放中外推交给 PositionSupplier。
            positionMs = (mirrorPositionSec * 1000.0).toLong(),
            durationMs = durationMs,
            playWhenReady = mirrorDesiredPlaying,
            isPlaying = mirrorIsPlaying,
            buffering = mirrorBuffering,
            ended = mirrorEnded,
            hasTrack = mirrorTrackId != null,
            rate = mirrorRate.toFloat().coerceAtLeast(0.01f),
        )
    }

    private fun positionSecNowLocked(): Double {
        var position = mirrorPositionSec
        if (mirrorIsPlaying && mirrorRate > 0) {
            val elapsed = (SystemClock.elapsedRealtime() - mirrorStampedElapsedMs) / 1000.0
            position += elapsed * mirrorRate
        }
        if (mirrorDurationSec > 0) {
            position = position.coerceAtMost(mirrorDurationSec)
        }
        return max(0.0, position)
    }

    private fun snapshotLocked(): NativeAudioState {
        val status = when {
            !mirrorError.isNullOrBlank() -> "error"
            mirrorEnded -> "ended"
            mirrorBuffering -> "loading"
            mirrorIsPlaying || mirrorDesiredPlaying -> "playing"
            mirrorTrackId != null -> "idle"
            else -> "idle"
        }
        return NativeAudioState(
            id = mirrorTrackId,
            status = status,
            currentTime = positionSecNowLocked(),
            duration = mirrorDurationSec,
            isPlaying = mirrorIsPlaying,
            buffering = mirrorBuffering,
            rate = mirrorRate,
            error = mirrorError,
        )
    }

    private fun emitState() {
        val snapshot = synchronized(lock) { snapshotLocked() }
        NativeAudioPlugin.emitToActive(snapshot)
    }

    private fun progressPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PROGRESS_PREFS_NAME, Context.MODE_PRIVATE)

    private fun persistProgressCheckpointLocked(
        context: Context,
        snapshot: NativeAudioState,
        force: Boolean,
    ) {
        val storyId = mirrorTrackId ?: return
        if (storyId <= 0L) return
        if (!snapshot.currentTime.isFinite() || snapshot.currentTime <= PROGRESS_NEAR_START_EPSILON_SEC) return

        val now = System.currentTimeMillis()
        if (!force && now - lastProgressPersistedAtMs < PROGRESS_PERSIST_THROTTLE_MS) return

        val prevStoryId = lastProgressPersistedStoryId
        val prevTime = lastProgressPersistedTimeSec
        if (!force &&
            prevStoryId == storyId &&
            prevTime != null &&
            kotlin.math.abs(prevTime - snapshot.currentTime) <= PROGRESS_PERSIST_EPSILON_SEC
        ) {
            return
        }

        progressPrefs(context).edit()
            .putLong(PROGRESS_KEY_STORY_ID, storyId)
            .putFloat(PROGRESS_KEY_CURRENT_TIME, snapshot.currentTime.toFloat())
            .putLong(PROGRESS_KEY_UPDATED_AT_MS, now)
            .putString(PROGRESS_KEY_STATUS, snapshot.status)
            .apply()

        lastProgressPersistedAtMs = now
        lastProgressPersistedStoryId = storyId
        lastProgressPersistedTimeSec = snapshot.currentTime
    }

    private fun requestAudioFocusLocked(context: Context) {
        if (holdsAudioFocus) return
        val manager = audioManager ?: return
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    FrameworkAudioAttributes.Builder()
                        .setUsage(FrameworkAudioAttributes.USAGE_MEDIA)
                        .setContentType(FrameworkAudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                .setOnAudioFocusChangeListener(focusChangeListener, mainHandler)
                .setAcceptsDelayedFocusGain(true)
                .build()
            focusRequest = request
            manager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(
                focusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            )
        }
        holdsAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonAudioFocusLocked() {
        if (!holdsAudioFocus) return
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { manager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(focusChangeListener)
        }
        holdsAudioFocus = false
    }

    private fun registerNoisyReceiverLocked(context: Context) {
        if (noisyRegistered) return
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(becomingNoisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(becomingNoisyReceiver, filter)
        }
        noisyRegistered = true
    }

    private fun unregisterNoisyReceiverLocked(context: Context) {
        if (!noisyRegistered) return
        runCatching { context.unregisterReceiver(becomingNoisyReceiver) }
        noisyRegistered = false
    }
}
