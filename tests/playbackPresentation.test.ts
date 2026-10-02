import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackWaveformAtlas, stabilizePlaybackWaveformWindow, playbackWaveformContiguousAtlasWindow, playbackWaveformFirstPaintSeconds, playbackWaveformRequestCenter } from "../src/lib/playbackWaveform";
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

test("first paint fits six-second head runway and leaves time for mid-song responses", () => {
  for (const position of [0, 1, 2.5, 3, 30, 90, 179]) {
    const seconds = playbackWaveformFirstPaintSeconds(position, 6);
    const center = playbackWaveformRequestCenter(position, 180, 6, seconds, 1);
    const response = wave(Math.max(0, center - seconds / 2), Math.min(180, center + seconds / 2), .4);
    assert.ok(waveformCoversViewport(response, 42, position, 6));
    assert.ok(waveformCoversViewport(response, 42, Math.min(180, position + .2), 6));
    assert.ok(seconds <= 7);
    if (position === 0) assert.equal(response.source_end, 6);
  }
});

test("renewals and global detail cannot recolor or resize previously visible waveform columns", () => {
  const atlas = createPlaybackWaveformAtlas(42);
  stabilizePlaybackWaveformWindow(atlas, wave(0, 6, .25));
  const before = playbackWaveformContiguousAtlasWindow(atlas, 3, 6, 3, 6)!;
  stabilizePlaybackWaveformWindow(atlas, wave(4, 12, .9));
  stabilizePlaybackWaveformWindow(atlas, wave(0, 180, .7));
  const after = playbackWaveformContiguousAtlasWindow(atlas, 3, 6, 3, 6)!;
  for (const key of ["amp", "minimum", "maximum", "r", "g", "b", "transient"] as const) assert.deepEqual(after[key], before[key]);
  const revisit = playbackWaveformContiguousAtlasWindow(atlas, 7, 6, 7, 6)!;
  assert.ok(waveformCoversViewport(revisit, 42, 7, 6));
});

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
