import assert from "node:assert/strict";
import test from "node:test";

import {
  performanceWaveformAmplitudeScale,
  waveformEdgeScales,
  waveformUsesReleaseOverviewPalette,
} from "../src/lib/waveformRenderPolicy";
import { drawWaveformCanvas } from "../src/components/library/WaveformCanvas";

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

test("edge envelopes can reuse a numeric buffer for live Canvas redraws", () => {
  const output = new Float64Array(5);
  const result = waveformEdgeScales(
    new Float64Array([0, 1, 0.8, 0.7, 0]),
    new Uint8Array([0, 1, 1, 1, 0]),
    2,
    0.02,
    output,
  );

  assert.equal(result, output);
  assert.ok(result[1] < result[2]);
  assert.ok(result[3] < result[2]);
  assert.throws(
    () => waveformEdgeScales([1], [true], 2, 0.02, new Float64Array(2)),
    /buffer length/,
  );
});

test("the requested surface profile alone owns the waveform palette", () => {
  assert.equal(waveformUsesReleaseOverviewPalette("release-overview"), true);
  assert.equal(waveformUsesReleaseOverviewPalette("current"), false);
});

test("performance waveform headroom follows the mixer trim in real time", () => {
  assert.equal(performanceWaveformAmplitudeScale(0), 0.7);
  assert.ok(Math.abs(performanceWaveformAmplitudeScale(0.5) - 0.98878) < 0.00001);
  assert.ok(Math.abs(performanceWaveformAmplitudeScale(-1) - 0.04417) < 0.00001);
  assert.equal(performanceWaveformAmplitudeScale(1), 1, "boosted peaks clip at the rail edge");
  assert.equal(performanceWaveformAmplitudeScale(Number.NaN), 0.7);
});

test("historical overview keeps hard energy columns while using backing-store resolution", () => {
  const fakeCanvas = () => {
    const calls = {
      bezier: 0,
      fill: 0,
      fillRect: 0,
      rectAmplitudes: [] as number[],
      stroke: 0,
    };
    const context = {
      beginPath() {},
      bezierCurveTo() { calls.bezier += 1; },
      clearRect() {},
      fill() { calls.fill += 1; },
      fillRect(_x: number, _y: number, _width: number, height: number) {
        calls.fillRect += 1;
        calls.rectAmplitudes.push(height / 40);
      },
      restore() {},
      save() {},
      setTransform() {},
      stroke() { calls.stroke += 1; },
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    return { calls, canvas };
  };
  const wave = {
    track_id: 1,
    duration: 8,
    amp: [0.1, 0.35, 0.8, 0.45, 0.65, 1, 0.5, 0.2],
    r: [255, 220, 80, 45, 31, 70, 180, 255],
    g: [31, 90, 255, 180, 70, 31, 120, 60],
    b: [45, 31, 80, 255, 255, 210, 31, 90],
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { devicePixelRatio: 1 },
  });
  try {
    const overview = fakeCanvas();
    drawWaveformCanvas(
      overview.canvas,
      wave,
      64,
      42,
      undefined,
      null,
      null,
      "release-overview",
    );
    assert.equal(overview.calls.fillRect, 64, "every backing-store position should stay a column");
    assert.equal(overview.calls.fill, 0, "overview must not become a rounded filled polygon");
    assert.equal(overview.calls.stroke, 0, "overview must have no outline or synthetic strands");
    assert.equal(overview.calls.bezier, 0, "de-pixelation must not smooth the amplitude shape");
    assert.ok(
      overview.calls.rectAmplitudes.every((amplitude) =>
        wave.amp.some((source) => Math.abs(source - amplitude) < 1e-6)
      ),
      "Retina upsampling must repeat real buckets rather than interpolate away sharp peaks",
    );

    const quiet = fakeCanvas();
    drawWaveformCanvas(
      quiet.canvas,
      { ...wave, amp: Array(64).fill(0.001), r: Array(64).fill(80), g: Array(64).fill(180), b: Array(64).fill(255) },
      16,
      42,
      undefined,
      null,
      null,
      "release-overview",
    );
    assert.equal(quiet.calls.fillRect, 16, "known quiet intervals must not disappear");
    assert.ok(
      quiet.calls.rectAmplitudes.every((amplitude) => Math.abs(amplitude - 0.025) < 1e-6),
      "quiet overview columns retain a one-CSS-pixel centre line",
    );

    const unknown = fakeCanvas();
    const unknownWave = {
      ...wave,
      known: new Uint8Array(wave.amp.length),
    };
    drawWaveformCanvas(
      unknown.canvas,
      unknownWave,
      16,
      42,
      unknownWave.known,
      null,
      null,
      "performance-detail",
    );
    assert.equal(
      unknown.calls.fillRect,
      0,
      "unavailable progressive columns stay empty instead of forming a centre rail",
    );

    const isolated = fakeCanvas();
    const isolatedAmp = Array(64).fill(0.4);
    isolatedAmp[30] = 1;
    drawWaveformCanvas(
      isolated.canvas,
      { ...wave, amp: isolatedAmp, r: Array(64).fill(255), g: Array(64).fill(80), b: Array(64).fill(40) },
      16,
      42,
      undefined,
      null,
      null,
      "release-overview",
    );
    assert.equal(isolated.calls.rectAmplitudes.length, 16);
    assert.ok(
      Math.abs(isolated.calls.rectAmplitudes[7] - 0.4) < 1e-6,
      "a one-sample outlier should not replace its logical-pixel interval",
    );

    const sustained = fakeCanvas();
    const sustainedAmp = Array(64).fill(0.4);
    sustainedAmp.fill(1, 28, 32);
    drawWaveformCanvas(
      sustained.canvas,
      { ...wave, amp: sustainedAmp, r: Array(64).fill(255), g: Array(64).fill(80), b: Array(64).fill(40) },
      16,
      42,
      undefined,
      null,
      null,
      "release-overview",
    );
    assert.ok(
      Math.abs(sustained.calls.rectAmplitudes[7] - 1) < 1e-6,
      "a feature sustained across the visible interval must remain full height",
    );

    const hardEdge = fakeCanvas();
    const steppedAmp = Array.from({ length: 64 }, (_, index) => index < 32 ? 0.2 : 0.8);
    drawWaveformCanvas(
      hardEdge.canvas,
      { ...wave, amp: steppedAmp, r: Array(64).fill(40), g: Array(64).fill(80), b: Array(64).fill(255) },
      16,
      42,
      undefined,
      null,
      null,
      "release-overview",
    );
    assert.ok(Math.abs(hardEdge.calls.rectAmplitudes[7] - 0.2) < 1e-6);
    assert.ok(
      Math.abs(hardEdge.calls.rectAmplitudes[8] - 0.8) < 1e-6,
      "independent preview intervals must not fit a hard edge into intermediate heights",
    );

    const detail = fakeCanvas();
    drawWaveformCanvas(
      detail.canvas,
      { ...wave, amp: isolatedAmp },
      16,
      42,
      undefined,
      null,
      null,
      "performance-detail",
    );
    assert.equal(detail.calls.stroke, 0, "DJ detail remains a hard-column renderer");
    assert.ok(detail.calls.fillRect > 0, "DJ detail still paints its dense screen columns");
    assert.ok(
      Math.abs(detail.calls.rectAmplitudes[7] - 1) < 1e-6,
      "detail must preserve a transient that macro overview intentionally rejects",
    );

    (globalThis.window as { devicePixelRatio: number }).devicePixelRatio = 2;
    const retinaDetail = fakeCanvas();
    drawWaveformCanvas(
      retinaDetail.canvas,
      { ...wave, amp: isolatedAmp },
      16,
      42,
      undefined,
      null,
      null,
      "performance-detail",
    );
    assert.equal(
      retinaDetail.calls.fillRect,
      32,
      "a moving DJ rail must retain one rendered column per physical pixel",
    );
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
