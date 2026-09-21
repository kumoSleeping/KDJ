package app.tauri.nativeaudio

/** Standalone JVM regression; compile with AudioFocusPolicy.kt, then run this main. No Android
 * device, framework mocks or plugin lifecycle is needed to verify focus request ownership. */
fun main() {
    val policy = AudioFocusPolicy()
    check(policy.updateIntent(true) == AudioFocusPolicy.IntentAction.REQUEST)
    val first = policy.generation
    check(policy.accept(first, AudioFocusPolicy.Result.WAITING) == AudioFocusPolicy.Result.WAITING)
    check(policy.updateIntent(true) == AudioFocusPolicy.IntentAction.NONE)
    check(policy.accept(first, AudioFocusPolicy.Result.GRANTED) == AudioFocusPolicy.Result.GRANTED)
    check(policy.accept(first, AudioFocusPolicy.Result.WAITING) == AudioFocusPolicy.Result.WAITING)
    check(policy.accept(first, AudioFocusPolicy.Result.GRANTED) == AudioFocusPolicy.Result.GRANTED)

    // Pause cancels even a never-granted request; neither its delayed grant nor denial is valid.
    check(policy.updateIntent(false) == AudioFocusPolicy.IntentAction.RELEASE)
    check(policy.accept(first, AudioFocusPolicy.Result.GRANTED) == null)
    check(policy.updateIntent(true) == AudioFocusPolicy.IntentAction.REQUEST)
    val second = policy.generation
    check(policy.accept(first, AudioFocusPolicy.Result.DENIED) == null)
    check(policy.accept(second, AudioFocusPolicy.Result.DENIED) == AudioFocusPolicy.Result.DENIED)
    // A rejected request cannot be recreated by every 100 ms playback snapshot.
    check(policy.updateIntent(true) == AudioFocusPolicy.IntentAction.NONE)
    check(policy.updateIntent(false) == AudioFocusPolicy.IntentAction.RELEASE)
    check(policy.updateIntent(false) == AudioFocusPolicy.IntentAction.NONE)
    check(policy.accept(second, AudioFocusPolicy.Result.GRANTED) == null)
    println("Audio focus ownership regressions passed")
}
