import assert from "node:assert/strict";
import test from "node:test";

import { waveformEdgeScales, waveformPlaceholderSampleIndex } from "../src/lib/waveformRenderPolicy";

test("progressive waveform tapers only its first and last audible screen columns", () => {
  const amplitudes = [0, 0, 1, 0.8, 0.6, 0.7, 0.9, 0, 0];
  const scales = waveformEdgeScales(amplitudes, amplitudes.map(() => true), 2);

  assert.ok(scales[2] < scales[3], "opening wall should rise over several pixels");
  assert.equal(scales[4], 1, "internal waveform transients stay untouched");
  assert.ok(scales[6] < scales[5], "closing wall should fall over several pixels");
  assert.deepEqual(scales.slice(0, 2), [1, 1], "silence remains a truthful baseline");
});

test("unknown buckets remain outside the audible-edge calculation", () => {
  const scales = waveformEdgeScales(
    [1, 1, 0.9, 0.8, 1, 1],
    [false, false, true, true, false, false],
    4,
  );

  assert.deepEqual(scales.slice(0, 2), [1, 1]);
  assert.deepEqual(scales.slice(4), [1, 1]);
  assert.ok(scales[2] < 1 && scales[3] < 1);
});

test("a single newly sampled bucket stays visible", () => {
  assert.deepEqual(waveformEdgeScales([0, 1, 0], [false, true, false]), [1, 1, 1]);
});

test("a centered DJ window never projects its placeholder into lead-in or tail blank space", () => {
  // This is the three-screen canvas at the beginning of a track: -16…0 is
  // intentionally blank, then the 0…20s source window begins.
  assert.equal(waveformPlaceholderSampleIndex(0, 360, 640, 217, -16, 20), null);
  assert.equal(waveformPlaceholderSampleIndex(159, 360, 640, 217, -16, 20), null);

  const firstTrackSample = waveformPlaceholderSampleIndex(160, 360, 640, 217, -16, 20);
  assert.ok(firstTrackSample !== null && firstTrackSample >= 0 && firstTrackSample < 2);

  // The tail behaves symmetrically: no overview sample may leak into it.
  assert.equal(waveformPlaceholderSampleIndex(359, 360, 640, 217, 197, 233), null);
});
