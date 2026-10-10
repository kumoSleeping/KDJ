/**
 * How the rows of the local track list arrive. Two gestures of one family (ListArrival.css):
 *
 * - "list": the list is presented — at startup, as another folder or 全部曲目, after a sort or a
 *   filter that replaced it, and every time its pane is shown again. The rows in view rise into
 *   place while they fade in, one after another from the top, each cover a beat after its row:
 *   the gesture of the search results, on the same clock (motion.css, "Lists").
 * - "chase": a fast scroll leaves only accurate row numbers (lib/libraryStandIns.ts). As it
 *   slows, libraryRowRecovery commits small batches of real contents and calls reveal for each.
 *   They use the same rise, a few times quicker, in the direction of travel. Numbers never move;
 *   previously built rows do not replay this gesture when the listener scrolls back.
 *
 * The table says which rows, in the order they arrive (it knows the viewport and its rendered
 * window); this module marks them and takes the marks off when the gesture is over. A row carries
 * `data-kd-arrive-row` and its step in `--kd-arrive-i`; the scroll container carries
 * `data-kd-arrive` (the gesture) and `data-kd-arrive-from` (the side the rows come from) only
 * while the gesture runs, so taking that one attribute off ends every row's motion at once.
 * Nothing is marked on a scroll at reading speed, a re-render, a selection, a row that updates or
 * rows the virtual window swaps in.
 */
import { prefersReducedMotion } from "../../lib/motion";
import "./ListArrival.css";

export type ListArrivalGesture = "list" | "chase";
/** Where the rows come from: "below" rises into place (the top row first), "above" drops (the bottom row first). */
export type ListArrivalSide = "below" | "above";

export const LIST_ARRIVAL_ATTR = "data-kd-arrive";
export const LIST_ARRIVAL_SIDE_ATTR = "data-kd-arrive-from";
export const LIST_ARRIVAL_ROW_ATTR = "data-kd-arrive-row";
/** Rows that arrive one after another; every later one comes with the last of them. */
export const LIST_ARRIVAL_STEPS = 14;
/**
 * How long the marks stay: a little longer than the gesture (ListArrival.css; the stylesheet's
 * numbers are checked against these in tests/libraryTable.test.tsx).
 * list: 60 + 13 × 28 + 70 + 420 = 914ms until the last cover has landed.
 * chase: 13 × 8 + 40 + 160 = 304ms.
 */
export const LIST_ARRIVAL_MS: Record<ListArrivalGesture, number> = { list: 960, chase: 340 };
/** A "list" arrival ends when the list is scrolled this far from where it arrived. */
const SCROLLED_AWAY_PX = 2;

type Row = HTMLElement | null | undefined;

export interface ListArrival {
  /**
   * Starts a gesture over `rows`, given in the order they arrive (a row that is not mounted is a
   * gap that keeps its place). One that is still running ends first — except a list presented
   * again while it is arriving: its rows that are still there carry on, the new ones start.
   */
  start(gesture: ListArrivalGesture, side: ListArrivalSide, rows: readonly Row[]): void;
  /**
   * The same rows again, after the table has rendered: one that was mounted since the gesture
   * started (a loading row whose track arrived) takes its place in it, in step with the others.
   */
  join(rows: readonly Row[]): void;
  /** A newly committed batch gets a complete gesture, without restarting earlier batches. */
  reveal(rows: readonly Row[], side: ListArrivalSide): void;
  /** The gesture that is running. */
  gesture(): ListArrivalGesture | null;
  /** Ends it at once: every row is simply there. */
  stop(): void;
}

export function createListArrival(scroller: HTMLElement): ListArrival {
  let live: { gesture: ListArrivalGesture; side: ListArrivalSide; startedAt: number; timer: ReturnType<typeof setTimeout>; rows: Set<HTMLElement>; origin: number } | null = null;

  const mark = (rows: readonly Row[], lag: number) => {
    if (!live) return;
    for (let at = 0; at < rows.length; at += 1) {
      const row = rows[at];
      if (!row || live.rows.has(row)) continue;
      row.setAttribute(LIST_ARRIVAL_ROW_ATTR, at < LIST_ARRIVAL_STEPS ? "step" : "rest");
      row.style.setProperty("--kd-arrive-i", String(Math.min(at, LIST_ARRIVAL_STEPS - 1)));
      // A negative delay starts a row's motion where the others already are.
      if (lag > 0) row.style.setProperty("--kd-arrive-lag", `${Math.round(lag)}ms`);
      live.rows.add(row);
    }
  };
  const onScroll = () => {
    // Being put at its place is a scroll too; only one that leaves that place ends the arrival.
    if (live && Math.abs(scroller.scrollTop - live.origin) > SCROLLED_AWAY_PX) stop();
  };
  const stop = () => {
    if (!live) return;
    const ended = live;
    live = null;
    clearTimeout(ended.timer);
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeAttribute(LIST_ARRIVAL_ATTR);
    scroller.removeAttribute(LIST_ARRIVAL_SIDE_ATTR);
    for (const row of ended.rows) {
      row.removeAttribute(LIST_ARRIVAL_ROW_ATTR);
      row.style.removeProperty("--kd-arrive-i");
      row.style.removeProperty("--kd-arrive-lag");
    }
  };

  const arrival: ListArrival = {
    start(gesture, side, rows) {
      // A list replaced while it is still being presented (a filter typed letter by letter): the
      // rows that stay go on arriving, and only the ones that are new to the view start.
      const kept = live && live.gesture === "list" && gesture === "list" && !prefersReducedMotion() ? live.rows : null;
      if (live && !kept) {
        // A row that stays keeps its animation unless the style without it is seen in between.
        const witness = [...live.rows].find((row) => row.isConnected);
        stop();
        if (witness) void getComputedStyle(witness).animationName;
      }
      if (prefersReducedMotion() || !rows.some(Boolean)) { stop(); return; }
      if (live) {
        clearTimeout(live.timer);
        scroller.removeEventListener("scroll", onScroll);
      }
      const mine = { gesture, side, startedAt: performance.now(), rows: kept ?? new Set<HTMLElement>(), origin: scroller.scrollTop,
        // Its own end only: a gesture that started meanwhile is not this timer's to stop.
        timer: setTimeout(() => { if (live === mine) stop(); }, LIST_ARRIVAL_MS[gesture]) };
      live = mine;
      scroller.setAttribute(LIST_ARRIVAL_ATTR, gesture);
      scroller.setAttribute(LIST_ARRIVAL_SIDE_ATTR, side);
      mark(rows, 0);
      // The chase runs while the rest of the scroll plays out; a presented list is left alone by a scroll.
      if (gesture === "list") scroller.addEventListener("scroll", onScroll, { passive: true });
    },
    join(rows) {
      if (live) mark(rows, performance.now() - live.startedAt);
    },
    reveal(rows, side) {
      if (prefersReducedMotion() || !rows.some(Boolean)) return;
      if (!live || (live.gesture === "chase" && live.side !== side)) {
        arrival.start("chase", side, rows);
        return;
      }
      // A presented list retains its gesture; a chase adds this batch on its own clock.
      // Neither cold data nor a slow commit should skip straight to an expired animation.
      for (const row of live.rows) if (!row.isConnected) live.rows.delete(row);
      mark(rows, 0);
      const current = live;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => { if (live === current) stop(); }, LIST_ARRIVAL_MS[current.gesture]);
    },
    gesture: () => live?.gesture ?? null,
    stop,
  };
  return arrival;
}
