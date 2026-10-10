/**
 * How the sidebar's rows come and go (styles: the "Rows arriving and folding" part of
 * FolderTree.css, on the clock of src/motion.css).
 *
 * - `reveal`: the rows of a list that has just appeared arrive one after another. Only the
 *   first few are staggered; the next ones arrive with the last of those and anything further
 *   down is simply there.
 * - A branch (the children of a folder, a source or a section) the user opens unfolds: its rows
 *   arrive the same way while what lies below it slides down from where it was.
 * - A branch the user closes folds: React removes it at once, a picture of it is put back over
 *   the place it held and is covered from below as the rows under it close up.
 *
 * - `reorder`: rows whose order is about to change (the playlist that was opened goes to the
 *   front) travel from their old places to their new ones; the one that went up is lifted.
 *
 * Nothing here is tied to rendering. A branch only moves when `expect` announced the user's own
 * toggle just before the render that mounts or removes it; a re-render, a selection, a count or
 * a list that changes for any other reason leaves every row where it is. The script only marks
 * elements — the frames are CSS animations — and all marks are taken off when a gesture ends.
 * An instance needs no teardown: what is left when its owner unmounts is a timer that takes
 * marks off rows nobody shows any more.
 */
import type { RefCallback } from "react";
import { MOTION_MICRO_MS, prefersReducedMotion } from "../../lib/motion";
import { reorderMoves } from "../../lib/reorderMoves";

const ENTER_ATTR = "data-kd-tree-enter";
const SHIFT_ATTR = "data-kd-tree-shift";
const UNFOLD_ATTR = "data-kd-tree-unfold";
const FOLD_ATTR = "data-kd-tree-fold";
const MOVE_ATTR = "data-kd-tree-move";
const INDEX_VAR = "--kd-tree-i";
const SHIFT_VAR = "--kd-tree-shift";

/** Rows that arrive one step apart; the cascade is over in 12 × 11 + 160 = 292 ms. */
export const TREE_STAGGER_ROWS = 12;
export const TREE_STAGGER_STEP_MS = 12;
/** Rows after the cascade that still arrive, together with its last row. */
const TAIL_ROWS = 36;
/** The rows of a folding branch leave from the last one up, this far apart. */
const FOLD_ROWS = 12;
/** A branch opens and shuts in a beat and a half of the small clock (FolderTree.css, --kd-tree-fold-time). */
export const TREE_FOLD_MS = MOTION_MICRO_MS * 1.5;
/** A reorder takes two beats of the small clock (FolderTree.css, kd-tree-move). */
export const TREE_REORDER_MS = MOTION_MICRO_MS * 2;
/** A toggle that has not rendered after this long was not the cause of a later render. */
const INTENT_FRESH_MS = 300;
/** What a picture of a closed branch must not carry: it is not a row any more. */
const PICTURE_STRIP = ["id", "data-kd-folder-drop-path", "data-kd-browse-item", "data-kd-browse-pane", "data-kd-browse-id", "data-kd-browse-cursor"];

export interface SidebarMotion {
  /**
   * The rows inside `within` arrive in sequence, in place of whatever was moving. With `only`,
   * just the rows it picks arrive (rows that are new), alongside what is already arriving.
   */
  reveal(within: Element | null | undefined, only?: (row: Element) => boolean): void;
  /** The user's own toggle of branch `key` is about to render. Call it from the handler. */
  expect(key: string, opening: boolean): void;
  /** The ref of the element that holds a branch's rows. Stable per key. */
  branch(key: string): RefCallback<HTMLElement>;
  /**
   * `apply` changes the order of the rows matching `selector` inside `within` (synchronously).
   * Rows that end up somewhere else travel there from where they were. `keyOf` names a row
   * across the change. Without an animation engine, under reduced motion, during a drag or while
   * the rows are still arriving the new order is simply there.
   */
  reorder(within: Element | null | undefined, selector: string, keyOf: (row: Element) => string, apply: () => void): void;
  /** The mounted element of a branch, if it is open. */
  branchElement(key: string): HTMLElement | null;
}

/** True while something is being dragged: the tree must not move under the pointer then. */
let htmlDragging = false;
let watching = false;
function watchDrags(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const options = { capture: true, passive: true } as const;
  window.addEventListener("dragstart", () => { htmlDragging = true; }, options);
  for (const type of ["dragend", "drop"]) window.addEventListener(type, () => { htmlDragging = false; }, options);
}
function dragging(): boolean {
  const flags = document.body.dataset;
  return htmlDragging || !!flags.kdSidebarRootDragging || !!flags.kdTrackPointerDragging || !!flags.kdSearchPointerDragging;
}

/**
 * @param rowSelector what counts as a row inside the lists this instance animates
 * @param scrollerSelector the scrolling list the rows live in; nothing outside it is moved
 */
export function createSidebarMotion(rowSelector: string, scrollerSelector: string): SidebarMotion {
  watchDrags();
  const refs = new Map<string, RefCallback<HTMLElement>>();
  const elements = new Map<string, HTMLElement>();
  let intent: { key: string; opening: boolean; at: number } | null = null;
  /** What is moving now. Ending a gesture takes its marks off and its picture away. */
  const running = new Set<() => void>();
  const finish = () => { for (const end of [...running]) end(); };

  const takeIntent = (key: string, opening: boolean): boolean => {
    const mine = intent !== null && intent.key === key && intent.opening === opening
      && performance.now() - intent.at < INTENT_FRESH_MS;
    if (mine) intent = null;
    return mine;
  };

  /** Starts a gesture: its marks are undone after `ms`, or as soon as `finish` ends what is moving. */
  const run = (ms: number, undo: () => void): void => {
    let timer = 0;
    const end = () => {
      if (!running.delete(end)) return;
      window.clearTimeout(timer);
      undo();
    };
    running.add(end);
    timer = window.setTimeout(end, ms);
  };

  /**
   * Marks rows as arriving and returns how to take the marks off. A row's step in the cascade
   * is its place among `rows`; with `only`, just the rows it picks are marked, at that place.
   */
  const enter = (rows: Element[], only?: (row: Element) => boolean): (() => void) => {
    const marked: HTMLElement[] = [];
    rows.slice(0, TREE_STAGGER_ROWS + TAIL_ROWS).forEach((row, index) => {
      if (only && !only(row)) return;
      (row as HTMLElement).style.setProperty(INDEX_VAR, String(Math.min(index, TREE_STAGGER_ROWS - 1)));
      row.setAttribute(ENTER_ATTR, "");
      marked.push(row as HTMLElement);
    });
    return () => marked.forEach(row => {
      row.removeAttribute(ENTER_ATTR);
      row.style.removeProperty(INDEX_VAR);
    });
  };
  const enterMs = MOTION_MICRO_MS + TREE_STAGGER_STEP_MS * (TREE_STAGGER_ROWS - 1) + 60;

  /**
   * Everything laid out below a branch inside the scroller starts `by` pixels away from where it
   * now is and slides home: the siblings from `first` on, then whatever follows `owner` and each
   * of its ancestors. Only what can be seen during the slide is marked.
   */
  const shiftBelow = (owner: Element, first: Element | null, by: number): (() => void) => {
    const scroller = owner.closest(scrollerSelector);
    if (!scroller) return () => undefined;
    const bottom = scroller.getBoundingClientRect().bottom;
    const moved: HTMLElement[] = [];
    let sibling: Element | null = first;
    measure: for (let node: Element | null = owner; ; node = node.parentElement) {
      for (; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.hasAttribute(FOLD_ATTR)) continue;
        // Where it is at the start of the slide. Past the bottom edge there, so is all the rest.
        if (sibling.getBoundingClientRect().top + Math.min(0, by) > bottom) break measure;
        moved.push(sibling as HTMLElement);
      }
      if (!node || node === scroller) break;
      sibling = node.nextElementSibling;
    }
    // Marked after measuring: a mark moves the element.
    moved.forEach(element => {
      element.style.setProperty(SHIFT_VAR, `${by}px`);
      element.setAttribute(SHIFT_ATTR, "");
    });
    return () => moved.forEach(element => {
      element.removeAttribute(SHIFT_ATTR);
      element.style.removeProperty(SHIFT_VAR);
    });
  };

  /** The room a branch takes in its parent: its own height and the gap a flex column adds for it. */
  const extent = (el: HTMLElement): number => {
    const height = el.offsetHeight;
    const gap = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).rowGap) : 0;
    return height > 0 ? height + (Number.isFinite(gap) ? gap : 0) : 0;
  };

  /** No animation engine (unit tests, a very old WebView): rows simply appear and go. */
  const canMove = () => typeof document !== "undefined" && typeof document.body.animate === "function" && !dragging();

  const unfold = (el: HTMLElement): void => {
    finish();
    const rows = Array.from(el.querySelectorAll(rowSelector));
    if (prefersReducedMotion()) {
      run(enterMs, enter(rows));
      return;
    }
    const room = extent(el);
    if (room <= 0) return;
    const undoShift = el.parentElement ? shiftBelow(el.parentElement, el.nextElementSibling, -room) : () => undefined;
    el.setAttribute(UNFOLD_ATTR, "");
    const undoEnter = enter(rows);
    run(enterMs, () => {
      el.removeAttribute(UNFOLD_ATTR);
      undoShift();
      undoEnter();
    });
  };

  /** Called while React is removing `el` and it is still laid out. */
  const fold = (el: HTMLElement): void => {
    const parent = el.parentElement;
    if (!parent || !el.isConnected || prefersReducedMotion()) return;
    const height = el.offsetHeight;
    const room = extent(el);
    if (room <= 0 || getComputedStyle(parent).position === "static") return;
    const top = el.offsetTop;
    const parentTop = parent.getBoundingClientRect().top;
    const next = el.nextElementSibling;
    queueMicrotask(() => {
      // Still there: StrictMode replayed the ref, nothing was removed. Parent gone as well: the
      // branch went with what it belonged to.
      if (el.isConnected || !parent.isConnected) return;
      // The list was scrolled to its end and moved as a whole when it became shorter: what is
      // on screen did not close up from below, so there is nothing to show.
      if (Math.abs(parent.getBoundingClientRect().top - parentTop) > 0.5) return;
      finish();
      const undoShift = shiftBelow(parent, next?.parentElement === parent ? next : null, room);
      for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))]) {
        for (const name of PICTURE_STRIP) node.removeAttribute(name);
      }
      const rows = Array.from(el.querySelectorAll<HTMLElement>(rowSelector));
      rows.slice(-FOLD_ROWS).reverse().forEach((row, index) => row.style.setProperty(INDEX_VAR, String(index)));
      el.setAttribute(FOLD_ATTR, "");
      el.setAttribute("data-kd-leaving", "true");
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("inert", "");
      Object.assign(el.style, { top: `${top}px`, height: `${height}px` });
      parent.append(el);
      run(TREE_FOLD_MS + 40, () => {
        el.remove();
        undoShift();
      });
    });
  };

  return {
    reveal(within, only) {
      if (!within || !canMove()) return;
      const rows = Array.from(within.querySelectorAll(rowSelector)).filter(row => !row.closest(`[${FOLD_ATTR}]`));
      if (!rows.some(row => !only || only(row))) return;
      // Rows that are new join what is already arriving, each at its own place in the list, so
      // a folder never shows before the root it hangs under; a whole list starts over.
      if (!only) finish();
      run(enterMs, enter(rows, only));
    },
    expect(key, opening) {
      intent = canMove() ? { key, opening, at: performance.now() } : null;
    },
    branch(key) {
      let ref = refs.get(key);
      if (!ref) {
        ref = el => {
          if (!el) return;
          elements.set(key, el);
          if (takeIntent(key, true)) unfold(el);
          return () => {
            if (elements.get(key) === el) elements.delete(key);
            if (takeIntent(key, false)) fold(el);
          };
        };
        refs.set(key, ref);
      }
      return ref;
    },
    reorder(within, selector, keyOf, apply) {
      if (!within || !canMove() || prefersReducedMotion() || running.size) {
        apply();
        return;
      }
      const rowsBefore = Array.from(within.querySelectorAll<HTMLElement>(selector));
      const order = rowsBefore.map(keyOf);
      const tops = new Map(rowsBefore.map(row => [row, row.getBoundingClientRect().top]));
      apply();
      const { places, lead } = reorderMoves(order, Array.from(within.querySelectorAll(selector), keyOf));
      if (!places.size) return;
      const view = (within.closest(scrollerSelector) ?? within.querySelector(scrollerSelector) ?? within).getBoundingClientRect();
      const moved: [HTMLElement, number, boolean][] = [];
      for (const [row, top] of tops) {
        if (!row.isConnected || !places.has(keyOf(row))) continue;
        const now = row.getBoundingClientRect();
        const by = top - now.top;
        // Out of sight where it was and where it is: there is nothing to see of its way.
        const hidden = (edge: number) => edge + now.height < view.top || edge > view.bottom;
        if (Math.abs(by) < 0.5 || (hidden(top) && hidden(now.top))) continue;
        moved.push([row, by, keyOf(row) === lead]);
      }
      if (!moved.length) return;
      // Marked after measuring: a mark moves the row.
      for (const [row, by, lifted] of moved) {
        row.style.setProperty(SHIFT_VAR, `${by}px`);
        row.setAttribute(MOVE_ATTR, lifted ? "lift" : "");
      }
      run(TREE_REORDER_MS + 40, () => moved.forEach(([row]) => {
        row.removeAttribute(MOVE_ATTR);
        row.style.removeProperty(SHIFT_VAR);
      }));
    },
    branchElement: key => elements.get(key) ?? null,
  };
}
