/** Shared local-row arrivals. Marks belong to real rows, so virtualization never animates
 * a spacer and late summaries receive the same gesture as an already cached list. */
import "./ListArrival.css";
import { MOTION_IN_MS, MOTION_STAGGER_TOTAL_MS } from "../../lib/motion";

export const LIST_ARRIVAL_ATTR = "data-kd-row-arrive";
export const LIST_ARRIVAL_MS = MOTION_IN_MS + MOTION_STAGGER_TOTAL_MS;
const marked = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function markRows(rows: HTMLElement[], direction: -1 | 1, catchup: boolean): void {
  rows.forEach((row, index) => {
    const timer = marked.get(row);
    if (timer !== undefined) clearTimeout(timer);
    row.style.setProperty("--kd-arrive-i", String(Math.min(index, 13)));
    row.style.setProperty("--kd-arrive-y", `${direction * 14}px`);
    row.toggleAttribute("data-kd-catchup", catchup);
    row.setAttribute(LIST_ARRIVAL_ATTR, row.getAttribute(LIST_ARRIVAL_ATTR) === "a" ? "b" : "a");
    marked.set(row, setTimeout(() => {
      row.removeAttribute(LIST_ARRIVAL_ATTR);
      row.removeAttribute("data-kd-catchup");
      row.style.removeProperty("--kd-arrive-i");
      row.style.removeProperty("--kd-arrive-y");
      marked.delete(row);
    }, LIST_ARRIVAL_MS));
  });
}

/** Each navigation, including a remounted local pane, arrives again. */
export function markListArrival(scroller: HTMLElement): void {
  markRows(Array.from(scroller.querySelectorAll<HTMLElement>(
    "tbody > tr:not([data-spacer]):not([data-loading-track])",
  )), 1, false);
}

/** Only newly mounted rows follow the scroll; already visible rows keep their place. */
export function markListCatchup(rows: HTMLElement[], direction: -1 | 1): void {
  markRows(rows, direction, true);
}
