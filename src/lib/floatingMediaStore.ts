import { create } from "zustand";
import {
  FLOAT_MEDIA_STORAGE_KEY,
  parseStoredFloatRect,
  serializeFloatRect,
  type FloatRect,
} from "./floatingMediaBox";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

interface FloatingMediaBoxState {
  /** The rectangle the user last left on screen; null until a window has been moved or sized. */
  rect: FloatRect | null;
  /** Follow the hand. Memory only: a gesture is written once, when it ends. */
  place(rect: FloatRect | null): void;
  /** Persist the current rectangle. Opening or fitting a window never calls this. */
  remember(): void;
}

/**
 * The one remembered place and size of the floating media window, whichever picture it shows.
 * Earlier builds kept the video window's box in component state only and the visualizer's
 * nowhere, so there is no older key to read.
 */
export const useFloatingMediaBox = create<FloatingMediaBoxState>((set, get) => ({
  rect: parseStoredFloatRect(readLocalStorage(FLOAT_MEDIA_STORAGE_KEY))?.rect ?? null,
  place(rect) {
    set({ rect });
  },
  remember() {
    const { rect } = get();
    if (!rect) return;
    // Keys written by a newer build survive; an identical value is not written again.
    const extra = parseStoredFloatRect(readLocalStorage(FLOAT_MEDIA_STORAGE_KEY))?.extra;
    writeLocalStorageNow(FLOAT_MEDIA_STORAGE_KEY, serializeFloatRect(rect, extra));
  },
}));
