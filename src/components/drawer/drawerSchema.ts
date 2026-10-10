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
 * `data-drawer-pending` on some element until it has it.
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
  /** The title. With `pages` the page labels are shown in its place and this names the drawer. */
  title: string;
  /**
   * What the drawer belongs to right now: a song, a folder. Written small and quiet at the far
   * end of the title row, on the title's baseline, before the tools; it is cut short first when
   * the row runs out of room. Never a line of its own under the title.
   */
  caption?: ReactNode;
  extent: DrawerExtent;
  /** Pages switched from the title row. The body wraps what changes in `SlidePages`. */
  pages?: readonly DrawerPage[];
  page?: string;
  onPage?(id: string): void;
  /** Compact actions at the right end of the title row, before the close button. */
  tools?: ReactNode;
  body: ReactNode;
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
