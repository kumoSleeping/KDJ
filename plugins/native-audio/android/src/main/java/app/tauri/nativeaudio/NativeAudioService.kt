package app.tauri.nativeaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerNotificationManager
import java.net.URL
import java.util.concurrent.Executors

private const val NOTIFICATION_ID = 9501
private const val CHANNEL_ID_SUFFIX = ".native_audio"
private const val NOTIFICATION_ICON_NAME = "ic_notification"
private const val MAX_ARTWORK_BYTES = 16 * 1024 * 1024
private const val MAX_ARTWORK_EDGE_PX = 512

class NativeAudioService : MediaSessionService() {
    private var notificationManager: PlayerNotificationManager? = null
    private var appLargeIcon: Bitmap? = null
    private var trackLargeIcon: Bitmap? = null
    private var loadedArtworkUrl: String? = null
    private var loadingArtworkUrl: String? = null
    private val artworkExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        NativeAudioRuntime.ensure(applicationContext)
        setupNotificationManager()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return NativeAudioRuntime.mediaSession()
    }

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // PlayerNotificationManager is the single source for media controls in notification shade.
    }

    override fun onDestroy() {
        notificationManager?.setPlayer(null)
        notificationManager = null
        appLargeIcon?.recycle()
        appLargeIcon = null
        trackLargeIcon?.recycle()
        trackLargeIcon = null
        artworkExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun setupNotificationManager() {
        val player = NativeAudioRuntime.mediaSessionPlayer() ?: return
        val mediaSession = NativeAudioRuntime.mediaSession() ?: return
        if (notificationManager != null) return

        ensureNotificationChannel()

        notificationManager = PlayerNotificationManager.Builder(this, NOTIFICATION_ID, channelId())
            .setMediaDescriptionAdapter(
                object : PlayerNotificationManager.MediaDescriptionAdapter {
                    override fun getCurrentContentTitle(player: androidx.media3.common.Player): CharSequence {
                        return player.mediaMetadata.title ?: appDisplayName()
                    }

                    override fun createCurrentContentIntent(player: androidx.media3.common.Player): PendingIntent? {
                        return mediaSession.sessionActivity
                    }

                    override fun getCurrentContentText(player: androidx.media3.common.Player): CharSequence? {
                        return player.mediaMetadata.artist
                    }

                    override fun getCurrentLargeIcon(
                        player: androidx.media3.common.Player,
                        callback: PlayerNotificationManager.BitmapCallback,
                    ): Bitmap? {
                        val artworkUrl = player.mediaMetadata.artworkUri?.toString()?.takeIf { it.isNotBlank() }
                            ?: return fallbackLargeIcon()
                        synchronized(this@NativeAudioService) {
                            if (loadedArtworkUrl == artworkUrl && trackLargeIcon != null) {
                                return trackLargeIcon
                            }
                            if (loadingArtworkUrl != artworkUrl) {
                                loadingArtworkUrl = artworkUrl
                                artworkExecutor.execute {
                                    val bitmap = loadArtwork(Uri.parse(artworkUrl))
                                    synchronized(this@NativeAudioService) {
                                        if (loadingArtworkUrl != artworkUrl) {
                                            bitmap?.recycle()
                                            return@execute
                                        }
                                        loadingArtworkUrl = null
                                        if (bitmap != null) {
                                            trackLargeIcon = bitmap
                                            loadedArtworkUrl = artworkUrl
                                            callback.onBitmap(bitmap)
                                        }
                                    }
                                }
                            }
                            return fallbackLargeIcon()
                        }
                    }
                },
            )
            .setNotificationListener(
                object : PlayerNotificationManager.NotificationListener {
                    override fun onNotificationPosted(notificationId: Int, notification: Notification, ongoing: Boolean) {
                        if (ongoing) {
                            startForeground(notificationId, notification)
                        } else {
                            stopForegroundCompat(remove = false)
                        }
                    }

                    override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
                        stopForegroundCompat(remove = true)
                        stopSelf()
                    }
                },
            )
            .build()
            .apply {
                setMediaSessionToken(mediaSession.platformToken)
                setUsePlayPauseActions(true)
                setUsePreviousAction(true)
                setUseNextAction(true)
                setUseFastForwardAction(true)
                setUseRewindAction(true)
                setUsePreviousActionInCompactView(true)
                setUseNextActionInCompactView(true)
                setUseRewindActionInCompactView(false)
                setUseFastForwardActionInCompactView(false)
                setUseStopAction(true)
                setSmallIcon(resolveNotificationSmallIconResId())
                setPlayer(player)
            }
    }

    private fun channelId(): String {
        return "${packageName}${CHANNEL_ID_SUFFIX}"
    }

    private fun appDisplayName(): String {
        return applicationInfo.loadLabel(packageManager).toString().ifBlank { "Audio app" }
    }

    private fun resolveNotificationSmallIconResId(): Int {
        val notificationIcon = resources.getIdentifier(NOTIFICATION_ICON_NAME, "drawable", packageName)
        if (notificationIcon != 0) return notificationIcon
        return android.R.drawable.ic_media_play
    }

    private fun resolveAppIconResId(): Int {
        val appIcon = applicationInfo.icon
        return if (appIcon != 0) appIcon else android.R.drawable.sym_def_app_icon
    }

    private fun fallbackLargeIcon(): Bitmap? {
        if (appLargeIcon == null) {
            val iconResId = resolveAppIconResId()
            if (iconResId != 0) appLargeIcon = BitmapFactory.decodeResource(resources, iconResId)
        }
        return appLargeIcon
    }

    private fun loadArtwork(uri: Uri): Bitmap? {
        return runCatching {
            val stream = when (uri.scheme?.lowercase()) {
                "content", "android.resource" -> contentResolver.openInputStream(uri)
                else -> URL(uri.toString()).openStream()
            }
            val bytes = stream?.use { it.readBytes() } ?: return@runCatching null
            if (bytes.size > MAX_ARTWORK_BYTES) return@runCatching null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sampleSize = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_ARTWORK_EDGE_PX) {
                sampleSize *= 2
            }
            BitmapFactory.decodeByteArray(
                bytes,
                0,
                bytes.size,
                BitmapFactory.Options().apply { inSampleSize = sampleSize },
            )
        }.getOrNull()
    }

    private fun stopForegroundCompat(remove: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(if (remove) Service.STOP_FOREGROUND_REMOVE else Service.STOP_FOREGROUND_DETACH)
            return
        }
        @Suppress("DEPRECATION")
        stopForeground(remove)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(channelId()) != null) return
        val channel = NotificationChannel(channelId(), appDisplayName(), NotificationManager.IMPORTANCE_LOW).apply {
            description = "Audio playback controls"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }
}
