/**
 * Perceptual display palette for three-band DJ waveform data.
 *
 * Cached R/G/B values are semantic low/mid/high strengths, not literal screen colours. Height
 * already carries loudness, so the display palette keeps even quiet passages bright. Chroma is
 * restrained by lifting secondary channels toward a cool near-white anchor instead of lowering
 * the dominant channel; frequency identity and section changes therefore remain visible.
 */

export type WaveformDisplayRgb = readonly [number, number, number];

const SOFT_NEUTRAL: readonly [number, number, number] = [0.9, 0.94, 1];
const SEMANTIC_COLOR_MIX = 0.58;
const NEUTRAL_VALUE = 174;
const COLOR_VALUE_LIFT = 54;
const AMPLITUDE_VALUE_LIFT = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** v0.2.41 overview treated cached RGB as literal screen colour; do not soften it. */
export function releaseOverviewWaveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
): WaveformDisplayRgb {
  return [lowValue, midValue, highValue].map((value) =>
    Math.round(clamp(value, 0, 255))
  ) as unknown as WaveformDisplayRgb;
}

export function waveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
  amplitude = 1,
): WaveformDisplayRgb {
  const source = [lowValue, midValue, highValue].map((value) => clamp(value, 0, 255));
  const peak = Math.max(source[0], source[1], source[2]);
  if (peak <= 0) return [0, 0, 0];

  const floor = Math.min(source[0], source[1], source[2]);
  const chroma = peak > 0 ? (peak - floor) / peak : 0;
  // Near-neutral source columns should be a readable cool grey, not a white wall. Spectrally
  // coloured columns receive the stronger value lift; amplitude contributes only a narrow tail.
  const value = NEUTRAL_VALUE
    + COLOR_VALUE_LIFT * Math.sqrt(chroma)
    + AMPLITUDE_VALUE_LIFT * Math.sqrt(clamp(amplitude, 0, 1));
  return [0, 1, 2].map((channel) => {
    const semantic = Math.pow(source[channel] / peak, 1.35);
    const softened = semantic * SEMANTIC_COLOR_MIX
      + SOFT_NEUTRAL[channel] * (1 - SEMANTIC_COLOR_MIX);
    return Math.round(clamp(value * softened, 0, 255));
  }) as unknown as WaveformDisplayRgb;
}

/**
 * Vocal-guide palette. The cached channels still describe low/mid/high spectral weight, but a
 * separate vocal rail is a navigation aid rather than a second full-spectrum overview. Map that
 * evidence through three vivid anchors so warmth reads yellow, presence reads yellow-green and
 * air reads green; blue is deliberately bounded to keep the guide visually distinct from the
 * original RGB waveform. Amplitude changes height, so it only adds a small value lift here.
 */
export function vocalGuideWaveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
  amplitude = 1,
): WaveformDisplayRgb {
  const source = [lowValue, midValue, highValue].map((value) => clamp(value, 0, 255));
  const total = source[0] + source[1] + source[2];
  if (total <= 0) return [0, 0, 0];

  const anchors: readonly WaveformDisplayRgb[] = [
    [255, 216, 18],
    [176, 246, 28],
    [48, 235, 86],
  ];
  const value = 0.9 + 0.1 * Math.sqrt(clamp(amplitude, 0, 1));
  return [0, 1, 2].map((channel) => Math.round(clamp(
    anchors.reduce(
      (sum, anchor, band) => sum + anchor[channel] * (source[band] / total),
      0,
    ) * value,
    0,
    255,
  ))) as unknown as WaveformDisplayRgb;
}

