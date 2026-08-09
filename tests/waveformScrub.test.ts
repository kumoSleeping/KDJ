import assert from "node:assert/strict";
import test from "node:test";
import { waveformScrubPosition } from "../src/lib/waveformScrub";

test("waveform pointer movement maps across the full media duration", () => {
  assert.equal(waveformScrubPosition(100, 100, 800, 1_850), 0);
  assert.equal(waveformScrubPosition(500, 100, 800, 1_850), 925);
  assert.equal(waveformScrubPosition(900, 100, 800, 1_850), 1_850);
});

test("waveform pointer movement remains clamped outside the track", () => {
  assert.equal(waveformScrubPosition(-200, 100, 800, 1_850), 0);
  assert.equal(waveformScrubPosition(1_200, 100, 800, 1_850), 1_850);
});

test("an unavailable track geometry cannot produce an invalid seek", () => {
  assert.equal(waveformScrubPosition(500, 100, 0, 1_850), 0);
  assert.equal(waveformScrubPosition(500, 100, 800, Number.NaN), 0);
});
