import type {
  OneLibraryPlaylist,
  OneLibraryTarget,
  OneLibraryTrack,
  RemovableDevice,
  Track,
} from "../types";
import { canonicalTrackCamelot } from "./keyDisplay";

export const ONE_LIBRARY_FILTER_TOGGLE_EVENT = "kd:onelibrary-filter-toggle";

export function reconcileOneLibrarySelection(
  tracks: OneLibraryTrack[],
  selectedContentIds: number[],
  focusedContentId: number | null,
) {
  const remaining = new Set(tracks.map((track) => track.content_id));
  return {
    selectedContentIds: selectedContentIds.filter((id) => remaining.has(id)),
    focusedContentId:
      focusedContentId !== null && remaining.has(focusedContentId)
        ? focusedContentId
        : null,
  };
}

/**
 * 设备刷新后只保留仍指向同一类已挂载设备的选择。
 * 除了路径也比较虚拟/实体身份，避免卸载 KDJ 后同一路径被其它卷复用时留下旧列表。
 */
export function isOneLibraryTargetConnected(
  target: OneLibraryTarget,
  devices: RemovableDevice[],
): boolean {
  return devices.some(
    (device) =>
      device.path === target.device_path && device.is_virtual === target.is_virtual,
  );
}

/** 把拖放 DOM 上的设备路径/列表 id 解析回完整且仍可写的 OneLibrary 目标。 */
export function resolveOneLibraryDropTarget(
  devicePath: string,
  playlistId: number,
  devices: RemovableDevice[],
  playlistsByDevice: Record<string, OneLibraryPlaylist[]>,
): OneLibraryTarget | null {
  const device = devices.find(
    (candidate) =>
      candidate.path === devicePath &&
      !candidate.read_only &&
      candidate.one_library_file_system,
  );
  const playlist = playlistsByDevice[devicePath]?.find(
    (candidate) => candidate.id === playlistId && candidate.attribute === 0,
  );
  if (!device || !playlist) return null;
  return {
    device_path: device.path,
    device_name: device.name,
    is_virtual: device.is_virtual,
    playlist_id: playlist.id,
    playlist_name: playlist.name,
  };
}

/**
 * OneLibrary 曲目不在 KDJ 本地 tracks 表里，但播放器仍只需要一份 Track 快照。
 * id 放到远离在线试听自增负数的区间；同一设备/内容在本次运行里始终稳定。
 */
function playbackId(target: OneLibraryTarget, contentId: number): number {
  const value = `${target.device_path}\u0000${contentId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return -1_000_000_000 - (hash >>> 0);
}

/** 播放历史只存 id；保留本次运行见过的外置快照，上一首不会误查本地 tracks API。 */
const playbackTracks = new Map<number, Track>();

export function oneLibraryTrackByPlaybackId(id: number): Track | null {
  return playbackTracks.get(id) ?? null;
}

export function oneLibraryPlayableTrack(
  track: OneLibraryTrack,
  target: OneLibraryTarget,
): Track {
  const normalized = track.path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const dot = track.filename.lastIndexOf(".");
  const format = dot >= 0 ? track.filename.slice(dot + 1).toLowerCase() : "";
  const playable: Track = {
    id: playbackId(target, track.content_id),
    path: track.path,
    filename: track.filename,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    year: track.year,
    duration: track.duration,
    bitrate: track.bitrate,
    samplerate: track.samplerate,
    channels: null,
    format,
    size: track.size,
    bpm: track.bpm,
    bpm_v2: false,
    bpm_confidence: null,
    first_beat: null,
    music_key: track.music_key,
    camelot: canonicalTrackCamelot(track),
    open_key: track.open_key ?? "",
    key_confidence: null,
    energy: null,
    rms_db: null,
    peak_db: null,
    rating: track.rating,
    color: "",
    comment: track.comment,
    cue_ms: null,
    end_ms: null,
    cue_points: track.cue_points ?? [],
    local_track_id: track.local_track_id,
    source_platform: "onelibrary",
    source_key: `${target.device_path}:${track.content_id}`,
    analyzed_at: null,
    added_at: "",
    modified_at: "",
    analysis_error: "",
    tags: [],
    folder: slash >= 0 ? normalized.slice(0, slash) : "",
  };
  playbackTracks.set(playable.id, playable);
  return playable;
}

/** 保持被拖块内部顺序，把整块插到目标行前/后。 */
export function reorderOneLibraryContentIds(
  current: number[],
  movedIds: number[],
  targetId: number,
  before: boolean,
): number[] {
  const movedSet = new Set(movedIds);
  const moved = current.filter((id) => movedSet.has(id));
  const rest = current.filter((id) => !movedSet.has(id));
  const targetIndex = rest.indexOf(targetId);
  if (moved.length === 0 || targetIndex < 0) return current;
  const insertAt = targetIndex + (before ? 0 : 1);
  return [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
}
