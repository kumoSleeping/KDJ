package app.tauri.nativeaudio

/** Focus request ownership is independent of mirrored playback. A pause invalidates delayed
 * callbacks; transient loss keeps the same request so GAIN may resume the latest user intent. */
internal class AudioFocusPolicy {
    enum class IntentAction { NONE, REQUEST, RELEASE }
    enum class Result { GRANTED, WAITING, DENIED }

    var generation = 0L
        private set
    private var requested = false
    private var desired = false

    fun updateIntent(playing: Boolean): IntentAction {
        desired = playing
        if (playing && !requested) {
            requested = true
            generation += 1
            return IntentAction.REQUEST
        }
        if (!playing && requested) {
            requested = false
            generation += 1
            return IntentAction.RELEASE
        }
        return IntentAction.NONE
    }

    fun accept(token: Long, result: Result): Result? =
        result.takeIf { requested && desired && token == generation }
}
