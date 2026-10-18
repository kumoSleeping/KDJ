import assert from "node:assert/strict";
import test from "node:test";
import { RESULT_COLUMNS, resultDownloadKeyColumn } from "../src/components/download/resultColumns";
import { pickStateOf, selectedShareItems, selectionKey, selectionRun } from "../src/lib/resultSelection";
import { formatShareListText } from "../src/lib/shareLink";
import type { IntakeItem } from "../src/types";
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

test("the picked rows are shared together, in the order they stand, each by its chosen source", () => {
  const source = (platform: string, key: string) => ({ platform, key, payload: {} });
  const group = (id: string, title: string, sources: ReturnType<typeof source>[]) =>
    ({ group_id: id, title, artists: ["A"], album: "", best_source_index: 0, sources });
  const items = [
    { groups: [group("a", "One", [source("wyy", "11"), source("qqm", "q1")]), group("b", "Local", [source("local", "x")])] },
    { groups: [group("c", "Three", [source("qqm", "q3")])] },
  ] as unknown as IntakeItem[];
  const picked = new Set([selectionKey(1, "c"), selectionKey(0, "b"), selectionKey(0, "a")]);
  const shared = selectedShareItems(items, picked, { a: 1 });
  assert.deepEqual(shared.map((item) => item.link), [
    "https://y.qq.com/n/ryqq/songDetail/q1",
    "https://y.qq.com/n/ryqq/songDetail/q3",
  ], "list order, the source the row shows, a row with nothing to share left out");
  const text = formatShareListText(shared, "more_info").split("\n");
  assert.deepEqual(text.slice(0, 2), ["One - A https://y.qq.com/n/ryqq/songDetail/q1", "Three - A https://y.qq.com/n/ryqq/songDetail/q3"]);
  assert.match(text[2], /^Share from KDJ v/);
  assert.equal(text.length, 3);
});
