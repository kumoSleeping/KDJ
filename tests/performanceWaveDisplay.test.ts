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

test("the original reference rail is mandatory and vocals are the only optional lane", () => {
  assert.equal(normalizePerformanceWaveMask(0), ORIGINAL_WAVE_BIT);
  assert.equal(normalizePerformanceWaveMask(STEM_LANE_BITS), ORIGINAL_WAVE_BIT | STEM_LANE_BITS);
  assert.equal(normalizePerformanceWaveMask(ORIGINAL_WAVE_BIT | 8), 24);
});

test("shared mask migrates old settings while removing non-vocal STEM lanes", () => {
  assert.equal(normalizePerformanceWaveMask([0, 31]), ORIGINAL_WAVE_BIT);
  assert.equal(normalizePerformanceWaveMask([STEM_LANE_BITS, 0]), ORIGINAL_WAVE_BIT | STEM_LANE_BITS);
  assert.equal(normalizePerformanceWaveMask([255, "bad"]), ORIGINAL_WAVE_BIT | STEM_LANE_BITS);
  assert.equal(normalizePerformanceWaveMask(null), DEFAULT_PERFORMANCE_WAVE_MASK);
  assert.equal(DEFAULT_PERFORMANCE_WAVE_MASK, ORIGINAL_WAVE_BIT);
});
