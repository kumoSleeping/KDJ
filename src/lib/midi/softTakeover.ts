/**
 * Mixxx 式软接管：绝对行程的实体推子和软件值错开时，忽略硬件，直到它追上软件位置。
 *
 * 典型场景是 SYNC 把虚拟 TEMPO 推到新 BPM（超量程则钉在量程边界），机体推子还停在原位。
 * 算法对齐 Mixxx `src/controllers/softtakeover.cpp`：同侧且远离则忽略，越过软件值或进入
 * 阈值则接管；已接管后 50ms 内的后续值放行，避免慢刷新推子被当成跳变。
 */

/** 3/128 行程：能接住非连续的快推，又听不出明显跳速。 */
export const SOFT_TAKEOVER_THRESHOLD = 3 / 128;
/** Mixxx `kSubsequentValueOverrideTime`：已接管后的甩杆窗口。 */
export const SOFT_TAKEOVER_WHIP_MS = 50;

export class SoftTakeover {
  private prev: number | null = null;
  private acceptedAt = Number.NEGATIVE_INFINITY;
  private readonly threshold: number;
  private readonly whipMs: number;

  constructor(threshold = SOFT_TAKEOVER_THRESHOLD, whipMs = SOFT_TAKEOVER_WHIP_MS) {
    this.threshold = threshold;
    this.whipMs = whipMs;
  }

  /** 软件侧自己改了值（SYNC、屏幕推子、换轨、切量程）后，下一笔硬件必须重新追上。 */
  ignoreNext(): void {
    this.prev = null;
  }

  /**
   * @param current 软件当前值（0..1 推子行程）
   * @param incoming 这一笔硬件值（同一空间）
   * @returns 为 true 时调用方不得把 incoming 写进引擎
   */
  ignore(current: number, incoming: number, now = SoftTakeover.now()): boolean {
    if (!Number.isFinite(current) || !Number.isFinite(incoming)) return true;
    const previous = this.prev;
    this.prev = incoming;
    if (previous == null) return true;
    if (now < this.acceptedAt + this.whipMs) {
      this.acceptedAt = now;
      return false;
    }
    const difference = current - incoming;
    const prevDiff = current - previous;
    if (Math.sign(prevDiff) !== Math.sign(difference)) {
      this.acceptedAt = now;
      return false;
    }
    if (Math.abs(difference) <= this.threshold || Math.abs(prevDiff) <= this.threshold) {
      this.acceptedAt = now;
      return false;
    }
    return true;
  }

  static now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}
