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

const SHARED_LOW_DOMINANCE = 0.9;
const RELEASE_SATURATION_RETENTION = 0.84;
const DETAIL_SATURATION_RETENTION = 0.7;
const DETAIL_NEUTRAL_VALUE = 178;
const DETAIL_COLOR_VALUE_LIFT = 50;
const DETAIL_AMPLITUDE_VALUE_LIFT = 6;

/** Low/mid/high keep one hue language across overview and DJ detail without sharing contrast. */
function balancedFrequencyRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
): [number, number, number] {
  let low = clamp(lowValue, 0, 255);
  const middle = clamp(midValue, 0, 255);
  const high = clamp(highValue, 0, 255);
  const strongestSecondary = Math.max(middle, high);
  if (low > strongestSecondary) {
    low = strongestSecondary + (low - strongestSecondary) * SHARED_LOW_DOMINANCE;
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
 * Keep the v0.2.41 colour identity, but take only the harshest edge off it: compress red dominance
 * first, then move every channel 16% toward that column's own neutral value. Full render opacity
 * is retained, so the result stays clear without becoming neon or washed out.
 */
export function releaseOverviewWaveformDisplayRgb(
  lowValue: number,
  midValue: number,
  highValue: number,
): WaveformDisplayRgb {
  const softened = retainedSaturation(
    balancedFrequencyRgb(lowValue, midValue, highValue),
    RELEASE_SATURATION_RETENTION,
  );
  return [
    Math.round(softened[0]),
    Math.round(softened[1]),
    Math.round(softened[2]),
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
): WaveformDisplayRgb {
  const source = balancedFrequencyRgb(lowValue, midValue, highValue);
  const peak = Math.max(source[0], source[1], source[2]);
  if (peak <= 0) return [0, 0, 0];
  const floor = Math.min(source[0], source[1], source[2]);
  const chroma = (peak - floor) / peak;
  const softened = retainedSaturation(source, DETAIL_SATURATION_RETENTION);
  const softenedPeak = Math.max(softened[0], softened[1], softened[2]);
  const value = DETAIL_NEUTRAL_VALUE
    + DETAIL_COLOR_VALUE_LIFT * Math.sqrt(chroma)
    + DETAIL_AMPLITUDE_VALUE_LIFT * Math.sqrt(clamp(amplitude, 0, 1));
  const scale = softenedPeak > 0 ? value / softenedPeak : 0;
  return [
    Math.round(clamp(softened[0] * scale, 0, 255)),
    Math.round(clamp(softened[1] * scale, 0, 255)),
    Math.round(clamp(softened[2] * scale, 0, 255)),
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
