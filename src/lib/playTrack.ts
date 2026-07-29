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

export interface PlayRequest {
  track: Track;
  /** 缺省 true。false = 只装进主播放条，等用户按播放。 */
  autoPlay?: boolean;
}

export function playTrack(track: Track, autoPlay = true): void {
  // 请求先于 React 换曲渲染发出；已有磁盘缓存时，波形通常能在组件挂载前进内存。
  prefetchWaveform(track);
  if (isVideoTrack(track.format)) {
    requestLocalVideo(track, autoPlay);
  } else if (useVideoPip.getState().active) {
    useVideoPip.getState().clear();
  }
  const detail: PlayRequest = { track, autoPlay };
  window.dispatchEvent(new CustomEvent<PlayRequest>(PLAY_EVENT, { detail }));
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
