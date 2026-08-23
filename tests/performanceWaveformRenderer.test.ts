import assert from "node:assert/strict";
import test from "node:test";
import {
  packPerformanceWaveformTexture,
  performanceOverlayStrokeX,
  performanceWaveformMotionSeconds,
} from "../src/lib/performanceWaveformRenderer";
import { waveformDisplayRgb } from "../src/lib/waveformPalette";

test("GPU waveform packing preserves RGBA amplitude and unknown-column masks", () => {
  const packed = packPerformanceWaveformTexture({
    track_id: 7,
    duration: 1,
    amp: [0, 0.5, 1],
    r: [1, 2, 300],
    g: [3, 4, 5],
    b: [6, 7, 8],
    known: [true, false, true],
  }, 8);
  assert.deepEqual([packed.width, packed.height, packed.count], [3, 1, 3]);
  assert.deepEqual([...packed.knownBytes], [255, 0, 255]);
  const first = waveformDisplayRgb(1, 3, 6, 0);
  const second = waveformDisplayRgb(2, 4, 7, 0.5);
  const third = waveformDisplayRgb(300, 5, 8, 1);
  assert.deepEqual([...packed.colorBytes.slice(0, 12)], [
    ...first, 0,
    ...second, 128,
    ...third, 255,
  ]);
});

test("waveforms longer than a device texture row are packed without truncation", () => {
  const packed = packPerformanceWaveformTexture({
    track_id: 8,
    duration: 5,
    amp: [0, 0.1, 0.2, 0.3, 0.4],
    r: [1, 2, 3, 4, 5],
    g: [1, 2, 3, 4, 5],
    b: [1, 2, 3, 4, 5],
  }, 2);
  assert.deepEqual([packed.width, packed.height, packed.count], [2, 3, 5]);
  assert.equal(packed.knownBytes[4], 255);
  assert.equal(packed.knownBytes[5], 0);
});

test("moving grid lines retain Retina sub-CSS-pixel positions without coarse stepping", () => {
  assert.equal(performanceOverlayStrokeX(10.24, 2), 10.25);
  assert.equal(performanceOverlayStrokeX(10.49, 2), 10.5);
  const positions = Array.from({ length: 20 }, (_, frame) =>
    performanceOverlayStrokeX(100 - frame * (100 / 60), 2)
  );
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] <= positions[index - 1]);
    assert.ok(positions[index - 1] - positions[index] < 2);
  }
});

test("ordinary display frames get a bounded shutter trail without delaying the current clock", () => {
  const motion = performanceWaveformMotionSeconds(10, 10 + 1 / 60, 12, 2_400, true);
  // 1/60 second is 3.33 physical pixels in this viewport; expose 75% of that travel.
  assert.ok(Math.abs(motion - 0.0125) < 1e-9);

  const capped = performanceWaveformMotionSeconds(10, 10.04, 12, 2_400, true);
  assert.ok(Math.abs(capped - 0.02) < 1e-9);
  assert.equal(performanceWaveformMotionSeconds(10, 10.2, 12, 2_400, true), 0);
});

test("first frames and discrete transport movement never receive a visual trail", () => {
  assert.equal(performanceWaveformMotionSeconds(null, 10, 12, 2_400, true), 0);
  assert.equal(performanceWaveformMotionSeconds(10, 10.02, 12, 2_400, false), 0);
  assert.equal(performanceWaveformMotionSeconds(11.99, 8.01, 12, 2_400, true), 0);
});
