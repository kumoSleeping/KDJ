import type { Track } from "../types";

export interface StreamCueSnapshot {
  cue_ms: number | null;
  end_ms: number | null;
}

const LIMIT = 128;
const cues = new Map<number, StreamCueSnapshot>();
const listeners = new Map<number, Set<() => void>>();

function touch(trackId: number, snapshot: StreamCueSnapshot): void {
  cues.delete(trackId);
  cues.set(trackId, snapshot);
}

function trim(): void {
  while (cues.size > LIMIT) {
    const candidate = cues.keys().next().value as number | undefined;
    if (candidate === undefined) return;
    if (listeners.get(candidate)?.size) {
      const snapshot = cues.get(candidate);
      if (!snapshot) return;
      touch(candidate, snapshot);
      if ([...cues.keys()].every((id) => listeners.get(id)?.size)) return;
      continue;
    }
    cues.delete(candidate);
  }
}

export function streamCueSnapshot(trackId: number): StreamCueSnapshot | null {
  return cues.get(trackId) ?? null;
}

/** 在线曲目的起止点只属于当前应用会话，不冒充可写回文件的持久 Cue。 */
export function updateStreamCue(
  track: Pick<Track, "id" | "cue_ms" | "end_ms">,
  patch: Partial<StreamCueSnapshot>,
): StreamCueSnapshot {
  if (track.id >= 0) throw new Error("会话 Cue 只用于在线试听曲目");
  const current = cues.get(track.id) ?? {
    cue_ms: track.cue_ms,
    end_ms: track.end_ms,
  };
  const next = Object.freeze({ ...current, ...patch });
  touch(track.id, next);
  trim();
  for (const listener of listeners.get(track.id) ?? []) listener();
  return next;
}

export function trackWithStreamCue(track: Track): Track {
  const cue = cues.get(track.id);
  return cue ? { ...track, ...cue } : track;
}

export function subscribeStreamCue(trackId: number, listener: () => void): () => void {
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
