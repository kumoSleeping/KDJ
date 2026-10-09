import assert from "node:assert/strict";
import test from "node:test";
import { liveWaveformPhaseError, smoothlyCorrectedWaveformRate } from "../src/lib/waveformMotion";
import { waveformCoversViewport } from "../src/lib/waveformViewport";
import type { Waveform } from "../src/types";

function wave(start: number, end: number, amplitude: number): Waveform {
  const count = Math.round((end - start) * 400);
  return { track_id: 42, duration: 180, source_start: start, source_end: end,
    amp: new Float32Array(count).fill(amplitude), minimum: new Float32Array(count).fill(-amplitude),
    maximum: new Float32Array(count).fill(amplitude), r: new Uint8Array(count).fill(amplitude * 200),
    g: new Uint8Array(count).fill(70), b: new Uint8Array(count).fill(90), transient: new Uint8Array(count) };
}

test("bridge jitter never reverses a playing rail and converges without a position assignment", () => {
  let visual = 0, authority = .18;
  for (let i = 0; i < 1000; i++) {
    const noisy = authority + (i % 2 ? .012 : -.012);
    const rate = smoothlyCorrectedWaveformRate(1, liveWaveformPhaseError(noisy, visual, null));
    assert.ok(rate >= .95 && rate <= 1.05);
    const next = visual + rate * .1;
    assert.ok(next > visual);
    visual = next; authority += .1;
  }
  assert.ok(Math.abs(visual - authority) < .02);
  assert.equal(smoothlyCorrectedWaveformRate(0, 10), 0);
  assert.ok(smoothlyCorrectedWaveformRate(-1, .4) < 0);
  assert.ok(smoothlyCorrectedWaveformRate(1, -10) > 0);
  assert.equal(smoothlyCorrectedWaveformRate(1, NaN), 1);
});
