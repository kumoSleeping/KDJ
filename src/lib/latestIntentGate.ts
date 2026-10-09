/**
 * A single-flight gate for repeatable UI intents.
 *
 * The first request starts immediately when the owner reports a safe state. While that task is
 * running (or the owner is temporarily unsafe), any number of repeat clicks collapse into one
 * latest request. This is intentionally not a time-based debounce: a click is never lost merely
 * because the device or decoder is slow, and `wake()` retries it when state becomes safe again.
 */
export class LatestIntentGate {
  private pending = false;
  private running = false;
  private readonly canRun: () => boolean;
  private readonly run: () => Promise<void>;
  private readonly onError: (error: unknown) => void;

  constructor(
    canRun: () => boolean,
    run: () => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.canRun = canRun;
    this.run = run;
    this.onError = onError;
  }

  request(): void {
    this.pending = true;
    this.drain();
  }

  /** Call after an external state edge may have made the pending request safe. */
  wake(): void {
    this.drain();
  }

  /** A different user intent (previous/play a chosen track/pause) supersedes queued next. */
  cancel(): void {
    this.pending = false;
  }

  private drain(): void {
    if (this.running || !this.pending || !this.canRun()) return;
    this.pending = false;
    this.running = true;
    void this.run()
      .catch(this.onError)
      .finally(() => {
        this.running = false;
        // If repeat clicks arrived while the task ran, either start the latest one now or leave
        // it pending until a later wake. Never recursively create more than one in-flight task.
        this.drain();
      });
  }
}

export interface NativeLatestIntentState {
  hasActiveTrack: boolean;
  currentTrackId: number | null;
  stateTrackId: number | null;
  targetTrackId: number | null;
  buffering: boolean;
  transitioning: boolean;
  chainDepth: number;
  allowsDeferredTransition: boolean;
  errored: boolean;
  errorRecoveryAvailable: boolean;
}

export interface NativeLatestIntentDecision {
  canRun: boolean;
  targetSettled: boolean;
  chainDepth: number;
  consumeErrorRecovery: boolean;
}

/**
 * Decide whether another native-player intent can safely enter the command queue.
 *
 * Mobile players have no second Deck, so even the collapsed latest click waits for a stable
 * track-id/buffering edge. The desktop/Android coordinator may admit exactly one request while
 * a transition is active; that request occupies its single deferred slot.
 */
export function decideNativeLatestIntent({
  hasActiveTrack,
  currentTrackId,
  stateTrackId,
  targetTrackId,
  buffering,
  transitioning,
  chainDepth,
  allowsDeferredTransition,
  errored,
  errorRecoveryAvailable,
}: NativeLatestIntentState): NativeLatestIntentDecision {
  const targetSettled =
    targetTrackId !== null && stateTrackId === targetTrackId && !buffering;
  if (targetTrackId !== null && !targetSettled) {
    return {
      canRun: false,
      targetSettled: false,
      chainDepth,
      consumeErrorRecovery: false,
    };
  }

  // Error is otherwise a terminal state with no future safe edge to wake a pending click. Admit
  // one explicit recovery attempt for this error episode; repeat taps remain collapsed by the
  // gate until that attempt either installs its target or the player publishes a new episode.
  if (errored) {
    return {
      canRun: errorRecoveryAvailable,
      targetSettled,
      chainDepth: 0,
      consumeErrorRecovery: errorRecoveryAvailable,
    };
  }

  // A selected/restored display fallback is enough to choose the next candidate, but it is not
  // yet the active transport owner. Ignore a stale native track id until PlayerBar promotes an
  // actual track; once active, mismatches remain unsafe and must wait for reconciliation.
  const trackAligned =
    !hasActiveTrack ||
    stateTrackId === null ||
    (currentTrackId !== null && stateTrackId === currentTrackId);
  const stable =
    !transitioning &&
    !buffering &&
    trackAligned;
  const nextChainDepth = chainDepth > 0 && stable ? 0 : chainDepth;
  if (!allowsDeferredTransition) {
    return {
      canRun: stable,
      targetSettled,
      chainDepth: nextChainDepth,
      consumeErrorRecovery: false,
    };
  }
  if (nextChainDepth === 0) {
    return {
      canRun: stable,
      targetSettled,
      chainDepth: nextChainDepth,
      consumeErrorRecovery: false,
    };
  }
  return {
    canRun: nextChainDepth === 1 && transitioning && !buffering,
    targetSettled,
    chainDepth: nextChainDepth,
    consumeErrorRecovery: false,
  };
}

/** While a seek has not landed, the next one restarts the decoder no sooner than this. */
export const SEEK_RESTART_INTERVAL_MS = 250;
/** A non-busy player that is still away from the target this long after the ACK will not get there. */
export const SEEK_SETTLE_MS = 400;

export interface NativeSeekGateState {
  stateTrackId: number | null;
  /** Authoritative state is loading, seeking or buffering. */
  busy: boolean;
  /** Time since our previous seek of this song was sent, while the state has stayed busy. */
  sinceUnlandedSeekMs: number | null;
  /** The shared Rust coordinator retargets a pending Load/handoff; iOS AVPlayer cannot. */
  foldsIntoPendingLoad: boolean;
}

/**
 * Milliseconds until the latest seek may enter the native command queue: 0 = now, null = not
 * until the authoritative state changes.
 *
 * The state must already belong to the requested song. Busy alone is no reason to wait on the
 * shared coordinator: right after a track switch it is the pending Load/handoff, which Rust
 * retargets to the seek position. While our own previous seek has not landed, the next one is
 * only spaced out, so a click or key-repeat burst restarts the decoder a few times a second.
 * It is never held until that landing: a stream that stalls must stay seekable, because a new
 * seek is what restarts it.
 */
export function nativeSeekDispatchDelay(trackId: number, state: NativeSeekGateState): number | null {
  if (state.stateTrackId !== trackId) return null;
  if (!state.busy) return 0;
  if (!state.foldsIntoPendingLoad) return null;
  if (state.sinceUnlandedSeekMs === null) return 0;
  return Math.max(0, SEEK_RESTART_INTERVAL_MS - state.sinceUnlandedSeekMs);
}

export interface SeekHoldState {
  /** The seek is still in the request slot or waiting for its ACK. */
  awaitingAck: boolean;
  sameTrack: boolean;
  busy: boolean;
  errored: boolean;
  /** Distance between the authoritative position and the held target, in seconds. */
  distance: number;
  /** How long the state has been acknowledged and not busy. */
  settledMs: number;
}

/**
 * Whether the progress bar keeps showing the clicked position instead of the player's clock.
 *
 * The hold exists so the old position reported while a seek loads cannot pull the playhead back.
 * It must end on what the player reports, not on the landing the UI expected: a seek the
 * coordinator dropped, clamped or replaced never arrives near the target, and holding for it
 * froze the bar for good.
 */
export function holdsSeekPosition(state: SeekHoldState): boolean {
  if (!state.sameTrack || state.errored) return false;
  if (state.awaitingAck || state.busy) return true;
  return state.distance >= 1.5 && state.settledMs < SEEK_SETTLE_MS;
}
