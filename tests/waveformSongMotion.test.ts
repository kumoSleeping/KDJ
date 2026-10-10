import assert from "node:assert/strict";
import test from "node:test";
import { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS } from "../src/lib/songSwapMotion";
import {
  WAVEFORM_PUSH_LIMIT,
  WAVEFORM_PUSH_MS,
  addWaveformPushes,
  advanceWaveformSongMotion,
  mountedWaveformSongMotion,
  newWaveformStretches,
  startWaveformSongCollapse,
  waveformPushLevel,
  waveformPushOver,
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

/** A mask of `length` columns with the given [from, to) ranges covered. */
const mask = (length: number, ...ranges: [number, number][]) => {
  const columns = new Uint8Array(length);
  for (const [from, to] of ranges) columns.fill(1, from, to);
  return columns;
};

test("a picture that arrives in pieces: only the stretch that is new is pushed", () => {
  // Nothing painted before, or a whole waveform before: nothing is new in this sense.
  assert.deepEqual(newWaveformStretches(null, mask(100, [0, 40])), []);
  assert.deepEqual(newWaveformStretches(null, "all", 100), []);
  assert.deepEqual(newWaveformStretches("all", "all", 100), []);
  assert.deepEqual(newWaveformStretches("all", mask(100, [0, 40])), []);

  // The decoded prefix extends: the new stretch starts where the old one ended.
  assert.deepEqual(newWaveformStretches(mask(100, [0, 40]), mask(100, [0, 55])), [{ from: 0.4, to: 0.55 }]);
  // The same data again, or less of it: nothing moves.
  assert.deepEqual(newWaveformStretches(mask(100, [0, 40]), mask(100, [0, 40])), []);
  assert.deepEqual(newWaveformStretches(mask(100, [0, 40]), mask(100, [0, 30])), []);
  // Several pieces at once (the prefix, and what was heard after a seek), in song order.
  assert.deepEqual(
    newWaveformStretches(mask(100, [0, 20], [60, 62]), mask(100, [0, 30], [60, 70])),
    [{ from: 0.2, to: 0.3 }, { from: 0.62, to: 0.7 }],
  );
  // A gap that closes is new as well; the columns on either side of it are not.
  assert.deepEqual(newWaveformStretches(mask(100, [0, 20], [30, 50]), mask(100, [0, 50])), [{ from: 0.2, to: 0.3 }]);
  // The finished waveform replaces the partial one: what was missing is the last push.
  assert.deepEqual(newWaveformStretches(mask(100, [0, 80]), "all"), [{ from: 0.8, to: 1 }]);
  assert.deepEqual(newWaveformStretches(mask(100, [0, 100]), "all"), []);
  // Masks of different lengths are compared by place in the song.
  assert.deepEqual(newWaveformStretches(mask(50, [0, 20]), mask(100, [0, 60])), [{ from: 0.4, to: 0.6 }]);
  assert.deepEqual(newWaveformStretches(mask(200, [0, 80]), mask(100, [0, 60])), [{ from: 0.4, to: 0.6 }]);
  // Too short to be seen (the bucket under the playhead): painted, not pushed.
  assert.deepEqual(newWaveformStretches(mask(4096, [0, 400]), mask(4096, [0, 401]), 0, 2 / 1000), []);
  assert.deepEqual(
    newWaveformStretches(mask(4096, [0, 400], [900, 901]), mask(4096, [0, 500], [900, 902]), 0, 2 / 1000),
    [{ from: 400 / 4096, to: 500 / 4096 }],
  );
  assert.deepEqual(newWaveformStretches(mask(0), mask(100, [0, 10])), []);
});

test("a push travels from the near end of its stretch to the far end and then stands", () => {
  const push = { from: 0.4, to: 0.6, startedAt: 1_000 };
  const level = (at: number, after: number) => waveformPushLevel(push, at, 1_000 + after);
  // At the start nothing of the stretch stands; at the end all of it does.
  for (const at of [0.4, 0.5, 0.6]) {
    assert.equal(level(at, 0), 0);
    assert.equal(level(at, WAVEFORM_PUSH_MS), 1);
    assert.equal(level(at, WAVEFORM_PUSH_MS * 4), 1);
  }
  // In between the near end is ahead of the middle, and the middle ahead of the far end.
  for (const after of [60, 120, 180, 240]) {
    assert.ok(level(0.4, after) >= level(0.5, after) && level(0.5, after) >= level(0.6, after), `ordered at ${after}`);
    assert.ok(level(0.4, after) > level(0.6, after), `a front at ${after}`);
  }
  // The far end waits for the front; every bar only ever grows.
  assert.equal(level(0.6, WAVEFORM_PUSH_MS * 0.4), 0);
  let before = 0;
  for (let after = 0; after <= WAVEFORM_PUSH_MS; after += 10) {
    assert.ok(level(0.5, after) >= before);
    before = level(0.5, after);
  }
  assert.equal(waveformPushOver(push, 1_000 + WAVEFORM_PUSH_MS - 1), false);
  assert.equal(waveformPushOver(push, 1_000 + WAVEFORM_PUSH_MS), true);
  // A place outside the stretch is read as its nearest end.
  assert.equal(waveformPushLevel(push, 0.1, 1_050), waveformPushLevel(push, 0.4, 1_050));
});

test("increments that arrive faster than a push each keep their own clock", () => {
  let running = addWaveformPushes([], [{ from: 0.2, to: 0.3 }], 0);
  assert.deepEqual(running, [{ from: 0.2, to: 0.3, startedAt: 0 }]);
  // The next piece arrives mid-push: the first goes on from where it is, the second starts.
  running = addWaveformPushes(running, [{ from: 0.3, to: 0.35 }], 100);
  assert.deepEqual(running.map((push) => push.startedAt), [0, 100]);
  // New data without a new stretch keeps what is running and drops what is over.
  running = addWaveformPushes(running, [], WAVEFORM_PUSH_MS);
  assert.deepEqual(running, [{ from: 0.3, to: 0.35, startedAt: 100 }]);
  assert.deepEqual(addWaveformPushes(running, [], 100 + WAVEFORM_PUSH_MS), []);
  // A burst never keeps more than the limit: the oldest are shown finished.
  let burst: ReturnType<typeof addWaveformPushes> = [];
  for (let piece = 0; piece < WAVEFORM_PUSH_LIMIT + 3; piece += 1) {
    burst = addWaveformPushes(burst, [{ from: piece / 100, to: (piece + 1) / 100 }], piece);
  }
  assert.equal(burst.length, WAVEFORM_PUSH_LIMIT);
  assert.equal(burst[0].startedAt, 3);
});
