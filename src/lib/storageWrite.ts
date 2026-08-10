/**
 * WebView 持久化写合并器。
 *
 * localStorage 的 API 是同步的，但 Chromium/WebView 最终仍会把值写进电脑硬盘。
 * 播放时钟、音量和拖动中的颜色滑条都可能一秒更新很多次；这些状态在内存里应当
 * 立即生效，落盘只需保留窗口内最后一份。每个 key 固定窗口最多写一次，页面退出
 * 前再统一 flush，避免把连续手势放大成大量小写入。
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type TimerId = number;
type ScheduleTimer = (callback: () => void, delayMs: number) => TimerId;
type CancelTimer = (timer: TimerId) => void;

interface PendingWrite {
  value: string;
  timer: TimerId;
}

export class DeferredStorageWriter {
  private readonly pending = new Map<string, PendingWrite>();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly scheduleTimer: ScheduleTimer,
    private readonly cancelTimer: CancelTimer,
  ) {}

  writeSoon(key: string, value: string, delayMs = 1_000): void {
    const queued = this.pending.get(key);
    if (queued) {
      // 不重置 timer：持续不断的 timeupdate 也必须按固定窗口落一次，而不是永远拖后。
      queued.value = value;
      return;
    }
    try {
      if (this.storage.getItem(key) === value) return;
    } catch {
      // 受限存储在 getItem 或 setItem 都可能抛错；延后再试，不能影响播放/UI。
    }
    const timer = this.scheduleTimer(() => this.flushKey(key), Math.max(0, delayMs));
    this.pending.set(key, { value, timer });
  }

  writeNow(key: string, value: string): void {
    this.discard(key);
    this.commit(key, value);
  }

  discard(key: string): void {
    const queued = this.pending.get(key);
    if (!queued) return;
    this.cancelTimer(queued.timer);
    this.pending.delete(key);
  }

  flushKey(key: string): void {
    const queued = this.pending.get(key);
    if (!queued) return;
    this.pending.delete(key);
    this.commit(key, queued.value);
  }

  flushAll(): void {
    for (const [key, queued] of this.pending) {
      this.cancelTimer(queued.timer);
      this.commit(key, queued.value);
    }
    this.pending.clear();
  }

  private commit(key: string, value: string): void {
    try {
      if (this.storage.getItem(key) !== value) this.storage.setItem(key, value);
    } catch {
      // 配额、隐私模式或系统策略禁用存储：丢偏好不应阻断主功能。
    }
  }
}

let browserWriter: DeferredStorageWriter | null = null;

function writer(): DeferredStorageWriter | null {
  if (browserWriter) return browserWriter;
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  browserWriter = new DeferredStorageWriter(
    localStorage,
    (callback, delayMs) => window.setTimeout(callback, delayMs),
    (timer) => window.clearTimeout(timer),
  );
  return browserWriter;
}

export function writeLocalStorageSoon(key: string, value: string, delayMs?: number): void {
  writer()?.writeSoon(key, value, delayMs);
}

export function writeLocalStorageNow(key: string, value: string): void {
  writer()?.writeNow(key, value);
}

export function discardLocalStorageWrite(key: string): void {
  writer()?.discard(key);
}

export function flushLocalStorageWrites(): void {
  browserWriter?.flushAll();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushLocalStorageWrites);
}
