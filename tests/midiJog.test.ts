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
  midiJogScratchSeconds,
  midiJogSeekSeconds,
  midiJogVinylSeconds,
} from "../src/lib/midiJog";
import { beginMidiScratchHold, canResumeMidiScratchHold } from "../src/lib/midiScratchHold";

test("a non-Shift jog revolution spans one numbered bar-grid cell, not a visible waveform window", () => {
  const beat = 60 / 180;
  const bar = beat * 4;
  assert.equal(midiJogScratchSeconds(1, bar), bar / MIDI_JOG_TICKS_PER_REVOLUTION);
  assert.equal(midiJogScratchSeconds(-2, bar), -2 * bar / MIDI_JOG_TICKS_PER_REVOLUTION);
  const oneRevolution = Array.from(
    { length: MIDI_JOG_TICKS_PER_REVOLUTION },
    () => midiJogScratchSeconds(1, bar),
  ).reduce((total, step) => total + step, 0);
  assert.ok(
    Math.abs(midiJogScratchSeconds(1, bar) * MIDI_JOG_TICKS_PER_REVOLUTION - bar) < 1e-12,
    "360 relative ticks must add up to exactly one numbered bar",
  );
  assert.ok(Math.abs(oneRevolution - bar) < 1e-12, "an actual full revolution must land one bar away");
  assert.equal(midiJogScratchSeconds(0, 12), 0);
});

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

test("fast relative jog values stay bounded while preserving direction", () => {
  assert.equal(midiJogScratchSeconds(99, 2), midiJogScratchSeconds(8, 2));
  assert.equal(midiJogSeekSeconds(-99, 192), midiJogSeekSeconds(-8, 192));
  assert.equal(midiJogNudgeAmount(1), 1 / 8);
  assert.equal(midiJogNudgeAmount(-99), -1);
});

test("jog position stays inside the track", () => {
  assert.equal(clampJogPosition(-4, 120), 0);
  assert.equal(clampJogPosition(140, 120), 120);
  assert.equal(clampJogPosition(12, 120), 12);
  assert.equal(clampJogPosition(12, 0), 12, "unknown stream duration must not pin jog at 0");
  assert.equal(clampJogPosition(-3, 0), 0, "the real start of audio remains the lower bound");
});

test("a held platter keeps its own cursor instead of following the live engine clock", () => {
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

test("capacitive scratch releases only the same playing physical Deck hold", () => {
  const playing = beginMidiScratchHold(4, 101, true);
  const paused = beginMidiScratchHold(5, 102, false);
  assert.equal(canResumeMidiScratchHold(playing, 4, 101), true);
  assert.equal(canResumeMidiScratchHold(playing, 4, 103), false, "replacement track must not revive");
  assert.equal(canResumeMidiScratchHold(playing, 5, 101), false, "newer touch wins over old release");
  assert.equal(canResumeMidiScratchHold(paused, 5, 102), false, "a paused deck stays paused");
});
