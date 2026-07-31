package app.tauri.nativeaudio

import android.net.Uri
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * 不解码、不出声的 MediaSession Player。状态由 Rust coordinator 镜像驱动；
 * 系统媒体键回调经 [NativeAudioBridge] 回到 `submit_platform`。
 */
class CoordinatorSessionPlayer(
    looper: Looper,
    private val mirror: () -> Mirror,
) : SimpleBasePlayer(looper) {

    data class Mirror(
        val trackId: Long?,
        val title: String,
        val artist: String,
        val album: String,
        val artworkUrl: String?,
        val positionMs: Long,
        val durationMs: Long,
        val playWhenReady: Boolean,
        val isPlaying: Boolean,
        val buffering: Boolean,
        val ended: Boolean,
        val hasTrack: Boolean,
        val rate: Float,
    ) {
        companion object {
            val EMPTY = Mirror(
                trackId = null,
                title = "",
                artist = "",
                album = "",
                artworkUrl = null,
                positionMs = 0L,
                durationMs = C.TIME_UNSET,
                playWhenReady = false,
                isPlaying = false,
                buffering = false,
                ended = false,
                hasTrack = false,
                rate = 1f,
            )
        }
    }

    fun publish() {
        invalidateState()
    }

    override fun getState(): State {
        val m = mirror()
        val playbackState = when {
            !m.hasTrack -> Player.STATE_IDLE
            m.ended -> Player.STATE_ENDED
            m.buffering -> Player.STATE_BUFFERING
            else -> Player.STATE_READY
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(m.title.ifBlank { "KDJ" })
            .setArtist(m.artist)
            .setAlbumTitle(m.album)
            .apply {
                if (m.durationMs > 0) setDurationMs(m.durationMs)
                val art = m.artworkUrl?.trim().orEmpty()
                if (art.isNotEmpty()) {
                    runCatching { Uri.parse(art) }.onSuccess { setArtworkUri(it) }
                }
            }
            .build()
        val mediaItem = MediaItem.Builder()
            .setMediaId(m.trackId?.toString() ?: "0")
            .setMediaMetadata(metadata)
            .build()
        val itemData = MediaItemData.Builder(m.trackId ?: 0L)
            .setMediaItem(mediaItem)
            .setMediaMetadata(metadata)
            .setIsSeekable(true)
            .setDurationUs(if (m.durationMs > 0) m.durationMs * 1000L else C.TIME_UNSET)
            .build()
        val positionSupplier = if (m.isPlaying && m.rate > 0f) {
            PositionSupplier.getExtrapolating(m.positionMs.coerceAtLeast(0L), m.rate)
        } else {
            PositionSupplier.getConstant(m.positionMs.coerceAtLeast(0L))
        }
        val builder = State.Builder()
            .setAvailableCommands(AVAILABLE_COMMANDS)
            .setPlayWhenReady(m.playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(playbackState)
            .setPlaylist(if (m.hasTrack) listOf(itemData) else emptyList())
            .setSeekBackIncrementMs(SEEK_STEP_MS)
            .setSeekForwardIncrementMs(SEEK_STEP_MS)
        if (m.hasTrack) {
            builder.setContentPositionMs(positionSupplier)
        }
        return builder.build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) NativeAudioBridge.play() else NativeAudioBridge.pause()
        return Futures.immediateVoidFuture()
    }

    override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleSeek(
        mediaItemIndex: Int,
        positionMs: Long,
        seekCommand: Int,
    ): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            -> NativeAudioBridge.previous()
            Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            -> NativeAudioBridge.next()
            Player.COMMAND_SEEK_BACK -> NativeAudioBridge.seekBy(-SEEK_STEP_SEC)
            Player.COMMAND_SEEK_FORWARD -> NativeAudioBridge.seekBy(SEEK_STEP_SEC)
            else -> {
                if (positionMs >= 0L) {
                    NativeAudioBridge.seek(positionMs / 1000.0)
                }
            }
        }
        return Futures.immediateVoidFuture()
    }

    override fun handleStop(): ListenableFuture<*> {
        NativeAudioBridge.pause()
        return Futures.immediateVoidFuture()
    }

    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

    companion object {
        private const val SEEK_STEP_SEC = 10.0
        private const val SEEK_STEP_MS = 10_000L

        private val AVAILABLE_COMMANDS: Player.Commands =
            Player.Commands.Builder()
                .addAll(
                    Player.COMMAND_PLAY_PAUSE,
                    Player.COMMAND_PREPARE,
                    Player.COMMAND_STOP,
                    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_BACK,
                    Player.COMMAND_SEEK_FORWARD,
                    Player.COMMAND_SEEK_TO_PREVIOUS,
                    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_NEXT,
                    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_GET_TIMELINE,
                    Player.COMMAND_GET_METADATA,
                )
                .build()
    }
}
