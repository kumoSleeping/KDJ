import type { ReactNode } from "react";

/**
 * How far a drawer is pulled down over the list.
 * - `two-thirds`: always two thirds of the way.
 * - `content`: two thirds while everything fits there, all the way down once it does not.
 * - `full`: always all the way down.
 */
export type DrawerExtent = "two-thirds" | "content" | "full";

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
