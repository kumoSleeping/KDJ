import type { Track } from "../types";

/** OneLibrary 曲目来自当前挂载的外置卷，不是 KDJ 曲库记录或在线试听。 */
export function isOneLibraryPlaybackTrack(
  track: Track | null | undefined,
): boolean {
  // 拖回本地曲库的文件也会保留 source_platform=onelibrary，但它已有正数曲库 id。
  // 只有外置卷播放快照使用负数稳定 id，不能把导入后的本地记录再绕回外置盘 API。
  return Boolean(track && track.id < 0 && track.source_platform === "onelibrary");
}

export interface OneLibraryPlaybackSource {
  devicePath: string;
  contentId: number;
}

/** source_key 使用“设备路径:content_id”；从最后一个冒号切，兼容 Windows 盘符。 */
export function oneLibraryPlaybackSource(
  track: Track | null | undefined,
): OneLibraryPlaybackSource | null {
  if (!isOneLibraryPlaybackTrack(track)) return null;
  const source = track?.source_key ?? "";
  const separator = source.lastIndexOf(":");
  if (separator <= 0) return null;
  const rawContentId = source.slice(separator + 1);
  const devicePath = source.slice(0, separator);
  if (!devicePath || !/^[1-9]\d*$/.test(rawContentId)) return null;
  const contentId = Number(rawContentId);
  return Number.isSafeInteger(contentId) ? { devicePath, contentId } : null;
}

/**
 * 在线试听目前使用负数临时 id；OneLibrary 也使用负数稳定 id，所以不能只看符号。
 * source_platform 是这两类播放来源之间已有的显式边界。
 */
export function usesRemotePlaybackSource(
  track: Track | null | undefined,
): boolean {
  return Boolean(track && track.id < 0 && !isOneLibraryPlaybackTrack(track));
}

/** OneLibrary 导出副本可复用原曲歌词；外来曲目和在线试听没有本地数据来源。 */
export function localLibraryDataTrackId(
  track: Track | null | undefined,
): number | null {
  if (!track) return null;
  if (track.id > 0) return track.id;
  if (
    isOneLibraryPlaybackTrack(track)
    && typeof track.local_track_id === "number"
    && Number.isSafeInteger(track.local_track_id)
    && track.local_track_id > 0
  ) return track.local_track_id;
  return null;
}

/** 只有正数 id 对应 KDJ 本地 tracks 表；详情、分析、标签和本地封面 API 都以此为界。 */
export function usesLocalLibraryRecord(
  track: Track | null | undefined,
): track is Track {
  return Boolean(track && track.id > 0);
}
