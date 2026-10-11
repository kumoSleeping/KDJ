/**
 * How the rows of a list arrive (ListArrival.css). Two gestures of one family, for every list
 * that is built on the row list (RowList.css): the local track list and the search results.
 *
 * - "list": the list is presented — at startup, as another folder or 全部曲目, after a sort or a
 *   filter that replaced it, a delivered search answer, and every time its pane is shown again.
 *   The rows in view rise into place while they fade in, one after another from the top, each
 *   cover a beat after its row (motion.css, "A list that is presented").
 * - "chase": a row that is built after the viewport has already moved over its place — a fast
 *   scroll ran ahead of the frames that build rows. Every such row joins one chase at the beat
 *   its distance from the edge the rows come in from says, on the clock of that chase: rows that
 *   are built a frame apart still arrive one after another, and a row that is late for its beat
 *   is simply there. A chase that has played out is over; the next late row starts another.
 *
 * The marks are on the row alone: `data-kd-arrive` (the gesture), `data-kd-arrive-row` (a
 * staggered "step" or the "rest" that comes with the last beat), `data-kd-arrive-from` (the side
 * the rows come from) and its step in `--kd-arrive-i`; a row that joins a running gesture carries
 * how far it already is in `--kd-arrive-lag`. Nothing is put on an ancestor, so marking a row
 * invalidates that row's style and nothing else, and the marks are taken off when the gesture
 * is over so the next presentation plays afresh (a pane hidden with display: none would
 * otherwise replay them when it is shown). Rows are positioned by `top`, never by a transform,
 * so the gesture's transform moves a row over its own place.
 */
import { prefersReducedMotion } from "../../lib/motion";
import "./ListArrival.css";

export type ListArrivalGesture = "list" | "chase";
/** Where the rows come from: "below" rises into place (the top row first), "above" drops (the bottom row first). */
export type ListArrivalSide = "below" | "above";

export const LIST_ARRIVAL_ATTR = "data-kd-arrive";
export const LIST_ARRIVAL_ROW_ATTR = "data-kd-arrive-row";
export const LIST_ARRIVAL_SIDE_ATTR = "data-kd-arrive-from";
/** Rows that arrive one after another; every later one comes with the last of them. */
export const LIST_ARRIVAL_STEPS = 14;
/** The beats of the stylesheet (motion.css; checked against it in tests/libraryTable.test.tsx). */
export const LIST_ARRIVAL_BEATS = {
  list: { lead: 60, step: 28, row: 380, rest: 240, cover: 420, coverAfter: 70 },
  chase: { lead: 0, step: 8, row: 160, rest: 160, cover: 160, coverAfter: 40 },
} as const;
/**
 * How long the marks stay: a little longer than the gesture.
 * list: 60 + 13 × 28 + 70 + 420 = 914ms until the last cover has landed.
 * chase: 13 × 8 + 40 + 160 = 304ms.
 */
export const LIST_ARRIVAL_MS: Record<ListArrivalGesture, number> = { list: 960, chase: 340 };
/** A "list" arrival ends when the list is scrolled this far from where it arrived. */
const SCROLLED_AWAY_PX = 2;

type Row = HTMLElement | null | undefined;

export interface ListArrival {
  /**
   * The list is presented: `rows` in the order they arrive (a row that is not mounted is a gap
   * that keeps its place). A list presented again while it is arriving (a filter typed letter
   * by letter) lets the rows that stay carry on and starts only the ones new to the view.
   */
  present(rows: readonly Row[]): void;
  /**
   * `row` was built after the viewport reached its place: it joins the chase from `side` at
   * `step` (its distance in rows from the edge the rows come in from), on the clock of the chase
   * that is running, or starts one.
   */
  chase(row: HTMLElement, step: number, side: ListArrivalSide): void;
  /** The gesture that is running. */
  gesture(): ListArrivalGesture | null;
  /** Ends it at once: every row is simply there. */
  stop(): void;
}

/** When a row at `step` is in place, from the start of its gesture. */
function landsAt(gesture: ListArrivalGesture, step: number): number {
  const beats = LIST_ARRIVAL_BEATS[gesture];
  const staggered = Math.min(step, LIST_ARRIVAL_STEPS - 1);
  return beats.lead + staggered * beats.step + beats.coverAfter + beats.cover;
}

export function createListArrival(scroller: HTMLElement): ListArrival {
  interface Live {
    gesture: ListArrivalGesture;
    startedAt: number;
    endsAt: number;
    timer: ReturnType<typeof setTimeout>;
    rows: Set<HTMLElement>;
    origin: number;
    side: ListArrivalSide;
  }
  let live: Live | null = null;

  const mark = (row: HTMLElement, gesture: ListArrivalGesture, step: number, side: ListArrivalSide, lag: number) => {
    row.setAttribute(LIST_ARRIVAL_ATTR, gesture);
    row.setAttribute(LIST_ARRIVAL_ROW_ATTR, step < LIST_ARRIVAL_STEPS ? "step" : "rest");
    row.setAttribute(LIST_ARRIVAL_SIDE_ATTR, side);
    row.style.setProperty("--kd-arrive-i", String(Math.min(step, LIST_ARRIVAL_STEPS - 1)));
    // A negative delay starts a row's motion where the others already are. Rows marked in the
    // same frame as the first one are not late.
    const late = Math.round(lag);
    if (late > 0) row.style.setProperty("--kd-arrive-lag", `${late}ms`);
    else row.style.removeProperty("--kd-arrive-lag");
  };
  const unmark = (row: HTMLElement) => {
    row.removeAttribute(LIST_ARRIVAL_ATTR);
    row.removeAttribute(LIST_ARRIVAL_ROW_ATTR);
    row.removeAttribute(LIST_ARRIVAL_SIDE_ATTR);
    row.style.removeProperty("--kd-arrive-i");
    row.style.removeProperty("--kd-arrive-lag");
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
    for (const row of ended.rows) unmark(row);
  };
  /** The marks come off when the last row has landed; a row that joins late moves that moment. */
  const endBy = (current: Live, at: number) => {
    if (at <= current.endsAt) return;
    current.endsAt = at;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { if (live === current) stop(); }, Math.max(0, at - performance.now()));
  };
  const begin = (gesture: ListArrivalGesture, rows: Set<HTMLElement>, side: ListArrivalSide): Live => {
    const now = performance.now();
    const started: Live = { gesture, startedAt: now, endsAt: now, rows, origin: scroller.scrollTop, side,
      timer: setTimeout(() => { if (live === started) stop(); }, 0) };
    live = started;
    endBy(started, now + LIST_ARRIVAL_MS[gesture]);
    // The chase runs while the rest of the scroll plays out; a presented list is left alone by a
    // scroll until it leaves the place it arrived at.
    if (gesture === "list") scroller.addEventListener("scroll", onScroll, { passive: true });
    return started;
  };

  const arrival: ListArrival = {
    present(rows) {
      // A list replaced while it is still being presented: the rows that stay go on arriving,
      // and only the ones that are new to the view start.
      const kept = live?.gesture === "list" && !prefersReducedMotion() ? live.rows : null;
      if (live && !kept) stop();
      if (prefersReducedMotion() || !rows.some(Boolean)) { stop(); return; }
      const current = live && kept ? live : begin("list", kept ?? new Set(), "below");
      for (const row of kept ?? []) if (!row.isConnected) current.rows.delete(row);
      for (let at = 0; at < rows.length; at += 1) {
        const row = rows[at];
        if (!row || current.rows.has(row)) continue;
        mark(row, "list", at, "below", 0);
        current.rows.add(row);
      }
      if (kept) endBy(current, performance.now() + LIST_ARRIVAL_MS.list);
    },
    chase(row, step, side) {
      if (prefersReducedMotion()) return;
      const now = performance.now();
      // A presented list that is scrolled away from ends on its own (onScroll); a chase whose
      // rows have all landed, or that comes from the other side, is over: this row starts the next.
      if (live && (live.gesture !== "chase" || now >= live.endsAt || live.side !== side)) stop();
      const current = live ?? begin("chase", new Set(), side);
      const lag = now - current.startedAt;
      // Late for its beat and past its landing: it is simply there.
      if (lag >= landsAt("chase", step)) return;
      if (current.rows.has(row)) return;
      mark(row, "chase", step, side, lag);
      current.rows.add(row);
      endBy(current, current.startedAt + landsAt("chase", step) + 40);
    },
    gesture: () => live?.gesture ?? null,
    stop,
  };
  return arrival;
}
