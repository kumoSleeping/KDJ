import type { PlayableTrack, Track } from "../types";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const PLAY_INTENT_SEQUENCE_KEY = "kdj-play-intent-sequence";
let nextIntentId = 0;

function validIntentId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
}

export function issuePlayIntentId(requested?: number): number {
  // The Rust manager outlives a WebView reload and rejects intents below its high-water mark.
  // Read the persisted sequence at each issuance: HMR can leave both old and new module users
  // alive briefly. Commit synchronously before dispatch so a reload cannot reuse a sent intent.
  const stored = Number(readLocalStorage(PLAY_INTENT_SEQUENCE_KEY));
  nextIntentId = Math.max(nextIntentId, validIntentId(stored) ? stored : 0);
  if (validIntentId(requested)) {
    nextIntentId = Math.max(nextIntentId, requested);
    writeLocalStorageNow(PLAY_INTENT_SEQUENCE_KEY, String(nextIntentId));
    // Preserve a received request's identity. Promoting it here would let late A supersede B.
    return requested;
  }
  // The epoch seed also upgrades a running pre-persistence backend without restarting audio.
  // The persisted counter, rather than wall time alone, handles same-ms clicks and clock rollback.
  nextIntentId = Math.max(nextIntentId + 1, Date.now());
  writeLocalStorageNow(PLAY_INTENT_SEQUENCE_KEY, String(nextIntentId));
  return nextIntentId;
}

/** Full details alone may enter selectedTrack; a synthesized player model never may. */
export function isCompleteTrack(track: PlayableTrack): track is Track {
  return "tags" in track && Array.isArray((track as Partial<Track>).tags);
}

export function materializePlayableTrack(track: PlayableTrack): Track {
  if (isCompleteTrack(track)) return track;
  return {
    ...track,
    genre: "",
    year: "",
    bitrate: null,
    samplerate: null,
    channels: null,
    bpm_confidence: track.bpm_confidence ?? null,
    first_beat: track.first_beat ?? null,
    beat_origin: track.beat_origin ?? null,
    beat_times: [],
    downbeat_origin: track.downbeat_origin ?? null,
    downbeats: [],
    downbeat_confidence: track.downbeat_confidence ?? null,
    beat_grid_revision: track.beat_grid_revision,
    key_confidence: null,
    color: "",
    comment: "",
    cue_ms: track.cue_ms ?? null,
    end_ms: track.end_ms ?? null,
    cue_points: [],
    cue_points_managed: false,
    analysis_error: "",
    tags: [],
  };
}

/** Pure fence shared by tests and async metadata consumers. */
export function isLatestPlayIntent(
  latestIntentId: number,
  latestTrackId: number,
  intentId: number,
  trackId: number,
): boolean {
  return latestIntentId === intentId && latestTrackId === trackId;
}
