/**
 * The mini waveform of the playing song's bubble: a few dozen rounded bars cut from the song's
 * overview, small enough to be the bubble's progress line. Pure geometry; NowPlayingTransport
 * draws it once per song and only moves the split between what was played and what is left.
 */
export const MINI_WAVE_BARS = 48;
/** The box the bars are drawn in, in px. Its width is stretched to the line; its height is not. */
export const MINI_WAVE_HEIGHT = 18;
/** One bar's place along the box. */
export const MINI_WAVE_PITCH = 4;
/** The stroke of a bar, in px; its round caps are part of its height. */
export const MINI_WAVE_STROKE = 2.5;
/** The shortest bar is a dot, so a quiet passage still reads as part of the song. */
const QUIET = 0.12;

/**
 * `count` levels 0..1 from an overview's amplitudes: each bar is the mean of its stretch of the
 * song, relative to the loudest bar. Null when there is nothing to draw (no samples, silence).
 */
export function miniWaveformLevels(amp: ArrayLike<number> | null | undefined, count = MINI_WAVE_BARS): number[] | null {
  const length = amp?.length ?? 0;
  if (!amp || length === 0 || count <= 0) return null;
  const means: number[] = [];
  let loudest = 0;
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.floor((bar * length) / count);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * length) / count));
    let sum = 0;
    for (let index = from; index < to && index < length; index += 1) {
      const value = amp[index];
      sum += Number.isFinite(value) ? Math.abs(value) : 0;
    }
    const mean = sum / (to - from);
    means.push(mean);
    loudest = Math.max(loudest, mean);
  }
  if (loudest <= 0) return null;
  // A little compression: the body of a loud song does not flatten into one block.
  return means.map(mean => QUIET + (1 - QUIET) * Math.pow(mean / loudest, 0.8));
}

/**
 * The bars as one SVG path in a box `levels.length * MINI_WAVE_PITCH` wide and MINI_WAVE_HEIGHT
 * high: a vertical stroke per bar, centred on the middle line, its round caps inside the box.
 */
export function miniWaveformPath(levels: readonly number[]): string {
  const middle = MINI_WAVE_HEIGHT / 2;
  const reach = (MINI_WAVE_HEIGHT - MINI_WAVE_STROKE) / 2;
  return levels.map((level, bar) => {
    const half = Math.max(0, Math.min(1, level)) * reach;
    const x = bar * MINI_WAVE_PITCH + MINI_WAVE_PITCH / 2;
    return `M${x} ${(middle - half).toFixed(2)}V${(middle + half).toFixed(2)}`;
  }).join("");
}

/** Where along a line of `width` px starting at `left` the pointer is, 0..1. */
export function seekFraction(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}
