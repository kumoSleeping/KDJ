import assert from "node:assert/strict";
import test from "node:test";
import {
  ARRIVAL_ATTR,
  ARRIVAL_CASCADE_ROWS,
  ARRIVAL_REST_ROWS,
  arrivalAfter,
  arriveRows,
  firstRowBelow,
  nearListEnd,
  NOTHING_PRESENTED,
  type ArrivalState,
  type ArrivalView,
} from "../src/components/download/resultArrival";

/** As much of a table row as marking it needs. */
function fakeRows(count: number): Element[] {
  return Array.from({ length: count }, () => {
    const attributes = new Map<string, string>();
    return {
      hidden: false,
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => void attributes.delete(name),
    } as unknown as Element;
  });
}
const mark = (row: Element) => row.getAttribute(ARRIVAL_ATTR);

/** The run after each view in turn: a change of it is one cascade. */
function runs(views: ArrivalView[]): number[] {
  let state: ArrivalState = NOTHING_PRESENTED;
  return views.map((view) => {
    state = arrivalAfter(state, view);
    return state.run;
  });
}

const list = (delivery: number, shown = true): ArrivalView => ({ delivery, shown, listed: true });
const none = (delivery: number, shown = true): ArrivalView => ({ delivery, shown, listed: false });

test("every list the user has not just been looking at is presented once", () => {
  assert.deepEqual(
    runs([
      none(0), //         the first search is running: a spinner
      list(1), //         its answer
      list(1), //         a re-render, a selection, an opened row
      list(1), //         the second search is running under the old rows
      list(2), //         its answer replaces them without passing through the spinner
      list(3), //         a collection opened from the candidates
      list(4), //         back to the previous results
      none(4), //         a playlist is being opened: the spinner again
      list(5), //         the playlist
    ]),
    [0, 1, 1, 1, 2, 3, 4, 4, 5],
  );
});

test("the pane coming back on screen presents its list again; hiding it does not", () => {
  assert.deepEqual(
    runs([list(1), list(1, false), list(1), list(1), list(1, false), list(1)]),
    [1, 1, 2, 2, 2, 3],
  );
  // A list delivered while the pane is away is presented when the pane returns, once.
  assert.deepEqual(runs([list(1), list(1, false), list(2, false), list(2)]), [1, 1, 1, 2]);
  // An empty pane coming back presents nothing.
  assert.deepEqual(runs([none(1, false), none(1), list(1)]), [0, 0, 1]);
  // A table mounted with its list already there (the pane was rebuilt) presents it.
  assert.deepEqual(runs([list(7)]), [1]);
  // Rows of the same delivery vanishing and returning (the list emptied by an error) present it.
  assert.deepEqual(runs([list(1), none(1), list(1)]), [1, 1, 2]);
});

test("a state that did not change is the same object, so nothing re-renders", () => {
  const first = arrivalAfter(NOTHING_PRESENTED, list(1));
  assert.equal(arrivalAfter(first, list(1)), first);
});

test("the cascade starts on the first row that reaches below the header line", () => {
  // Forty rows of 36px, stacked from 28 (under the header).
  const bottom = (index: number) => 28 + (index + 1) * 36;
  assert.equal(firstRowBelow(40, bottom, 0), 0);
  assert.equal(firstRowBelow(40, bottom, 28), 0);
  // The first row is exactly out: the second one is first.
  assert.equal(firstRowBelow(40, bottom, 64), 1);
  // Half of row 10 is still in view.
  assert.equal(firstRowBelow(40, bottom, 28 + 10 * 36 + 18), 10);
  // Past the end: no row.
  assert.equal(firstRowBelow(40, bottom, 99999), 40);
  assert.equal(firstRowBelow(0, bottom, 10), 0);
});

test("more is due when the end of the list is in reach, never for a pane that is not laid out", () => {
  assert.equal(nearListEnd(0, 800, 1900), false);
  assert.equal(nearListEnd(1000, 800, 1900), false);
  assert.equal(nearListEnd(1004, 800, 1900), true);
  assert.equal(nearListEnd(1100, 800, 1900), true);
  // A first batch that does not fill the pane is at its end already.
  assert.equal(nearListEnd(0, 1200, 900), true);
  // Hidden: no size at all.
  assert.equal(nearListEnd(0, 0, 0), false);
});

test("marks: fourteen steps from the starting row, a bounded rest, and nothing left behind", () => {
  const rows = fakeRows(300);
  (rows[7] as HTMLElement).hidden = true; // the end mark of a folding package holds no room
  const clear = arriveRows(rows, 5);
  assert.equal(mark(rows[4]), null);
  assert.deepEqual([5, 6, 7, 8, 9].map((index) => mark(rows[index])), ["0", "1", null, "2", "3"]);
  assert.equal(mark(rows[5 + ARRIVAL_CASCADE_ROWS]), String(ARRIVAL_CASCADE_ROWS - 1));
  assert.equal(mark(rows[6 + ARRIVAL_CASCADE_ROWS]), "rest");
  const marked = rows.filter((row) => mark(row) !== null).length;
  assert.equal(marked, ARRIVAL_CASCADE_ROWS + ARRIVAL_REST_ROWS);
  assert.equal(mark(rows[299]), null);

  // The list is presented again while this arrival runs: the rows belong to the new arrival,
  // and the old one ending takes none of their marks off.
  const again = arriveRows(rows, 100);
  assert.equal(mark(rows[100]), "0");
  clear();
  assert.equal(mark(rows[5]), null);
  assert.equal(mark(rows[100]), "0");
  assert.equal(mark(rows[110]), "10");
  again();
  assert.equal(rows.filter((row) => mark(row) !== null).length, 0);
  // Ending twice, or starting past the end, is nothing.
  again();
  arriveRows(rows, 999)();
  assert.equal(rows.filter((row) => mark(row) !== null).length, 0);
});
