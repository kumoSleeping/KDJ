import { api } from "./api";
import { oneLibraryTrackByPlaybackId } from "./oneLibraryTrack";
import {
  isOneLibraryPlaybackTrack,
  localLibraryDataTrackId,
  oneLibraryPlaybackSource,
  usesLocalLibraryRecord,
} from "./playbackTrackSource";
import {
  isStreamTrack,
  makePendingSongStreamTrack,
  mediaUrlForTrack,
  resolvePendingStreamTrack,
  streamCoverUrl,
  streamTrackById,
} from "./streamTrack";
import {
  streamAnalysisSnapshot,
  subscribeStreamAnalysis,
  trackWithStreamAnalysis,
} from "./streamAnalysis";
import type { SongSource, Track } from "../types";
import type { UnifiedPlayerSource } from "./unifiedPlayer";

/**
 * Everything outside this module deals in a Track, regardless of where its bytes came from.
 * Provider search rows, temporary stream tracks, OneLibrary snapshots and local database ids are
 * normalized exactly once at the input edge instead of growing parallel Deck implementations.
 */
export type PlaybackTrackRequest =
  | { kind: "track"; track: Track }
  | { kind: "track-id"; trackId: number }
  | { kind: "song-source"; source: SongSource };

export function trackRequest(track: Track): PlaybackTrackRequest {
  return { kind: "track", track };
}

export function trackIdRequest(trackId: number): PlaybackTrackRequest {
  return { kind: "track-id", trackId };
}

export function songSourceRequest(source: SongSource): PlaybackTrackRequest {
  return { kind: "song-source", source };
}

/** Resolve presentation/search identity into the common Track contract. No media is opened here. */
export async function resolvePlaybackTrack(request: PlaybackTrackRequest): Promise<Track> {
  switch (request.kind) {
    case "track":
      return request.track;
    case "song-source":
      return makePendingSongStreamTrack(request.source);
    case "track-id": {
      if (!Number.isFinite(request.trackId)) throw new Error("无效的曲目 ID");
      return oneLibraryTrackByPlaybackId(request.trackId)
        ?? streamTrackById(request.trackId)
        ?? api.track(request.trackId);
    }
  }
}

/**
 * Resolve the only source-specific part of a Deck load. Once this returns, local and remote tracks
 * use the exact same coordinator load/seek/mixer lifecycle.
 */
export async function playbackSourceForTrack(
  track: Track,
  options: Omit<UnifiedPlayerSource, "src" | "track" | "artworkUrl"> = {},
): Promise<UnifiedPlayerSource> {
  await ensurePlaybackTrackReady(track);
  return {
    ...options,
    src: mediaUrlForTrack(track),
    track,
    artworkUrl: playbackArtworkUrl(track),
  };
}

/** Resolve lazy provider media without making transport callers branch on source kind. */
export async function ensurePlaybackTrackReady(track: Track): Promise<Track> {
  return isStreamTrack(track) ? resolvePendingStreamTrack(track) : track;
}

/** A source adapter owns artwork lookup too; Deck/UI callers do not branch on id sign. */
export function playbackArtworkUrl(track: Track): string {
  if (isStreamTrack(track)) return streamCoverUrl(track);
  const source = oneLibraryPlaybackSource(track);
  if (source) {
    return api.oneLibraryCoverUrl(source.devicePath, source.contentId, track.modified_at);
  }
  return usesLocalLibraryRecord(track) ? api.coverUrl(track.id, track.modified_at) : "";
}

/**
 * Hydrate BPM/key/grid metadata while preserving the playable Track identity and path. The UI has
 * one metadata contract; only this adapter knows whether it came from the DB or stream analysis.
 */
export async function hydratePlaybackTrack(track: Track): Promise<Track> {
  if (isStreamTrack(track)) {
    return trackWithStreamAnalysis(track, streamAnalysisSnapshot(track.id));
  }
  const localId = localLibraryDataTrackId(track);
  if (localId === null) return track;
  const analyzed = await api.track(localId);
  if (!isOneLibraryPlaybackTrack(track)) return analyzed;
  return {
    ...track,
    bpm: analyzed.bpm ?? track.bpm,
    bpm_v2: analyzed.bpm_v2,
    bpm_confidence: analyzed.bpm_confidence ?? track.bpm_confidence,
    first_beat: analyzed.first_beat ?? track.first_beat,
    music_key: analyzed.music_key || track.music_key,
    camelot: analyzed.camelot || track.camelot,
    open_key: analyzed.open_key || track.open_key,
    key_confidence: analyzed.key_confidence ?? track.key_confidence,
    energy: analyzed.energy ?? track.energy,
    rms_db: analyzed.rms_db ?? track.rms_db,
    peak_db: analyzed.peak_db ?? track.peak_db,
    analyzed_at: analyzed.analyzed_at ?? track.analyzed_at,
    analysis_error: analyzed.analysis_error || track.analysis_error,
  };
}

/** Subscribe to metadata that can change while a Deck stays mounted. */
export function subscribePlaybackTrackMetadata(track: Track, listener: () => void): () => void {
  return isStreamTrack(track) ? subscribeStreamAnalysis(track.id, listener) : () => {};
}
