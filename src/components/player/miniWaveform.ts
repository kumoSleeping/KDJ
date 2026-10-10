/**
 * The mini waveform of the playing song's bubble: a few dozen rounded bars cut from the song's
 * overview, small enough to be the bubble's progress line. Each bar reaches up and down as far as
 * the sound does there and takes the song's own colour at that point. Pure geometry and grouping;
 * NowPlayingTransport draws it once per song and only moves the split between what was played
 * and what is left.
 */
/** The bars of a line about 250 px long, and of one that is not laid out yet. */
export const MINI_WAVE_BARS = 48;
/**
 * A bar's share of the line on screen, in px, and the most bars a line is given. The count
 * follows the line's width in steps, so a window being sized redraws the wave now and then,
 * not on every pixel.
 */
const BAR_SPAN = 5.25;
const BAR_STEP = 8;
export const MINI_WAVE_MAX_BARS = 192;

/** How many bars a line `width` px long has room for; MINI_WAVE_BARS before it is laid out. */
export function miniWaveformBars(width: number): number {
  if (!(width > 0)) return MINI_WAVE_BARS;
  const bars = Math.round(width / BAR_SPAN / BAR_STEP) * BAR_STEP;
  return Math.min(MINI_WAVE_MAX_BARS, Math.max(MINI_WAVE_BARS / 2, bars));
}

/** The box the bars are drawn in, in px. Its width is stretched to the line; its height is not. */
export const MINI_WAVE_HEIGHT = 18;
/** One bar's place along the box. */
export const MINI_WAVE_PITCH = 4;
/** The stroke of a bar, in px; its round caps are part of its height. */
export const MINI_WAVE_STROKE = 2.5;
/** The most colours the bars of one line are drawn in: one path each, however many bars. */
export const MINI_WAVE_COLOURS = 16;
/** The shortest bar is a dot, so a quiet passage still reads as part of the song. */
const QUIET = 0.12;
/**
 * The overview's envelope is already compressed for a tall rail. On a strip this low that reads
 * as one block, so the bars take a little of it back: a passage half as loud is clearly lower,
 * and a quiet one still stands above the dot.
 */
const LOUDNESS_CURVE = 1.2;
/**
 * What full height means while a part of the song is still unknown (an online song that is
 * loading). Measuring against the loudest bar so far would resize every bar each time a louder
 * passage arrived; the usual level of a song's loudest stretch keeps them where they are.
 */
const GROWING_FULL_LEVEL = 0.85;
/**
 * The part of a pitch a stretch of the rail keeps clear of the bars beside it, so its round
 * ends do not touch them.
 */
const RAIL_INSET = 0.4;

/** The columns of an overview the bars are cut from (see `Waveform` in types.ts). */
export interface MiniWaveSource {
  amp: ArrayLike<number>;
  /** The signed envelope; a source without it is drawn as ±amp. */
  minimum?: ArrayLike<number>;
  maximum?: ArrayLike<number>;
  r: ArrayLike<number>;
  g: ArrayLike<number>;
  b: ArrayLike<number>;
  /** Which columns were really analysed; all of them when absent. */
  known?: ArrayLike<boolean | number>;
}

/**
 * One bar: how far it reaches above and below the middle line, 0..1 each, and the song's colour
 * coordinates (low / mid / high strength, 0..255) over its stretch.
 */
export interface MiniWaveBar {
  up: number;
  down: number;
  r: number;
  g: number;
  b: number;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * `count` bars from an overview. A bar is the mean of its stretch of the song — above and below
 * the middle line separately, so a sound that swings further one way shows it — relative to the
 * loudest bar and eased by LOUDNESS_CURVE. A stretch nothing is known about yet is null. Null
 * altogether when there is nothing to draw (no columns, silence, nothing known).
 */
export function miniWaveformLevels(
  wave: MiniWaveSource | null | undefined,
  count = MINI_WAVE_BARS,
): (MiniWaveBar | null)[] | null {
  const length = wave?.amp.length ?? 0;
  if (!wave || length === 0 || count <= 0) return null;
  const { amp, known, r, g, b } = wave;
  const contour = wave.minimum?.length === length && wave.maximum?.length === length;
  const raw: (MiniWaveBar | null)[] = [];
  let loudest = 0;
  let growing = false;
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.floor((bar * length) / count);
    const to = Math.min(length, Math.max(from + 1, Math.floor(((bar + 1) * length) / count)));
    let columns = 0;
    let up = 0;
    let down = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let index = from; index < to; index += 1) {
      if (known && !known[index]) continue;
      const level = Math.abs(finite(amp[index]));
      columns += 1;
      up += contour ? Math.max(0, finite(wave.maximum![index])) : level;
      down += contour ? Math.max(0, -finite(wave.minimum![index])) : level;
      // As the overview itself is drawn: the colour of a quiet column counts for little.
      const share = level + 0.001;
      red += finite(r[index]) * share;
      green += finite(g[index]) * share;
      blue += finite(b[index]) * share;
      weight += share;
    }
    if (columns === 0) {
      growing = true;
      raw.push(null);
      continue;
    }
    up /= columns;
    down /= columns;
    loudest = Math.max(loudest, up, down);
    raw.push({ up, down, r: red / weight, g: green / weight, b: blue / weight });
  }
  if (loudest <= 0) return null;
  const full = growing ? GROWING_FULL_LEVEL : loudest;
  const eased = (level: number) => QUIET + (1 - QUIET) * Math.pow(Math.min(1, level / full), LOUDNESS_CURVE);
  return raw.map(bar => bar && { ...bar, up: eased(bar.up), down: eased(bar.down) });
}

/** A display colour, 0..255 a channel. */
export type MiniWaveRgb = readonly [number, number, number];

/** The bars of one colour as one path, and the stretches of the song that have no bars yet. */
export interface MiniWaveShape {
  strokes: { colour: MiniWaveRgb; path: string }[];
  /** The unknown stretches as a line along the middle; "" when every bar is known. */
  rail: string;
}

/** The colour steps tried, finest first, until the bars fit in the colours a line may have. */
const COLOUR_STEPS = [12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 256];

/**
 * The bars as SVG paths in a box `bars.length * MINI_WAVE_PITCH` wide and MINI_WAVE_HEIGHT high:
 * a vertical stroke per bar from its upper to its lower reach, round caps inside the box.
 *
 * A bar's colour is `colourOf` its coordinates. Bars whose colours fall in the same cell of a
 * fixed grid share a path, drawn in the mean of their colours, so a line of any length is at
 * most `colours` paths. The grid does not depend on the other bars: a bar keeps its colour
 * while more of the song arrives, unless the line then needs a coarser grid.
 */
export function miniWaveformShape(
  bars: readonly (MiniWaveBar | null)[],
  colourOf: (r: number, g: number, b: number) => MiniWaveRgb,
  colours = MINI_WAVE_COLOURS,
): MiniWaveShape {
  const middle = MINI_WAVE_HEIGHT / 2;
  const reach = (MINI_WAVE_HEIGHT - MINI_WAVE_STROKE) / 2;
  const side = (level: number) => Math.max(0, Math.min(1, finite(level))) * reach;
  const drawn: { colour: MiniWaveRgb; stroke: string }[] = [];
  let rail = "";
  let gap = -1;
  bars.forEach((bar, index) => {
    if (!bar) {
      if (gap < 0) gap = index;
      return;
    }
    if (gap >= 0) rail += railStretch(gap, index);
    gap = -1;
    const x = index * MINI_WAVE_PITCH + MINI_WAVE_PITCH / 2;
    drawn.push({
      colour: colourOf(bar.r, bar.g, bar.b),
      stroke: `M${x} ${(middle - side(bar.up)).toFixed(2)}V${(middle + side(bar.down)).toFixed(2)}`,
    });
  });
  if (gap >= 0) rail += railStretch(gap, bars.length);

  const limit = Math.max(1, Math.floor(colours));
  let cells = new Map<string, typeof drawn>();
  for (const step of COLOUR_STEPS) {
    cells = new Map();
    for (const bar of drawn) {
      const cell = bar.colour.map(channel => Math.floor(Math.max(0, Math.min(255, channel)) / step)).join(",");
      const members = cells.get(cell);
      if (members) members.push(bar);
      else cells.set(cell, [bar]);
    }
    if (cells.size <= limit) break;
  }
  const strokes = [...cells.values()].map(members => ({
    colour: [0, 1, 2].map(channel => Math.round(
      members.reduce((sum, bar) => sum + bar.colour[channel], 0) / members.length,
    )) as unknown as MiniWaveRgb,
    path: members.map(bar => bar.stroke).join(""),
  }));
  return { strokes, rail };
}

/** The rail under bars `from` up to `to`: one line along the middle, clear of its neighbours. */
function railStretch(from: number, to: number): string {
  const middle = MINI_WAVE_HEIGHT / 2;
  const start = (from + RAIL_INSET) * MINI_WAVE_PITCH;
  const end = (to - RAIL_INSET) * MINI_WAVE_PITCH;
  return `M${+start.toFixed(2)} ${middle}H${+end.toFixed(2)}`;
}

/** Where along a line of `width` px starting at `left` the pointer is, 0..1. */
export function seekFraction(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}
