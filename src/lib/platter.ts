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
/** Three recent motion intervals suppress encoder/PointerEvent quantization without hand lag. */
const PLATTER_VELOCITY_HISTORY_SAMPLES = 4;
const PLATTER_VELOCITY_HISTORY_MS = 120;

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
  private distance = 0;
  private samples: Array<{ at: number; distance: number }> = [];

  start(at: number): void {
    const now = finiteTimestamp(at);
    this.lastInputAt = now;
    this.lastMotionAt = null;
    this.velocity = 0;
    this.distance = 0;
    this.samples = [{ at: now, distance: 0 }];
  }

  move(distanceSeconds: number, at: number): number {
    const observedAt = finiteTimestamp(at, this.lastInputAt ?? 0);
    // WebKit may give every coalesced point the parent event timestamp; some MIDI backends also
    // batch several values at one device tick. Give those samples a small monotonic interval so
    // they do not later collapse into one infinite-speed history point.
    const now = this.lastInputAt !== null && observedAt <= this.lastInputAt
      ? this.lastInputAt + PLATTER_FALLBACK_SAMPLE_MS
      : observedAt;
    const elapsed = this.lastInputAt === null
      ? PLATTER_FALLBACK_SAMPLE_MS
      : now - this.lastInputAt;
    const elapsedMs = Number.isFinite(elapsed) && elapsed > 0
      ? elapsed
      : PLATTER_FALLBACK_SAMPLE_MS;
    const previousAt = this.lastInputAt ?? now - elapsedMs;
    this.lastInputAt = now;
    if (!Number.isFinite(distanceSeconds)) return this.velocity;
    const rawVelocity = clampPlatterVelocity(distanceSeconds / (elapsedMs / 1_000));
    // A real direction reversal must not drag the previous direction through the averaging
    // window. For same-direction motion, average three packet intervals: integer MIDI ticks and
    // coalesced pointer batches then describe one continuous hand speed instead of a staircase.
    if (rawVelocity * this.velocity < 0 && Math.abs(rawVelocity) > 0.05) {
      this.samples = [{ at: previousAt, distance: this.distance }];
    }
    this.distance += distanceSeconds;
    this.samples.push({ at: now, distance: this.distance });
    while (this.samples.length > PLATTER_VELOCITY_HISTORY_SAMPLES) this.samples.shift();
    while (
      this.samples.length > 2
      && now - this.samples[1].at > PLATTER_VELOCITY_HISTORY_MS
    ) this.samples.shift();
    const first = this.samples[0];
    const windowMs = now - first.at;
    const windowVelocity = windowMs > 0
      ? (this.distance - first.distance) / (windowMs / 1_000)
      : rawVelocity;
    this.velocity = clampPlatterVelocity(windowVelocity);
    this.lastMotionAt = now;
    return this.velocity;
  }

  end(at: number): number {
    const now = Math.max(
      finiteTimestamp(at, this.lastInputAt ?? 0),
      this.lastInputAt ?? 0,
    );
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
    this.distance = 0;
    this.samples = [];
  }
}
