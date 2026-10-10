import { create } from "zustand";

/**
 * A drawer app can take the window (`takesWindow` in the drawer schema): its panel becomes the
 * window's one block above the playing song's bubble, and everything else of the window is out
 * of sight while it does. This says which app has it, for the parts that have to stand back:
 * the page (hidden and inert, not unmounted — Workspace.tsx, Drawer.css) and the player bar
 * (away, without touching the listener's own choice — playerBarAway.ts). The bubble's key that
 * calls the bar back also gives the window back (`leave`), since the bar needs its row.
 *
 * It is the state of the screen, not a preference: nothing here is stored. `leave` is the
 * taking app's own way back to being a drawer.
 */
export const useWindowTaken = create<{
  by: string | null;
  leave: (() => void) | null;
  take(by: string, leave: () => void): void;
  /** Gives the window back if `by` still has it. */
  release(by: string): void;
}>((set, get) => ({
  by: null,
  leave: null,
  take: (by, leave) => set({ by, leave }),
  release: by => { if (get().by === by) set({ by: null, leave: null }); },
}));

/** Whether an app has the window. */
export const windowTaken = (state: { by: string | null }): boolean => state.by !== null;
