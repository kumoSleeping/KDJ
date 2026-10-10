import { create } from "zustand";
import {
  nextPlayerBarPhase,
  playerBarMoving,
  playerBarRest,
  playerBarStandsDown,
  readPlayerBarAway,
  usePlayerBarAway,
  type PlayerBarPhase,
} from "./playerBarAway";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const PINNED_KEY = "kd-now-playing-pinned";
/** How long the bubble stays up after a song starts, unless it is held or pinned. */
export const NOW_PLAYING_PEEK_MS = 5_000;

let peeks = 0;

/** What holds the bubble up. */
export interface NowPlayingHold {
  /** Opened from the now-playing card. */
  open: boolean;
  /** Pinned by the listener: it stays beside the bar. A preference. */
  pinned: boolean;
  /** Identifies the running peek; a new value restarts the countdown. 0 = not peeking. */
  peek: number;
  /**
   * The player bar is put away, so the bubble is the listener's transport: it is up whatever
   * else holds it, from the moment the bar starts down until the bar starts back. It is never
   * written into `pinned`: when the bar returns, the bubble is held by exactly what holds it
   * then. The listener cannot have neither — sending the bubble away brings the bar back
   * (`close`).
   */
  barAway: boolean;
}

/** The bubble stays until it is dismissed, instead of leaving by itself. */
export const nowPlayingHeld = (state: NowPlayingHold): boolean =>
  state.open || state.pinned || state.barAway;

export const nowPlayingInfoVisible = (state: NowPlayingHold): boolean =>
  nowPlayingHeld(state) || state.peek > 0;

/**
 * What holds the bubble at launch: the pin as it was left, and the bar's place as the window's
 * shape and its choice give it. The bar's driver corrects that in its first pass when there is
 * no song to show.
 */
export function readNowPlayingHold(): NowPlayingHold {
  return {
    open: false,
    pinned: readLocalStorage(PINNED_KEY) === "true",
    peek: 0,
    barAway: readPlayerBarAway(),
  };
}

/**
 * 曲目信息, the task bubble of the playing song (NowPlayingTask). It is up while any of four
 * things holds it: the listener opened it from the now-playing card, pinned it, the player bar
 * is away (`barAway`), or another song has just started (a timed peek).
 *
 * With the bar: opened or pinned it stays until it is dismissed; a peek leaves by itself. With
 * the bar away it always stays and carries the mini transport, the pin only says whether it
 * will still stay when the bar is back, and dismissing it is the way back to the bar.
 */
export const useNowPlayingInfo = create<NowPlayingHold & {
  /** The now-playing card: bring the bubble up and keep it, or send it away as `close` does. */
  toggle(): void;
  /**
   * The listener sends the bubble away, whatever holds it: its own key, Esc, the card. That
   * clears the pin. With the bar away it also asks the bar back — the bubble lets go at once, so
   * it rolls down as the bar starts up.
   */
  close(): void;
  setPinned(pinned: boolean): void;
  startPeek(): void;
  endPeek(): void;
  /** The bar's driver: the bar starts down (the bubble is kept from now) or starts back up. */
  setBarAway(away: boolean): void;
}>((set, get) => ({
  ...readNowPlayingHold(),
  toggle() {
    if (nowPlayingHeld(get())) return get().close();
    // During a peek the card keeps the bubble instead of dismissing what was about to leave.
    set({ open: true, peek: 0 });
  },
  close() {
    const { pinned, barAway } = get();
    if (pinned) writeLocalStorageNow(PINNED_KEY, "false");
    set({ open: false, pinned: false, peek: 0, barAway: false });
    if (barAway) usePlayerBarAway.getState().setCollapsed(false);
  },
  setPinned(pinned) {
    writeLocalStorageNow(PINNED_KEY, String(pinned));
    if (pinned) { set({ pinned, peek: 0 }); return; }
    // Unpinned beside the bar, the bubble goes back to leaving by itself: a fresh countdown
    // starts. With the bar away it stays, as the transport, and leaves when the bar is back.
    set(get().barAway ? { pinned, open: false } : { pinned, open: false, peek: ++peeks });
  },
  startPeek() {
    if (!nowPlayingHeld(get())) set({ peek: ++peeks });
  },
  endPeek: () => set({ peek: 0 }),
  setBarAway(away) {
    if (get().barAway === away) return;
    // A peek that was running is over: kept, the bubble no longer counts down, and it must not
    // come back as a countdown when the bar returns.
    set({ barAway: away, peek: 0 });
  },
}));

/*
 * The handover between the bar and the bubble. One of the two is on screen at every moment:
 * the bubble is kept from the moment the bar starts down, and let go only as the bar starts
 * back up. PlayerBarAway.tsx calls these; it adds nothing but the slide's time.
 */

/** The first pass of a run: the bar takes its place without a slide, and the bubble with it. */
export function settlePlayerBar(away: boolean): void {
  usePlayerBarAway.getState().setPhase(away ? "away" : "up");
  useNowPlayingInfo.getState().setBarAway(away);
}

/**
 * Start the slide towards where the bar is wanted, if it is at rest somewhere else, and hand
 * the transport over in the same step. Returns the slide that started, or null. Nothing is
 * touched while a slide runs; at rest the bubble's hold is made to agree with the bar, so a
 * bubble that was sent away during the slide down is back if the bar stays away after all.
 */
export function advancePlayerBar(away: boolean): PlayerBarPhase | null {
  const bar = usePlayerBarAway.getState();
  if (playerBarMoving(bar.phase)) return null;
  const step = nextPlayerBarPhase(bar.phase, away);
  if (step) bar.setPhase(step);
  useNowPlayingInfo.getState().setBarAway(playerBarStandsDown(step ?? bar.phase));
  return step;
}

/** The slide's time is over: the bar is where it was going. Ask advancePlayerBar again then. */
export function endPlayerBarSlide(): void {
  const bar = usePlayerBarAway.getState();
  bar.setPhase(playerBarRest(bar.phase));
}
