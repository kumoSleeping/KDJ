import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERFORMANCE_WAVE_MASK,
  normalizePerformanceWaveMask,
  ORIGINAL_WAVE_BIT,
  STEM_LANE_BITS,
  performanceStemLanesVisible,
} from "../src/lib/performanceWaveDisplay";

test("visible STEM lanes are display-only and the safe default is the original rail", () => {
  assert.equal(performanceStemLanesVisible(DEFAULT_PERFORMANCE_WAVE_MASK), false);
  assert.equal(performanceStemLanesVisible(ORIGINAL_WAVE_BIT), false);
  assert.equal(performanceStemLanesVisible(0), false);
  assert.equal(performanceStemLanesVisible(STEM_LANE_BITS), true);
});

test("the original reference rail can be hidden independently from STEM lanes", () => {
  assert.equal(normalizePerformanceWaveMask(0), 0);
  assert.equal(normalizePerformanceWaveMask(STEM_LANE_BITS), STEM_LANE_BITS);
  assert.equal(normalizePerformanceWaveMask(ORIGINAL_WAVE_BIT | 8), 24);
});

test("shared mask migrates the old A-side setting, removes unknown bits, and defaults to original", () => {
  assert.equal(normalizePerformanceWaveMask([0, 31]), 0);
  assert.equal(normalizePerformanceWaveMask([STEM_LANE_BITS, 0]), STEM_LANE_BITS);
  assert.equal(normalizePerformanceWaveMask([255, "bad"]), 31);
  assert.equal(normalizePerformanceWaveMask(null), DEFAULT_PERFORMANCE_WAVE_MASK);
  assert.equal(DEFAULT_PERFORMANCE_WAVE_MASK, ORIGINAL_WAVE_BIT);
});
