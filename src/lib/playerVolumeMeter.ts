const DEFAULT_LAG_MS = 96;
const MIN_LAG_MS = 64;
const MAX_LAG_MS = 140;
const METER_FLOOR_DB = -48;
const METER_HIGH_START_DB = -12;
const METER_LOW_SPAN = 0.46;
const METER_HIGH_SPAN = 1 - METER_LOW_SPAN;
const FAST_ATTACK_SECONDS = 0.004;
const FAST_RELEASE_SECONDS = 0.018;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Map post-master full scale onto a compact logarithmic meter. Quiet levels
 * share the shorter left section; the last 12 dB get most of the right-hand
 * travel so mastered music still looks loud but its peaks visibly move.
 */
export function playerVolumeMeterLevel(peak: number, volume: number): number {
  const outputPeak = Math.max(0, Number.isFinite(peak) ? peak : 0)
    * clamp01(Number.isFinite(volume) ? volume : 0);
  if (outputPeak <= 0) return 0;
  const db = 20 * Math.log10(outputPeak);
  if (db <= METER_HIGH_START_DB) {
    const lowRatio = (db - METER_FLOOR_DB) / (METER_HIGH_START_DB - METER_FLOOR_DB);
    return clamp01(lowRatio) * METER_LOW_SPAN;
  }
  const highRatio = (db - METER_HIGH_START_DB) / -METER_HIGH_START_DB;
  return METER_LOW_SPAN + clamp01(highRatio) * METER_HIGH_SPAN;
}

/** Red is an overload flag, not a permanent color band near the top of the scale. */
export function playerVolumeMeterClipping(peak: number, volume: number): boolean {
  const safePeak = Math.max(0, Number.isFinite(peak) ? peak : 0);
  const safeVolume = clamp01(Number.isFinite(volume) ? volume : 0);
  return safePeak * safeVolume >= 1;
}

/** The upper row follows a short earlier sample, roughly a quarter beat behind. */
export function playerVolumeMeterLagMs(bpm: number | null | undefined): number {
  if (!Number.isFinite(bpm) || (bpm ?? 0) <= 0) return DEFAULT_LAG_MS;
  return Math.min(MAX_LAG_MS, Math.max(MIN_LAG_MS, 15_000 / (bpm as number)));
}

/** Fast visual ballistics retained from the earlier, more animated meter. */
export function smoothPlayerVolumeMeter(
  current: number,
  target: number,
  elapsedSeconds: number,
): number {
  const safeCurrent = clamp01(Number.isFinite(current) ? current : 0);
  const safeTarget = clamp01(Number.isFinite(target) ? target : 0);
  const dt = Math.min(0.1, Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0));
  const timeConstant = safeTarget >= safeCurrent ? FAST_ATTACK_SECONDS : FAST_RELEASE_SECONDS;
  const amount = 1 - Math.exp(-dt / timeConstant);
  return safeCurrent + (safeTarget - safeCurrent) * amount;
}
