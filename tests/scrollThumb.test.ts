import assert from "node:assert/strict";
import test from "node:test";
import { scrollThumb, thumbPosition, scrollFromThumb } from "../src/lib/scrollThumb";

test("floating thumb maps the entire ten-thousand-row range to a usable handle", () => {
  const metric = scrollThumb(720, 360028, 32, 14);
  assert.equal(metric.extent, 359308);
  assert.equal(metric.length, 44);
  for (const fraction of [0, 0.1, 0.5, 0.95, 1]) {
    const position = thumbPosition(metric.extent * fraction, metric.extent, metric.travel);
    assert.ok(Math.abs(scrollFromThumb(position, metric.extent, metric.travel) - metric.extent * fraction) < 0.00001);
  }
  assert.equal(scrollFromThumb(-100, metric.extent, metric.travel), 0);
  assert.equal(scrollFromThumb(99999, metric.extent, metric.travel), metric.extent);
  assert.equal(scrollThumb(720, 720, 4, 4).extent, 0);
  assert.equal(scrollThumb(20, 10000, 32, 14).travel, 0);
});

test("the handle stays a short mark however little the content overflows", () => {
  const barely = scrollThumb(720, 800, 2, 2);
  assert.equal(barely.length, 72);
  assert.equal(barely.travel, 720 - 4 - 72);
  assert.equal(scrollThumb(720, 3000, 2, 2, 28).length, 72);
  assert.equal(scrollThumb(720, 30000, 2, 2, 28).length, 28);
  // A rail shorter than the smallest handle is filled, never overrun.
  assert.equal(scrollThumb(20, 400, 2, 2, 28).length, 16);
});
