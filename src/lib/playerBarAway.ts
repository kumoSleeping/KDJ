import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";
import { watchWindowTall, windowIsTall } from "./useLayoutMode";

/**
 * The shape of the window (see useLayoutMode.ts). Each shape remembers its own choice: a wide
 * window keeps the bar unless it was put away, a tall one keeps it away unless it was brought
 * back — there the playing song's bubble spans the window and is the usual transport.
 */
export type PlayerBarShape = "wide" | "tall";

const COLLAPSED_KEY: Record<PlayerBarShape, string> = {
  wide: "kd-player-bar-collapsed",
  tall: "kd-player-bar-collapsed-tall",
};

const shapeOf = (tall: boolean): PlayerBarShape => tall ? "tall" : "wide";

/**
 * Where the player bar is. `up`: in its row at the bottom of the window. `leaving`: sliding
 * down out of the window. `away`: out of sight; the playing song's bubble is the transport, and
 * sending that away brings the bar back. `returning`: sliding back up.
 *
 * From `leaving` on the bar is out of the layout and lies over the page, so the content takes
 * its row once, under the bar that still covers it, and gives it back once when the bar has
 * returned: the slide itself moves nothing but the bar.
 */
export type PlayerBarPhase = "up" | "leaving" | "away" | "returning";

/** The listener's choice for a shape, as it was left at the last run. */
export function readPlayerBarCollapsed(shape: PlayerBarShape = shapeOf(windowIsTall())): boolean {
  const stored = readLocalStorage(COLLAPSED_KEY[shape]);
  return shape === "tall" ? stored !== "false" : stored === "true";
}

/** The collapse is the desktop's. A phone keeps its bar: there it is the whole of the transport. */
export function playerBarCollapseOffered(): boolean {
  const platform = typeof window === "undefined" ? undefined : window.kdj?.platform;
  return platform !== "android" && platform !== "ios";
}

/**
 * Whether the bar is to be away. The listener always has a transport on screen, the bar or the
 * playing song's bubble: so the bar is only away while there is a song for that bubble to show
 * (`song`), whatever was chosen, and the choice itself is left as it is for when a song arrives.
 */
export function playerBarAwayWanted(collapsed: boolean, song: boolean, offered = playerBarCollapseOffered()): boolean {
  return collapsed && offered && song;
}

/** Where a launch finds the bar, before anything is known about the deck. */
export function readPlayerBarAway(): boolean {
  return playerBarAwayWanted(readPlayerBarCollapsed(), true);
}

/**
 * The player bar can be put away. `collapsed` is the choice of the shape the window is in now
 * (`tall`), and `setCollapsed` changes that shape's choice only. `phase` is where the bar is,
 * which PlayerBar drives (see playerBarAwayWanted and PlayerBarAway.tsx).
 */
export const usePlayerBarAway = create<{
  tall: boolean;
  collapsed: boolean;
  phase: PlayerBarPhase;
  setCollapsed(collapsed: boolean): void;
  /** The window crossed between the two shapes: the other shape's choice applies from now on. */
  setTall(tall: boolean): void;
  setPhase(phase: PlayerBarPhase): void;
}>((set, get) => {
  const tall = windowIsTall();
  return {
    tall,
    collapsed: readPlayerBarCollapsed(shapeOf(tall)),
    phase: readPlayerBarAway() ? "away" : "up",
    setCollapsed(next) {
      if (get().collapsed === next) return;
      writeLocalStorageNow(COLLAPSED_KEY[shapeOf(get().tall)], String(next));
      set({ collapsed: next });
    },
    setTall(next) {
      if (get().tall !== next) set({ tall: next, collapsed: readPlayerBarCollapsed(shapeOf(next)) });
    },
    setPhase(phase) {
      if (get().phase !== phase) set({ phase });
    },
  };
});

watchWindowTall(tall => usePlayerBarAway.getState().setTall(tall));

/** The bar no longer holds the bottom of the window: what stood on it stands on the window's edge. */
export const playerBarStandsDown = (phase: PlayerBarPhase): boolean => phase === "leaving" || phase === "away";

/** The bar is on its way: it lies over the page and the content has its row. */
export const playerBarMoving = (phase: PlayerBarPhase): boolean => phase === "leaving" || phase === "returning";

/**
 * The slide to start from `phase` when the bar should be away (`away`) or up, or null. A slide
 * is never turned around halfway: while the bar is on its way nothing starts, whatever is
 * wanted meanwhile (a key, the window dragged across the two shapes and back, a song arriving),
 * and the question is asked again where the slide ends (playerBarRest).
 */
export function nextPlayerBarPhase(phase: PlayerBarPhase, away: boolean): PlayerBarPhase | null {
  if (phase === "up") return away ? "leaving" : null;
  if (phase === "away") return away ? null : "returning";
  return null;
}

/** Where the bar is when the slide it is on has ended. */
export function playerBarRest(phase: PlayerBarPhase): PlayerBarPhase {
  return phase === "leaving" ? "away" : phase === "returning" ? "up" : phase;
}

/**
 * The height of the strip at the bottom of the window the bar holds now, in px: 0 while it is
 * away, undefined while there is no bar to measure yet.
 */
export function playerBarFloor(): number | undefined {
  if (playerBarStandsDown(usePlayerBarAway.getState().phase)) return 0;
  return document.querySelector<HTMLElement>(".kd-player")?.offsetHeight || undefined;
}
