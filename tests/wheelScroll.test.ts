import assert from "node:assert/strict";
import test from "node:test";
import { wheelPixels } from "../src/lib/wheelScroll";

test("wheel deltas convert line and page modes and Shift turns a vertical wheel sideways", () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -40, deltaMode: 0, shiftKey: false }, 36, 800, 600), { x: 3, y: -40 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, 36, 800, 600), { x: 0, y: 108 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2, shiftKey: false }, 36, 800, 600), { x: 0, y: -600 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 120, y: 0 });
  assert.deepEqual(wheelPixels({ deltaX: 5, deltaY: 120, deltaMode: 0, shiftKey: true }, 36, 800, 600), { x: 5, y: 120 });
});
