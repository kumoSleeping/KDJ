import assert from "node:assert/strict";
import test from "node:test";
import { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS } from "../src/lib/songSwapMotion";
import {
  advanceWaveformSongMotion,
  mountedWaveformSongMotion,
  startWaveformSongCollapse,
  waveformSongMotionWakeAt,
  type WaveformSongMotion,
} from "../src/lib/waveformSongMotion";

const step = (
  state: WaveformSongMotion,
  trackId: number,
  ready: boolean,
  now: number,
  reduced = false,
) => {
  const next = advanceWaveformSongMotion(state, { trackId, ready, now, reduced });
  // Running it again on the same input must settle, or a render would loop.
  assert.equal(advanceWaveformSongMotion(next, { trackId, ready, now, reduced }), next);
  return next;
};

/** A song that is fully grown at `now`. */
const shown = (trackId: number, now: number) => {
  const state = step(mountedWaveformSongMotion(trackId), trackId, true, now);
  return step(state, trackId, true, now + SONG_SWAP_IN_MS);
};

test("a mounted waveform with cached data grows once", () => {
  assert.equal(mountedWaveformSongMotion(1).phase, "line");
  let state = step(mountedWaveformSongMotion(1), 1, true, 10);
  assert.equal(state.phase, "in");
  assert.equal(state.endsAt, 10 + SONG_SWAP_IN_MS);
  assert.equal(waveformSongMotionWakeAt(state, true), 10 + SONG_SWAP_IN_MS);

  assert.equal(step(state, 1, true, 10 + SONG_SWAP_IN_MS - 1), state);
  state = step(state, 1, true, 10 + SONG_SWAP_IN_MS);
  assert.equal(state.phase, "shown");
  assert.equal(waveformSongMotionWakeAt(state, true), null);
});

test("the line waits for data, and later refinements do not grow the picture again", () => {
  let state = step(mountedWaveformSongMotion(-7), -7, false, 0);
  assert.equal(state.phase, "line");
  assert.equal(waveformSongMotionWakeAt(state, false), null);
  state = step(state, -7, false, 5_000);
  assert.equal(state.phase, "line");

  state = step(state, -7, true, 5_200);
  assert.equal(state.phase, "in");
  const growing = state;
  // More of the stream arrives while it grows and after it has grown.
  assert.equal(step(state, -7, true, 5_300), growing);
  state = step(state, -7, true, 5_200 + SONG_SWAP_IN_MS);
  assert.equal(state.phase, "shown");
  assert.equal(step(state, -7, true, 9_000), state);
});

test("a change of song closes the old picture first, then grows the cached new one", () => {
  let state = shown(1, 0);
  const changeAt = 1_000;
  state = step(state, 2, true, changeAt);
  assert.equal(state.phase, "out");
  assert.equal(state.trackId, 1, "the old song's picture is the one that closes");
  assert.equal(waveformSongMotionWakeAt(state, true), changeAt + SONG_SWAP_OUT_MS);

  assert.equal(step(state, 2, true, changeAt + SONG_SWAP_OUT_MS - 1), state);
  state = step(state, 2, true, changeAt + SONG_SWAP_OUT_MS);
  assert.equal(state.phase, "in", "cached data grows right when the exit ends");
  assert.equal(state.trackId, 2);
  assert.equal(state.endsAt, changeAt + SONG_SWAP_OUT_MS + SONG_SWAP_IN_MS);
});

test("the line stays after the exit until the new song can be drawn", () => {
  let state = shown(1, 0);
  state = step(state, 2, false, 1_000);
  assert.equal(state.phase, "out");
  state = step(state, 2, false, 1_000 + SONG_SWAP_OUT_MS);
  assert.equal(state.phase, "line");
  assert.equal(state.trackId, 2);
  assert.equal(waveformSongMotionWakeAt(state, false), null);
  state = step(state, 2, true, 4_000);
  assert.equal(state.phase, "in");
});

test("skips do not queue: one collapse, then the latest song", () => {
  let state = shown(1, 0);
  state = step(state, 2, true, 1_000);
  const collapseEnds = state.endsAt;
  state = step(state, 3, true, 1_100);
  state = step(state, 4, true, 1_200);
  assert.equal(state.phase, "out");
  assert.equal(state.trackId, 1);
  assert.equal(state.endsAt, collapseEnds, "the running collapse is not restarted");

  // The collapse is over, but the last skip's exit is still running elsewhere.
  state = step(state, 4, true, collapseEnds);
  assert.equal(state.phase, "line");
  assert.equal(state.trackId, 4);
  assert.equal(waveformSongMotionWakeAt(state, true), 1_200 + SONG_SWAP_OUT_MS);
  state = step(state, 4, true, 1_200 + SONG_SWAP_OUT_MS);
  assert.equal(state.phase, "in");
  assert.equal(state.trackId, 4);
});

test("a skip while only the line shows waits out the exit without a collapse", () => {
  let state = step(mountedWaveformSongMotion(1), 1, false, 0);
  state = step(state, 2, true, 500);
  assert.equal(state.phase, "line");
  assert.equal(state.trackId, 2);
  assert.equal(waveformSongMotionWakeAt(state, true), 500 + SONG_SWAP_OUT_MS);
  state = step(state, 2, true, 500 + SONG_SWAP_OUT_MS);
  assert.equal(state.phase, "in");
});

test("a skip in the middle of growing closes that picture", () => {
  let state = step(mountedWaveformSongMotion(1), 1, true, 0);
  assert.equal(state.phase, "in");
  state = step(state, 2, true, 100);
  assert.equal(state.phase, "out");
  assert.equal(state.trackId, 1);
});

test("a shown song that loses its data closes to the line", () => {
  let state = shown(1, 0);
  state = step(state, 1, false, 2_000);
  assert.equal(state.phase, "out");
  state = step(state, 1, false, 2_000 + SONG_SWAP_OUT_MS);
  assert.equal(state.phase, "line");
});

test("reduced motion follows the song without any step", () => {
  let state = mountedWaveformSongMotion(1);
  state = step(state, 1, true, 0, true);
  assert.equal(state.phase, "shown");
  state = step(state, 2, false, 10, true);
  assert.deepEqual([state.phase, state.trackId], ["line", 2]);
  state = step(state, 2, true, 20, true);
  assert.deepEqual([state.phase, state.trackId], ["shown", 2]);
  assert.equal(waveformSongMotionWakeAt(state, true), null);
});

test("a collapse that reaches the screen late still runs its whole time", () => {
  let state = shown(1, 0);
  state = step(state, 2, true, 1_000);
  assert.equal(startWaveformSongCollapse(state, 1_000), state, "an immediate first frame changes nothing");

  // The first frame after the change comes 500 ms late.
  state = startWaveformSongCollapse(state, 1_500);
  assert.equal(state.endsAt, 1_500 + SONG_SWAP_OUT_MS);
  assert.equal(step(state, 2, true, 1_000 + SONG_SWAP_OUT_MS + 200), state);
  state = step(state, 2, true, 1_500 + SONG_SWAP_OUT_MS);
  assert.deepEqual([state.phase, state.trackId], ["in", 2]);

  const grown = shown(3, 0);
  assert.equal(startWaveformSongCollapse(grown, 9_000), grown, "only a closing picture is timed");
});
