import { eqBandDb } from "./performanceCues";

/** 1/3-octave-like centres: five visual/analyser cells for each LOW / MID / HIGH group. */
export const EQ_GRAPH_FREQUENCIES = [
  40, 63, 100, 160, 250,
  400, 630, 1_000, 1_600, 2_500,
  4_000, 6_300, 10_000, 14_000, 18_000,
] as const;

export const EQ_GRAPH_BAND_COUNT = EQ_GRAPH_FREQUENCIES.length;
export const EQ_GRAPH_MIN_DB = -24;
export const EQ_GRAPH_MAX_DB = 6;

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
