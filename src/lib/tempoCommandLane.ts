/**
 * Latest-value delivery for a continuous TEMPO fader.
 *
 * Pointer events can arrive far faster than IPC, and every acknowledged native command used to
 * force React to retarget all waveform rails. This lane sends the first position immediately,
 * then retains only one trailing value per short audio-control interval. It is intentionally not
 * a debounce: a held fader keeps changing tempo, while stale intermediate values never queue.
 */

export interface TempoLaneClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const browserClock: TempoLaneClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) =>
    window.setTimeout(callback, delayMs) as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: (timer) => window.clearTimeout(timer as unknown as number),
};

/** One latest value per display frame keeps a physical/software fader smooth without queuing. */
export const TEMPO_COMMAND_INTERVAL_MS = 16;

export class LatestTempoCommandLane {
  private pending: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly dispatch: (rate: number) => void;
  private readonly intervalMs: number;
  private readonly clock: TempoLaneClock;

  constructor(
    dispatch: (rate: number) => void,
    intervalMs = TEMPO_COMMAND_INTERVAL_MS,
    clock: TempoLaneClock = browserClock,
  ) {
    this.dispatch = dispatch;
    this.intervalMs = Math.max(1, intervalMs);
    this.clock = clock;
  }

  submit(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.pending = rate;
    const elapsed = this.clock.now() - this.lastSentAt;
    if (elapsed >= this.intervalMs) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, Math.max(0, this.intervalMs - elapsed));
  }

  /** Deliver the final pointer-up/key value without waiting for the trailing timer. */
  flush(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    const rate = this.pending;
    this.pending = null;
    if (rate === null) return;
    this.lastSentAt = this.clock.now();
    this.dispatch(rate);
  }

  /** A deck replacement supersedes a gesture; never deliver its stale final value to a new song. */
  cancel(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
