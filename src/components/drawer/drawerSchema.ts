import type { ReactNode } from "react";

/**
 * How tall the drawer's panel is over the list.
 * - `two-thirds`: always two thirds of the way down.
 * - `content`: two thirds while everything fits there; beyond that exactly as tall as what it
 *   holds needs, growing with it, up to the whole way down.
 * - `fit`: exactly as tall as what it holds needs — short for a short page, long for a long
 *   one — up to the whole way down.
 * - `full`: always the whole way down.
 * A height the user drags (the panel's bottom edge) replaces any of these until it is reset.
 */
export type DrawerExtent = "two-thirds" | "content" | "fit" | "full";

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
  /** What the drawer belongs to right now: a song, a folder. One short line under the title. */
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
