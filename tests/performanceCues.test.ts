import assert from "node:assert/strict";
import test from "node:test";
import type { CuePoint } from "../src/types";
import { beatGridMarkers, channelFaderGain, crossfaderChannelGains, eqBandDb, HOT_CUE_COLORS, HOT_CUE_PAD_COUNT, nextLoadedDeckIndex, performanceLoadDeckIndex, removeHotCue, shouldDropSeekPreview, snapCueSeconds, updateHotCueComment, upsertHotCue, validateCuePoints } from "../src/lib/performanceCues";

const cue = (values: Partial<CuePoint>): CuePoint => ({ id: 1, hot_cue: null, start_ms: 0, end_ms: null, color_index: null, color: "", comment: "", active_loop: false, ...values });

test("quantize snaps around the analyzed first beat", () => {
  assert.equal(snapCueSeconds(1.12, 120, 0.1, true), 1.1);
  assert.equal(snapCueSeconds(1.12, 120, 0.1, false), 1.12);
  assert.equal(snapCueSeconds(1.12, 120, null, true), 1.12);
});

test("beat grid marks each fourth beat as a new bar", () => {
  assert.deepEqual(beatGridMarkers(2.1, 120, 0.1), [
    { positionSec: 0.1, beat: 1, bar: 1 },
    { positionSec: 0.6, beat: 2, bar: 1 },
    { positionSec: 1.1, beat: 3, bar: 1 },
    { positionSec: 1.6, beat: 4, bar: 1 },
    { positionSec: 2.1, beat: 1, bar: 2 },
  ]);
});

test("beat grid keeps first_beat as the downbeat instead of wrapping it into one beat", () => {
  assert.deepEqual(beatGridMarkers(2.6, 120, 0.6), [
    { positionSec: 0.1, beat: 4, bar: 0 },
    { positionSec: 0.6, beat: 1, bar: 1 },
    { positionSec: 1.1, beat: 2, bar: 1 },
    { positionSec: 1.6, beat: 3, bar: 1 },
    { positionSec: 2.1, beat: 4, bar: 1 },
    { positionSec: 2.6, beat: 1, bar: 2 },
  ]);
});

test("beat grid can generate only a visible window without resetting bar numbers", () => {
  assert.deepEqual(beatGridMarkers(20, 120, 0.1, 4, 5.2), [
    { positionSec: 4.1, beat: 1, bar: 3 },
    { positionSec: 4.6, beat: 2, bar: 3 },
    { positionSec: 5.1, beat: 3, bar: 3 },
  ]);
});

test("beat grid extends infinitely through silent lead-in with negative bar numbers", () => {
  const markers = beatGridMarkers(20, 120, 0.1, -4.0, 0.2);
  assert.deepEqual(
    markers.filter((marker) => marker.beat === 1),
    [
      { positionSec: -3.9, beat: 1, bar: -1 },
      { positionSec: -1.9, beat: 1, bar: 0 },
      { positionSec: 0.1, beat: 1, bar: 1 },
    ],
  );
});

test("a leftover positive overlay is dropped once TIME is already in preroll", () => {
  assert.equal(shouldDropSeekPreview(5, -5, false), true);
  assert.equal(shouldDropSeekPreview(-5, 5, false), false, "keep a reverse landing until the engine catches up");
  assert.equal(shouldDropSeekPreview(5, -5, true), false, "an active search still owns the overlay");
  assert.equal(shouldDropSeekPreview(-5.02, -5, false), true);
  assert.equal(shouldDropSeekPreview(null, -5, false), false);
});

test("beat grid does not invent phase or show a rejected low-confidence fit", () => {
  assert.deepEqual(beatGridMarkers(20, 120, null), []);
  assert.deepEqual(beatGridMarkers(20, 120, 0.1, 0, 20, 0.2), []);
  assert.ok(beatGridMarkers(20, 120, 0.1, 0, 20, 0.8).length > 0);
});

test("a distinct track is loaded on the opposite fixed deck", () => {
  assert.equal(nextLoadedDeckIndex(0, 10, 11), 1);
  assert.equal(nextLoadedDeckIndex(1, 10, 11), 0);
  assert.equal(nextLoadedDeckIndex(1, null, 11), 1);
  assert.equal(nextLoadedDeckIndex(0, 11, 11), 0);
});

test("DJ double-click protects playing Decks and then chooses the quieter side", () => {
  const empty = { trackId: null, playing: false };
  const paused = { trackId: 10, playing: false };
  const playing = { trackId: 11, playing: true };
  assert.equal(performanceLoadDeckIndex([empty, empty], [1, 1], 1), 0);
  assert.equal(performanceLoadDeckIndex([playing, empty], [0.2, 1], 0), 1);
  assert.equal(performanceLoadDeckIndex([paused, playing], [1, 0.1], 1), 0);
  assert.equal(performanceLoadDeckIndex([playing, { ...playing, trackId: 12 }], [0.2, 0.8], 1), 0);
  assert.equal(performanceLoadDeckIndex([playing, { ...playing, trackId: 12 }], [0.8, 0.2], 0), 1);
  assert.equal(performanceLoadDeckIndex([playing, { ...playing, trackId: 12 }], [0.5, 0.5], 0), 1);
  assert.equal(performanceLoadDeckIndex([playing, { ...playing, trackId: 12 }], [0.5, 0.5], 1), 0);
});

test("performance pads expose eight grouped hot cue slots", () => {
  assert.equal(HOT_CUE_PAD_COUNT, 8);
  assert.equal(HOT_CUE_COLORS.length, HOT_CUE_PAD_COUNT);
});

test("hot cue upsert and removal are immutable and sorted", () => {
  const original = [cue({ id: 9, start_ms: 8_000 })];
  const inserted = upsertHotCue(original, 3, 4_000);
  assert.equal(original.length, 1);
  assert.deepEqual(inserted.map((item) => item.start_ms), [4_000, 8_000]);
  assert.equal(inserted[0].color, "orange");
  assert.deepEqual(removeHotCue(inserted, 3), original);
});

test("hot cue comments are immutable and trimmed", () => {
  const original = [cue({ hot_cue: 2, comment: "old" })];
  const updated = updateHotCueComment(original, 2, "  drop here  ");
  assert.equal(original[0].comment, "old");
  assert.equal(updated[0].comment, "drop here");
});

test("crossfader keeps both decks full at center and cubes only the opposite deck down", () => {
  assert.deepEqual(crossfaderChannelGains(-1), [1, 0]);
  const center = crossfaderChannelGains(0);
  assert.deepEqual(center, [1, 1]);
  const right = crossfaderChannelGains(1);
  assert.ok(Math.abs(right[0]) < 1e-10);
  assert.equal(right[1], 1);
  const [leftAtHalfRight, rightAtHalfRight] = crossfaderChannelGains(0.5);
  assert.equal(leftAtHalfRight, 0.125);
  assert.equal(rightAtHalfRight, 1);
  const [leftAtHalfLeft, rightAtHalfLeft] = crossfaderChannelGains(-0.5);
  assert.equal(leftAtHalfLeft, 1);
  assert.equal(rightAtHalfLeft, 0.125);
});

test("channel fader stays quiet through the first half and opens near the top", () => {
  assert.equal(channelFaderGain(0), 0);
  assert.equal(channelFaderGain(1), 1);
  assert.ok(channelFaderGain(0.5) < 0.13);
  assert.ok(channelFaderGain(0.6) > 0.2 && channelFaderGain(0.6) < 0.25);
  assert.ok(channelFaderGain(0.7) > 0.33 && channelFaderGain(0.7) < 0.36);
  assert.ok(channelFaderGain(0.3) < channelFaderGain(0.5));
  assert.ok(channelFaderGain(0.5) < channelFaderGain(0.7));
});

test("DJ EQ uses a continuous Pioneer/Mixxx audio taper, not a last-quarter dump", () => {
  const cutGain = (throwAmount: number) => 1 + (10 ** (-26 / 20) - 1) * throwAmount;
  const cutDb = (throwAmount: number) => 20 * Math.log10(cutGain(throwAmount));
  assert.equal(eqBandDb(0), 0);
  assert.equal(eqBandDb(1), 9);
  assert.ok(Math.abs(eqBandDb(-1) + 26) < 1e-9);
  assert.equal(eqBandDb(0.5), 4.5);
  assert.ok(Math.abs(eqBandDb(-0.2) - cutDb(0.2)) < 1e-9);
  assert.ok(Math.abs(eqBandDb(-0.5) - cutDb(0.5)) < 1e-9);
  assert.ok(eqBandDb(-0.2) > -2.5, "a slight cut must stay musical");
  assert.ok(eqBandDb(-0.5) > -7, "halfway cut stays near Mixxx −6 dB, not −24");
  assert.ok(eqBandDb(-1) - eqBandDb(-0.9) > -12, "last 10% must not dump more than a Pioneer step");
});

test("cue validation catches duplicate slots and invalid loops", () => {
  const errors = validateCuePoints([
    cue({ hot_cue: 1, start_ms: 100, end_ms: 100, active_loop: true }),
    cue({ id: 2, hot_cue: 1, start_ms: 200 }),
  ]);
  assert.ok(errors.some((error) => error.includes("Loop")));
  assert.ok(errors.some((error) => error.includes("重复")));
});
