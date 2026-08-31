import type { Track } from "../types";

export function usesRemotePlaybackSource(
  track: Track | null | undefined,
): boolean {
  return Boolean(track && track.id < 0);
}

export function localLibraryDataTrackId(
  track: Track | null | undefined,
): number | null {
  if (!track) return null;
  if (track.id > 0) return track.id;
  return null;
}

/** 只有正数 id 对应 KDJ 本地 tracks 表；详情、分析、标签和本地封面 API 都以此为界。 */
export function usesLocalLibraryRecord(
  track: Track | null | undefined,
): track is Track {
  return Boolean(track && track.id > 0);
}
