import { eqBandDb } from "./performanceCues";

/** 1/3-octave-like centres: five visual/analyser cells for each LOW / MID / HIGH group. */
export const EQ_GRAPH_FREQUENCIES = [
  40, 63, 100, 160, 250,
  400, 630, 1_000, 1_600, 2_500,
  4_000, 6_300, 10_000, 14_000, 18_000,
] as const;

export const EQ_GRAPH_BAND_COUNT = EQ_GRAPH_FREQUENCIES.length;
export const EQ_GRAPH_MIN_DB = -26;
export const EQ_GRAPH_MAX_DB = 9;

export interface EqGraphValues {
  low: number;
  mid: number;
  high: number;
}

export interface EqGraphWeights extends EqGraphValues {}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const LOW_ANCHOR = 2;
const MID_ANCHOR = 7;
const HIGH_ANCHOR = 12;

/**
 * Converts the chart's equal-width hit cells to three mixer controls. Group centres are pure
 * LOW/MID/HIGH. Between centres, movement is shared linearly; therefore the visual group
 * boundaries (between cells 5/6 and 10/11) split a gesture exactly 50/50.
 */
export function eqControlWeightsAtRatio(ratio: number): EqGraphWeights {
  const position = clamp(Number.isFinite(ratio) ? ratio : 0.5) * EQ_GRAPH_BAND_COUNT - 0.5;
  const x = clamp(position, 0, EQ_GRAPH_BAND_COUNT - 1);
  if (x <= LOW_ANCHOR) return { low: 1, mid: 0, high: 0 };
  if (x < MID_ANCHOR) {
    const mid = (x - LOW_ANCHOR) / (MID_ANCHOR - LOW_ANCHOR);
    return { low: 1 - mid, mid, high: 0 };
  }
  if (x === MID_ANCHOR) return { low: 0, mid: 1, high: 0 };
  if (x < HIGH_ANCHOR) {
    const high = (x - MID_ANCHOR) / (HIGH_ANCHOR - MID_ANCHOR);
    return { low: 0, mid: 1 - high, high };
  }
  return { low: 0, mid: 0, high: 1 };
}

/** Continuous logarithmic frequency under a pointer, interpolated through the 15 hit centres. */
export function eqFrequencyAtRatio(ratio: number): number {
  const position = clamp(Number.isFinite(ratio) ? ratio : 0.5) * EQ_GRAPH_BAND_COUNT - 0.5;
  const x = clamp(position, 0, EQ_GRAPH_BAND_COUNT - 1);
  const lower = Math.floor(x);
  const upper = Math.min(EQ_GRAPH_BAND_COUNT - 1, lower + 1);
  if (lower === upper) return EQ_GRAPH_FREQUENCIES[lower];
  const blend = x - lower;
  const from = Math.log(EQ_GRAPH_FREQUENCIES[lower]);
  const to = Math.log(EQ_GRAPH_FREQUENCIES[upper]);
  return Math.exp(from + (to - from) * blend);
}

/** Average weights along one coalesced pointer segment so a fast sweep cannot skip a cell. */
export function eqGestureWeights(fromRatio: number, toRatio: number): EqGraphWeights {
  const from = clamp(Number.isFinite(fromRatio) ? fromRatio : 0.5);
  const to = clamp(Number.isFinite(toRatio) ? toRatio : from);
  const crossedCells = Math.abs(to - from) * EQ_GRAPH_BAND_COUNT;
  const steps = Math.max(1, Math.ceil(crossedCells * 2));
  const total: EqGraphWeights = { low: 0, mid: 0, high: 0 };
  for (let index = 0; index < steps; index += 1) {
    const at = from + (to - from) * ((index + 0.5) / steps);
    const weight = eqControlWeightsAtRatio(at);
    total.low += weight.low;
    total.mid += weight.mid;
    total.high += weight.high;
  }
  return { low: total.low / steps, mid: total.mid / steps, high: total.high / steps };
}

const smoothstep = (value: number) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};

/** Smooth, three-control preset curve. It has no hidden 15-band state. */
export function eqCurveDbAtRatio(values: EqGraphValues, ratio: number): number {
  const position = clamp(Number.isFinite(ratio) ? ratio : 0.5) * EQ_GRAPH_BAND_COUNT - 0.5;
  const x = clamp(position, 0, EQ_GRAPH_BAND_COUNT - 1);
  const low = eqBandDb(values.low);
  const mid = eqBandDb(values.mid);
  const high = eqBandDb(values.high);
  if (x <= LOW_ANCHOR) return low;
  if (x < MID_ANCHOR) {
    const blend = smoothstep((x - LOW_ANCHOR) / (MID_ANCHOR - LOW_ANCHOR));
    return low + (mid - low) * blend;
  }
  if (x < HIGH_ANCHOR) {
    const blend = smoothstep((x - MID_ANCHOR) / (HIGH_ANCHOR - MID_ANCHOR));
    return mid + (high - mid) * blend;
  }
  return high;
}

/** 0 dB is the visual centre; boost and cut each own one half despite asymmetric dB ranges. */
export function eqDbToGraphRatio(db: number): number {
  const value = Number.isFinite(db) ? db : 0;
  if (value >= 0) return 0.5 - clamp(value / EQ_GRAPH_MAX_DB) * 0.5;
  return 0.5 + clamp(-value / -EQ_GRAPH_MIN_DB) * 0.5;
}

/** Fixed dBFS display scale for genuine narrow-band levels; no per-frame normalisation. */
export function eqSpectrumLevelToRatio(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return clamp((db + 72) / 72);
}

/** Mirrors `kdj-player` channel FILTER: bipolar throw, centre detent, RBJ LPF/HPF. */
export const CHANNEL_FILTER_CENTER_DEADZONE = 0.01;
export const CHANNEL_FILTER_NEAR_CENTER_Q = Math.SQRT1_2;
export const CHANNEL_FILTER_RESONANCE_RAMP_START = 0.1;
export const CHANNEL_FILTER_RESONANCE_RAMP_END = 0.3;
export const CHANNEL_FILTER_SAMPLE_RATE = 48_000;
export const CHANNEL_FILTER_RESONANCE_Q = {
  low: 0.72,
  medium: 1.85,
  high: 3.2,
} as const;
/** Mirrors `kdj-player`: both throws take the same 0.95 headroom scale. */
export const CHANNEL_FILTER_RESONANCE_SCALE = 0.95;

export type ChannelFilterResonance = keyof typeof CHANNEL_FILTER_RESONANCE_Q;

export function channelFilterResonanceQ(setting: ChannelFilterResonance | undefined): number {
  return CHANNEL_FILTER_RESONANCE_Q[setting ?? "high"];
}

export function effectiveChannelFilterQ(filter: number, selectedQ: number): number {
  const amount = Math.abs(Number.isFinite(filter) ? filter : 0);
  const linear = clamp(
    (amount - CHANNEL_FILTER_RESONANCE_RAMP_START)
      / (CHANNEL_FILTER_RESONANCE_RAMP_END - CHANNEL_FILTER_RESONANCE_RAMP_START),
  );
  const smooth = linear * linear * (3 - 2 * linear);
  const scaledQ = selectedQ * CHANNEL_FILTER_RESONANCE_SCALE;
  return CHANNEL_FILTER_NEAR_CENTER_Q
    + (scaledQ - CHANNEL_FILTER_NEAR_CENTER_Q) * smooth;
}

export function channelFilterCutoffHz(filter: number): number | null {
  const value = Number.isFinite(filter) ? Math.min(1, Math.max(-1, filter)) : 0;
  if (value < -CHANNEL_FILTER_CENTER_DEADZONE) {
    return 18_000 * (90 / 18_000) ** -value;
  }
  if (value > CHANNEL_FILTER_CENTER_DEADZONE) {
    return 22 * (8_000 / 22) ** value;
  }
  return null;
}

function rbjLowPass(frequency: number, q: number): readonly [number, number, number, number, number] {
  const omega = 2 * Math.PI * Math.min(CHANNEL_FILTER_SAMPLE_RATE * 0.45, Math.max(20, frequency))
    / CHANNEL_FILTER_SAMPLE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return [
    (1 - cosine) * 0.5 / a0,
    (1 - cosine) / a0,
    (1 - cosine) * 0.5 / a0,
    -2 * cosine / a0,
    (1 - alpha) / a0,
  ];
}

function rbjHighPass(frequency: number, q: number): readonly [number, number, number, number, number] {
  const omega = 2 * Math.PI * Math.min(CHANNEL_FILTER_SAMPLE_RATE * 0.45, Math.max(20, frequency))
    / CHANNEL_FILTER_SAMPLE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Math.max(0.1, q));
  const a0 = 1 + alpha;
  return [
    (1 + cosine) * 0.5 / a0,
    -(1 + cosine) / a0,
    (1 + cosine) * 0.5 / a0,
    -2 * cosine / a0,
    (1 - alpha) / a0,
  ];
}

function biquadGainDb(
  frequency: number,
  [b0, b1, b2, a1, a2]: readonly [number, number, number, number, number],
): number {
  const omega = 2 * Math.PI * frequency / CHANNEL_FILTER_SAMPLE_RATE;
  const cos = Math.cos(omega);
  const sin = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  const numRe = b0 + b1 * cos + b2 * cos2;
  const numIm = -(b1 * sin + b2 * sin2);
  const denRe = 1 + a1 * cos + a2 * cos2;
  const denIm = -(a1 * sin + a2 * sin2);
  const mag = Math.hypot(numRe, numIm) / Math.max(1e-12, Math.hypot(denRe, denIm));
  return 20 * Math.log10(Math.max(mag, 1e-9));
}

/** Magnitude of the live channel FILTER at one frequency, in dB. Centre detent is flat. */
export function channelFilterDbAtFrequency(
  frequency: number,
  filter: number,
  selectedQ: number,
): number {
  const cutoff = channelFilterCutoffHz(filter);
  if (cutoff == null || !Number.isFinite(frequency) || frequency <= 0) return 0;
  const q = effectiveChannelFilterQ(filter, selectedQ);
  const coefficients = filter < 0 ? rbjLowPass(cutoff, q) : rbjHighPass(cutoff, q);
  return biquadGainDb(frequency, coefficients);
}

export function channelFilterDbAtRatio(
  filter: number,
  selectedQ: number,
  ratio: number,
): number {
  return channelFilterDbAtFrequency(eqFrequencyAtRatio(ratio), filter, selectedQ);
}
