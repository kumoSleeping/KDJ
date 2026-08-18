const CLOCK_REGRESSION_TOLERANCE_SECONDS = 0.12;
const CLOCK_DISCONTINUITY_SECONDS = 1.25;
/** Sub-frame native timestamp noise is less visible as a fixed phase offset than as speed wobble. */
const CLOCK_CORRECTION_DEADBAND_SECONDS = 0.006;
const CLOCK_CORRECTION_HORIZON_SECONDS = 2.5;
const CLOCK_MAX_RATE_CORRECTION = 0.025;
const CLOCK_CORRECTION_BLEND = 0.15;

export interface PerformanceVisualClockSample {
  trackId: number | null;
  position: number;
  duration: number;
  rate: number;
  playing: boolean;
  /** Platter motion is already a display-rate cursor and must be followed exactly. */
  interactive: boolean;
  /** SYNC/seek landings are explicit transport discontinuities, not clock noise. */
  snap: boolean;
  loopStart?: number | null;
  loopLength?: number | null;
}

export interface PerformanceVisualClockState {
  trackId: number | null;
  anchorPosition: number;
  anchorTimeMs: number;
  authoritativePosition: number;
  duration: number;
  rate: number;
  correctionRate: number;
  playing: boolean;
  loopStart: number | null;
  loopLength: number | null;
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizedRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampPosition(position: number, duration: number): number {
  const safe = finiteNonNegative(position);
  return duration > 0 ? Math.min(duration, safe) : safe;
}

function normalizedLoop(
  startValue: number | null | undefined,
  lengthValue: number | null | undefined,
  duration: number,
): { start: number; length: number } | null {
  if (
    startValue === null
    || startValue === undefined
    || lengthValue === null
    || lengthValue === undefined
    || !Number.isFinite(startValue)
    || !Number.isFinite(lengthValue)
    || lengthValue <= 0
  ) return null;
  const start = clampPosition(startValue, duration);
  const length = duration > 0
    ? Math.min(lengthValue, Math.max(0, duration - start))
    : lengthValue;
  return length > 0 ? { start, length } : null;
}

function loopedPosition(position: number, state: PerformanceVisualClockState): number {
  const loop = normalizedLoop(state.loopStart, state.loopLength, state.duration);
  if (!loop || position < loop.start + loop.length) {
    return clampPosition(position, state.duration);
  }
  return loop.start + ((position - loop.start) % loop.length + loop.length) % loop.length;
}

/**
 * Position of the display-rate transport clock at a requestAnimationFrame timestamp.
 * Ordinary playback can slow down or speed up slightly while converging on a native sample, but
 * it never runs backward. Explicit transport discontinuities are handled by the update function.
 */
export function performanceVisualClockPosition(
  state: PerformanceVisualClockState,
  nowMs: number,
): number {
  if (!state.playing) return clampPosition(state.anchorPosition, state.duration);
  const elapsed = Math.max(0, (finiteNonNegative(nowMs, state.anchorTimeMs) - state.anchorTimeMs) / 1_000);
  const effectiveRate = Math.max(0, state.rate + state.correctionRate);
  return loopedPosition(state.anchorPosition + elapsed * effectiveRate, state);
}

function snappedClock(
  sample: PerformanceVisualClockSample,
  nowMs: number,
): PerformanceVisualClockState {
  const duration = finiteNonNegative(sample.duration);
  const loop = normalizedLoop(sample.loopStart, sample.loopLength, duration);
  return {
    trackId: sample.trackId,
    anchorPosition: clampPosition(sample.position, duration),
    anchorTimeMs: finiteNonNegative(nowMs),
    authoritativePosition: clampPosition(sample.position, duration),
    duration,
    rate: normalizedRate(sample.rate),
    correctionRate: 0,
    playing: sample.playing && !sample.interactive,
    loopStart: loop?.start ?? null,
    loopLength: loop?.length ?? null,
  };
}

/**
 * Fold a sparse native Deck sample into the display-rate clock.
 *
 * Same-track clock noise changes velocity for a short convergence window instead of changing the
 * current visual position. That makes the rendered cursor monotonic without hiding real seeks,
 * loop wraps, scratches, track changes, pauses, or SYNC landings.
 */
export function updatePerformanceVisualClock(
  previous: PerformanceVisualClockState | null,
  sample: PerformanceVisualClockSample,
  nowMs: number,
): PerformanceVisualClockState {
  const now = finiteNonNegative(nowMs);
  const duration = finiteNonNegative(sample.duration);
  const position = clampPosition(sample.position, duration);
  const rate = normalizedRate(sample.rate);
  const loop = normalizedLoop(sample.loopStart, sample.loopLength, duration);
  const loopChanged = previous !== null && (
    previous.loopStart !== (loop?.start ?? null)
    || previous.loopLength !== (loop?.length ?? null)
  );
  if (
    previous === null
    || previous.trackId !== sample.trackId
    || sample.snap
    || sample.interactive
    || loopChanged
    || !sample.playing
    || !previous.playing
  ) {
    return snappedClock({ ...sample, position, duration, rate }, now);
  }

  const predicted = performanceVisualClockPosition(previous, now);
  const authorityDelta = position - previous.authoritativePosition;
  let error = position - predicted;
  if (loop && loop.length > 0) {
    // Samples on opposite sides of a loop boundary are adjacent in transport time. Correct along
    // the shortest loop arc instead of undoing the display clock's frame-accurate wrap.
    if (error > loop.length / 2) error -= loop.length;
    if (error < -loop.length / 2) error += loop.length;
  }
  const discontinuity = (!loop && authorityDelta < -CLOCK_REGRESSION_TOLERANCE_SECONDS)
    || Math.abs(error) > CLOCK_DISCONTINUITY_SECONDS;
  if (discontinuity) {
    return snappedClock({ ...sample, position, duration, rate }, now);
  }

  const correctionError = Math.abs(error) <= CLOCK_CORRECTION_DEADBAND_SECONDS
    ? 0
    : error - Math.sign(error) * CLOCK_CORRECTION_DEADBAND_SECONDS;
  const requestedCorrection = correctionError / CLOCK_CORRECTION_HORIZON_SECONDS;
  const maxCorrection = rate * CLOCK_MAX_RATE_CORRECTION;
  const desiredCorrection = Math.max(-maxCorrection, Math.min(maxCorrection, requestedCorrection));
  const correctionRate = previous.correctionRate
    + (desiredCorrection - previous.correctionRate) * CLOCK_CORRECTION_BLEND;
  return {
    trackId: sample.trackId,
    // Preserve the exact position already shown at this instant. Corrections affect only future
    // velocity, so a harmless decoder/source handoff can never create a backwards frame.
    anchorPosition: predicted,
    anchorTimeMs: now,
    authoritativePosition: position,
    duration,
    rate,
    correctionRate,
    playing: true,
    loopStart: loop?.start ?? null,
    loopLength: loop?.length ?? null,
  };
}
