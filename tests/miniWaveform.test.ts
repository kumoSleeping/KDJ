import assert from "node:assert/strict";
import test from "node:test";
import {
  MINI_WAVE_BARS,
  MINI_WAVE_HEIGHT,
  MINI_WAVE_PITCH,
  MINI_WAVE_STROKE,
  miniWaveformLevels,
  miniWaveformPath,
  seekFraction,
} from "../src/components/player/miniWaveform";

test("the mini waveform: a few dozen levels from an overview, the loudest stretch full height", () => {
  assert.equal(miniWaveformLevels(null), null);
  assert.equal(miniWaveformLevels([]), null);
  assert.equal(miniWaveformLevels(new Float32Array(4096)), null, "silence has no shape");

  // Quiet first half, loud second half.
  const amp = new Float32Array(4096).map((_, index) => index < 2048 ? 0.1 : 0.8);
  const levels = miniWaveformLevels(amp)!;
  assert.equal(levels.length, MINI_WAVE_BARS);
  assert.ok(levels.every(level => level > 0 && level <= 1));
  assert.equal(levels[MINI_WAVE_BARS - 1], 1);
  assert.ok(levels[0] < levels[MINI_WAVE_BARS - 1] / 2, "the quiet half is clearly lower");
  assert.ok(Math.abs(levels[0] - levels[10]) < 1e-9, "an even stretch is even bars");

  // Fewer samples than bars still gives every bar a level; odd values do not break it.
  const short = miniWaveformLevels([0.2, Number.NaN, -0.6], 6)!;
  assert.equal(short.length, 6);
  assert.ok(short.every(Number.isFinite));
});

test("the mini waveform's path keeps every bar, round caps included, inside its box", () => {
  const path = miniWaveformPath([0, 0.5, 1, 4]);
  const bars = [...path.matchAll(/M([\d.]+) ([\d.]+)V([\d.]+)/g)].map(match => match.slice(1).map(Number));
  assert.equal(bars.length, 4);
  bars.forEach(([x, top, bottom], bar) => {
    assert.equal(x, bar * MINI_WAVE_PITCH + MINI_WAVE_PITCH / 2);
    assert.ok(top >= MINI_WAVE_STROKE / 2 - 1e-9 && bottom <= MINI_WAVE_HEIGHT - MINI_WAVE_STROKE / 2 + 1e-9);
    assert.ok(Math.abs((top + bottom) / 2 - MINI_WAVE_HEIGHT / 2) < 0.01, "centred on the middle line");
  });
  assert.equal(bars[0][1], bars[0][2], "a level of nothing is a dot");
  assert.deepEqual(bars[2].slice(1), bars[3].slice(1), "a level past full is full");
});

test("seeking on the line: the pointer's place along it, kept inside", () => {
  assert.equal(seekFraction(150, 100, 200), 0.25);
  assert.equal(seekFraction(40, 100, 200), 0);
  assert.equal(seekFraction(900, 100, 200), 1);
  assert.equal(seekFraction(150, 100, 0), 0, "a line that is not laid out seeks nowhere");
});
