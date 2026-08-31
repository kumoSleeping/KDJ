import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlaybackWaveformAtlas,
  decodePlaybackWaveformWindow,
  playbackWaveformAtlasWindow,
  playbackWaveformContiguousAtlasWindow,
  playbackWaveformMayPrefetchFullDetail,
  playbackWaveformRequestCenter,
  playbackWaveformRequestIsUrgent,
  playbackWaveformShouldLoadFullDetail,
  stabilizePlaybackWaveformWindow,
} from "../src/lib/playbackWaveform";
import type { Waveform } from "../src/types";

const HEADER_BYTES = 48;

test("only first paint and real discontinuities may preempt whole-track waveform work", () => {
  assert.equal(playbackWaveformRequestIsUrgent(false, true, false), true);
  assert.equal(playbackWaveformRequestIsUrgent(true, false, true), true);

  // The regression: advancing beyond a rolling window is routine renewal, even if that old
  // window no longer owns every visible pixel. It must not restart the whole-track preview.
  assert.equal(playbackWaveformRequestIsUrgent(true, false, false), false);
  assert.equal(playbackWaveformRequestIsUrgent(false, false, false), true);
});

test("whole-track detail prefetch waits until its Deck is audibly parked", () => {
  const transport = {
    trackId: 7,
    playing: true,
    scratchHeld: false,
    audibleRate: 1,
  };
  assert.equal(playbackWaveformMayPrefetchFullDetail(7, transport), false);
  assert.equal(
    playbackWaveformMayPrefetchFullDetail(7, { ...transport, playing: false, audibleRate: 0.01 }),
    true,
  );
  assert.equal(
    playbackWaveformMayPrefetchFullDetail(7, { ...transport, playing: false, scratchHeld: true }),
    false,
  );
  assert.equal(
    playbackWaveformMayPrefetchFullDetail(7, { ...transport, playing: false, audibleRate: Number.NaN }),
    false,
  );
  assert.equal(
    playbackWaveformMayPrefetchFullDetail(7, { ...transport, trackId: 8 }),
    true,
    "another Deck's activity does not own this track's optional cache",
  );
});

test("missing Manager first paint turns full detail into an active-playback fallback", () => {
  const active = {
    trackId: 7,
    playing: true,
    scratchHeld: false,
    audibleRate: 1,
  };
  assert.equal(
    playbackWaveformShouldLoadFullDetail(false, 7, active),
    true,
    "a blank detail panel must never wait for playback to stop",
  );
  assert.equal(
    playbackWaveformShouldLoadFullDetail(true, 7, active),
    false,
    "optional cache work waits once bounded PCM is already visible",
  );
  assert.equal(
    playbackWaveformShouldLoadFullDetail(true, 7, { ...active, playing: false, audibleRate: 0 }),
    true,
  );
});

test("urgent local requests reserve playback runway without losing either visible side", () => {
  assert.equal(playbackWaveformRequestCenter(20, 100, 6, 12, 1), 23);
  assert.equal(playbackWaveformRequestCenter(20, 100, 6, 12, -1), 17);
  assert.equal(playbackWaveformRequestCenter(20, 100, 6, 12, 0), 20);

  // Boundary correction fills the complete twelve-second bounded cache rather than requesting
  // six seconds before zero or beyond the end of the song.
  assert.equal(playbackWaveformRequestCenter(0, 100, 6, 12, 1), 6);
  assert.equal(playbackWaveformRequestCenter(100, 100, 6, 12, -1), 94);
  assert.equal(playbackWaveformRequestCenter(2, 8, 6, 12, 1), 4);
});

function encodedWindow(trackId: number): ArrayBuffer {
  const minimum = [-0.25, -0.5, -1];
  const maximum = [0.5, 0.75, 1];
  const count = minimum.length;
  const payload = new ArrayBuffer(HEADER_BYTES + count * 12);
  const bytes = new Uint8Array(payload);
  bytes.set([0x4b, 0x44, 0x4a, 0x57, 0x49, 0x4e, 0, 0]);
  const view = new DataView(payload);
  view.setUint16(8, 1, true);
  view.setBigInt64(12, BigInt(trackId), true);
  view.setFloat64(20, 180, true);
  view.setFloat64(28, 12, true);
  view.setFloat64(36, 15, true);
  view.setUint32(44, count, true);
  let offset = HEADER_BYTES;
  for (const value of minimum) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  for (const value of maximum) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  bytes.set([10, 20, 30], offset);
  offset += count;
  bytes.set([40, 50, 60], offset);
  offset += count;
  bytes.set([70, 80, 90], offset);
  offset += count;
  bytes.set([1, 2, 3], offset);
  return payload;
}

test("bounded IPC decoder retains exact source ownership and typed channels", () => {
  const waveform = decodePlaybackWaveformWindow(encodedWindow(42), 42);
  assert.ok(waveform);
  assert.equal(waveform.track_id, 42);
  assert.equal(waveform.source_start, 12);
  assert.equal(waveform.source_end, 15);
  assert.ok(waveform.amp instanceof Float32Array);
  assert.ok(waveform.r instanceof Uint8Array);
  assert.deepEqual([...waveform.r], [10, 20, 30]);
  assert.deepEqual([...waveform.transient!], [1, 2, 3]);
  assert.ok(Math.abs((waveform.maximum?.[1] ?? 0) - 0.75) < 1e-4);
  assert.equal(decodePlaybackWaveformWindow(new ArrayBuffer(0), 42), null);
  assert.throws(() => decodePlaybackWaveformWindow(encodedWindow(42), 7));
});

function wave(
  start: number,
  end: number,
  amp: number[],
  offset: number,
): Waveform {
  const count = amp.length;
  return {
    track_id: 9,
    duration: 10,
    source_start: start,
    source_end: end,
    amp: Float32Array.from(amp),
    minimum: Float32Array.from(amp, (value) => -value),
    maximum: Float32Array.from(amp),
    r: Uint8Array.from({ length: count }, (_, index) => offset + index),
    g: Uint8Array.from({ length: count }, (_, index) => offset + 10 + index),
    b: Uint8Array.from({ length: count }, (_, index) => offset + 20 + index),
    transient: Uint8Array.from(
      { length: count },
      (_, index) => offset + 30 + index,
    ),
  };
}

test("the session atlas freezes absolute detail cells across shifted reanalysis", () => {
  const atlas = createPlaybackWaveformAtlas(9);
  const first = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1, 1.01, [0.1, 0.2, 0.3, 0.4], 10),
  );
  const shifted = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1.005, 1.015, [0.8, 0.8, 0.8, 0.8], 100),
  );

  assert.equal(first.source_start, 1);
  assert.equal(first.source_end, 1.01);
  assert.equal(shifted.source_start, 1.005);
  assert.equal(shifted.source_end, 1.015);
  assert.deepEqual(
    [...shifted.amp],
    [...Float32Array.from([first.amp[2], first.amp[3], 0.8, 0.8])],
  );
  assert.deepEqual([...shifted.r], [first.r[2], first.r[3], 102, 103]);

  const revisited = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1, 1.01, [0.9, 0.9, 0.9, 0.9], 200),
  );
  assert.deepEqual([...revisited.amp], [...first.amp]);
  assert.deepEqual([...revisited.r], [...first.r]);
  assert.deepEqual([...revisited.transient!], [...first.transient!]);
});

test("frame-aligned PCM windows snap to the same whole-track detail lattice", () => {
  const atlas = createPlaybackWaveformAtlas(9);
  const first = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1.001, 1.011, [0.1, 0.2, 0.3, 0.4], 10),
  );
  const shifted = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1.006, 1.016, [0.9, 0.9, 0.9, 0.9], 100),
  );

  assert.equal(first.source_start, 1.0025);
  assert.equal(first.source_end, 1.01);
  assert.equal(shifted.source_start, 1.0075);
  assert.equal(shifted.source_end, 1.015);
  assert.equal(shifted.amp[0], first.amp[2]);
  assert.equal(shifted.r[0], first.r[2]);
});

test("the sparse session atlas serves revisited online columns without inventing gaps", () => {
  const atlas = createPlaybackWaveformAtlas(9);
  stabilizePlaybackWaveformWindow(
    atlas,
    wave(1, 1.01, [0.1, 0.2, 0.3, 0.4], 10),
  );
  const revisited = playbackWaveformAtlasWindow(atlas, 1.005, 0.02);
  assert.ok(revisited);
  assert.equal(revisited.source_start, 0.995);
  assert.equal(revisited.source_end, 1.015);
  assert.equal(Array.from(revisited.known ?? []).filter(Boolean).length, 4);
  assert.ok(Math.abs((revisited.amp[2] ?? 0) - 0.1) < 1e-6);
  assert.ok(Math.abs((revisited.amp[5] ?? 0) - 0.4) < 1e-6);
});

test("Manager presentation never joins two known atlas islands across an internal gap", () => {
  const atlas = createPlaybackWaveformAtlas(9);
  stabilizePlaybackWaveformWindow(
    atlas,
    wave(0, 3, [0.1, 0.2, 0.3, 0.4], 10),
  );
  stabilizePlaybackWaveformWindow(
    atlas,
    wave(4, 8, [0.5, 0.6, 0.7, 0.8], 100),
  );

  const sparse = playbackWaveformAtlasWindow(atlas, 4, 8);
  assert.ok(sparse);
  assert.ok(
    Array.from(sparse.known ?? []).some((value) => !value),
    "the reproduction requires a real unknown interval between later approved pixels",
  );

  const visible = playbackWaveformContiguousAtlasWindow(atlas, 4, 8, 1.5, 2);
  assert.ok(visible);
  assert.deepEqual([visible.source_start, visible.source_end], [0, 3]);
  assert.ok(Array.from(visible.known ?? []).every(Boolean));
  assert.ok(
    [...visible.r].every((value) => value < 100),
    "pixels from the later island must not be painted beyond an unknown gap",
  );
  assert.equal(
    playbackWaveformContiguousAtlasWindow(atlas, 4, 8, 3.5, 1),
    null,
    "a viewport that itself crosses the gap must wait for continuous PCM",
  );
});

test("a completed full-detail asset fills unseen cells without repainting visible detail", () => {
  const atlas = createPlaybackWaveformAtlas(9);
  const visible = stabilizePlaybackWaveformWindow(
    atlas,
    wave(1, 1.01, [0.1, 0.2, 0.3, 0.4], 10),
  );

  // Simulate the background whole-song cache arriving with deliberately different normalization
  // and colours across both the visible overlap and previously unseen outer columns.
  stabilizePlaybackWaveformWindow(
    atlas,
    wave(0.995, 1.015, new Array<number>(8).fill(0.9), 100),
  );
  const takenOver = playbackWaveformAtlasWindow(atlas, 1.005, 0.02);
  assert.ok(takenOver);

  assert.deepEqual(
    [...takenOver.amp],
    [...Float32Array.from([0.9, 0.9, ...visible.amp, 0.9, 0.9])],
  );
  assert.deepEqual([...takenOver.r], [100, 101, ...visible.r, 106, 107]);
  assert.deepEqual(
    [...takenOver.transient!],
    [130, 131, ...visible.transient!, 136, 137],
  );
});
