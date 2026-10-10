import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";
import { useLayoutSignals } from "./useLayoutMode";

/**
 * How tall the lyrics are, chosen from the menu on the lyrics panel (right click, long press).
 * - `standard`: two thirds of the way down the list.
 * - `longer`: down to just above the bottom strip: the player bar, or the playing song's
 *   bubble while the bar is away.
 * - `full`: the window is the lyrics and the playing song's bubble, one block above the other,
 *   and everything else is out of sight. Only a tall window does this: a wide one shows
 *   `longer`, and the choice is kept for when the window is tall again.
 */
export type LyricsExtent = "standard" | "longer" | "full";

const EXTENT_KEY = "kd-lyrics-extent";

export const LYRICS_EXTENT_LABEL: Readonly<Record<LyricsExtent, string>> = {
  standard: "标准",
  longer: "更长",
  full: "全屏",
};

export function normalizeLyricsExtent(value: unknown): LyricsExtent {
  return value === "longer" || value === "full" ? value : "standard";
}

/** What the window is. */
export interface LyricsExtentShape {
  /** A tall window (useLayoutMode.ts): there the playing song's bubble spans the bottom. */
  tall: boolean;
  /** A phone or a tablet. Upright it shows the lyrics in a sheet, which is as long as it can be. */
  mobile: boolean;
}

/**
 * The choices this window offers, in the order of the menu. Full screen is a tall desktop
 * window's: the lyrics above the spanning bubble. An upright phone has no drawer to size.
 */
export function lyricsExtentChoices(shape: LyricsExtentShape): readonly LyricsExtent[] {
  if (shape.mobile) return shape.tall ? [] : ["standard", "longer"];
  return shape.tall ? ["standard", "longer", "full"] : ["standard", "longer"];
}

/**
 * The extent this window shows for a stored choice: where full screen is not offered it is
 * shown, and marked in the menu, as `longer`. The stored choice is not rewritten for that.
 */
export function shownLyricsExtent(stored: LyricsExtent, shape: LyricsExtentShape): LyricsExtent {
  return stored === "full" && !lyricsExtentChoices(shape).includes("full") ? "longer" : stored;
}

/** The shape of this window, for the two functions above. */
export function useLyricsExtentShape(): LyricsExtentShape {
  const { tall } = useLayoutSignals();
  const platform = typeof window === "undefined" ? undefined : window.kdj?.platform;
  return { tall, mobile: platform === "android" || platform === "ios" };
}

/** The listener's choice, remembered across runs. */
export const useLyricsExtent = create<{ extent: LyricsExtent; setExtent(extent: LyricsExtent): void }>((set, get) => ({
  extent: normalizeLyricsExtent(readLocalStorage(EXTENT_KEY)),
  setExtent(extent) {
    if (get().extent === extent) return;
    writeLocalStorageNow(EXTENT_KEY, extent);
    set({ extent });
  },
}));
