import assert from "node:assert/strict";
import test from "node:test";
import { RESULT_COLUMNS, resultDownloadKeyColumn } from "../src/components/download/resultColumns";
import { pickStateOf, selectionKey, selectionRun } from "../src/lib/resultSelection";
import { orderByPrefs } from "../src/lib/tableColumnPrefs";

test("a Shift-click takes the rows from the one touched last to the one clicked, as they are shown", () => {
  const shown = ["0:a", "0:b", "0:c", "1:a", "1:d"];
  assert.deepEqual(selectionRun(shown, "0:b", "1:a"), ["0:b", "0:c", "1:a"]);
  assert.deepEqual(selectionRun(shown, "1:d", "0:c"), ["0:c", "1:a", "1:d"], "upwards as well");
  assert.deepEqual(selectionRun(shown, "0:c", "0:c"), ["0:c"]);
  // Nothing was touched yet, or the row touched last is on another page or folded away.
  assert.equal(selectionRun(shown, null, "0:c"), null);
  assert.equal(selectionRun(shown, "9:z", "0:c"), null);
  assert.equal(selectionRun(shown, "0:a", "9:z"), null);
  // The same song found by two keywords is two rows with two keys.
  assert.notEqual(selectionKey(0, "a"), selectionKey(1, "a"));
});

test("the head's mark says all, some or none of the rows it stands for", () => {
  const keys = ["0:a", "0:b", "0:c"];
  assert.equal(pickStateOf(keys, new Set()), "none");
  assert.equal(pickStateOf(keys, new Set(["0:b"])), "some");
  assert.equal(pickStateOf(keys, new Set(["0:a", "0:b", "0:c", "1:x"])), "all");
  assert.equal(pickStateOf(keys, new Set(["1:x"])), "none", "a pick elsewhere is not a pick here");
  assert.equal(pickStateOf([], new Set(["0:a"])), "none", "nothing to pick is never all");
});

test("the download key belongs to the first data column that is shown, whatever it is", () => {
  const visible = (order: string[], hidden: string[] = [], withData = RESULT_COLUMNS.map((column) => column.key)) =>
    orderByPrefs(RESULT_COLUMNS, order).filter((column) => !hidden.includes(column.key) && withData.includes(column.key));
  assert.equal(resultDownloadKeyColumn(visible([])), "title", "the title by default");
  assert.equal(resultDownloadKeyColumn(visible(["artist", "title"])), "artist", "the user put the artist first");
  assert.equal(resultDownloadKeyColumn(visible(["sources", "artist", "title"])), "sources");
  // A first column that is hidden, or has nothing to show for these results, is not the first one shown.
  assert.equal(resultDownloadKeyColumn(visible(["artist", "title"], ["artist"])), "title");
  assert.equal(resultDownloadKeyColumn(visible(["album", "duration", "title"], [], ["title", "duration"])), "duration");
  assert.equal(resultDownloadKeyColumn([]), null);
});
