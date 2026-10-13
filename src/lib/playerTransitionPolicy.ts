export interface ManagerTransitionIntent {
  autoPlay: boolean;
  currentPlaying: boolean;
  transitionEnabled: boolean;
  realtimeTransitionAvailable: boolean;
  dualDeck: boolean;
  currentTrackId: number | null;
  nextTrackId: number;
}

/**
 * Decide before touching either playback owner whether a Manager source replacement belongs to
 * the two-Deck transition lane. Lazy online sources use this same decision while their provider
 * URL resolves, so the old Deck is not cleared before the handoff code gets a chance to overlap it.
 */
export function shouldBeginManagerTransition(intent: ManagerTransitionIntent): boolean {
  return Boolean(
    intent.autoPlay
      && intent.currentPlaying
      && intent.transitionEnabled
      && intent.realtimeTransitionAvailable
      && !intent.dualDeck
      && intent.currentTrackId !== null
      && intent.currentTrackId !== intent.nextTrackId,
  );
}

/**
 * The local-video presenter is a companion of the currently loaded Manager track. Automatic
 * handoffs do not pass through `playTrack`, so reconcile that presenter again when the incoming
 * track becomes the UI authority. Network previews are independent and must not be dismissed by
 * an unrelated Manager handoff.
 */
export function shouldClearLocalVideoSessionForTrack(
  sessionSource: "local" | "network" | null,
  sessionTrackId: number | null,
  nextTrackId: number,
  nextIsVideo: boolean,
): boolean {
  return sessionSource === "local" && (!nextIsVideo || sessionTrackId !== nextTrackId);
}

/**
 * A direct Deck handoff does not pass through `playTrack`, which normally creates the local-video
 * presentation session. Create it exactly once when the incoming Deck actually becomes current;
 * an already prepared session came from an explicit play request and must not be reset/reloaded.
 */
export function shouldRequestLocalVideoSessionForTrack(
  sessionSource: "local" | "network" | null,
  sessionTrackId: number | null,
  nextTrackId: number,
  nextIsVideo: boolean,
): boolean {
  return nextIsVideo && (sessionSource !== "local" || sessionTrackId !== nextTrackId);
}

export interface SourceSwitchFenceIntent {
  autoPlay: boolean;
  /** The switch is a DJ handoff: the outgoing Deck is meant to stay audible for the overlap. */
  djTransition: boolean;
  /** The target plays from a provider stream (any id < 0). */
  nextIsStream: boolean;
  /** Its provider URL is still being resolved. */
  nextIsUnresolved: boolean;
  /** A scratch/preview track of a composition editor keeps its own lifecycle. */
  nextIsCompositionPreview: boolean;
  purposeIsComposition: boolean;
}

/**
 * A stream cannot start sounding when the user picks it: its URL is still being resolved, or it
 * is already known but the remote bytes must be buffered first. The UI has already moved to the
 * new song, so the outgoing Deck must be stopped and its snapshots disowned at the same moment
 * (Clear + a fence on stale snapshots); a hand-over that keeps it audible until the replacement
 * is ready is only right for a DJ overlap. Local files load fast enough to keep the old Deck
 * until the new one is installed (eager manager load). A stream without a URL has always been
 * fenced, whatever it is for; one whose URL is known is fenced outside the composition editors.
 */
export function shouldFenceStreamSwitch(intent: SourceSwitchFenceIntent): boolean {
  return intent.autoPlay
    && !intent.djTransition
    && (intent.nextIsUnresolved
      || (intent.nextIsStream && !intent.nextIsCompositionPreview && !intent.purposeIsComposition));
}
