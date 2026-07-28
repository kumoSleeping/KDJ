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
}

const metaById = new Map<number, StreamMeta>();
let nextId = -1;

export function isStreamTrack(track: Track | null | undefined): boolean {
  return Boolean(track && track.id < 0);
}

export function streamMeta(track: Track | null | undefined): StreamMeta | null {
  if (!track || track.id >= 0) return null;
  return metaById.get(track.id) ?? null;
}

export function streamMediaUrl(track: Track): string | null {
  return streamMeta(track)?.url ?? null;
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
  });
  const now = new Date().toISOString();
  return {
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
}
