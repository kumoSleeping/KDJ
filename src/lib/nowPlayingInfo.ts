import { create } from "zustand";
import { readPlayerBarCollapsed } from "./playerBarAway";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const PINNED_KEY = "kd-now-playing-pinned";
const DETAILED_KEY = "kd-now-playing-detailed";
const AWAY_DISMISSED_KEY = "kd-now-playing-away-dismissed";
/** How long the bubble stays up after a song starts, unless it is held or pinned. */
export const NOW_PLAYING_PEEK_MS = 5_000;

let peeks = 0;

/** What holds the bubble up. */
export interface NowPlayingHold {
  /** Opened from the now-playing card. */
  open: boolean;
  /** Pinned by the listener. A preference. */
  pinned: boolean;
  /** Identifies the running peek; a new value restarts the countdown. 0 = not peeking. */
  peek: number;
  /** The player bar is put away. */
  barAway: boolean;
  /** The listener dismissed or unpinned the bubble since the bar was put away. */
  awayDismissed: boolean;
}

/**
 * Kept because the bar is away: with the player bar put away the bubble is the listener's
 * transport, so it stays up as if it were pinned — until they send it away themselves. That is
 * a state of its own and never written into `pinned`: when the bar returns, the bubble is held
 * by exactly what held it before.
 */
export const nowPlayingKeptAway = (state: Pick<NowPlayingHold, "barAway" | "awayDismissed">): boolean =>
  state.barAway && !state.awayDismissed;

/** The bubble stays until it is dismissed, instead of leaving by itself. */
export const nowPlayingHeld = (state: NowPlayingHold): boolean =>
  state.open || state.pinned || nowPlayingKeptAway(state);

export const nowPlayingInfoVisible = (state: NowPlayingHold): boolean =>
  nowPlayingHeld(state) || state.peek > 0;

/**
 * What holds the bubble at launch: the pin as it was left, and a bar that was away at the last
 * run is away again, with what the listener had decided about the bubble then.
 */
export function readNowPlayingHold(): NowPlayingHold {
  return {
    open: false,
    pinned: readLocalStorage(PINNED_KEY) === "true",
    peek: 0,
    barAway: readPlayerBarCollapsed(),
    awayDismissed: readLocalStorage(AWAY_DISMISSED_KEY) === "true",
  };
}

/**
 * 曲目信息, the task bubble of the playing song (NowPlayingTask). It is up while any of four
 * things holds it: the listener opened it from the now-playing card, pinned it, the player bar
 * is away (see nowPlayingKeptAway), or another song has just started (a timed peek).
 */
export const useNowPlayingInfo = create<NowPlayingHold & {
  /** The bubble shows the fuller detail instead of the compact summary. A preference. */
  detailed: boolean;
  /** The now-playing card: bring the bubble up and keep it, or dismiss it whatever holds it. */
  toggle(): void;
  close(): void;
  setPinned(pinned: boolean): void;
  setDetailed(detailed: boolean): void;
  startPeek(): void;
  endPeek(): void;
  /** The player bar was put away or brought back. Putting it away keeps the bubble up again. */
  setBarAway(away: boolean): void;
}>((set, get) => {
  /** The listener sent the bubble away while the bar is away: it is no longer kept for the bar. */
  const dismissedWhileAway = (): { awayDismissed: boolean } | null => {
    const { barAway, awayDismissed } = get();
    if (!barAway || awayDismissed) return null;
    writeLocalStorageNow(AWAY_DISMISSED_KEY, "true");
    return { awayDismissed: true };
  };
  return {
    ...readNowPlayingHold(),
    detailed: readLocalStorage(DETAILED_KEY) === "true",
    toggle() {
      if (nowPlayingHeld(get())) return get().close();
      // During a peek the card keeps the bubble instead of dismissing what was about to leave.
      set({ open: true, peek: 0 });
    },
    close() {
      if (get().pinned) writeLocalStorageNow(PINNED_KEY, "false");
      set({ open: false, pinned: false, peek: 0, ...dismissedWhileAway() });
    },
    setPinned(pinned) {
      writeLocalStorageNow(PINNED_KEY, String(pinned));
      // Unpinned, the bubble goes back to leaving by itself: a fresh countdown starts. With the
      // bar away that is the listener letting it go, so it is not kept for the bar either.
      set(pinned ? { pinned, peek: 0 } : { pinned, open: false, peek: ++peeks, ...dismissedWhileAway() });
    },
    setDetailed(detailed) {
      writeLocalStorageNow(DETAILED_KEY, String(detailed));
      set({ detailed });
    },
    startPeek() {
      if (!nowPlayingHeld(get())) set({ peek: ++peeks });
    },
    endPeek: () => set({ peek: 0 }),
    setBarAway(away) {
      if (get().barAway === away) return;
      // Every time the bar is put away the bubble is kept again; what was decided while it was
      // away is forgotten when it returns.
      if (get().awayDismissed) writeLocalStorageNow(AWAY_DISMISSED_KEY, "false");
      // A peek that was running is over either way: kept, the bubble no longer counts down, and
      // it must not come back as a countdown when the bar returns.
      set({ barAway: away, awayDismissed: false, ...(away ? { peek: 0 } : null) });
    },
  };
});
