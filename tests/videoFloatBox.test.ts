import assert from "node:assert/strict";
import test from "node:test";
import {
  clampVideoFloatBox,
  maxVideoFloatWidth,
  videoFloatHeight,
} from "../src/lib/videoFloatBox";

test("floating video can grow past the former 720px ceiling", () => {
  const box = clampVideoFloatBox({ x: 20, y: 20, w: 1200 }, 1360, 880);

  assert.equal(box.w, 1200);
  assert.equal(videoFloatHeight(box.w), 675);
});

test("floating video grows only to the largest 16:9 box in the viewport", () => {
  const box = clampVideoFloatBox({ x: 400, y: 300, w: 3000 }, 1360, 880);

  assert.equal(box.w, 1344);
  assert.equal(box.x, 8);
  assert.equal(box.y, 116);
  assert.equal(box.y + videoFloatHeight(box.w), 872);
});

test("viewport height limits the maximum width when it is the tighter edge", () => {
  const maximum = maxVideoFloatWidth(800, 400);
  const box = clampVideoFloatBox({ x: -100, y: 999, w: 2000 }, 800, 400);

  assert.equal(maximum, (384 * 16) / 9);
  assert.equal(box.w, maximum);
  assert.equal(box.x, 8);
  assert.equal(box.y, 8);
  assert.equal(videoFloatHeight(box.w), 384);
});

test("a previously large box shrinks and returns on-screen with the app window", () => {
  const box = clampVideoFloatBox({ x: 900, y: 600, w: 1100 }, 720, 520);

  assert.ok(box.w <= 704);
  assert.ok(box.x >= 8);
  assert.ok(box.y >= 8);
  assert.ok(box.x + box.w <= 712);
  assert.ok(box.y + videoFloatHeight(box.w) <= 512);
});
