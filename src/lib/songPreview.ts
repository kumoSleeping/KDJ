/**
 * 搜索结果在线试听：解析最低码率直链，装进主播放条（临时 Track）。
 * 右栏 SongPreviewPanel 已停用；只有双击 / 右键「播放」才进条并开播，
 * 单击搜索结果不碰正在播的。
 */

import { api } from "./api";
import { playTrack } from "./playTrack";
import {
  makePendingSongStreamTrack,
  makeSongStreamTrack,
  setStreamNextTrack,
} from "./streamTrack";
import type { SongSource } from "../types";

export const SONG_PREVIEW_EVENT = "kd:song-preview";

export interface SongPreviewItem {
  source: SongSource;
  title: string;
  artist: string;
}

export interface SongPreviewRequest extends SongPreviewItem {
  /** 为 true 时主播放条自动开播。搜索入口现在一律 true。 */
  autoPlay?: boolean;
  /** 当前搜索结果中排在本项之后的歌曲；用于填充主播放条“下一首”。 */
  queue?: SongPreviewItem[];
}

export function requestSongPreview(request: SongPreviewRequest): void {
  window.dispatchEvent(new CustomEvent<SongPreviewRequest>(SONG_PREVIEW_EVENT, { detail: request }));
}

export function sourceKey(source: SongSource): string {
  return `${source.platform}:${source.key}`;
}

/** 解析直链期间用户又点了别的，晚回来的结果直接作废。 */
let seq = 0;

/**
 * 把一首在线来源送进主播放条。失败时把原因抛给调用方（行上可自行提示）。
 */
export async function playSongPreview(request: SongPreviewRequest): Promise<void> {
  const mySeq = ++seq;
  const { url } = await api.songPreview(request.source);
  if (seq !== mySeq) return;
  const normalize = (item: SongPreviewItem): SongSource => ({
    ...item.source,
    title: item.title || item.source.title,
    artists: item.artist
      ? item.artist.split(",").map((part) => part.trim()).filter(Boolean)
      : item.source.artists,
  });
  const track = makeSongStreamTrack(normalize(request), url);
  const following = (request.queue ?? []).map((item) =>
    makePendingSongStreamTrack(normalize(item)),
  );
  for (let index = 0; index < following.length - 1; index += 1) {
    setStreamNextTrack(following[index], following[index + 1]);
  }
  setStreamNextTrack(track, following[0] ?? null);
  playTrack(track, request.autoPlay !== false);
}

/** 挂到 window，供 Workspace / App 一次性订阅。 */
export function bindSongPreviewToPlayer(): () => void {
  const onPreview = (event: Event) => {
    const detail = (event as CustomEvent<SongPreviewRequest>).detail;
    if (!detail?.source) return;
    void playSongPreview(detail).catch(() => {
      /* 播放条会在 media error 时提示；这里避免未捕获 Promise */
    });
  };
  window.addEventListener(SONG_PREVIEW_EVENT, onPreview);
  return () => window.removeEventListener(SONG_PREVIEW_EVENT, onPreview);
}
