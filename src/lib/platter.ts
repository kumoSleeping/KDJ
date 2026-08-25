/**
 * One source-independent platter unit: media speed relative to normal playback.
 *
 * `1` means forward at the Deck's nominal 33⅓ RPM / 1x transport speed, `-1` is
 * the same speed in reverse. Pointer, touch and MIDI inputs are converted to a
 * media-distance observation first, then divided by the input device's own
 * timestamp. IPC and React scheduling therefore cannot change the measured speed.
 */

export const PLATTER_RPM = 100 / 3;
export const PLATTER_SECONDS_PER_REVOLUTION = 60 / PLATTER_RPM;
/** Matches the native callback clamp. Higher rates outrun the bounded stream cushion. */
export const PLATTER_MAX_RATE = 8;
/** A MIDI touch-up can trail its final rotary packet by more than one USB frame. */
export const PLATTER_RELEASE_MEMORY_MS = 160;
const PLATTER_FALLBACK_SAMPLE_MS = 8;

export type UnifiedPlatterEvent =
  | { phase: "start" }
  | { phase: "move"; velocity: number }
  | { phase: "end"; velocity: number };

function finiteTimestamp(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clampPlatterVelocity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-PLATTER_MAX_RATE, Math.min(PLATTER_MAX_RATE, value));
}

/**
 * Convert horizontal pointer travel to virtual-record media distance. One full
 * surface width is one platter revolution. Positive X pulls the waveform to the
 * right, which is reverse media motion.
 */
export function pointerPlatterDistance(deltaX: number, width: number): number {
  if (!Number.isFinite(deltaX) || !Number.isFinite(width) || width <= 0) return 0;
  return -(deltaX / width) * PLATTER_SECONDS_PER_REVOLUTION;
}

/**
 * Stateful timestamp normalizer shared by pointer/touch and MIDI. It intentionally
 * reports velocity rather than a target playhead position: moving faster accelerates
 * the platter, while a release preserves the final throw velocity.
 */
export class PlatterVelocityTracker {
  private lastInputAt: number | null = null;
  private lastMotionAt: number | null = null;
  private velocity = 0;

  start(at: number): void {
    const now = finiteTimestamp(at);
    this.lastInputAt = now;
    this.lastMotionAt = null;
    this.velocity = 0;
  }

  move(distanceSeconds: number, at: number): number {
    const now = finiteTimestamp(at, this.lastInputAt ?? 0);
    const elapsed = this.lastInputAt === null
      ? PLATTER_FALLBACK_SAMPLE_MS
      : now - this.lastInputAt;
    const elapsedMs = Number.isFinite(elapsed) && elapsed > 0
      ? elapsed
      : PLATTER_FALLBACK_SAMPLE_MS;
    this.lastInputAt = now;
    if (!Number.isFinite(distanceSeconds)) return this.velocity;
    this.velocity = clampPlatterVelocity(distanceSeconds / (elapsedMs / 1_000));
    this.lastMotionAt = now;
    return this.velocity;
  }

  end(at: number): number {
    const now = finiteTimestamp(at, this.lastInputAt ?? 0);
    const fresh = this.lastMotionAt !== null
      && now >= this.lastMotionAt
      && now - this.lastMotionAt <= PLATTER_RELEASE_MEMORY_MS;
    const velocity = fresh ? this.velocity : 0;
    this.reset();
    return velocity;
  }

  reset(): void {
    this.lastInputAt = null;
    this.lastMotionAt = null;
    this.velocity = 0;
  }
}
