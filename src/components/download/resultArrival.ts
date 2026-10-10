/**
 * The search results arriving: when the table presents a list the user has not just been
 * looking at, its rows are laid out one after another from the first one in view; when rows are
 * added to the list that is shown, those rows do the same and the rest stay where they are.
 *
 * What counts as presented is decided here (`arrivalAfter`): a delivered list (a search answer,
 * a collection or a playlist opened, the previous results brought back) and the pane coming
 * back on screen. A delivery is one answer in one piece — the backend merges its sources before
 * it replies — so there is one cascade per delivery, never a first trickle and stragglers. A
 * re-render, a selection, an opened row or a scroll presents nothing.
 *
 * The motion itself is ResultTable.css: `arriveRows` only marks the rows that take part
 * (`data-reveal`, their step in the cascade) and takes the marks off when the gesture is over.
 * Nothing stays on a row afterwards, which is what lets the next presentation play again: the
 * pane is hidden with `display: none`, and a rule still matching a row would simply run once
 * more every time it is shown.
 */

/** A list as its owner delivered it: which one, and where it starts. */
export interface ResultDelivery {
  /** Changes with every delivered list; rows added to or taken from a list keep it. */
  id: number;
  /** The scroll position the list is presented at (its top, or where it was left). */
  top: number;
  left: number;
}

/**
 * Rows that rise one after another, and how many more behind them arrive on the last beat:
 * together more than the tallest window shows. Rows further down are simply there by the time
 * they are scrolled to.
 */
export const ARRIVAL_CASCADE_ROWS = 14;
export const ARRIVAL_REST_ROWS = 106;
/**
 * The last badge of the fourteenth row has landed after 60 + 13 × 28 + 290 + 340 = 1054 ms;
 * the marks stay a little longer.
 */
export const RESULT_ARRIVAL_MS = 1100;
export const ARRIVAL_ATTR = "data-reveal";
/** The mark of a row behind the cascade. */
export const ARRIVAL_REST = "rest";

export interface ArrivalView {
  /** The delivered list's id. */
  delivery: number;
  /** The pane that holds the table is on screen. */
  shown: boolean;
  /** There are rows to show (not the spinner, not the empty state). */
  listed: boolean;
}

export interface ArrivalState extends ArrivalView {
  /** Counts presentations; a change of it starts the cascade. */
  run: number;
}

export const NOTHING_PRESENTED: ArrivalState = {
  delivery: Number.NaN,
  shown: false,
  listed: false,
  run: 0,
};

/**
 * The arrival after the table has come to `now`. A list is presented when there are rows on
 * screen that were not there a moment ago: another delivery, rows where the spinner or nothing
 * was, or the pane shown again. A list delivered while the pane is away is presented when the
 * pane returns. While a request is pending, bringing retained rows back is not a presentation:
 * record their visibility without a cascade, so ending the request cannot replay them either.
 * A genuinely new delivery may arrive before the caller lowers its loading flag.
 */
export function arrivalAfter(seen: ArrivalState, now: ArrivalView, loading = false): ArrivalState {
  if (seen.delivery === now.delivery && seen.shown === now.shown && seen.listed === now.listed) {
    return seen;
  }
  const visible = now.shown && now.listed;
  const wasVisible = seen.shown && seen.listed;
  const delivered = Number.isFinite(seen.delivery) && seen.delivery !== now.delivery;
  const presented = visible && (!wasVisible || delivered) && (!loading || delivered);
  return { ...now, run: presented ? seen.run + 1 : seen.run };
}

/**
 * The first of `count` rows that reaches below `viewTop`: the row the cascade starts on when
 * the list is not at its top. `bottomOf` grows with the index (rows are stacked).
 */
export function firstRowBelow(
  count: number,
  bottomOf: (index: number) => number,
  viewTop: number,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bottomOf(middle) > viewTop) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The first row of `table` that is in view inside `scroller`, below the header that stays at
 * the top. Read once, before the gesture.
 */
export function firstRowInView(
  table: HTMLTableElement,
  rows: ArrayLike<HTMLElement>,
  scroller: HTMLElement | null,
): number {
  const scrollTop = scroller?.scrollTop ?? 0;
  if (scrollTop <= 0 || rows.length === 0) return 0;
  // Rows measure from the table; so does the line the header ends at.
  const viewTop = scrollTop - table.offsetTop + (table.tHead?.offsetHeight ?? 0);
  const first = firstRowBelow(
    rows.length,
    (index) => rows[index].offsetTop + rows[index].offsetHeight,
    viewTop,
  );
  // A list scrolled past its end has nothing below the line: start on its last rows.
  return Math.min(first, Math.max(0, rows.length - 1));
}

/** Which arrival a row's mark belongs to, so an older one never takes a newer one's mark off. */
const owners = new WeakMap<Element, object>();

/**
 * `rows[from…]` arrive: the first fourteen that are drawn one step apart, the next ones
 * together on the last beat. Returns what ends the arrival early (the list changed, the table
 * is gone).
 */
export function arriveRows(rows: ArrayLike<Element>, from: number): () => void {
  const owner = {};
  const marked: Element[] = [];
  let step = 0;
  for (
    let index = Math.max(0, from);
    index < rows.length && step < ARRIVAL_CASCADE_ROWS + ARRIVAL_REST_ROWS;
    index += 1
  ) {
    const row = rows[index];
    // A row that holds no room (the end mark of a folding package) takes no step.
    if ((row as HTMLElement).hidden) continue;
    row.setAttribute(ARRIVAL_ATTR, step < ARRIVAL_CASCADE_ROWS ? String(step) : ARRIVAL_REST);
    owners.set(row, owner);
    marked.push(row);
    step += 1;
  }
  let over = false;
  const clear = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    for (const row of marked) {
      if (owners.get(row) !== owner) continue;
      owners.delete(row);
      row.removeAttribute(ARRIVAL_ATTR);
    }
  };
  const timer = setTimeout(clear, RESULT_ARRIVAL_MS);
  return clear;
}

/** The marks the rows themselves carry while they slot in or unfold (set when they mount). */
const ROW_GESTURE_ATTRS = ["data-enter", "data-unfold"] as const;

/**
 * A row's own entrance (a row slotting into a settled list, a source or a part unfolding) is
 * marked by the row when it mounts. The mark comes off here when that animation is over or was
 * cut short, for the same reason the cascade's marks do: left on the row, it would play again
 * each time the pane is shown, and again when a cascade that had outranked it ends.
 * Returns what stops listening.
 */
export function settleRowGestures(table: HTMLElement): () => void {
  const onOver = (event: Event) => {
    const row = event.target;
    // Covers and badges animate inside a row and their events pass through here too.
    if (!(row instanceof Element) || row.tagName !== "TR") return;
    for (const name of ROW_GESTURE_ATTRS) row.removeAttribute(name);
  };
  table.addEventListener("animationend", onOver);
  table.addEventListener("animationcancel", onOver);
  return () => {
    table.removeEventListener("animationend", onOver);
    table.removeEventListener("animationcancel", onOver);
  };
}

/** How close to the end of what is shown the list has to be scrolled before more is asked for. */
export const LIST_END_MARGIN_PX = 96;

/**
 * The end of the list is in reach: the next batch is due. A pane that is not laid out (hidden,
 * no height) is never near its end.
 */
export function nearListEnd(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  margin = LIST_END_MARGIN_PX,
): boolean {
  if (clientHeight <= 0 || scrollHeight <= 0) return false;
  return scrollTop + clientHeight >= scrollHeight - margin;
}
