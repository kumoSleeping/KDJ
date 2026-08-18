import assert from "node:assert/strict";
import test from "node:test";
import {
  performanceVisualClockPosition,
  updatePerformanceVisualClock,
  type PerformanceVisualClockSample,
} from "../src/lib/performanceVisualClock";

const playing: PerformanceVisualClockSample = {
  trackId: 7,
  position: 10,
  duration: 180,
  rate: 1,
  playing: true,
  interactive: false,
  snap: false,
};

test("visual transport advances at display timestamps between sparse native samples", () => {
  const state = updatePerformanceVisualClock(null, playing, 1_000);
  assert.equal(performanceVisualClockPosition(state, 1_000), 10);
  assert.equal(performanceVisualClockPosition(state, 1_008), 10.008);
  assert.equal(performanceVisualClockPosition(state, 1_100), 10.1);
});

test("tiny backwards authority correction changes velocity without a backwards frame", () => {
  const first = updatePerformanceVisualClock(null, playing, 1_000);
  const before = performanceVisualClockPosition(first, 1_100);
  const corrected = updatePerformanceVisualClock(first, { ...playing, position: 10.08 }, 1_100);
  assert.equal(performanceVisualClockPosition(corrected, 1_100), before);
  assert.ok(performanceVisualClockPosition(corrected, 1_116) > before);
  assert.ok(corrected.correctionRate < 0);
  assert.ok(Math.abs(corrected.correctionRate) < 0.002);
});

test("native phase jitter cannot modulate visual velocity like a ten-hertz sawtooth", () => {
  let state = updatePerformanceVisualClock(null, playing, 0);
  let priorCorrection = state.correctionRate;
  for (let tick = 1; tick <= 40; tick += 1) {
    const at = tick * 100;
    const jitter = tick % 2 === 0 ? 0.025 : -0.025;
    state = updatePerformanceVisualClock(state, {
      ...playing,
      position: 10 + tick * 0.1 + jitter,
    }, at);
    assert.ok(Math.abs(state.correctionRate) <= 0.025);
    assert.ok(Math.abs(state.correctionRate - priorCorrection) < 0.008);
    priorCorrection = state.correctionRate;
  }
});

test("loop wraps and explicit seek landings snap to their authoritative position", () => {
  const first = updatePerformanceVisualClock(null, { ...playing, position: 40 }, 1_000);
  const looped = updatePerformanceVisualClock(first, { ...playing, position: 12 }, 1_100);
  assert.equal(performanceVisualClockPosition(looped, 1_100), 12);

  const seeked = updatePerformanceVisualClock(looped, { ...playing, position: 70, snap: true }, 1_200);
  assert.equal(performanceVisualClockPosition(seeked, 1_200), 70);
});

test("an active loop wraps on the display frame without waiting for the next native sample", () => {
  const state = updatePerformanceVisualClock(null, {
    ...playing,
    position: 11.95,
    loopStart: 8,
    loopLength: 4,
  }, 1_000);
  assert.ok(Math.abs(performanceVisualClockPosition(state, 1_040) - 11.99) < 1e-9);
  assert.ok(Math.abs(performanceVisualClockPosition(state, 1_060) - 8.01) < 1e-9);

  const afterAuthorityWrap = updatePerformanceVisualClock(state, {
    ...playing,
    position: 8.04,
    loopStart: 8,
    loopLength: 4,
  }, 1_100);
  assert.ok(performanceVisualClockPosition(afterAuthorityWrap, 1_100) < 8.1);
});

test("pause, scratch, track switch, rate, and duration boundaries stay authoritative", () => {
  const first = updatePerformanceVisualClock(null, playing, 1_000);
  const paused = updatePerformanceVisualClock(first, { ...playing, position: 10.05, playing: false }, 1_100);
  assert.equal(performanceVisualClockPosition(paused, 5_000), 10.05);

  const scratched = updatePerformanceVisualClock(paused, { ...playing, position: 4, interactive: true }, 5_000);
  assert.equal(performanceVisualClockPosition(scratched, 5_100), 4);

  const switched = updatePerformanceVisualClock(scratched, { ...playing, trackId: 8, position: 179.9, rate: 2 }, 6_000);
  assert.equal(performanceVisualClockPosition(switched, 7_000), 180);
});

test("ten-hertz jitter corrections remain monotonic across display-rate frames", () => {
  let state = updatePerformanceVisualClock(null, playing, 0);
  let last = performanceVisualClockPosition(state, 0);
  for (let tick = 1; tick <= 100; tick += 1) {
    const sampleAt = tick * 100;
    const jitter = tick % 4 === 0 ? -0.025 : tick % 5 === 0 ? 0.018 : 0;
    state = updatePerformanceVisualClock(
      state,
      { ...playing, position: 10 + tick * 0.1 + jitter },
      sampleAt,
    );
    for (let frameAt = sampleAt; frameAt < sampleAt + 100; frameAt += 8.333) {
      const current = performanceVisualClockPosition(state, frameAt);
      assert.ok(current >= last, `clock reversed at native tick ${tick}`);
      last = current;
    }
  }
});
