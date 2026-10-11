/**
 * The search results arriving: when the table presents a list the user has not just been
 * looking at, its rows in view are laid out one after another from the first one (the shared
 * gesture of a presented list, components/common/listArrival.ts); when rows are added to the
 * list that is shown, those rows do the same and the rest stay where they are.
 *
 * What counts as presented is decided here (`arrivalAfter`): a delivered list (a search answer,
 * a collection or a playlist opened, the previous results brought back) and the pane coming
 * back on screen. A delivery is one answer in one piece — the backend merges its sources before
 * it replies — so there is one cascade per delivery, never a first trickle and stragglers. A
 * re-render, a selection, an opened row or a scroll presents nothing.
 */

/** A list as its owner delivered it: which one, and where it starts. */
export interface ResultDelivery {
  /** Changes with every delivered list; rows added to or taken from a list keep it. */
  id: number;
  /** The scroll position the list is presented at (its top, or where it was left). */
  top: number;
  left: number;
}

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

/** The marks the rows themselves carry while they slot in or unfold (set when they mount). */
const ROW_GESTURE_ATTRS = ["data-enter", "data-unfold"] as const;

/**
 * A row's own entrance (a row slotting into a settled list, a source or a part unfolding) is
 * marked by the row when it mounts. The mark comes off here when that animation is over or was
 * cut short, for the same reason the cascade's marks do: left on the row, it would play again
 * each time the pane is shown, and again when a cascade that had outranked it ends.
 * Returns what stops listening.
 */
export function settleRowGestures(body: HTMLElement): () => void {
  const onOver = (event: Event) => {
    const row = event.target;
    // Covers and badges animate inside a row and their events pass through here too.
    if (!(row instanceof Element) || !row.classList.contains("kd-list-row")) return;
    for (const name of ROW_GESTURE_ATTRS) row.removeAttribute(name);
  };
  body.addEventListener("animationend", onOver);
  body.addEventListener("animationcancel", onOver);
  return () => {
    body.removeEventListener("animationend", onOver);
    body.removeEventListener("animationcancel", onOver);
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
