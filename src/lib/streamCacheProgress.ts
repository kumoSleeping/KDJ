import type { StreamWaveformProgress } from "../types";

export interface StreamCacheProgressSnapshot {
  cachedBytes: number;
  totalBytes: number;
  complete: boolean;
  active: boolean;
  updatedAt: number;
}

const EMPTY_SNAPSHOT: StreamCacheProgressSnapshot = Object.freeze({
  cachedBytes: 0,
  totalBytes: 0,
  complete: false,
  active: false,
  updatedAt: 0,
});

const SNAPSHOT_LIMIT = 128;
const snapshots = new Map<number, StreamCacheProgressSnapshot>();
const listeners = new Map<number, Set<() => void>>();

function finiteBytes(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function trim(): void {
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const candidate = [...snapshots.keys()].find((trackId) => !listeners.get(trackId)?.size);
    if (candidate === undefined) return;
    snapshots.delete(candidate);
  }
}

/** PlayerBar 的既有会话轮询顺手发布媒体字节，不建立第二套请求或定时器。 */
export function recordStreamCacheProgress(
  trackId: number,
  progress: StreamWaveformProgress,
): void {
  if (trackId >= 0) return;
  const cachedBytes = finiteBytes(progress.cached_bytes);
  const totalBytes = Math.max(cachedBytes, finiteBytes(progress.total_bytes));
  const next: StreamCacheProgressSnapshot = {
    cachedBytes,
    totalBytes,
    complete: progress.complete,
    active: progress.active,
    updatedAt: Date.now(),
  };
  const previous = snapshots.get(trackId);
  if (
    previous &&
    previous.cachedBytes === next.cachedBytes &&
    previous.totalBytes === next.totalBytes &&
    previous.complete === next.complete &&
    previous.active === next.active
  ) {
    return;
  }
  snapshots.delete(trackId);
  snapshots.set(trackId, next);
  trim();
  for (const listener of listeners.get(trackId) ?? []) listener();
}

export function streamCacheProgressSnapshot(trackId: number): StreamCacheProgressSnapshot {
  return snapshots.get(trackId) ?? EMPTY_SNAPSHOT;
}

export function clearStreamCacheProgressCache(): void {
  const affected = new Set([...snapshots.keys(), ...listeners.keys()]);
  snapshots.clear();
  for (const trackId of affected) {
    for (const listener of listeners.get(trackId) ?? []) listener();
  }
}

export function subscribeStreamCacheProgress(
  trackId: number,
  listener: () => void,
): () => void {
  if (trackId >= 0) return () => {};
  let current = listeners.get(trackId);
  if (!current) {
    current = new Set();
    listeners.set(trackId, current);
  }
  current.add(listener);
  return () => {
    current?.delete(listener);
    if (!current?.size) listeners.delete(trackId);
    trim();
  };
}
