/**
 * The local track list's arrival: when the list is a different list (another folder, 全部曲目,
 * a sort or a filter that changed the result), its first screenful of rows fades in from the
 * top, one row a moment after the other, and is settled within a quarter of a second.
 *
 * The table calls `markListArrival` at the one place where it already knows the list changed
 * (the query version it resets its scroll on). That puts `data-kd-arrive` on the scroll
 * container for LIST_ARRIVAL_MS; ListArrival.css does the rest with `nth-child` on the rows
 * that exist then. Nothing is marked on a scroll, a re-render, a row that updates or rows the
 * virtual window swaps in, and the mark is dropped at once when the list is scrolled, so a row
 * is never animated during a scroll or under a stand-in canvas.
 */
import "./ListArrival.css";

export const LIST_ARRIVAL_ATTR = "data-kd-arrive";
/** The cascade is over after 11 × 8 + 160 = 248 ms; the mark stays a little longer. */
export const LIST_ARRIVAL_MS = 300;

const marked = new WeakMap<HTMLElement, () => void>();

/** The list in `scroller` was replaced and starts at its top: its first rows arrive. */
export function markListArrival(scroller: HTMLElement): void {
  marked.get(scroller)?.();
  // The two values name the same motion: going from one to the other starts it again for a
  // list that is replaced while the previous one is still arriving, without a forced layout.
  const value = scroller.getAttribute(LIST_ARRIVAL_ATTR) === "a" ? "b" : "a";
  const onScroll = () => {
    // Setting the list to its top is a scroll too; only one that leaves the top ends the arrival.
    if (scroller.scrollTop > 2) clear();
  };
  const clear = () => {
    if (marked.get(scroller) !== stop) return;
    stop();
    scroller.removeAttribute(LIST_ARRIVAL_ATTR);
  };
  const stop = () => {
    marked.delete(scroller);
    clearTimeout(timer);
    scroller.removeEventListener("scroll", onScroll);
  };
  const timer = setTimeout(clear, LIST_ARRIVAL_MS);
  marked.set(scroller, stop);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.setAttribute(LIST_ARRIVAL_ATTR, value);
}
