import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const PINNED_KEY = "kd-now-playing-pinned";
const DETAILED_KEY = "kd-now-playing-detailed";
/** How long the bubble stays up after a song starts, unless it is held or pinned. */
export const NOW_PLAYING_PEEK_MS = 5_000;

let peeks = 0;

/**
 * 曲目信息, the task bubble of the playing song (NowPlayingTask). It is up while any of three
 * things holds it: the listener opened it from the now-playing card, pinned it, or another song
 * has just started (a timed peek).
 */
export const useNowPlayingInfo = create<{
  open: boolean;
  pinned: boolean;
  /** Identifies the running peek; a new value restarts the countdown. 0 = not peeking. */
  peek: number;
  /** The bubble shows the fuller detail instead of the compact summary. A preference. */
  detailed: boolean;
  /** The now-playing card: bring the bubble up and keep it, or dismiss it whatever holds it. */
  toggle(): void;
  close(): void;
  setPinned(pinned: boolean): void;
  setDetailed(detailed: boolean): void;
  startPeek(): void;
  endPeek(): void;
}>((set, get) => ({
  open: false,
  pinned: readLocalStorage(PINNED_KEY) === "true",
  peek: 0,
  detailed: readLocalStorage(DETAILED_KEY) === "true",
  toggle() {
    const { open, pinned } = get();
    if (open || pinned) return get().close();
    // During a peek the card keeps the bubble instead of dismissing what was about to leave.
    set({ open: true, peek: 0 });
  },
  close() {
    if (get().pinned) writeLocalStorageNow(PINNED_KEY, "false");
    set({ open: false, pinned: false, peek: 0 });
  },
  setPinned(pinned) {
    writeLocalStorageNow(PINNED_KEY, String(pinned));
    // Unpinned, the bubble goes back to leaving by itself: a fresh countdown starts.
    set(pinned ? { pinned, peek: 0 } : { pinned, open: false, peek: ++peeks });
  },
  setDetailed(detailed) {
    writeLocalStorageNow(DETAILED_KEY, String(detailed));
    set({ detailed });
  },
  startPeek() {
    const { open, pinned } = get();
    if (!open && !pinned) set({ peek: ++peeks });
  },
  endPeek: () => set({ peek: 0 }),
}));

export const nowPlayingInfoVisible = (state: { open: boolean; pinned: boolean; peek: number }) =>
  state.open || state.pinned || state.peek > 0;
