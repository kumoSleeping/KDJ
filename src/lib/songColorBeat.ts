/**
 * 歌曲色彩: how the field keeps time with the song.
 *
 * The field breathes by one animation whose cycle is four pulses long — a bar, for a song with
 * a beat grid — and runs on the compositor. Nothing is computed per frame: the animation is
 * set to the place in the cycle the song is at when it starts, when it is sought and when its
 * tempo changes, and is set again only when the player's own reports show it has drifted. What
 * the song is doing over a longer stretch (a quiet bridge, a loud chorus) comes from its
 * overview waveform, read once a bar.
 *
 * Pure: the arithmetic only. SongColorBackdrop owns the animations.
 */
import { BEATS_PER_BAR, beatIntervalSec, gridOriginSec } from "./beatGridSync";
import type { Track } from "../types";

/** Pulses in one cycle of the animation. */
export const PULSES_PER_CYCLE = BEATS_PER_BAR;
/** A pulse is never shorter than this, in seconds: a fast song pulses on every other beat. */
const PULSE_MIN_SEC = 0.4;
/** Nor longer than this: a very slow song pulses twice a beat. */
const PULSE_MAX_SEC = 1.25;
/** A song without a tempo breathes this slowly, and not in time with anything. */
export const FREE_CYCLE_SEC = 4.8;
/** The downbeat is trusted, and given the stronger pulse, from this confidence up. */
const DOWNBEAT_CONFIDENCE = 0.5;
/** The animation is set again when it is this far from the song, in ms of song time. */
export const BEAT_RESYNC_MS = 45;

export interface SongBeat {
  /** One cycle of the animation, in seconds of the song. */
  cycleSec: number;
  /** Where in the song a cycle starts, in seconds, less than one cycle. */
  originSec: number;
  /** The cycle follows the song's beat grid; otherwise it only breathes. */
  synced: boolean;
  /** The first pulse of a cycle is the bar's downbeat. */
  accented: boolean;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function songBeat(track: Pick<Track, "bpm" | "first_beat" | "beat_origin" | "downbeat_origin" | "downbeat_confidence"> | null | undefined): SongBeat {
  const beat = beatIntervalSec(track?.bpm);
  if (!track || beat === null || beat < 0.15 || beat > 3) {
    return { cycleSec: FREE_CYCLE_SEC, originSec: 0, synced: false, accented: false };
  }
  let pulse = beat;
  while (pulse < PULSE_MIN_SEC) pulse *= 2;
  while (pulse > PULSE_MAX_SEC) pulse /= 2;
  const cycleSec = pulse * PULSES_PER_CYCLE;
  const downbeat = finite(track.downbeat_origin) && (track.downbeat_confidence ?? 0) >= DOWNBEAT_CONFIDENCE ? track.downbeat_origin : null;
  const first = downbeat ?? (finite(track.beat_origin) ? track.beat_origin : finite(track.first_beat) ? track.first_beat : 0);
  return {
    cycleSec,
    originSec: gridOriginSec(first, cycleSec),
    synced: true,
    // Only a cycle that is exactly a bar can start on the bar.
    accented: downbeat !== null && pulse === beat,
  };
}

/** Where in its cycle the animation belongs when the song is at `positionSec`, in ms. */
export function beatCycleTime(positionSec: number, beat: SongBeat): number {
  const cycle = beat.cycleSec * 1000;
  const at = ((Number.isFinite(positionSec) ? positionSec : 0) - beat.originSec) * 1000;
  return ((at % cycle) + cycle) % cycle;
}

/** How far `actualMs` is from `expectedMs` round a cycle of `cycleMs`, signed, the short way. */
export function beatDrift(expectedMs: number, actualMs: number, cycleMs: number): number {
  const half = cycleMs / 2;
  return ((((actualMs - expectedMs) + half) % cycleMs) + cycleMs) % cycleMs - half;
}

/**
 * The model of a running animation: where it was last set and how fast it runs. `at` is a
 * performance.now() stamp, `time` the place in the cycle it was given then.
 */
export interface BeatAnchor { time: number; at: number; rate: number }

/** Where an animation set at `anchor` is now, in its cycle. */
export function anchoredCycleTime(anchor: BeatAnchor, now: number, cycleMs: number): number {
  const at = anchor.time + (now - anchor.at) * anchor.rate;
  return ((at % cycleMs) + cycleMs) % cycleMs;
}

/**
 * What a report from the player asks of the animation: the place to set it to, or null when it
 * is still where the song is.
 */
export function beatCorrection(anchor: BeatAnchor | null, positionSec: number, rate: number, now: number, beat: SongBeat): number | null {
  const expected = beatCycleTime(positionSec, beat);
  if (!anchor || Math.abs(anchor.rate - rate) > 0.002) return expected;
  const cycle = beat.cycleSec * 1000;
  return Math.abs(beatDrift(expected, anchoredCycleTime(anchor, now, cycle), cycle)) > BEAT_RESYNC_MS ? expected : null;
}

/** Which cycle of the song `positionSec` is in: it changes once a bar. */
export function beatCycleIndex(positionSec: number, beat: SongBeat): number {
  return Math.floor(((Number.isFinite(positionSec) ? positionSec : 0) - beat.originSec) / beat.cycleSec);
}

/** One step of the animation's keyframes: `level` 0..1 is how far the pulse is out. */
export interface BeatStep { offset: number; level: number; easing: string }

/** How much of a pulse its rise takes. */
const ATTACK = 0.14;
/** The top of the swell of a song without a tempo. */
const FREE_LEVEL = 0.7;
/** The curves of a pulse's rise and fall and of that slow swell, as cubic-bezier numbers. */
type Curve = readonly [number, number, number, number];
const RISE: Curve = [0.3, 0.7, 0.4, 1];
const FALL: Curve = [0.22, 0.5, 0.36, 1];
const SWELL: Curve = [0.37, 0, 0.63, 1];
const css = (curve: Curve) => `cubic-bezier(${curve.join(", ")})`;
/** How far out a pulse goes: the downbeat a little further than the rest when it is known. */
const pulseLevel = (beat: SongBeat, pulse: number) => beat.accented ? (pulse === 0 ? 1 : 0.72) : 0.85;

/** The glow between beats, as a share of its peak; how far it and the field grow on a beat. */
export const GLOW_REST = 0.3;
export const GLOW_SWELL = 0.09;
export const FIELD_SWELL = 0.024;

/**
 * The pulse over one cycle. In time with the song: a quick rise on each pulse and a long fall
 * to the next, the downbeat a little stronger when it is known. Without a tempo: one slow
 * swell and back.
 */
export function beatSteps(beat: SongBeat): BeatStep[] {
  if (!beat.synced) {
    return [
      { offset: 0, level: 0, easing: css(SWELL) },
      { offset: 0.5, level: FREE_LEVEL, easing: css(SWELL) },
      { offset: 1, level: 0, easing: "linear" },
    ];
  }
  const steps: BeatStep[] = [];
  for (let pulse = 0; pulse < PULSES_PER_CYCLE; pulse += 1) {
    const start = pulse / PULSES_PER_CYCLE;
    steps.push({ offset: start, level: 0, easing: css(RISE) });
    steps.push({ offset: start + ATTACK / PULSES_PER_CYCLE, level: pulseLevel(beat, pulse), easing: css(FALL) });
  }
  steps.push({ offset: 1, level: 0, easing: "linear" });
  return steps;
}

/** y of a CSS cubic-bezier at x. */
function curveAt([x1, y1, x2, y2]: Curve, x: number): number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let low = 0, high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    if (at(x1, x2, middle) < x) low = middle; else high = middle;
  }
  return at(y1, y2, (low + high) / 2);
}

/** Which pulse of the song `positionSec` is in: it changes once a pulse. */
export function beatPulseIndex(positionSec: number, beat: SongBeat): number {
  return Math.floor(((Number.isFinite(positionSec) ? positionSec : 0) - beat.originSec) / (beat.cycleSec / PULSES_PER_CYCLE));
}

/**
 * How far the pulse is out when the song is at `positionSec`, 0..1: the keyframes of
 * `beatSteps` as a function of the song's time, for a picture that is drawn frame by frame
 * (the visualizer) and must show the same frame whenever it is asked for the same moment.
 */
export function beatLevel(positionSec: number, beat: SongBeat): number {
  const at = beatCycleTime(positionSec, beat) / (beat.cycleSec * 1000);
  if (!beat.synced) return FREE_LEVEL * (at < 0.5 ? curveAt(SWELL, at * 2) : 1 - curveAt(SWELL, at * 2 - 1));
  const place = at * PULSES_PER_CYCLE, pulse = Math.min(PULSES_PER_CYCLE - 1, Math.floor(place)), within = place - pulse;
  return pulseLevel(beat, pulse) * (within < ATTACK ? curveAt(RISE, within / ATTACK) : 1 - curveAt(FALL, (within - ATTACK) / (1 - ATTACK)));
}

/** The loudness the field treats as the song's full strength: a high percentile of its overview. */
export function waveLoudness(amp: ArrayLike<number>): number {
  const length = amp.length;
  if (!length) return 0;
  // Every 16th column is plenty for a percentile.
  const sample: number[] = [];
  for (let index = 0; index < length; index += Math.max(1, Math.floor(length / 256))) {
    const value = amp[index];
    sample.push(Number.isFinite(value) ? Math.abs(value) : 0);
  }
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.9))];
}

/**
 * The song's energy over `spanSec` from `positionSec`, 0..1, from its overview's amplitudes:
 * the mean level there against the song's own loud level. 0.6 when there is nothing to read.
 */
export function waveEnergy(amp: ArrayLike<number> | null | undefined, loudness: number, duration: number, positionSec: number, spanSec: number): number {
  const length = amp?.length ?? 0;
  if (!amp || !length || !(duration > 0) || !(loudness > 0)) return 0.6;
  const from = Math.min(length - 1, Math.max(0, Math.floor((positionSec / duration) * length)));
  const to = Math.min(length, Math.max(from + 1, Math.ceil(((positionSec + spanSec) / duration) * length)));
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const value = amp[index];
    sum += Number.isFinite(value) ? Math.abs(value) : 0;
  }
  return Math.min(1, Math.max(0, sum / (to - from) / loudness));
}
