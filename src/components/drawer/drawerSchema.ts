import type { ReactNode } from "react";

/**
 * How tall the drawer's panel is over the list.
 * - `fit`: the usual case. Exactly as tall as what it holds needs — short for a short page,
 *   long for a long one — following it as it changes (a switch of page included), up to the
 *   whole way down.
 * - `at-least-half`: as `fit`, but never shorter than half the way down. Only for an app that
 *   needs empty room even while it holds nothing (downloads: things are dropped on its blank).
 * - `two-thirds`: always two thirds of the way down. For a view with no height of its own
 *   (lyrics scroll about the line being sung).
 * - `full`: always the whole way down (a docked picture with such a view beneath it).
 * A height the user drags (the panel's bottom edge) replaces any of these until it is reset.
 *
 * `fit` and `at-least-half` are measured from the body's scrolling elements, which carry the
 * class `kd-scroll` or the attribute `data-drawer-scroll`. Every part beside them, and everything
 * inside them, must have a height of its own: one that merely fills what it is given says
 * nothing about what it needs. A body that is still fetching what decides its height carries
 * `data-drawer-pending` until its first result or error; a `fit` panel waits offscreen for that
 * initial content and keeps its measured height throughout the entrance.
 */
export type DrawerExtent = "fit" | "at-least-half" | "two-thirds" | "full";

/** One page of a drawer. Its label is a word of the drawer's title. */
export interface DrawerPage {
  id: string;
  label: string;
  /** The full name, for the tooltip and assistive technology. */
  title?: string;
}

/**
 * Everything the drawer shell needs to present one app: what it is called, how far it comes
 * down, what it shows, and how it is put away. The shell draws the title row, the close
 * button and the motion; an app supplies only this description and its body.
 *
 * See docs/drawer-schema.md for the rules and a worked example.
 */
export interface DrawerSpec {
  /** Stable name of the app; also `data-app` on the drawer for theme packs and tests. */
  id: string;
  /** Another content identity leaves with its whole panel before the new one enters.
   * Keep `id` stable: the app's remembered open state and order do not change with a song. */
  contentKey?: string | number;
  /** Still enabled, but nothing to show yet. Keep the entry and order, not an empty shell. */
  suspended?: boolean;
  /** The title. With `pages` the page labels are shown in its place and this names the drawer. */
  title: string;
  extent: DrawerExtent;
  /** Pages switched from the title row. The body wraps what changes in `SlidePages`. */
  pages?: readonly DrawerPage[];
  /**
   * The page in view, as a hook the title row calls. The page is read where it is shown — by
   * the title and by the body — so a switch redraws those two and nothing around the drawer.
   * Always the same hook for an app: `() => useStore(state => state.page)`.
   */
  usePage?(): string;
  onPage?(id: string): void;
  /** Compact actions at the right end of the title row, before the close button. */
  tools?: ReactNode;
  body: ReactNode;
  /**
   * A layer of the app's own under the whole panel, title row included: the host draws it in
   * the panel's backdrop slot (src/components/common/SurfaceBackdrop.tsx), inside the panel's
   * shape and behind everything on it. The panel is the list's colour and an app gives it no
   * tone of its own; this is the one narrow exception, for the lyrics under 歌曲色彩, whose
   * layer also says which ink reads on it (`useBackdropInk`).
   */
  backdrop?: ReactNode;
  /**
   * The app takes the window (a tall desktop window's full-screen lyrics): its panel is the
   * window's one block, from under the title bar down to the playing song's bubble with the
   * bubble's gap on either side, and the rest of the window is out of sight meanwhile
   * (src/lib/windowTaken.ts). The panel grows out of the place it has as a drawer and goes back
   * into it. `leave` gives the window back: the key at the end of the title row, which then
   * carries `label`, and Esc call it instead of `close`. `extent` is what the panel returns to.
   */
  takesWindow?: { label: string; leave(): void };
  /**
   * Puts the app away. Returns false when it refuses (an unsaved draft): the drawer then
   * stays, and an app that was opened over it gives way instead.
   */
  close(): boolean | void;
}

/**
 * One thing the rolled-up drawer offers: an app that is opened by hand. The head lists these
 * while nothing is open and keeps them as small icons while an app is; an app that is only ever
 * opened from elsewhere (a row's menu, a button on the picture) needs no entry.
 */
export interface DrawerEntry {
  /** The `id` of the app it opens; also `data-drawer-entry` on the control. */
  id: string;
  /** A word or two beside the icon while the drawer is rolled up. */
  label: string;
  /** The full name, for the tooltip and assistive technology. */
  title?: string;
  icon: ReactNode;
  /** What is going on in the app while it is put away, as a small number; nothing at zero. */
  count?: number;
  /** Asks for the app. Putting it away again is the open app's own `close`. */
  open(): void;
}
