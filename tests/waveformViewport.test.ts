import assert from "node:assert/strict";
import test from "node:test";
import {
  detailWaveformBuckets,
  overviewWaveformFromDetail,
  performanceWaveformViewportSeconds,
  projectedWaveformPosition,
  shouldAnimateWaveformRail,
  stabilizedWaveformPosition,
  waveformBakeTranslatePercent,
  waveformBakeWindow,
  waveformBakeRangeChanged,
  waveformPointerSeconds,
  waveformViewportLayout,
} from "../src/lib/waveformViewport";

test("DJ canvas bakes three screens and reuses the window while the playhead stays inside", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  assert.equal(first.widthScale, 3);
  assert.equal(first.translatePercent, 50);
  assert.ok(Math.abs(first.endSec - first.startSec - 90) < 1e-9);

  const inside = waveformBakeWindow(180, 91, 12, first);
  assert.equal(inside.startSec, first.startSec);
  assert.ok(inside.translatePercent > first.translatePercent);

  const jumped = waveformBakeWindow(180, 140, 12, inside);
  assert.notEqual(jumped.startSec, first.startSec);
  assert.equal(jumped.translatePercent, 50);
});

test("a rebaked DJ canvas is distinguished from ordinary rail movement", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  // The 2.4s guard lets the 90s canvas reach 90% before it is replaced.
  const moved = waveformBakeWindow(180, 126, 12, first);
  const rebaked = waveformBakeWindow(180, 127, 12, moved);

  assert.equal(waveformBakeRangeChanged(first, moved), false);
  assert.equal(waveformBakeRangeChanged(moved, rebaked), true);
  // The new PCM pixels are centered at 50%; interpolating from `moved` would travel almost a
  // screen width and recreate the visible large-range migration regression.
  assert.equal(rebaked.translatePercent, 50);
  assert.ok(moved.translatePercent > 80);
});

test("a rebased canvas can land on raw time before starting its projected runway", () => {
  const rebased = waveformBakeWindow(180, 102, 12, null);
  assert.equal(waveformBakeTranslatePercent(rebased, 102), 50);
  assert.ok(waveformBakeTranslatePercent(rebased, 102.24) > 50);
});

test("TEMPO / SYNC zoom reuses the baked canvas instead of redrawing PCM", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  const halfTime = waveformBakeWindow(180, 90.05, 6, first);
  const doubleTime = waveformBakeWindow(180, 90.05, 24, first);
  assert.equal(halfTime.startSec, first.startSec);
  assert.equal(halfTime.endSec, first.endSec);
  assert.equal(doubleTime.startSec, first.startSec);
  assert.equal(doubleTime.endSec, first.endSec);
});

test("DJ viewport keeps the playhead centered while the rail moves", () => {
  const start = waveformViewportLayout(180, 0, 18);
  const middle = waveformViewportLayout(180, 90, 18);
  const end = waveformViewportLayout(180, 180, 18);

  assert.equal(start.playheadPercent, 50);
  assert.equal(middle.playheadPercent, 50);
  assert.equal(end.playheadPercent, 50);
  assert.equal(start.railTranslatePercent, 0);
  assert.equal(middle.railTranslatePercent, 50);
  assert.equal(end.railTranslatePercent, 100);
});

test("DJ viewport preserves blank lead-in and tail instead of moving the playhead", () => {
  const start = waveformViewportLayout(180, 0, 18);
  const end = waveformViewportLayout(180, 180, 18);

  assert.ok(start.viewStartSec < 0);
  assert.ok(end.viewEndSec > 180);
});

test("invalid viewport falls back to the original full-track playhead", () => {
  const layout = waveformViewportLayout(200, 50, null);

  assert.equal(layout.active, false);
  assert.equal(layout.railScale, 1);
  assert.equal(layout.playheadPercent, 25);
});

test("a click on a centered DJ rail maps onto the time under the pointer", () => {
  const duration = 180;
  const position = 60;
  const viewport = 12;
  const width = 1_200;
  assert.equal(waveformPointerSeconds(600, 0, width, duration, position, viewport), 60);
  assert.equal(waveformPointerSeconds(0, 0, width, duration, position, viewport), 54);
  assert.equal(waveformPointerSeconds(1_200, 0, width, duration, position, viewport), 66);
});

test("overview waveforms still map a click across the whole track", () => {
  assert.equal(waveformPointerSeconds(250, 0, 1_000, 200, 40, null), 50);
});

test("long tracks preserve the requested viewport instead of changing scroll speed", () => {
  const layout = waveformViewportLayout(3_600, 1_800, 12);

  assert.equal(layout.railScale, 300);
  assert.equal(layout.viewEndSec - layout.viewStartSec, 12);
  assert.equal(layout.playheadPercent, 50);
});

test("Performance tempo changes resize beat cells while preserving screen speed", () => {
  const rates = [0.5, 1, 1.25, 2];
  const screenSpeeds = rates.map((rate) =>
    rate / performanceWaveformViewportSeconds(rate),
  );

  assert.deepEqual(
    rates.map(performanceWaveformViewportSeconds),
    [15, 30, 37.5, 60],
  );
  assert.ok(screenSpeeds.every((speed) => Math.abs(speed - 1 / 30) < 1e-12));
  // 同一曲目的源拍间隔不变；升速后每一拍占据的屏幕宽度应按倍率缩短。
  const beatSeconds = 60 / 120;
  const normalBeatWidth = beatSeconds / performanceWaveformViewportSeconds(1);
  const fastBeatWidth = beatSeconds / performanceWaveformViewportSeconds(1.25);
  assert.ok(fastBeatWidth < normalBeatWidth);

  const slowTrackBeatWidth = (60 / 100) / performanceWaveformViewportSeconds(1);
  const fastTrackBeatWidth = (60 / 160) / performanceWaveformViewportSeconds(1);
  assert.ok(slowTrackBeatWidth > fastTrackBeatWidth);
});

test("DJ detail keeps one hundred real envelope columns per second", () => {
  assert.equal(detailWaveformBuckets(0), 2_000);
  assert.equal(detailWaveformBuckets(180), 18_000);
  assert.equal(detailWaveformBuckets(600), 24_000);
});

test("full-track overview averages dense peaks instead of becoming a solid wall", () => {
  const overview = overviewWaveformFromDetail({
    track_id: 7,
    duration: 4,
    amp: [1, 0, 1, 0, 0.8, 0.2, 0.8, 0.2],
    r: [255, 255, 255, 255, 32, 32, 32, 32],
    g: [32, 32, 32, 32, 255, 255, 255, 255],
    b: [32, 32, 32, 32, 32, 32, 32, 32],
  }, 2);

  assert.deepEqual(overview.amp, [0.5, 0.5]);
  assert.equal(overview.r[0], 255);
  assert.equal(overview.g[1], 255);
});

test("same-track clock samples keep rail smoothing through pause intent", () => {
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 10.2), true);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10.2, 10.2), true);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10.2, 10.28), true);
});

test("playing rails project sparse native samples across a delayed compositor edge", () => {
  assert.ok(Math.abs(projectedWaveformPosition(10, 180, 1) - 10.24) < 1e-12);
  assert.ok(Math.abs(projectedWaveformPosition(10, 180, 1.25) - 10.3) < 1e-12);
  assert.equal(projectedWaveformPosition(179.9, 180, 1), 180);
  assert.equal(projectedWaveformPosition(10, 180, 1, 0), 10);
});

test("forward playback suppresses only tiny backwards decoder-clock corrections", () => {
  assert.equal(stabilizedWaveformPosition(10, 9.96, true), 10);
  assert.equal(stabilizedWaveformPosition(10, 9.8, true), 9.8);
  assert.equal(stabilizedWaveformPosition(10, 9.96, false), 9.96);
  assert.equal(stabilizedWaveformPosition(null, 9.96, true), 9.96);
});

test("TEMPO zoom scales around the playhead without changing the translating rail", () => {
  const normal = waveformViewportLayout(180, 90, 30);
  const fast = waveformViewportLayout(180, 90, 37.5);

  assert.equal(normal.baseRailScale, 6);
  assert.equal(fast.baseRailScale, 6);
  assert.equal(normal.railTranslatePercent, 50);
  assert.equal(fast.railTranslatePercent, 50);
  assert.equal(normal.tempoScaleX, 1);
  assert.ok(Math.abs(fast.tempoScaleX - 30 / 37.5) < 1e-12);
  assert.ok(Math.abs(fast.baseRailScale * fast.tempoScaleX - fast.railScale) < 1e-12);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 10.1), true);
});

test("rail smoothing snaps on seek, rewind, track switch, and inactive viewport", () => {
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 12), false);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 9.9), false);
  assert.equal(shouldAnimateWaveformRail(true, 6, 7, 10, 10.1), false);
  assert.equal(shouldAnimateWaveformRail(false, 7, 7, 10, 10.1), false);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, null, 10.1), false);
});

test("a held platter interpolates small reverse motion instead of stepping or snapping", () => {
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 9.96, undefined, true), true);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 8.5, undefined, true), false);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 7, 8, true), true);
  assert.equal(shouldAnimateWaveformRail(true, 7, 7, 10, 9.96), false);
});
