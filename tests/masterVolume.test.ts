import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMasterVolume, useMasterVolume } from "../src/lib/masterVolume";

test("master volume clamps every media output to the same safe range", () => {
  assert.equal(normalizeMasterVolume(-1), 0);
  assert.equal(normalizeMasterVolume(0.42), 0.42);
  assert.equal(normalizeMasterVolume(2), 1);
  assert.equal(normalizeMasterVolume(Number.NaN), 0);

  useMasterVolume.getState().setVolume(0.35);
  assert.equal(useMasterVolume.getState().volume, 0.35);
  useMasterVolume.getState().setVolume(5);
  assert.equal(useMasterVolume.getState().volume, 1);
});
