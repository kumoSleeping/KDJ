/**
 * 播放事件：曲库双击、在线试听、自动续播都发到这里，PlayerBar 接住。
 * 单独成文件，避免 lib ↔ 大组件互相 import。
 *
 * 本地视频在这里就发出 LOCAL_VIDEO（对齐网络侧 requestVideoPreview 在点击处发出），
 * 不把小窗命运绑在 PlayerBar 是否已挂上 PLAY 监听上。
 */

import { isVideoTrack } from "./format";
import { requestLocalVideo, useVideoPip } from "./videoPip";
import { prefetchWaveform } from "./waveformCache";
import type { Track } from "../types";

export const PLAY_EVENT = "kd:play";
let waveformPrefetchTimer: number | null = null;

export interface PlayRequest {
  track: Track;
  /** 缺省 true。false = 只装进主播放条，等用户按播放。 */
  autoPlay?: boolean;
}

export function playTrack(track: Track, autoPlay = true): void {
  if (isVideoTrack(track.format)) {
    requestLocalVideo(track, autoPlay);
  } else if (useVideoPip.getState().active) {
    useVideoPip.getState().clear();
  }
  const detail: PlayRequest = { track, autoPlay };
  window.dispatchEvent(new CustomEvent<PlayRequest>(PLAY_EVENT, { detail }));
  // Audio submission owns the user gesture and the first turn of the native command lane.
  // Waveform I/O starts on the next task so a cold overview cannot reach disk/IPC first.
  if (waveformPrefetchTimer !== null) {
    window.clearTimeout(waveformPrefetchTimer);
    waveformPrefetchTimer = null;
  }
  waveformPrefetchTimer = window.setTimeout(() => {
    waveformPrefetchTimer = null;
    prefetchWaveform(track);
  }, 0);
}

export function parsePlayRequest(detail: unknown): PlayRequest | null {
  if (!detail || typeof detail !== "object") return null;
  if ("id" in detail && "path" in detail && !("track" in detail)) {
    return { track: detail as Track, autoPlay: true };
  }
  const req = detail as PlayRequest;
  if (!req.track) return null;
  return { track: req.track, autoPlay: req.autoPlay !== false };
}
