/**
 * 搜索结果在线试听：按试听音质设置解析代理地址，装进主播放条（临时 Track）。
 * 右栏 SongPreviewPanel 已停用；只有双击 / 右键「播放」才进条并开播，
 * 单击搜索结果不碰正在播的。
 */

import { playTrack } from "./playTrack";
import {
  makePendingSongStreamTrack,
  makeSongStreamTrack,
  preloadStreamTrack,
  setStreamNextTrack,
} from "./streamTrack";
import type { SongSource } from "../types";

export const SONG_PREVIEW_STATE_EVENT = "kd:song-preview-state";

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
  /** 解码/读取失败后的重试：丢弃可能损坏的本地缓存并强制回源。 */
  bypassCache?: boolean;
}

export type SongPreviewPhase = "idle" | "resolving" | "ready" | "error";

/** 右侧详情栏只订阅解析状态，不持有第二套播放器或 audio 元素。 */
export interface SongPreviewState {
  phase: SongPreviewPhase;
  requestId: number;
  sourceKey: string;
  request: SongPreviewRequest | null;
  trackId: number | null;
  error: string;
  canRetry: boolean;
}

const EMPTY_PREVIEW_STATE: SongPreviewState = {
  phase: "idle",
  requestId: 0,
  sourceKey: "",
  request: null,
  trackId: null,
  error: "",
  canRetry: false,
};

let previewState = EMPTY_PREVIEW_STATE;
const previewStateListeners = new Set<() => void>();

export function getSongPreviewState(): SongPreviewState {
  return previewState;
}

export function subscribeSongPreviewState(listener: () => void): () => void {
  previewStateListeners.add(listener);
  return () => previewStateListeners.delete(listener);
}

function publishSongPreviewState(next: SongPreviewState): void {
  previewState = next;
  for (const listener of previewStateListeners) listener();
  window.dispatchEvent(
    new CustomEvent<SongPreviewState>(SONG_PREVIEW_STATE_EVENT, { detail: next }),
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason || "在线试听解析失败");
}

export function requestSongPreview(request: SongPreviewRequest): void {
  // Do not bounce this user gesture through a temporary window listener. During startup/HMR the
  // result table can become interactive one passive-effect tick before App installs that listener;
  // the first double-click was then dropped while the second worked. Start the owned async lane
  // directly; playSongPreview already has latest-intent sequencing for late provider responses.
  void playSongPreview(request).catch((reason: unknown) => {
    console.warn("在线试听解析失败", reason);
  });
}

export function sourceKey(source: SongSource): string {
  return `${source.platform}:${source.key}`;
}

/** 解析直链期间用户又点了别的，晚回来的结果直接作废。 */
let seq = 0;

/**
 * 把一首在线来源送进主播放条。失败时把原因抛给调用方（行上可自行提示）。
 *
 * YouTube Music 等平台解析直链可能要等 BotGuard / poToken，不能把唱盘反馈绑在
 * 这次网络完成上。先用已有封面标题占位装盘，真正的媒体由 PlayerBar 等直链就绪后 load。
 */
export async function playSongPreview(request: SongPreviewRequest): Promise<void> {
  const mySeq = ++seq;
  const key = sourceKey(request.source);
  const normalize = (item: SongPreviewItem): SongSource => ({
    ...item.source,
    title: item.title || item.source.title,
    artists: item.artist
      ? item.artist.split(",").map((part) => part.trim()).filter(Boolean)
      : item.source.artists,
  });
  const track = makeSongStreamTrack(
    normalize(request),
    "",
    request.bypassCache === true,
  );
  const following = (request.queue ?? []).map((item) =>
    makePendingSongStreamTrack(normalize(item)),
  );
  for (let index = 0; index < following.length - 1; index += 1) {
    setStreamNextTrack(following[index], following[index + 1]);
  }
  setStreamNextTrack(track, following[0] ?? null);
  publishSongPreviewState({
    phase: "resolving",
    requestId: mySeq,
    sourceKey: key,
    request,
    trackId: track.id,
    error: "",
    canRetry: false,
  });
  playTrack(track, request.autoPlay !== false);
  try {
    await preloadStreamTrack(track);
    if (seq !== mySeq) return;
    publishSongPreviewState({
      phase: "ready",
      requestId: mySeq,
      sourceKey: key,
      request,
      trackId: track.id,
      error: "",
      canRetry: false,
    });
  } catch (reason: unknown) {
    if (seq === mySeq) {
      publishSongPreviewState({
        phase: "error",
        requestId: mySeq,
        sourceKey: key,
        request,
        trackId: track.id,
        error: errorText(reason),
        canRetry: true,
      });
    }
    throw reason;
  }
}

/** 失败提示上的“重试”复用原始来源与队列，不要求结果行仍挂载。 */
export function retrySongPreview(
  request: SongPreviewRequest | null = previewState.request,
): Promise<void> {
  if (!request) return Promise.reject(new Error("没有可重试的在线试听"));
  return playSongPreview({ ...request, bypassCache: true });
}
