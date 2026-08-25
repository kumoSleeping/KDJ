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
  beatMarkerRangePercent,
} from "../src/lib/waveformViewport";
import {
  correctedLiveWaveformRate,
  liveWaveformAnimationTimeMs,
  liveWaveformLoopAnimationTimeMs,
  liveWaveformPhaseError,
  liveWaveformPlaybackRate,
  loopedWaveformPosition,
  projectedLiveWaveformPosition,
  shouldPauseLiveWaveformClock,
  shouldLandPlatterWaveform,
  updateWaveformMotionClock,
  waveformMotionClockPosition,
} from "../src/lib/waveformMotion";

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

test("DJ detail keeps one hundred real envelope columns per second", () => {
  assert.equal(detailWaveformBuckets(0), 2_000);
  assert.equal(detailWaveformBuckets(180), 18_000);
  assert.equal(detailWaveformBuckets(600), 24_000);
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
