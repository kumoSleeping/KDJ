import assert from "node:assert/strict";
import test from "node:test";
import {
  MINI_WAVE_BARS,
  MINI_WAVE_COLOURS,
  MINI_WAVE_HEIGHT,
  MINI_WAVE_PITCH,
  MINI_WAVE_MAX_BARS,
  MINI_WAVE_STROKE,
  miniWaveformBars,
  miniWaveformLevels,
  miniWaveformShape,
  seekFraction,
  type MiniWaveBar,
  type MiniWaveSource,
} from "../src/components/player/miniWaveform";

/** An overview of `length` columns: `level(index)` is its amplitude, drawn evenly both ways. */
function overview(length: number, level: (index: number) => number, more: Partial<MiniWaveSource> = {}): MiniWaveSource {
  const amp = Float32Array.from({ length }, (_, index) => level(index));
  return {
    amp,
    minimum: amp.map(value => -value),
    maximum: amp,
    r: new Uint8Array(length).fill(200),
    g: new Uint8Array(length).fill(40),
    b: new Uint8Array(length).fill(40),
    ...more,
  };
}

/** The strokes of a path: where each bar stands and how far up and down it reaches. */
function strokesOf(path: string): [x: number, top: number, bottom: number][] {
  return [...path.matchAll(/M([\d.]+) ([\d.]+)V([\d.]+)/g)].map(match => match.slice(1).map(Number) as [number, number, number]);
}

test("the mini waveform: a few dozen bars from an overview, the loudest stretch full height", () => {
  assert.equal(miniWaveformLevels(null), null);
  assert.equal(miniWaveformLevels(overview(0, () => 0)), null);
  assert.equal(miniWaveformLevels(overview(4096, () => 0)), null, "silence has no shape");

  // Quiet first half, loud second half.
  const bars = miniWaveformLevels(overview(4096, index => index < 2048 ? 0.1 : 0.8))!;
  assert.equal(bars.length, MINI_WAVE_BARS);
  assert.ok(bars.every(bar => bar && bar.up > 0 && bar.up <= 1 && bar.down > 0 && bar.down <= 1));
  assert.equal(bars[MINI_WAVE_BARS - 1]!.up, 1);
  assert.ok(bars[0]!.up < bars[MINI_WAVE_BARS - 1]!.up / 3, "the quiet half is clearly lower");
  assert.ok(bars[0]!.up > 0.15, "and still stands above a dot");
  assert.ok(Math.abs(bars[0]!.up - bars[10]!.up) < 1e-9, "an even stretch is even bars");

  // Fewer columns than bars still gives every bar a level; odd values do not break it.
  const short = miniWaveformLevels({ amp: [0.2, Number.NaN, -0.6], r: [1, 2, 3], g: [1, 2, 3], b: [1, 2, 3] }, 6)!;
  assert.equal(short.length, 6);
  assert.ok(short.every(bar => bar && Number.isFinite(bar.up) && Number.isFinite(bar.down) && Number.isFinite(bar.r)));
  assert.equal(short[0]!.up, short[0]!.down, "without an envelope a bar is as high as it is deep");
});

test("the heights follow the loudness finely: every step of a slow swell is its own height", () => {
  const bars = miniWaveformLevels(overview(4096, index => 0.05 + 0.9 * (index / 4095)))!;
  for (let bar = 1; bar < bars.length; bar += 1) {
    assert.ok(bars[bar]!.up > bars[bar - 1]!.up, `bar ${bar} is higher than the one before`);
  }
  // Half as loud is clearly lower, not a block of nearly equal bars.
  const half = miniWaveformLevels(overview(4096, index => index < 2048 ? 0.4 : 0.8))!;
  assert.ok(half[0]!.up < 0.6 && half[0]!.up > 0.4);
});

test("a bar reaches up and down as far as the sound does", () => {
  const length = 4096;
  const amp = new Float32Array(length).fill(0.8);
  // The first half swings mostly upwards, the second half mostly downwards.
  const maximum = Float32Array.from({ length }, (_, index) => index < length / 2 ? 0.8 : 0.3);
  const minimum = Float32Array.from({ length }, (_, index) => index < length / 2 ? -0.3 : -0.8);
  const bars = miniWaveformLevels(overview(length, () => 0.8, { amp, maximum, minimum }))!;
  const first = bars[0]!, last = bars[MINI_WAVE_BARS - 1]!;
  assert.equal(first.up, 1);
  assert.ok(first.down < first.up * 0.5, "the lower side of an upward sound is shorter");
  assert.equal(last.down, 1);
  assert.ok(last.up < last.down * 0.5);

  const [upward] = strokesOf(miniWaveformShape([first], () => [0, 0, 0]).strokes[0].path);
  const middle = MINI_WAVE_HEIGHT / 2;
  assert.ok(middle - upward[1] > upward[2] - middle + 2, "and is drawn so, off the middle line");
});

test("a bar takes the colour of the loud part of its stretch", () => {
  const length = 96;
  // Each bar: a loud red column and a quiet blue one.
  const wave = overview(length, index => index % 2 ? 0.02 : 0.9, {
    r: Uint8Array.from({ length }, (_, index) => index % 2 ? 0 : 255),
    g: new Uint8Array(length),
    b: Uint8Array.from({ length }, (_, index) => index % 2 ? 255 : 0),
  });
  const bar = miniWaveformLevels(wave)![0]!;
  assert.ok(bar.r > 240 && bar.b < 15, "the quiet column hardly counts");
});

test("an online song that is still loading: bars where it is known, the rail where it is not", () => {
  const length = 4096;
  const known = Uint8Array.from({ length }, (_, index) => index < length / 4 ? 1 : 0);
  const bars = miniWaveformLevels(overview(length, () => 0.3, { known }))!;
  assert.equal(bars.length, MINI_WAVE_BARS, "the bars stay where they are along the song");
  assert.ok(bars.slice(0, MINI_WAVE_BARS / 4).every(Boolean));
  assert.ok(bars.slice(MINI_WAVE_BARS / 4).every(bar => bar === null));
  assert.equal(miniWaveformLevels(overview(length, () => 0.3, { known: new Uint8Array(length) })), null, "nothing known yet");

  // More of the song arriving, a louder passage included, leaves the bars already drawn alone.
  const more = Uint8Array.from({ length }, (_, index) => index < length / 2 ? 1 : 0);
  const grown = miniWaveformLevels(overview(length, index => index < length / 4 ? 0.3 : 0.8, { known: more }))!;
  assert.deepEqual(grown.slice(0, MINI_WAVE_BARS / 4), bars.slice(0, MINI_WAVE_BARS / 4));
  assert.ok(grown[MINI_WAVE_BARS / 4]!.up > bars[0]!.up);

  const shape = miniWaveformShape(bars, () => [10, 20, 30]);
  assert.equal(strokesOf(shape.strokes.map(stroke => stroke.path).join("")).length, MINI_WAVE_BARS / 4);
  const [, from, to] = /^M([\d.]+) 9H([\d.]+)$/.exec(shape.rail)!.map(Number);
  assert.ok(from > (MINI_WAVE_BARS / 4) * MINI_WAVE_PITCH && from < (MINI_WAVE_BARS / 4 + 0.5) * MINI_WAVE_PITCH, "the rail starts clear of the last bar");
  assert.ok(to < MINI_WAVE_BARS * MINI_WAVE_PITCH && to > (MINI_WAVE_BARS - 0.5) * MINI_WAVE_PITCH, "and ends inside the box");
  assert.equal(miniWaveformShape(grown.map(bar => bar ?? grown[0]), () => [0, 0, 0]).rail, "", "a whole song has no rail");

  // A gap in the middle (a seek ahead) is its own stretch of rail.
  const holed = bars.map((bar, index) => index >= 40 ? bars[0] : bar);
  assert.equal(miniWaveformShape(holed, () => [0, 0, 0]).rail.match(/M/g)!.length, 1);
  assert.equal(miniWaveformShape(holed.map((bar, index) => index < 2 ? null : bar), () => [0, 0, 0]).rail.match(/M/g)!.length, 2);
});

test("the shape keeps every bar, round caps included, inside its box", () => {
  const bar = (up: number, down = up): MiniWaveBar => ({ up, down, r: 0, g: 0, b: 0 });
  const shape = miniWaveformShape([bar(0), bar(0.5), bar(1), bar(4), bar(1, 0.25)], () => [1, 2, 3]);
  assert.equal(shape.strokes.length, 1, "bars of one colour are one path");
  assert.deepEqual(shape.strokes[0].colour, [1, 2, 3]);
  const bars = strokesOf(shape.strokes[0].path);
  assert.equal(bars.length, 5);
  bars.forEach(([x, top, bottom], index) => {
    assert.equal(x, index * MINI_WAVE_PITCH + MINI_WAVE_PITCH / 2);
    assert.ok(top >= MINI_WAVE_STROKE / 2 - 1e-9 && bottom <= MINI_WAVE_HEIGHT - MINI_WAVE_STROKE / 2 + 1e-9);
  });
  assert.equal(bars[0][1], bars[0][2], "a level of nothing is a dot");
  assert.deepEqual(bars[2].slice(1), bars[3].slice(1), "a level past full is full");
  assert.ok(Math.abs((bars[1][1] + bars[1][2]) / 2 - MINI_WAVE_HEIGHT / 2) < 0.01, "an even bar is centred on the middle line");
  assert.equal(bars[4][1], bars[2][1]);
  assert.ok(bars[4][2] < bars[2][2]);
});

test("the bars of a line are drawn in a few colours, each bar close to its own", () => {
  // The longest line, every bar another colour: a slow sweep through the song's three bands.
  const bars: MiniWaveBar[] = Array.from({ length: MINI_WAVE_MAX_BARS }, (_, index) => {
    const turn = (index / MINI_WAVE_MAX_BARS) * Math.PI * 2;
    return {
      up: 1,
      down: 1,
      r: 128 + 127 * Math.cos(turn),
      g: 128 + 127 * Math.cos(turn - 2.1),
      b: 128 + 127 * Math.cos(turn + 2.1),
    };
  });
  const own = (r: number, g: number, b: number) => [r, g, b] as const;
  const shape = miniWaveformShape(bars, own);
  assert.ok(shape.strokes.length > 4 && shape.strokes.length <= MINI_WAVE_COLOURS);
  const drawn = new Map<number, readonly number[]>();
  for (const stroke of shape.strokes) {
    for (const [x] of strokesOf(stroke.path)) {
      assert.ok(!drawn.has(x), "a bar is drawn once");
      drawn.set(x, stroke.colour);
    }
  }
  assert.equal(drawn.size, MINI_WAVE_MAX_BARS, "every bar is drawn");
  bars.forEach((bar, index) => {
    const colour = drawn.get(index * MINI_WAVE_PITCH + MINI_WAVE_PITCH / 2)!;
    const off = Math.max(Math.abs(colour[0] - bar.r), Math.abs(colour[1] - bar.g), Math.abs(colour[2] - bar.b));
    assert.ok(off < 64, `bar ${index} is ${off} off its colour`);
  });

  // A song of two colours is two paths, in exactly those colours, whatever else is in the line.
  const two = miniWaveformShape(bars.map((bar, index) => ({ ...bar, r: index % 2 ? 250 : 20, g: 30, b: index % 2 ? 20 : 250 })), own);
  assert.deepEqual(two.strokes.map(stroke => stroke.colour), [[20, 30, 250], [250, 30, 20]]);
  // A bar keeps its colour while more of the song arrives.
  const fewer = miniWaveformShape(bars.slice(0, 24).map((bar, index) => ({ ...bar, r: index % 2 ? 250 : 20, g: 30, b: index % 2 ? 20 : 250 })), own);
  assert.deepEqual(fewer.strokes.map(stroke => stroke.colour), two.strokes.map(stroke => stroke.colour));
});

test("seeking on the line: the pointer's place along it, kept inside", () => {
  assert.equal(seekFraction(150, 100, 200), 0.25);
  assert.equal(seekFraction(40, 100, 200), 0);
  assert.equal(seekFraction(900, 100, 200), 1);
  assert.equal(seekFraction(150, 100, 0), 0, "a line that is not laid out seeks nowhere");
});

test("the bars follow the line's width, in steps and within bounds", () => {
  assert.equal(miniWaveformBars(0), MINI_WAVE_BARS, "not laid out yet");
  assert.equal(miniWaveformBars(Number.NaN), MINI_WAVE_BARS);
  assert.equal(miniWaveformBars(250), MINI_WAVE_BARS, "the line of the bubble at its usual width");
  assert.equal(miniWaveformBars(40), MINI_WAVE_BARS / 2, "a short line keeps a readable shape");
  assert.equal(miniWaveformBars(540), 104, "a long line shows more of the song");
  assert.equal(miniWaveformBars(545), miniWaveformBars(540), "a few pixels do not redraw it");
  assert.equal(miniWaveformBars(5000), MINI_WAVE_MAX_BARS);
});
