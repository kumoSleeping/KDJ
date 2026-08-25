import assert from "node:assert/strict";
import test from "node:test";
import { knobBias, snapKnobToCenter } from "../src/lib/stemDeckLog";

test("knobBias keeps the software centre detent", () => {
  assert.equal(knobBias(0.01, -1, 1), null);
  assert.equal(knobBias(0.011, -1, 1), "boost");
  assert.equal(snapKnobToCenter(-0.008, -1, 1), 0);
});
