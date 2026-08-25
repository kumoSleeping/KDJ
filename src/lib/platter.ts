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
/** Fast pointer/encoder streams must stop carrying a stale velocity almost immediately. */
export const PLATTER_MIN_VELOCITY_VALIDITY_MS = 24;
/** Sparse low-speed MIDI packets may need several detent intervals before the next observation. */
export const PLATTER_MAX_VELOCITY_VALIDITY_MS = 250;
const PLATTER_VELOCITY_VALIDITY_INTERVALS = 3;
const PLATTER_VELOCITY_VALIDITY_MULTIPLIER = 2.5;
/** Three recent motion intervals suppress encoder/PointerEvent quantization without hand lag. */
const PLATTER_VELOCITY_HISTORY_SAMPLES = 4;
const PLATTER_VELOCITY_HISTORY_MS = 120;

export type UnifiedPlatterEvent =
  | { phase: "start" }
  | { phase: "move"; velocity: number; validForMs?: number }
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

export interface PointerPlatterSample {
  clientX: number;
  timeStamp: number;
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
  private sampleIntervals: number[] = [];

  start(at: number): void {
    const now = finiteTimestamp(at);
    this.lastInputAt = now;
    this.lastMotionAt = null;
    this.velocity = 0;
    this.distance = 0;
    this.samples = [{ at: now, distance: 0 }];
    this.sampleIntervals = [];
  }

  move(distanceSeconds: number, at: number): number {
    const now = finiteTimestamp(at, this.lastInputAt ?? 0);
    if (this.lastInputAt !== null && now < this.lastInputAt) return this.velocity;
    const previousAt = this.lastInputAt;
    const elapsedMs = previousAt === null ? 0 : now - previousAt;
    if (elapsedMs > 0) {
      this.sampleIntervals.push(elapsedMs);
      while (this.sampleIntervals.length > PLATTER_VELOCITY_VALIDITY_INTERVALS) {
        this.sampleIntervals.shift();
      }
    }
    this.lastInputAt = now;
    if (!Number.isFinite(distanceSeconds)) return this.velocity;
    if (distanceSeconds === 0) {
      this.velocity = 0;
      this.lastMotionAt = null;
      this.samples = [{ at: now, distance: this.distance }];
      return 0;
    }

    const sameTimestamp = this.samples.at(-1)?.at === now;
    const prior = sameTimestamp ? this.samples.at(-2) : this.samples.at(-1);
    const intervalMs = prior ? now - prior.at : 0;
    const nextDistance = this.distance + distanceSeconds;
    const intervalDistance = prior ? nextDistance - prior.distance : 0;
    const rawVelocity = intervalMs > 0
      ? clampPlatterVelocity(intervalDistance / (intervalMs / 1_000))
      : 0;
    // A real direction reversal must not drag the previous direction through the averaging
    // window. For same-direction motion, average three packet intervals: integer MIDI ticks and
    // coalesced pointer batches then describe one continuous hand speed instead of a staircase.
    if (rawVelocity * this.velocity < 0 && Math.abs(rawVelocity) > 0.05) {
      this.samples = prior ? [{ ...prior }] : [];
    }
    this.distance = nextDistance;
    const latest = this.samples.at(-1);
    if (latest?.at === now) {
      latest.distance = this.distance;
    } else {
      this.samples.push({ at: now, distance: this.distance });
    }
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

  velocityValidityMs(): number {
    if (this.sampleIntervals.length === 0) return PLATTER_MIN_VELOCITY_VALIDITY_MS;
    const sorted = [...this.sampleIntervals].sort((left, right) => left - right);
    const recentInterval = sorted[Math.floor((sorted.length - 1) / 2)];
    return Math.max(
      PLATTER_MIN_VELOCITY_VALIDITY_MS,
      Math.min(
        PLATTER_MAX_VELOCITY_VALIDITY_MS,
        recentInterval * PLATTER_VELOCITY_VALIDITY_MULTIPLIER,
      ),
    );
  }

  end(at: number): number {
    const now = Math.max(
      finiteTimestamp(at, this.lastInputAt ?? 0),
      this.lastInputAt ?? 0,
    );
    const fresh = this.lastMotionAt !== null
      && now >= this.lastMotionAt
      && now - this.lastMotionAt <= this.velocityValidityMs();
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
    this.sampleIntervals = [];
  }
}

/**
 * Pointer-specific batching around the source-independent velocity tracker. WebKit can stamp
 * every coalesced point with one parent-event time; those points describe one distance sample,
 * not a series of invented 8ms samples.
 */
export class PointerPlatterTracker {
  private readonly tracker = new PlatterVelocityTracker();
  private lastX: number;
  private stationary = true;

  constructor(startX: number, private readonly width: number, at: number) {
    this.lastX = startX;
    this.tracker.start(at);
  }

  move(samples: readonly PointerPlatterSample[], parentAt: number): number | null {
    if (samples.length === 0) return null;
    const timestampsDiffer = samples.some((sample) => sample.timeStamp !== samples[0].timeStamp);
    let groupAt = timestampsDiffer
      ? finiteTimestamp(samples[0].timeStamp, parentAt)
      : finiteTimestamp(parentAt, samples[0].timeStamp);
    let groupDistance = 0;
    let velocity = 0;

    const flush = () => {
      velocity = this.tracker.move(groupDistance, groupAt);
      groupDistance = 0;
    };

    for (const sample of samples) {
      if (!Number.isFinite(sample.clientX)) continue;
      const sampleAt = timestampsDiffer
        ? finiteTimestamp(sample.timeStamp, parentAt)
        : groupAt;
      if (sampleAt !== groupAt) {
        flush();
        groupAt = sampleAt;
      }
      groupDistance += pointerPlatterDistance(sample.clientX - this.lastX, this.width);
      this.lastX = sample.clientX;
    }
    flush();

    if (velocity === 0) {
      if (this.stationary) return null;
      this.stationary = true;
      return 0;
    }
    this.stationary = false;
    return velocity;
  }

  end(at: number): number {
    return this.tracker.end(at);
  }

  velocityValidityMs(): number {
    return this.tracker.velocityValidityMs();
  }
}
