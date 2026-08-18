import assert from "node:assert/strict";
import test from "node:test";
import { DJ_TRACK_TABLE_COLUMN_WIDTHS, fitDjTrackColumns } from "../src/lib/djTableLayout";
import { cycleTableSort } from "../src/lib/tableSort";

test("DJ track table keeps performance columns inside one fixed-width row", () => {
  const columns = ["title", "artist", "album", "bpm", "camelot", "energy", "duration", "format", "rating"]
    .map((key) => ({ key }));
  assert.deepEqual(
    fitDjTrackColumns(columns).map((column) => column.key),
    ["title", "artist", "bpm", "camelot", "duration"],
  );
  const allocated = Object.values(DJ_TRACK_TABLE_COLUMN_WIDTHS)
    .reduce((sum, width) => sum + Number.parseFloat(width), 0);
  assert.equal(allocated, 90, "the fixed index column owns the remaining 10%");
});

test("track table sorting releases to source order and preserves secondary promotion", () => {
  const source = { sort: "custom", order: "asc", sort2: null, order2: "asc" } as const;
  const ascending = cycleTableSort(source, "bpm", "custom", "asc");
  assert.deepEqual(ascending, { ...source, sort: "bpm" });
  const descending = cycleTableSort(ascending, "bpm", "custom", "asc");
  assert.equal(descending.order, "desc");
  assert.deepEqual(cycleTableSort(descending, "bpm", "custom", "asc"), source);

  const withSecondary = cycleTableSort(ascending, "key", "custom", "asc");
  assert.equal(withSecondary.sort, "bpm");
  assert.equal(withSecondary.sort2, "key");
  assert.deepEqual(cycleTableSort(withSecondary, "key", "custom", "asc"), {
    sort: "key",
    order: "asc",
    sort2: "bpm",
    order2: "asc",
  });
});
