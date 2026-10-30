// The progressive waveform of an online song (src/lib/waveformCache.ts): where on the rail the
// server's prefixes and its finished waveform land. Runs bundled (scripts/bundle-test.mjs):
// waveformCache reaches the native player client through the API module.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStreamWaveform,
  mergeCachedStreamWaveform,
  updateStreamWaveform,
  type StreamWaveformSnapshot,
} from "../src/lib/waveformCache";
import { completedStreamDuration, streamDurationsAgree } from "../src/lib/streamWaveformExtent";
import type { Waveform } from "../src/types";

const BUCKETS = 4096;

/**
 * What the server sends for `seconds` of decoded audio of a song `song` seconds long: its
 * columns span exactly the decoded part, and a column's amplitude is its place in the whole
 * song (0 at the start, 1 at the end), so a test can read back which moment a bucket shows.
 */
function decoded(seconds: number, song: number, columns = 4805): Waveform {
  const amp = Array.from({ length: columns }, (_, index) => ((index + 0.5) / columns) * seconds / song);
  return {
    track_id: 0,
    duration: seconds,
    amp,
    minimum: amp.map(value => -value),
    maximum: amp,
    r: Array(columns).fill(200),
    g: Array(columns).fill(40),
    b: Array(columns).fill(40),
    transient: Array(columns).fill(0),
  };
}

/** The buckets a snapshot has bars in: how many, and the last one. */
function drawn(snapshot: StreamWaveformSnapshot): { count: number; last: number } {
  let count = 0;
  let last = -1;
  snapshot.known.forEach((known, index) => {
    if (known) {
      count += 1;
      last = index;
    }
  });
  return { count, last };
}

/** The place in the song (0..1) the bars at `fraction` of the rail show. */
const shownAt = (snapshot: StreamWaveformSnapshot, fraction: number): number =>
  snapshot.waveform.amp[Math.min(BUCKETS - 1, Math.floor(fraction * BUCKETS))];

let nextId = -9000;
/** A song's own cache entry and a server revision counter. */
function stream(duration: number) {
  const id = nextId--;
  let revision = 0;
  updateStreamWaveform(id, 0, duration, null, []);
  return {
    id,
    merge: (seconds: number, song: number, total: number, complete = false, probed = 0) =>
      mergeCachedStreamWaveform(id, total, seconds, decoded(seconds, song), ++revision, [], complete, probed),
    done: () => clearStreamWaveform(id),
  };
}

test("durations of the same song agree; a finished decode overrules the transport only with a witness", () => {
  assert.ok(streamDurationsAgree(269, 269.31), "catalogue seconds are rounded");
  assert.ok(streamDurationsAgree(600, 595), "one percent of a long song");
  assert.ok(!streamDurationsAgree(269, 240));
  assert.ok(!streamDurationsAgree(0, 0) && !streamDurationsAgree(Number.NaN, 240));

  assert.equal(completedStreamDuration(269, 269.3, 269.3), 0, "the transport is right: it stands");
  assert.equal(completedStreamDuration(269, 60, 60.02), 60, "the file is a 60 s clip");
  assert.equal(completedStreamDuration(30, 240, 240.1), 240, "or longer than the catalogue says");
  assert.equal(completedStreamDuration(269, 150, 269), 0, "a decode that stopped early is a prefix");
  assert.equal(completedStreamDuration(269, 150, 0), 0, "and so is one nothing vouches for");
  assert.equal(completedStreamDuration(0, 240, 0), 240, "no other length is known");
  assert.equal(completedStreamDuration(0, 150, 240), 240, "the container is longer than the decode");
  assert.equal(completedStreamDuration(269, 0, 0), 0);
});

test("a song that is loading: every prefix lies under its own stretch of the song, never stretched", () => {
  const song = stream(240);
  for (const seconds of [48, 96, 192]) {
    const snapshot = song.merge(seconds, 240, 240);
    const { count, last } = drawn(snapshot);
    const end = Math.ceil((seconds / 240) * BUCKETS);
    assert.equal(count, end, `${seconds} s of 240 s cover their share of the rail`);
    assert.equal(last, end - 1);
    assert.ok(Math.abs(shownAt(snapshot, seconds / 480) - seconds / 480) < 0.002, "the bars show the moment they stand at");
  }
  // The container's duration says nothing about a prefix: it is not laid over the whole rail.
  const stillLoading = song.merge(200, 240, 240, false, 200);
  assert.equal(drawn(stillLoading).last, Math.ceil((200 / 240) * BUCKETS) - 1);
  const finished = song.merge(240, 240, 240, true, 240);
  assert.deepEqual(drawn(finished), { count: BUCKETS, last: BUCKETS - 1 });
  assert.equal(finished.waveform.duration, 240);
  song.done();
});

test("playing a song again does not trade its finished waveform for the new capture's first prefix", () => {
  const song = stream(240);
  song.merge(96, 240, 240);
  song.merge(240, 240, 240, true, 240);
  // The server started over: its prefixes have newer revisions than the finished picture.
  const replayed = song.merge(48, 240, 240);
  assert.deepEqual(drawn(replayed), { count: BUCKETS, last: BUCKETS - 1 }, "the whole song stays");
  assert.ok(Math.abs(shownAt(replayed, 0.9) - 0.9) < 0.002);
  assert.deepEqual(drawn(song.merge(96, 240, 240)), { count: BUCKETS, last: BUCKETS - 1 });
  // Its next finished waveform replaces the old one.
  const again = mergeCachedStreamWaveform(song.id, 240, 240, { ...decoded(240, 240), g: Array(4805).fill(222) }, 99, [], true, 240);
  assert.equal(again.waveform.g[2000], 222);
  song.done();
});

test("a finished waveform is the whole song although the transport reports a longer one", () => {
  // The catalogue says 240 s; the file that was played and decoded is 96 s long.
  const song = stream(240);
  const loading = song.merge(48, 96, 240);
  assert.equal(drawn(loading).last, Math.ceil((48 / 240) * BUCKETS) - 1, "nothing says so while it loads");
  const finished = song.merge(96, 96, 240, true, 96.01);
  assert.deepEqual(drawn(finished), { count: BUCKETS, last: BUCKETS - 1 }, "not squeezed into the first 40 % of the rail");
  assert.equal(finished.waveform.duration, 96, "the rail is as long as the audio");
  assert.ok(Math.abs(shownAt(finished, 0.5) - 0.5) < 0.002, "and its middle is the middle of the audio");

  // A rail that mounts later, or a player that reports its duration again, passes the
  // transport's figure: the finished song is not pushed back into a prefix of it.
  for (const again of [updateStreamWaveform(song.id, 0, 240, null), updateStreamWaveform(song.id, 0, 600, null)]) {
    assert.deepEqual(drawn(again), { count: BUCKETS, last: BUCKETS - 1 });
    assert.equal(again.waveform.duration, 96);
  }
  song.done();

  // The same when the file is longer than the transport believes.
  const longer = stream(30);
  const whole = longer.merge(240, 240, 30, true, 240);
  assert.equal(whole.waveform.duration, 240);
  assert.deepEqual(drawn(whole), { count: BUCKETS, last: BUCKETS - 1 });
  longer.done();
});

test("a decode that fell short of the song is never stretched over it", () => {
  // "Complete" with 150 s decoded, but the container declares the 240 s the transport reports:
  // the decode stopped early, and its bars belong under the first 150 s.
  const damaged = stream(240);
  const short = damaged.merge(150, 240, 240, true, 240);
  assert.equal(short.waveform.duration, 240);
  assert.equal(drawn(short).last, Math.ceil((150 / 240) * BUCKETS) - 1);
  assert.ok(Math.abs(shownAt(short, 0.3) - 0.3) < 0.002, "every bar under its own moment");
  assert.equal(drawn(updateStreamWaveform(damaged.id, 0, 240, null)).last, drawn(short).last);
  damaged.done();

  // The same with no witness at all (the analysis failed, an older server).
  const unvouched = stream(240);
  assert.equal(drawn(unvouched.merge(150, 240, 240, true)).last, Math.ceil((150 / 240) * BUCKETS) - 1);
  unvouched.done();
});

test("a song whose length the transport does not know is as long as its finished decode", () => {
  const song = stream(0);
  assert.equal(drawn(song.merge(48, 200, 0)).count, 0, "a prefix of an unknown length has no place yet");
  const finished = song.merge(200, 200, 0, true, 200);
  assert.equal(finished.waveform.duration, 200);
  assert.deepEqual(drawn(finished), { count: BUCKETS, last: BUCKETS - 1 });
  song.done();
});

test("the dev trace writes a line when the layout of a song changes, not on every poll", async () => {
  const { streamWaveformTrace } = await import("../src/lib/streamWaveformTrace");
  const answer = (more: Record<string, unknown>) => ({
    enabled: true, waveform: decoded(48, 240), covered_seconds: 48, revision: 3, cached_bytes: 1_000, total_bytes: 5_000,
    complete: false, active: true, waveform_status: "partial", ...more,
  }) as never;
  const loading = streamWaveformTrace(-5, "qqm", answer({}), false, 240, 240, false);
  assert.deepEqual(loading.detail, {
    track: -5, platform: "qqm", status: "partial", complete: "false", active: "true", revision: 3,
    covered: 48, bytes: "1000/5000", bar: 240, rail: 240, probed: 0, place: "prefix",
  });
  // The next pass is being decoded, the lease flag flips, two more seconds arrive: no news.
  const same = streamWaveformTrace(-5, "qqm", answer({ waveform_status: "analyzing", active: false, covered_seconds: 49.5, revision: 4 }), false, 240, 240, false);
  assert.equal(same.signature, loading.signature);
  assert.notEqual(streamWaveformTrace(-5, "qqm", answer({ covered_seconds: 96 }), false, 240, 240, false).signature, loading.signature);
  assert.notEqual(streamWaveformTrace(-5, "qqm", answer({}), false, 300, 300, false).signature, loading.signature, "the bar's duration changed");

  const done = { waveform_status: "ready", complete: true, active: false, analysis_status: "ready", analysis: { duration: 96 } };
  const clip = streamWaveformTrace(-5, "qqm", answer({ ...done, covered_seconds: 96 }), true, 240, 96, true);
  assert.equal(clip.detail.place, "full");
  assert.deepEqual([clip.detail.bar, clip.detail.rail, clip.detail.probed], [240, 96, 96], "the decode overruled the bar's duration");
  const short = streamWaveformTrace(-5, "qqm", answer({ ...done, covered_seconds: 150, analysis: { duration: 240 } }), true, 240, 240, true);
  assert.equal(short.detail.place, "prefix", "a finished decode that fell short");
  assert.equal(streamWaveformTrace(-5, "qqm", answer({}), false, 240, 240, true).detail.place, "kept-finished");
  assert.equal(streamWaveformTrace(-5, "qqm", answer({ waveform: null, waveform_status: "waiting" }), false, 240, 240, false).detail.place, "none");
});
