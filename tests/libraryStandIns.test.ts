import assert from "node:assert/strict";
import test from "node:test";
import { STAND_IN_TILE_ROWS, fitStandInText, standInGap, standInPlan, type StandInPlanInput } from "../src/lib/libraryStandIns";

const base: StandInPlanInput = { top: 0, height: 684, rowHeight: 36, count: 10_000, first: 0, windowStart: 0, windowEnd: 0, direction: 0 };
const shown = (input: StandInPlanInput) => standInPlan(input).map((tile) => [tile.shownStart, tile.shownEnd] as const);

test("stand-in tiles cover the viewport and several screens ahead of a scroll, never the table's own rows", () => {
  for (const direction of [-1, 0, 1] as const) for (const row of [0, 7, 500, 5000, 9990]) {
    for (const [windowStart, windowEnd] of [[0, 0], [row - 30, row + 60], [row + 5, row + 80], [0, 10_000]] as const) {
      const input = { ...base, top: row * 36, direction, windowStart: Math.max(0, windowStart), windowEnd: Math.min(10_000, windowEnd) };
      const plan = standInPlan(input);
      const first = Math.min(10_000, row), last = Math.min(10_000, row + 19);
      const covered = [[input.windowStart, input.windowEnd] as const, ...shown(input)];
      assert.equal(standInGap(covered, first, last), 0, "every row of the viewport has something to show");
      for (const tile of plan) {
        assert.ok(tile.start >= tile.index * STAND_IN_TILE_ROWS && tile.end <= (tile.index + 1) * STAND_IN_TILE_ROWS && tile.end <= 10_000);
        assert.ok(tile.start <= tile.shownStart && tile.shownStart < tile.shownEnd && tile.shownEnd <= tile.end);
        assert.ok(tile.shownEnd <= input.windowStart || tile.shownStart >= input.windowEnd, "a stand-in is never drawn over a real row");
        assert.equal(tile.urgent, tile.shownStart < last && tile.shownEnd > first);
      }
      assert.ok(plan.length <= 12);
      assert.ok(plan.every((tile, at) => at === 0 || !tile.urgent || plan[at - 1].urgent), "tiles under the viewport come first");
      // Six screens ahead of a fast scroll; nothing beyond the viewport for a table that builds its own rows.
      if (direction) {
        const edge = Math.min(9_999, Math.max(0, direction < 0 ? first - 6 * 19 : last + 6 * 19 - 1));
        assert.equal(standInGap(covered, edge, edge + 1), 0);
      } else {
        assert.ok(plan.every((tile) => tile.urgent), "no canvas is held for rows out of sight");
      }
    }
  }
  assert.deepEqual(standInPlan({ ...base, windowStart: 0, windowEnd: 10_000 }), []);
  assert.deepEqual(standInPlan({ ...base, count: 0 }), []);
});

test("pending downloads keep their own rows; the last tile ends with the table", () => {
  const plan = standInPlan({ ...base, count: 60, first: 10, top: 0, direction: 1 });
  assert.equal(Math.min(...plan.map((tile) => tile.start)), 10);
  assert.equal(Math.max(...plan.map((tile) => tile.end)), 60);
});

test("a long text is cut with an ellipsis to the width of its cell", () => {
  const measure = (text: string) => text.length * 10;
  assert.equal(fitStandInText(measure, "Night Drive", 200), "Night Drive");
  assert.equal(fitStandInText(measure, "Night Drive", 80), "Night D…");
  assert.equal(fitStandInText(measure, "Night Drive", 50), "Nigh…");
  assert.equal(fitStandInText(measure, "Night Drive", 15), "");
  assert.equal(fitStandInText(measure, "Night Drive", 0), "");
  assert.equal(standInGap([[0, 5], [8, 12]], 3, 10), 3);
});
