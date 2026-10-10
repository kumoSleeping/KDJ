import assert from "node:assert/strict";
import test from "node:test";
import {
  BEAT_RESYNC_MS,
  FREE_CYCLE_SEC,
  PULSES_PER_CYCLE,
  anchoredCycleTime,
  beatCorrection,
  beatCycleIndex,
  beatCycleTime,
  beatDrift,
  beatSteps,
  songBeat,
  waveEnergy,
  waveLoudness,
} from "../src/lib/songColorBeat";

const near = (actual: number, expected: number, slack = 1e-6) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} ≈ ${expected}`);

test("song colour beat: the cycle is a bar of the song's grid", () => {
  const beat = songBeat({ bpm: 120, first_beat: 0.25, beat_origin: null, downbeat_origin: null, downbeat_confidence: null });
  assert.equal(beat.synced, true);
  near(beat.cycleSec, 2);
  near(beat.originSec, 0.25);
  assert.equal(beat.accented, false, "without a trusted downbeat every pulse is alike");
  // A trusted downbeat starts the cycle, wherever the first beat is.
  const barred = songBeat({ bpm: 120, first_beat: 0.25, beat_origin: 0.25, downbeat_origin: 5.75, downbeat_confidence: 0.9 });
  near(barred.originSec, 1.75);
  assert.equal(barred.accented, true);
  assert.equal(songBeat({ bpm: 120, first_beat: 0.25, downbeat_origin: 5.75, downbeat_confidence: 0.2 }).accented, false);
  // A fast song pulses on every other beat, a very slow one twice a beat; neither can start on the bar.
  const fast = songBeat({ bpm: 174, first_beat: 0, downbeat_origin: 0, downbeat_confidence: 1 });
  near(fast.cycleSec, (60 / 174) * 2 * PULSES_PER_CYCLE);
  assert.equal(fast.accented, false);
  near(songBeat({ bpm: 40, first_beat: 0 }).cycleSec, (60 / 40 / 2) * PULSES_PER_CYCLE);
  // No tempo: it breathes, in time with nothing.
  for (const track of [null, { bpm: null }, { bpm: 0 }, { bpm: Number.NaN }]) {
    const free = songBeat(track as never);
    assert.equal(free.synced, false);
    assert.equal(free.cycleSec, FREE_CYCLE_SEC);
  }
});

test("song colour beat: where the animation belongs, and when it is set again", () => {
  const beat = songBeat({ bpm: 120, first_beat: 0.25 });
  near(beatCycleTime(0.25, beat), 0);
  near(beatCycleTime(1.25, beat), 1000);
  near(beatCycleTime(2.25, beat), 0);
  near(beatCycleTime(0, beat), 1750, 1e-6);
  assert.equal(beatCycleIndex(0.2, beat), -1);
  assert.equal(beatCycleIndex(0.3, beat), 0);
  assert.equal(beatCycleIndex(4.3, beat), 2);
  // Drift is the short way round the cycle.
  near(beatDrift(100, 130, 2000), 30);
  near(beatDrift(1990, 10, 2000), 20);
  near(beatDrift(10, 1990, 2000), -20);
  // A running animation is where it was put, plus the time since, at its rate.
  near(anchoredCycleTime({ time: 500, at: 1000, rate: 1 }, 1800, 2000), 1300);
  near(anchoredCycleTime({ time: 1500, at: 1000, rate: 1.5 }, 2000, 2000), 1000);
  // No anchor (just started, sought or paused): set it to the song's place.
  near(beatCorrection(null, 1.25, 1, 5000, beat)!, 1000);
  // In step with the song's reports: left alone, however long it has run.
  const anchor = { time: 1000, at: 5000, rate: 1 };
  assert.equal(beatCorrection(anchor, 1.75, 1, 5500, beat), null);
  assert.equal(beatCorrection(anchor, 61.25 + 0.03, 1, 65_000, beat), null, "inside the tolerance");
  // The song stalled or jumped: the animation is put where the song is.
  near(beatCorrection(anchor, 1.75, 1, 5500 + BEAT_RESYNC_MS + 20, beat)!, 1500);
  near(beatCorrection(anchor, 30.25, 1, 5500, beat)!, 0);
  // Another tempo: always set again, at the new rate.
  near(beatCorrection(anchor, 1.75, 1.06, 5500, beat)!, 1500);
});

test("song colour beat: the pulse is a quick rise and a long fall, both ends written", () => {
  const steps = beatSteps(songBeat({ bpm: 128, first_beat: 0 }));
  assert.equal(steps[0].offset, 0);
  assert.equal(steps[steps.length - 1].offset, 1);
  assert.equal(steps[0].level, steps[steps.length - 1].level, "the cycle closes where it starts");
  for (let index = 1; index < steps.length; index += 1) assert.ok(steps[index].offset > steps[index - 1].offset);
  const peaks = steps.filter(step => step.level > 0);
  assert.equal(peaks.length, PULSES_PER_CYCLE);
  for (const peak of peaks) assert.ok(peak.offset % (1 / PULSES_PER_CYCLE) < 0.05, "the rise is a small part of the pulse");
  assert.ok(new Set(peaks.map(peak => peak.level)).size === 1);
  const barred = beatSteps(songBeat({ bpm: 128, first_beat: 0, downbeat_origin: 0, downbeat_confidence: 1 })).filter(step => step.level > 0);
  assert.ok(barred[0].level > barred[1].level, "the downbeat is the strongest");
  const free = beatSteps(songBeat(null));
  assert.equal(free.filter(step => step.level > 0).length, 1, "one slow swell without a tempo");
});

test("song colour beat: the song's energy comes from its overview", () => {
  // A song that is quiet for its first half and loud for the second.
  const amp = Float32Array.from({ length: 4096 }, (_, index) => index < 2048 ? 0.1 : 0.8);
  const loud = waveLoudness(amp);
  near(loud, 0.8, 1e-6);
  near(waveEnergy(amp, loud, 200, 10, 2), 0.125, 1e-6);
  near(waveEnergy(amp, loud, 200, 150, 2), 1, 1e-6);
  assert.equal(waveEnergy(null, loud, 200, 10, 2), 0.6, "nothing to read");
  assert.equal(waveEnergy(amp, 0, 200, 10, 2), 0.6);
  assert.equal(waveEnergy(amp, loud, 0, 10, 2), 0.6);
  near(waveEnergy(amp, loud, 200, 500, 2), 1, 1e-6);
});
