import assert from "node:assert/strict";
import test from "node:test";
import {
  clampJogPosition,
  MIDI_JOG_CURSOR_STALE_MS,
  MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK,
  MIDI_JOG_TICKS_PER_REVOLUTION,
  MIDI_JOG_VINYL_RPM,
  midiJogCursorPosition,
  midiJogNudgeAmount,
  midiJogNudgeRate,
  midiJogSeekSeconds,
  midiJogMode,
  midiJogVinylSeconds,
} from "../src/lib/midiJog";
import {
  PLATTER_MAX_RATE,
  PLATTER_RELEASE_MEMORY_MS,
  PLATTER_SECONDS_PER_REVOLUTION,
  PlatterVelocityTracker,
  pointerPlatterDistance,
} from "../src/lib/platter";
import { PERFORMANCE_PREROLL_SECONDS } from "../src/lib/deckPosition";

test("held vinyl motion maps one platter revolution to 33⅓ RPM of audio", () => {
  const secondsPerRevolution = 60 / MIDI_JOG_VINYL_RPM;
  assert.equal(
    midiJogVinylSeconds(1),
    secondsPerRevolution / MIDI_JOG_TICKS_PER_REVOLUTION,
  );
  const oneRevolution = Array.from(
    { length: MIDI_JOG_TICKS_PER_REVOLUTION },
    () => midiJogVinylSeconds(1),
  ).reduce((total, step) => total + step, 0);
  assert.ok(Math.abs(oneRevolution - 1.8) < 1e-12, "360 ticks at 33⅓ RPM must be 1.8s of audio");
  assert.equal(midiJogVinylSeconds(0), 0);
});
test("pointer and MIDI motion normalize to the same 1x platter velocity", () => {
  const pointer = new PlatterVelocityTracker();
  pointer.start(1_000);
  const pointerRate = pointer.move(
    pointerPlatterDistance(-1_000, 1_000),
    1_000 + PLATTER_SECONDS_PER_REVOLUTION * 1_000,
  );
  assert.ok(Math.abs(pointerRate - 1) < 1e-12);

  const midi = new PlatterVelocityTracker();
  midi.start(2_000);
  const oneMidiRevolution = Array.from(
    { length: MIDI_JOG_TICKS_PER_REVOLUTION },
    () => midiJogVinylSeconds(1),
  ).reduce((sum, distance) => sum + distance, 0);
  const midiRate = midi.move(
    oneMidiRevolution,
    2_000 + PLATTER_SECONDS_PER_REVOLUTION * 1_000,
  );
  assert.ok(Math.abs(midiRate - 1) < 1e-12);
});

test("a faster flick produces more speed and release preserves only a fresh throw", () => {
  const tracker = new PlatterVelocityTracker();
  tracker.start(0);
  const slow = tracker.move(0.1, 100);
  const fast = tracker.move(0.1, 110);
  assert.ok(fast > slow);
  assert.equal(tracker.end(110 + PLATTER_RELEASE_MEMORY_MS), fast);

  const bounded = new PlatterVelocityTracker();
  bounded.start(0);
  assert.equal(bounded.move(1, 1), PLATTER_MAX_RATE, "stream-safe native speed is bounded");

  tracker.start(1_000);
  tracker.move(0.1, 1_010);
  assert.equal(tracker.end(1_011 + PLATTER_RELEASE_MEMORY_MS), 0);
});

test("quantized packet timing is averaged but a real direction reversal stays immediate", () => {
  const tracker = new PlatterVelocityTracker();
  tracker.start(0);
  assert.equal(tracker.move(0.01, 8), 1.25);
  const averaged = tracker.move(0.01, 24);
  assert.ok(averaged > 0.625 && averaged < 1.25, "two uneven packets should describe one stable window");
  assert.equal(tracker.move(-0.01, 32), -1.25, "opposite hand motion must reset old history");
});

test("coalesced samples with one timestamp retain a finite continuous velocity", () => {
  const tracker = new PlatterVelocityTracker();
  tracker.start(100);
  assert.equal(tracker.move(0.008, 100), 1);
  assert.equal(tracker.move(0.008, 100), 1);
  assert.equal(tracker.end(100), 1);
});

test("Shift quick search crosses a track in a bounded number of deliberate turns", () => {
  const duration = 192;
  assert.equal(
    midiJogSeekSeconds(1, duration),
    duration / (MIDI_JOG_TICKS_PER_REVOLUTION * MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK),
  );
  assert.ok(
    Math.abs(
      midiJogSeekSeconds(1, duration)
        * MIDI_JOG_TICKS_PER_REVOLUTION
        * MIDI_JOG_QUICK_SEARCH_TURNS_PER_TRACK
        - duration,
    ) < 1e-12,
  );
});

test("fast relative vinyl packets keep their encoder ticks", () => {
  assert.equal(midiJogVinylSeconds(16) / midiJogVinylSeconds(1), 16);
  assert.equal(midiJogSeekSeconds(-16, 192) / midiJogSeekSeconds(-1, 192), 16);
  assert.equal(midiJogVinylSeconds(99), midiJogVinylSeconds(64));
  assert.equal(midiJogNudgeAmount(1), 1 / 8);
  assert.equal(midiJogNudgeAmount(-99), -1);
});

test("pitch-preserving edge nudge previews the native transient tempo without persisting it", () => {
  assert.ok(Math.abs(midiJogNudgeRate(1, 1) - 1.18) < 1e-12);
  assert.ok(Math.abs(midiJogNudgeRate(1.25, -1) - 1.025) < 1e-12);
  assert.equal(midiJogNudgeRate(2, 1), 2);
  assert.equal(midiJogNudgeRate(0.5, -1), 0.5);
});

test("capacitive touch is required for vinyl motion on a stopped Deck", () => {
  assert.equal(midiJogMode(true, true), "platter");
  assert.equal(midiJogMode(true, false), "platter");
  assert.equal(midiJogMode(false, true), "nudge");
  assert.equal(midiJogMode(false, false), "idle");
});

test("jog position stays inside the track and its bounded silent pre-roll", () => {
  assert.equal(clampJogPosition(-4, 120), -4);
  assert.equal(clampJogPosition(-PERFORMANCE_PREROLL_SECONDS - 4, 120), -PERFORMANCE_PREROLL_SECONDS);
  assert.equal(clampJogPosition(140, 120), 120);
  assert.equal(clampJogPosition(12, 120), 12);
  assert.equal(clampJogPosition(12, 0), 12, "unknown stream duration must not pin jog at 0");
  assert.equal(clampJogPosition(-3, 0), -3, "pre-roll remains available before duration metadata");
});

test("a held platter keeps its own cursor instead of following the live engine clock", () => {
  // Tick deltas and Shift+seek still accumulate a local cursor. MIDI vinyl scrolling itself
  // follows the engine needle — this cursor must not drive the waveform preview rail.
  const held = { trackId: 7, position: 12, at: 1_000 };
  assert.equal(midiJogCursorPosition(held, 7, 18, 2_000, true), 12);
  assert.equal(
    midiJogCursorPosition(held, 7, 18, 1_100, false),
    12,
    "edge-jog bursts still share a short-lived cursor",
  );
  assert.equal(
    midiJogCursorPosition(held, 7, 18, 1_000 + MIDI_JOG_CURSOR_STALE_MS, false),
    18,
    "an untouched wheel may resume from the engine after the burst window",
  );
  assert.equal(midiJogCursorPosition(held, 8, 18, 1_100, true), 18, "a replacement track starts fresh");
  assert.equal(midiJogCursorPosition(null, 7, 18, 1_100, true), 18);
});
