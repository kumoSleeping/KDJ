import type { StreamAnalysisResult, StreamWaveformProgress, Track } from "../types";

export type StreamAnalysisPhase = "idle" | "waiting" | "analyzing" | "ready" | "failed";

export interface StreamAnalysisSnapshot {
  phase: StreamAnalysisPhase;
  result: StreamAnalysisResult | null;
  error: string;
  completedAt: string;
}

const EMPTY_SNAPSHOT: StreamAnalysisSnapshot = Object.freeze({
  phase: "idle",
  result: null,
  error: "",
  completedAt: "",
});

const SNAPSHOT_LIMIT = 128;
const snapshots = new Map<number, StreamAnalysisSnapshot>();
const signatures = new Map<number, string>();
const listeners = new Map<number, Set<() => void>>();

function touch(trackId: number, snapshot: StreamAnalysisSnapshot): void {
  snapshots.delete(trackId);
  snapshots.set(trackId, snapshot);
}

function trim(): void {
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const candidate = snapshots.keys().next().value as number | undefined;
    if (candidate === undefined) return;
    if (listeners.get(candidate)?.size) {
      const protectedSnapshot = snapshots.get(candidate);
      if (!protectedSnapshot) return;
      touch(candidate, protectedSnapshot);
      // 所有条目都有订阅者时不能继续原地轮转。
      if ([...snapshots.keys()].every((id) => listeners.get(id)?.size)) return;
      continue;
    }
    snapshots.delete(candidate);
    signatures.delete(candidate);
  }
}

/** PlayerBar 已有的 token 轮询同时发布完整分析，不建立第二条网络/定时链路。 */
export function recordStreamAnalysisProgress(
  trackId: number,
  progress: StreamWaveformProgress,
): void {
  if (trackId >= 0 || !progress.analysis_status) return;
  const phase = progress.analysis_status;
  const result = progress.analysis ?? null;
  const error = progress.analysis_error?.trim() ?? "";
  const signature = `${phase}\u0000${error}\u0000${result ? JSON.stringify(result) : ""}`;
  const previous = snapshots.get(trackId);
  if (signatures.get(trackId) === signature && previous) {
    touch(trackId, previous);
    return;
  }
  const snapshot: StreamAnalysisSnapshot = {
    phase,
    result,
    error,
    completedAt:
      phase === "ready" || phase === "failed"
        ? previous?.completedAt || new Date().toISOString()
        : "",
  };
  signatures.set(trackId, signature);
  touch(trackId, snapshot);
  trim();
  for (const listener of listeners.get(trackId) ?? []) listener();
}

export function streamAnalysisSnapshot(trackId: number): StreamAnalysisSnapshot {
  return snapshots.get(trackId) ?? EMPTY_SNAPSHOT;
}

/** Project temporary full-file analysis onto the in-memory stream Track used by Performance. */
export function trackWithStreamAnalysis(
  track: Track,
  snapshot: StreamAnalysisSnapshot = streamAnalysisSnapshot(track.id),
): Track {
  const result = snapshot.result;
  if (snapshot.phase !== "ready" || !result) return track;
  return {
    ...track,
    duration: track.duration ?? result.duration,
    bpm: result.bpm ?? track.bpm,
    bpm_v2: result.bpm !== null,
    bpm_confidence: result.bpm_confidence ?? track.bpm_confidence,
    first_beat: result.first_beat ?? track.first_beat,
    beat_origin: result.beat_origin ?? track.beat_origin,
    beat_times: result.beat_times,
    downbeat_origin: result.downbeat_origin ?? track.downbeat_origin,
    downbeats: result.downbeats ?? track.downbeats,
    downbeat_confidence: result.downbeat_confidence ?? track.downbeat_confidence,
    music_key: result.key || result.key_short || track.music_key,
    camelot: result.camelot || track.camelot,
    open_key: result.open_key || track.open_key,
    key_confidence: result.key_confidence ?? track.key_confidence,
    energy: result.energy ?? track.energy,
    rms_db: result.rms_db ?? track.rms_db,
    peak_db: result.peak_db ?? track.peak_db,
    analyzed_at: snapshot.completedAt || track.analyzed_at,
    analysis_error: snapshot.error || result.errors.join("；"),
  };
}

export function subscribeStreamAnalysis(trackId: number, listener: () => void): () => void {
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
