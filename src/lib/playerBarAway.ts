import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const COLLAPSED_KEY = "kd-player-bar-collapsed";

/**
 * Where the player bar is. `up`: in its row at the bottom of the window. `leaving`: sliding
 * down out of the window. `away`: out of sight; a small key at the bottom-left corner brings it
 * back. `returning`: sliding back up.
 *
 * From `leaving` on the bar is out of the layout and lies over the page, so the content takes
 * its row once, under the bar that still covers it, and gives it back once when the bar has
 * returned: the slide itself moves nothing but the bar.
 */
export type PlayerBarPhase = "up" | "leaving" | "away" | "returning";

/** The listener's choice, as it was left at the last run. */
export function readPlayerBarCollapsed(): boolean {
  return readLocalStorage(COLLAPSED_KEY) === "true";
}

/**
 * The player bar can be put away. `collapsed` is the preference; `phase` is where the bar is
 * now, which PlayerBar drives (a layout that does not offer the collapse keeps the bar up
 * whatever the preference says).
 */
export const usePlayerBarAway = create<{
  collapsed: boolean;
  phase: PlayerBarPhase;
  setCollapsed(collapsed: boolean): void;
  setPhase(phase: PlayerBarPhase): void;
}>((set, get) => {
  const collapsed = readPlayerBarCollapsed();
  return {
    collapsed,
    phase: collapsed ? "away" : "up",
    setCollapsed(next) {
      if (get().collapsed === next) return;
      writeLocalStorageNow(COLLAPSED_KEY, String(next));
      set({ collapsed: next });
    },
    setPhase(phase) {
      if (get().phase !== phase) set({ phase });
    },
  };
});

/** The bar no longer holds the bottom of the window: what stood on it stands on the window's edge. */
export const playerBarStandsDown = (phase: PlayerBarPhase): boolean => phase === "leaving" || phase === "away";

/** The bar is on its way: it lies over the page and the content has its row. */
export const playerBarMoving = (phase: PlayerBarPhase): boolean => phase === "leaving" || phase === "returning";

/**
 * The step after `phase` when the bar should be away (`away`) or up: the slide to start, or
 * null when the bar is already there or on its way there.
 */
export function nextPlayerBarPhase(phase: PlayerBarPhase, away: boolean): PlayerBarPhase | null {
  if (away) return playerBarStandsDown(phase) ? null : "leaving";
  return playerBarStandsDown(phase) ? "returning" : null;
}

/**
 * The height of the strip at the bottom of the window the bar holds now, in px: 0 while it is
 * away, undefined while there is no bar to measure yet.
 */
export function playerBarFloor(): number | undefined {
  if (playerBarStandsDown(usePlayerBarAway.getState().phase)) return 0;
  return document.querySelector<HTMLElement>(".kd-player")?.offsetHeight || undefined;
}
