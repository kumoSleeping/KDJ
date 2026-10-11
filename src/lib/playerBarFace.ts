import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

/**
 * What the player bar shows to the right of the transport, one at a time: `tools`, the keys of
 * the song and of what plays next (lyrics, song colour, small windows, auto-advance, mode …), or
 * `eq`, the deck's knobs, tempo slider and readouts. The key that ends the row switches between
 * them, and the choice is kept across runs.
 */
export type PlayerBarFace = "tools" | "eq";

/** In the order they lie: the knobs arrive from the right, the keys come back from the left. */
export const PLAYER_BAR_FACES: readonly PlayerBarFace[] = ["tools", "eq"];

const FACE_KEY = "kd-player-bar-face";

export const usePlayerBarFace = create<{ face: PlayerBarFace; toggle(): void }>(set => ({
  face: readLocalStorage(FACE_KEY) === "eq" ? "eq" : "tools",
  toggle: () => set(state => {
    const face: PlayerBarFace = state.face === "eq" ? "tools" : "eq";
    writeLocalStorageNow(FACE_KEY, face);
    return { face };
  }),
}));
