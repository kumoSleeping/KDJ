import assert from "node:assert/strict";
import test from "node:test";
import {
  detailWaveformBuckets,
  overviewWaveformFromDetail,
  performanceWaveformViewportSeconds,
  managerWaveformRasterGeometry,
  managerWaveformViewportSeconds,
  managerWaveformRequestSeconds,
  projectedWaveformPosition,
  shouldAnimateWaveformRail,
  stabilizedWaveformPosition,
  waveformBakeTranslatePercent,
  waveformBakeWindow,
  waveformBakeRangeChanged,
  waveformPointerSeconds,
  waveformViewportLayout,
  beatMarkerRangePercent,
  waveformCoversViewport,
  waveformIntersectsViewport,
  waveformSourceRange,
  waveformWindowFromFullDetail,
  shouldWriteWaveformTransform,
} from "../src/lib/waveformViewport";
import {
  correctedLiveWaveformRate,
  liveWaveformAnimationTimeMs,
  liveWaveformLoopAnimationTimeMs,
  liveWaveformPhaseError,
  liveWaveformPlaybackRate,
  loopedWaveformPosition,
  projectedLiveWaveformPosition,
  projectedNativeWaveformPosition,
  shouldPauseLiveWaveformClock,
  shouldLandPlatterWaveform,
  updateWaveformMotionClock,
  waveformMotionClockPosition,
} from "../src/lib/waveformMotion";

test("DJ canvas bakes three screens and reuses the window while the playhead stays inside", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  assert.equal(first.widthScale, 3);
  assert.equal(first.translatePercent, 50);
  assert.ok(Math.abs(first.endSec - first.startSec - 36) < 1e-9);

  const inside = waveformBakeWindow(180, 91, 12, first);
  assert.equal(inside.startSec, first.startSec);
  assert.ok(inside.translatePercent > first.translatePercent);

  const jumped = waveformBakeWindow(180, 100, 12, inside);
  assert.notEqual(jumped.startSec, first.startSec);
  assert.equal(jumped.translatePercent, 50);
});

test("a rebaked DJ canvas is distinguished from ordinary rail movement", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  // The 2.4s guard lets the native 36s canvas approach its last screen before replacement.
  const moved = waveformBakeWindow(180, 99, 12, first);
  const rebaked = waveformBakeWindow(180, 100, 12, moved);

  assert.equal(waveformBakeRangeChanged(first, moved), false);
  assert.equal(waveformBakeRangeChanged(moved, rebaked), true);
  // The new PCM pixels are centered at 50%; interpolating from `moved` would travel almost a
  // screen width and recreate the visible large-range migration regression.
  assert.equal(rebaked.translatePercent, 50);
  assert.ok(moved.translatePercent > 70);
});

test("a rebased canvas can land on raw time before starting its projected runway", () => {
  const rebased = waveformBakeWindow(180, 102, 12, null);
  assert.equal(waveformBakeTranslatePercent(rebased, 102), 50);
  assert.ok(waveformBakeTranslatePercent(rebased, 102.24) > 50);
});

test("a native waveform always writes its initial transform before epsilon filtering", () => {
  assert.equal(shouldWriteWaveformTransform(Number.NaN, 50), true);
  assert.equal(shouldWriteWaveformTransform(50, 50), false);
  assert.equal(shouldWriteWaveformTransform(50, 50.001), true);
  assert.equal(shouldWriteWaveformTransform(50, Number.NaN), false);
});

test("a viewport scale change rebakes native PCM instead of stretching its bitmap", () => {
  const first = waveformBakeWindow(180, 90, 12, null);
  const halfTime = waveformBakeWindow(180, 90.05, 6, first);
  const doubleTime = waveformBakeWindow(180, 90.05, 24, first);
  assert.notEqual(halfTime.startSec, first.startSec);
  assert.equal(halfTime.endSec - halfTime.startSec, 18);
  assert.notEqual(doubleTime.startSec, first.startSec);
  assert.equal(doubleTime.endSec - doubleTime.startSec, 72);
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
  const preroll = waveformViewportLayout(180, -3, 18);
  const start = waveformViewportLayout(180, 0, 18);
  const end = waveformViewportLayout(180, 180, 18);

  assert.equal(preroll.playheadPercent, 50);
  assert.ok(preroll.railTranslatePercent < 0, "negative time moves frame 0 right of the needle");
  assert.equal(preroll.viewStartSec, -12);
  assert.ok(start.viewStartSec < 0);
  assert.ok(end.viewEndSec > 180);
});

test("preroll keeps bar 1 to the right of the needle instead of redrawing 1/2/3 under it", () => {
  const layout = waveformViewportLayout(275, -5, 30);
  assert.equal(layout.playheadPercent, 50);
  const needle = beatMarkerRangePercent(-5, layout.viewStartSec, layout.viewEndSec);
  const bar1 = beatMarkerRangePercent(0, layout.viewStartSec, layout.viewEndSec);
  assert.equal(needle, 50);
  assert.ok(bar1 > needle, "frame 0 sits after the playhead during silent lead-in");
  assert.ok(Math.abs(bar1 - (20 / 30) * 100) < 1e-6);
});

test("DJ canvas bakes negative lead-in from the start and does not lift the song to redraw it", () => {
  const atZero = waveformBakeWindow(180, 0, 30, null);
  assert.ok(atZero.startSec < 0, "the first bitmap already contains silent time before frame 0");
  assert.equal(atZero.translatePercent, 50);

  const reverse = waveformBakeWindow(180, -20, 30, atZero);
  assert.equal(reverse.startSec, atZero.startSec);
  assert.equal(reverse.endSec, atZero.endSec);
  assert.ok(reverse.translatePercent < atZero.translatePercent);

  const further = waveformBakeWindow(180, -40, 30, reverse);
  assert.equal(further.startSec, atZero.startSec, "further preroll only translates the same bitmap");
  assert.equal(further.endSec, atZero.endSec);
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

test("a click in silent lead-in maps onto negative time instead of clamping to zero", () => {
  assert.equal(waveformPointerSeconds(0, 0, 1_200, 180, 0, 12), -6);
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

test("Performance tempo changes velocity without changing the source-time zoom", () => {
  const rates = [0.5, 1, 1.25, 2];

  assert.deepEqual(
    rates.map(performanceWaveformViewportSeconds),
    [30, 30, 30, 30],
  );
  // The same source-time beat lattice stays fixed. TEMPO changes how quickly it crosses the
  // needle; it must not make React resize every PCM/beat cell during a fader gesture.
  const beatSeconds = 60 / 120;
  const normalBeatWidth = beatSeconds / performanceWaveformViewportSeconds(1);
  const fastBeatWidth = beatSeconds / performanceWaveformViewportSeconds(1.25);
  assert.equal(fastBeatWidth, normalBeatWidth);

  const slowTrackBeatWidth = (60 / 100) / performanceWaveformViewportSeconds(1);
  const fastTrackBeatWidth = (60 / 160) / performanceWaveformViewportSeconds(1);
  assert.ok(slowTrackBeatWidth > fastTrackBeatWidth);
});

test("Manager waveform uses a tighter stable source-time window", () => {
  assert.equal(managerWaveformViewportSeconds(0.5), 6);
  assert.equal(managerWaveformViewportSeconds(1), 6);
  assert.equal(managerWaveformViewportSeconds(2), 6);
  assert.ok(managerWaveformViewportSeconds(1) < performanceWaveformViewportSeconds(1));
});

test("Manager renewal requests exactly the coverage margin it later requires", () => {
  assert.equal(managerWaveformRequestSeconds(6, 0.75), 7.5);
  assert.equal(managerWaveformRequestSeconds(Number.NaN, 0.75), 1.5);
  assert.equal(managerWaveformRequestSeconds(6, -1), 6);
});

test("Manager raster density follows destination physical pixels rather than 400 Hz analysis", () => {
  const raster = managerWaveformRasterGeometry(30, 42, 400, 2, 6);
  assert.equal(raster.backingWidth, 1_600);
  assert.equal(raster.cssWidth, 800);
  assert.equal(raster.pixelsPerSecond, 400 / 3);
  assert.ok(Math.abs(raster.spanSec - 12) < 1.0e-12);
});

test("overlapping Manager windows share one absolute destination-pixel lattice", () => {
  const first = managerWaveformRasterGeometry(10.0025, 22.0025, 397, 2, 6);
  const renewed = managerWaveformRasterGeometry(10.7525, 22.7525, 397, 2, 6);
  assert.ok(Math.abs(first.startSec * first.pixelsPerSecond - first.firstPixel) < 1.0e-9);
  assert.ok(Math.abs(first.endSec * first.pixelsPerSecond - first.lastPixel) < 1.0e-9);
  assert.equal(first.pixelsPerSecond, renewed.pixelsPerSecond);
  // The same absolute instant resolves to the same global physical column after renewal.
  const sharedTime = 16.25;
  const firstGlobalPixel = first.firstPixel
    + Math.floor((sharedTime - first.startSec) * first.pixelsPerSecond);
  const renewedGlobalPixel = renewed.firstPixel
    + Math.floor((sharedTime - renewed.startSec) * renewed.pixelsPerSecond);
  assert.equal(firstGlobalPixel, renewedGlobalPixel);
});

test("bounded Manager assets keep source-time ownership instead of stretching full-track", () => {
  const waveform = {
    track_id: 7,
    duration: 180,
    source_start: 84,
    source_end: 96,
    amp: new Float32Array([0.2, 0.8]),
    r: new Uint8Array([1, 2]),
    g: new Uint8Array([3, 4]),
    b: new Uint8Array([5, 6]),
  };
  assert.deepEqual(waveformSourceRange(waveform), [84, 96]);
  assert.equal(waveformCoversViewport(waveform, 7, 90, 6, 0.75), true);
  assert.equal(waveformCoversViewport(waveform, 7, 93, 6, 0.75), false);
  assert.equal(waveformCoversViewport(waveform, 8, 90, 6), false);
});

test("Manager distinguishes visible partial PCM from complete first-paint coverage", () => {
  const waveform = {
    track_id: 7,
    duration: 180,
    source_start: 90,
    source_end: 92,
    amp: new Float32Array([0.2, 0.8]),
    r: new Uint8Array([1, 2]),
    g: new Uint8Array([3, 4]),
    b: new Uint8Array([5, 6]),
  };
  assert.equal(waveformCoversViewport(waveform, 7, 90, 6), false);
  assert.equal(waveformIntersectsViewport(waveform, 7, 90, 6), true);
  assert.equal(waveformIntersectsViewport(waveform, 7, 96, 6), false);
  assert.equal(waveformIntersectsViewport(waveform, 8, 90, 6), false);
});

test("sparse Manager windows remain visible without claiming unknown coverage", () => {
  const known = new Uint8Array(8);
  known.set([1, 1], 4);
  const waveform = {
    track_id: 7,
    duration: 8,
    source_start: 0,
    source_end: 8,
    amp: new Float32Array(8).fill(0.5),
    r: new Uint8Array(8),
    g: new Uint8Array(8),
    b: new Uint8Array(8),
    known,
  };
  assert.equal(waveformIntersectsViewport(waveform, 7, 4, 4), true);
  assert.equal(waveformCoversViewport(waveform, 7, 4, 4), false);
  assert.equal(
    waveformIntersectsViewport({ ...waveform, known: new Uint8Array(8) }, 7, 4, 4),
    false,
  );
});

test("a cached full detail master is sliced on its original source-time lattice", () => {
  const full = {
    track_id: 7,
    duration: 8,
    amp: Float32Array.from({ length: 8 }, (_, index) => index / 10),
    minimum: Float32Array.from({ length: 8 }, (_, index) => -index / 10),
    maximum: Float32Array.from({ length: 8 }, (_, index) => index / 10),
    r: Uint8Array.from({ length: 8 }, (_, index) => index),
    g: Uint8Array.from({ length: 8 }, (_, index) => index + 10),
    b: Uint8Array.from({ length: 8 }, (_, index) => index + 20),
    transient: Uint8Array.from({ length: 8 }, (_, index) => index + 30),
  };
  const window = waveformWindowFromFullDetail(full, 4, 4);
  assert.ok(window);
  assert.deepEqual(waveformSourceRange(window), [2, 6]);
  assert.deepEqual([...window.amp], [...Float32Array.from([0.2, 0.3, 0.4, 0.5])]);
  assert.deepEqual([...window.transient!], [32, 33, 34, 35]);
});

test("a canonical live window may trim only one 400 Hz cell at its PCM edges", () => {
  const waveform = {
    track_id: 7,
    duration: 180,
    source_start: 84.0025,
    source_end: 95.9975,
    amp: new Float32Array([0.2, 0.8]),
    r: new Uint8Array([1, 2]),
    g: new Uint8Array([3, 4]),
    b: new Uint8Array([5, 6]),
  };
  assert.equal(waveformCoversViewport(waveform, 7, 90, 12), true);
  assert.equal(
    waveformCoversViewport({ ...waveform, source_start: 84.003 }, 7, 90, 12),
    false,
  );
});

test("DJ detail keeps four hundred independent evidence columns per second", () => {
  assert.equal(detailWaveformBuckets(0), 2_000);
  assert.equal(detailWaveformBuckets(180), 72_000);
  assert.equal(detailWaveformBuckets(600), 100_000);
});

test("full-track overview uses the same crest-aware RMS/peak pooling as the server", () => {
  const overview = overviewWaveformFromDetail({
    track_id: 7,
    duration: 4,
    amp: [1, 0, 1, 0, 0.8, 0.2, 0.8, 0.2],
    r: [255, 255, 255, 255, 32, 32, 32, 32],
    g: [32, 32, 32, 32, 255, 255, 255, 255],
    b: [32, 32, 32, 32, 32, 32, 32, 32],
  }, 2);

  assert.ok(Math.abs(overview.amp[0] - 0.765685424949238) < 1e-12);
  assert.ok(Math.abs(overview.amp[1] - 0.6264761515876241) < 1e-12);
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

test("the DJ visual clock walks continuously between ten-hertz native samples", () => {
  const sample = {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  };
  const first = updateWaveformMotionClock(null, sample, 1_000);
  assert.equal(waveformMotionClockPosition(first, 1_050), 10.05);

  const second = updateWaveformMotionClock(first, { ...sample, position: 10.1 }, 1_100);
  assert.equal(second.snapped, false);
  assert.ok(Math.abs(second.anchorPosition - 10.1) < 1e-12);
  assert.ok(Math.abs(waveformMotionClockPosition(second, 1_150) - 10.15) < 1e-12);
});

test("the compositor clock wraps locally without waiting for a sparse engine sample", () => {
  const sample = {
    trackId: 7,
    position: 11.9,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    loopStart: 10,
    loopLength: 2,
  };
  const first = updateWaveformMotionClock(null, sample, 1_000);
  assert.ok(Math.abs(waveformMotionClockPosition(first, 1_200) - 10.1) < 1e-12);

  const wrappedSnapshot = updateWaveformMotionClock(
    first,
    { ...sample, position: 10.08 },
    1_200,
  );
  assert.equal(wrappedSnapshot.snapped, false, "the engine wrap must not restart an already-looping compositor");
  assert.ok(Math.abs(waveformMotionClockPosition(wrappedSnapshot, 1_250) - 10.15) < 1e-12);

  const changedLoop = updateWaveformMotionClock(
    wrappedSnapshot,
    { ...sample, position: 10.1, loopLength: 1 },
    1_250,
  );
  assert.equal(changedLoop.snapped, true, "changing the loop window is an exact phase boundary");

  const cleared = updateWaveformMotionClock(
    wrappedSnapshot,
    { ...sample, position: 10.2, loopStart: null, loopLength: null },
    1_300,
  );
  assert.equal(cleared.snapped, true, "LOOP off must land on the engine needle, not the linear timer");
  assert.ok(Math.abs(cleared.anchorPosition - 10.2) < 1e-12);
});

test("sub-clock-interval loops retain exact modulo phase", () => {
  assert.ok(Math.abs(loopedWaveformPosition(10.051, 10, 0.04) - 10.011) < 1e-12);
  assert.ok(Math.abs((liveWaveformLoopAnimationTimeMs(10.051, 10, 0.04) ?? 0) - 11) < 1e-9);
  const clock = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10.03,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    loopStart: 10,
    loopLength: 0.04,
  }, 1_000);
  assert.ok(Math.abs(waveformMotionClockPosition(clock, 1_100) - 10.01) < 1e-12);
});

test("the live waveform follows DAC-audible tempo instead of building target-rate phase debt", () => {
  assert.equal(liveWaveformPlaybackRate(1.08, 1.0), 1.0);
  assert.equal(liveWaveformPlaybackRate(1, 0.4, true), 0.4);
  assert.equal(liveWaveformPlaybackRate(0, 0.94), 0.94);
  assert.equal(liveWaveformPlaybackRate(1, -1.4), -1.4);
  assert.equal(liveWaveformPlaybackRate(1, 0), 0);
  assert.equal(
    liveWaveformPlaybackRate(1.08, 0),
    0,
    "a parked Deck must not fall back to TEMPO and keep the rail walking",
  );
});

test("platter authority projects the queued callback cursor onto the client clock", () => {
  assert.ok(Math.abs(projectedLiveWaveformPosition(10, 1_020, 1_000, 2, 180) - 9.96) < 1e-12);
  assert.ok(Math.abs(projectedLiveWaveformPosition(10, 1_000, 1_050, -2, 180) - 9.9) < 1e-12);
  assert.equal(projectedLiveWaveformPosition(179.9, 1_000, 1_200, 2, 180), 180);
});

test("native VSync projection has no stale phase across seek and rapid loop revisions", () => {
  assert.ok(Math.abs(
    projectedNativeWaveformPosition(42, 1_000, 1_016, 1, 180, null, null) - 42.016,
  ) < 1e-9);
  assert.equal(
    projectedNativeWaveformPosition(90, 2_000, 2_000, 1, 180, null, null),
    90,
    "a seek is rendered from the new DAC anchor in the same frame",
  );
  assert.ok(Math.abs(
    projectedNativeWaveformPosition(10.49, 3_000, 3_020, 1, 180, 10, 0.5) - 10.01,
  ) < 1e-9);
  assert.ok(Math.abs(
    projectedNativeWaveformPosition(10.49, 3_000, 3_020, 1, 180, null, null) - 10.51,
  ) < 1e-9, "effective LOOP off immediately removes modulo without retained animation state");
});

test("platter phase lands once at contact instead of seeking on every velocity sample", () => {
  assert.equal(shouldLandPlatterWaveform(false, true, false), true);
  assert.equal(shouldLandPlatterWaveform(true, true, false), false);
  assert.equal(shouldLandPlatterWaveform(true, true, true), true);
  assert.equal(shouldLandPlatterWaveform(true, false, false), true);
  assert.equal(shouldLandPlatterWaveform(false, false, true), false);
});

test("a seek handoff must not pause the live waveform compositor", () => {
  assert.equal(shouldPauseLiveWaveformClock(true, false, true, false), false);
  assert.equal(
    shouldPauseLiveWaveformClock(true, true, true, false),
    false,
    "a held platter must keep the compositor walking with audible rate",
  );
  assert.equal(shouldPauseLiveWaveformClock(false, true, true, false), true);
  assert.equal(shouldPauseLiveWaveformClock(false, false, true, false), true);
  assert.equal(
    shouldPauseLiveWaveformClock(false, true, true, false, 1.4),
    false,
    "spinning under a finger must slide the rail even while paused",
  );
  assert.equal(
    shouldPauseLiveWaveformClock(false, false, true, false, -1.2),
    false,
    "paused vinyl coast must keep the rail sliding with audible rate",
  );
  assert.equal(
    shouldPauseLiveWaveformClock(false, false, true, true),
    false,
    "cleared decoder during seek: keep walking; do not freeze then catch up",
  );
  assert.equal(
    shouldPauseLiveWaveformClock(false, false, false, true),
    false,
    "landing outside this bake window is a rebase, not a pause",
  );
});

test("live waveform PLL applies bounded correction and understands circular loop phase", () => {
  assert.ok(Math.abs(liveWaveformPhaseError(10.01, 10, null) - 0.01) < 1e-12);
  assert.ok(Math.abs(liveWaveformPhaseError(8.01, 11.99, 4) - 0.02) < 1e-12);
  assert.ok(Math.abs(correctedLiveWaveformRate(1, 0.1) - 1.005) < 1e-12);
  assert.ok(Math.abs(correctedLiveWaveformRate(1, -0.1) - 0.995) < 1e-12);
  assert.equal(correctedLiveWaveformRate(0, 1), 0);
});

test("a far seek must not clamp the live waveform animation to the old bake endpoints", () => {
  assert.equal(liveWaveformAnimationTimeMs(12, 90), 12_000);
  assert.equal(liveWaveformAnimationTimeMs(-0.02, 90), 0);
  assert.equal(liveWaveformAnimationTimeMs(90.02, 90), 90_000);
  assert.equal(
    liveWaveformAnimationTimeMs(-5, 90),
    null,
    "before this bake window: do not snap currentTime to 0",
  );
  assert.equal(
    liveWaveformAnimationTimeMs(120, 90),
    null,
    "after this bake window: do not snap currentTime to duration",
  );
});

test("small native clock jitter never becomes a hidden waveform pitch bend", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_000);
  const continued = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 10.075,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_100);

  assert.equal(continued.snapped, false);
  assert.ok(Math.abs(continued.anchorPosition - 10.1) < 1e-12);
  assert.equal(continued.rate, 1);
  assert.ok(Math.abs(waveformMotionClockPosition(continued, 1_116) - 10.116) < 1e-12);
});

test("a VSync detail rail never follows a small native clock sample backwards", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10.1,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    motionRevision: 4,
  }, 1_000);
  const regressed = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 10.08,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    motionRevision: 4,
  }, 1_016);

  assert.equal(regressed.snapped, false);
  assert.ok(waveformMotionClockPosition(regressed, 1_016) > 10.1);
});

test("a late queued native sample leaves the already-running native timeline alone", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_000);
  const stale = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 10.1,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_500);

  assert.equal(stale.snapped, false);
  assert.equal(stale.anchorPosition, 10.5);
  assert.ok(Math.abs(waveformMotionClockPosition(stale, 1_516) - 10.516) < 1e-12);
});

test("a native SYNC revision lands even a small phase correction immediately", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    motionRevision: 0,
  }, 1_000);
  const synced = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 10.06,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
    motionRevision: 1,
  }, 1_100);

  assert.equal(synced.snapped, true);
  assert.equal(synced.anchorPosition, 10.06);
  assert.equal(waveformMotionClockPosition(synced, 1_100), 10.06);
});

test("TEMPO changes only the native timeline rate and preserve its current phase", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_000);
  const faster = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 10.1,
    duration: 180,
    rate: 1.25,
    playing: true,
    discrete: false,
  }, 1_100);

  assert.equal(faster.snapped, false);
  assert.ok(Math.abs(faster.anchorPosition - 10.1) < 1e-12);
  assert.ok(Math.abs(waveformMotionClockPosition(faster, 1_150) - 10.1625) < 1e-12);
});

test("seeks, rewinds, pauses, and scratches remain authoritative visual landings", () => {
  const first = updateWaveformMotionClock(null, {
    trackId: 7,
    position: 10,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_000);
  const seek = updateWaveformMotionClock(first, {
    trackId: 7,
    position: 40,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: false,
  }, 1_100);
  assert.equal(seek.snapped, true);
  assert.equal(waveformMotionClockPosition(seek, 1_100), 40);

  const scratch = updateWaveformMotionClock(seek, {
    trackId: 7,
    position: 4,
    duration: 180,
    rate: 1,
    playing: true,
    discrete: true,
  }, 1_200);
  assert.equal(scratch.playing, false);
  assert.equal(waveformMotionClockPosition(scratch, 5_000), 4);
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
