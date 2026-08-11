import assert from "node:assert/strict";
import test from "node:test";
import { cycleTableSort } from "../src/lib/tableSort";

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
