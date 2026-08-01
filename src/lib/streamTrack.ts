/**
 * 在线试听的临时曲目：不入库、不分析，只把最低码率直链挂进主播放条。
 * id 用负数，和曲库主键错开；媒体 URL / 封面记在旁路表里，不污染 Track 契约。
 */

import { api } from "./api";
import { thumbUrl } from "./format";
import type { SongSource, Track } from "../types";

export type StreamKind = "song" | "video";

interface StreamMeta {
  url: string;
  cover: string;
  kind: StreamKind;
  sourceKey: string;
  source: SongSource | null;
  nextTrack: Track | null;
}

const metaById = new Map<number, StreamMeta>();
let nextId = -1;

/** 给独立歌词 WebView 读：主窗写入当前试听曲目快照。 */
const PUBLISHED_STREAM_KEY = "kd-active-stream-track";

function notifyStreamTrackChanged(): void {
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit("stream-track-changed"))
    .catch(() => {});
}

/** 主窗播放 / 切换在线试听时调用，供桌面歌词窗直取平台歌词。 */
export function publishStreamTrack(track: Track | null): void {
  try {
    if (track && track.id < 0) {
      localStorage.setItem(PUBLISHED_STREAM_KEY, JSON.stringify(track));
    } else {
      localStorage.removeItem(PUBLISHED_STREAM_KEY);
    }
  } catch {
    // localStorage 满了也不挡播放。
  }
  notifyStreamTrackChanged();
}

export function readPublishedStreamTrack(trackId: number): Track | null {
  if (trackId >= 0) return null;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PUBLISHED_STREAM_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const track = raw as Track;
    return track.id === trackId ? track : null;
  } catch {
    return null;
  }
}

export function isStreamTrack(track: Track | null | undefined): boolean {
  return Boolean(track && track.id < 0);
}

export function streamMeta(track: Track | null | undefined): StreamMeta | null {
  if (!track || track.id >= 0) return null;
  return metaById.get(track.id) ?? null;
}

export function streamMediaUrl(track: Track): string | null {
  return streamMeta(track)?.url || null;
}

export function streamCoverUrl(track: Track): string {
  const cover = streamMeta(track)?.cover ?? "";
  return cover ? thumbUrl(cover, 96) : "";
}

/** 主播放条 / DJ 引擎装 src 时用：在线流优先，否则走曲库音频接口。 */
export function mediaUrlForTrack(track: Track): string {
  return streamMediaUrl(track) ?? api.audioUrl(track.id);
}

export function makeSongStreamTrack(source: SongSource, url: string): Track {
  const id = nextId--;
  const title = source.title || "在线试听";
  const artist = source.artists.join(", ");
  metaById.set(id, {
    url,
    cover: source.cover || "",
    kind: "song",
    sourceKey: `${source.platform}:${source.key}`,
    source,
    nextTrack: null,
  });
  const now = new Date().toISOString();
  const track: Track = {
    id,
    path: `stream:${source.platform}:${source.key}`,
    filename: title,
    title,
    artist,
    album: source.album || "",
    genre: "",
    year: "",
    duration: source.duration,
    bitrate: null,
    samplerate: null,
    channels: null,
    format: "stream",
    size: 0,
    bpm: null,
    bpm_confidence: null,
    first_beat: null,
    music_key: "",
    camelot: "",
    open_key: "",
    key_confidence: null,
    energy: null,
    rms_db: null,
    peak_db: null,
    rating: 0,
    color: "",
    comment: "在线试听（最低音质，未下载）",
    cue_ms: null,
    end_ms: null,
    source_platform: source.platform,
    source_key: source.key,
    analyzed_at: null,
    added_at: now,
    modified_at: now,
    analysis_error: "",
    tags: [],
    folder: "",
    link: "",
  };
  return track;
}

/** 搜索结果的后继项先只建展示元数据；真正轮到它播放时才解析直链。 */
export function makePendingSongStreamTrack(source: SongSource): Track {
  return makeSongStreamTrack(source, "");
}

export function setStreamNextTrack(track: Track, next: Track | null): void {
  const meta = streamMeta(track);
  if (meta) meta.nextTrack = next;
}

export function streamNextTrack(track: Track | null | undefined): Track | null {
  return streamMeta(track)?.nextTrack ?? null;
}

/** 将搜索结果占位曲目解析成可播放流，保留 id 和已经串好的后继链。 */
export async function preloadStreamTrack(track: Track): Promise<void> {
  const meta = streamMeta(track);
  if (!meta) throw new Error("在线试听上下文已经失效");
  if (meta.url) return;
  if (!meta.source) throw new Error("在线试听来源缺失");
  const { url } = await api.songPreview(meta.source);
  meta.url = url;
}

export async function resolvePendingStreamTrack(track: Track): Promise<Track> {
  const meta = streamMeta(track);
  if (!meta) throw new Error("在线试听上下文已经失效");
  await preloadStreamTrack(track);
  return track;
}
