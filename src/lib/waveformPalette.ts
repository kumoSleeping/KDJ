/**
 * Perceptual display palette for three-band DJ waveform data.
 *
 * Cached R/G/B values are semantic low/mid/high strengths, not literal screen colours. Height
 * already carries loudness. Overview and Performance detail therefore share frequency hues while
 * owning separate contrast: overview shows macro sections; detail lifts secondary channels so
 * beat-scale frequency evidence stays readable instead of becoming high-density RGB confetti.
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

const RELEASE_LOW_DOMINANCE = 0.95;
const DETAIL_LOW_DOMINANCE = 0.93;
// The light PlayerBar only needs a restrained colour lift. The earlier 0.82 proposal targeted
// roughly 1.5x perceived contrast; 0.74 is the proportional 1.1x trial requested by the user.
const RELEASE_SATURATION_RETENTION = 0.74;
const DETAIL_SATURATION_RETENTION = 0.60;
const DETAIL_NEUTRAL_VALUE = 174;
const DETAIL_COLOR_VALUE_LIFT = 42;
const DETAIL_AMPLITUDE_VALUE_LIFT = 4;
const DETAIL_TEXTURE_VALUE_LIFT = 12;
const DETAIL_TRANSIENT_VALUE_LIFT = 4;
const TEXTURE_SOURCE_VALUE_FLOOR = 0.91;
const TEXTURE_SOURCE_VALUE_RANGE = 0.09;
const RELEASE_VALUE_CAP = 238;
const DETAIL_VALUE_CAP = 238;

/** Surface-relative contrast trials requested for the two waveform views. */
export const RELEASE_OVERVIEW_CONTRAST = 1.1;
export const PERFORMANCE_DETAIL_CONTRAST = 0.9;
export const RELEASE_OVERVIEW_LIGHT_BACKGROUND: WaveformDisplayRgb = [249, 250, 251];
export const RELEASE_OVERVIEW_DARK_BACKGROUND: WaveformDisplayRgb = [1, 4, 9];
export const PERFORMANCE_DETAIL_BACKGROUND: WaveformDisplayRgb = [8, 10, 13];

/**
 * Scale a rendered colour around the surface it is actually composited onto.
 *
 * Multiplying RGB directly does not mean "10% more contrast" on a near-white surface, and CSS
 * `filter: contrast()` pivots around middle grey rather than the waveform background. This helper
 * keeps the requested 1.10/0.90 factors literal for both light overview and dark detail rails.
 */
export function waveformSurfaceContrastRgb(
  colour: WaveformDisplayRgb,
  background: WaveformDisplayRgb,
  contrast: number,
): WaveformDisplayRgb {
  const factor = Number.isFinite(contrast) ? Math.max(0, contrast) : 1;
  return [0, 1, 2].map((channel) => Math.round(clamp(
    background[channel] + (colour[channel] - background[channel]) * factor,
    0,
    255,
  ))) as unknown as WaveformDisplayRgb;
}

/** Low/mid/high keep one hue language across overview and DJ detail without sharing contrast. */
function balancedFrequencyRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
  lowDominance: number,
): [number, number, number] {
  let low = clamp(lowValue, 0, 255);
  const middle = clamp(midValue, 0, 255);
  const high = clamp(highValue, 0, 255);
  const strongestSecondary = Math.max(middle, high);
  if (low > strongestSecondary) {
    low = strongestSecondary + (low - strongestSecondary) * lowDominance;
  }
  return [low, middle, high];
}

function retainedSaturation(
  source: readonly [number, number, number],
  retention: number,
): [number, number, number] {
  const neutral = (source[0] + source[1] + source[2]) / 3;
  return [
    neutral + (source[0] - neutral) * retention,
    neutral + (source[1] - neutral) * retention,
    neutral + (source[2] - neutral) * retention,
  ];
}

/**
 * Preserve the analytical ratios used by the approved comparison. This only caps display value
 * and chroma; it does not steer a detected feature toward a chosen hue.
 */
export function releaseOverviewWaveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
): WaveformDisplayRgb {
  const softened = retainedSaturation(
    balancedFrequencyRgb(lowValue, midValue, highValue, RELEASE_LOW_DOMINANCE),
    RELEASE_SATURATION_RETENTION,
  );
  const peak = Math.max(...softened);
  const scale = peak > RELEASE_VALUE_CAP ? RELEASE_VALUE_CAP / peak : 1;
  return [
    Math.round(softened[0] * scale),
    Math.round(softened[1] * scale),
    Math.round(softened[2] * scale),
  ];
}

/**
 * DJ detail uses the overview's low=red / mid=green / high=blue identity, but not its macro
 * contrast. A 30-second rail must keep adjacent kicks, vocals and cymbals separable, so secondary
 * channels are lifted further and overall value is stabilised independently from amplitude.
 * Height remains the authoritative transient/loudness channel.
 */
export function performanceDetailWaveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
  amplitude = 1,
  transient = 0,
): WaveformDisplayRgb {
  const rawPeak = Math.max(
    clamp(lowValue, 0, 255),
    clamp(midValue, 0, 255),
    clamp(highValue, 0, 255),
  );
  // The analysis stores texture novelty in the otherwise redundant source-value envelope:
  // max(R,G,B) = 255 × (0.91 + 0.09 × sqrt(novelty)). Recovering it here avoids a new cache/wire
  // channel while leaving the measured frequency ratios untouched.
  const textureNoveltyRoot = clamp(
    (rawPeak / 255 - TEXTURE_SOURCE_VALUE_FLOOR) / TEXTURE_SOURCE_VALUE_RANGE,
    0,
    1,
  );
  const source = balancedFrequencyRgb(
    lowValue,
    midValue,
    highValue,
    DETAIL_LOW_DOMINANCE,
  );
  const peak = Math.max(source[0], source[1], source[2]);
  if (peak <= 0) return [0, 0, 0];
  const floor = Math.min(source[0], source[1], source[2]);
  const chroma = (peak - floor) / peak;
  const softened = retainedSaturation(source, DETAIL_SATURATION_RETENTION);
  const softenedPeak = Math.max(softened[0], softened[1], softened[2]);
  const value = DETAIL_NEUTRAL_VALUE
    + DETAIL_COLOR_VALUE_LIFT * Math.sqrt(chroma)
    + DETAIL_AMPLITUDE_VALUE_LIFT * Math.sqrt(clamp(amplitude, 0, 1))
    + DETAIL_TEXTURE_VALUE_LIFT * textureNoveltyRoot
    + DETAIL_TRANSIENT_VALUE_LIFT * Math.pow(clamp(transient, 0, 1), 0.7);
  const scale = softenedPeak > 0 ? value / softenedPeak : 0;
  return [
    Math.round(clamp(softened[0] * scale, 0, DETAIL_VALUE_CAP)),
    Math.round(clamp(softened[1] * scale, 0, DETAIL_VALUE_CAP)),
    Math.round(clamp(softened[2] * scale, 0, DETAIL_VALUE_CAP)),
  ];
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
