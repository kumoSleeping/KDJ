/**
 * 播放事件：曲库双击、在线试听、自动续播都发到这里，PlayerBar 接住。
 * 单独成文件，避免 lib ↔ 大组件互相 import。
 *
 * 本地视频在这里就发出 LOCAL_VIDEO（对齐网络侧 requestVideoPreview 在点击处发出），
 * 不把小窗命运绑在 PlayerBar 是否已挂上 PLAY 监听上。
 */

import { isImageTrack, isVideoTrack } from "./format";
import { requestLocalVideo, useVideoPip } from "./videoPip";
import {
  issuePlayIntentId,
  materializePlayableTrack,
} from "./playIntent";
import { loadReleaseOverviewForTrack } from "./waveformCache";
import type { PlayableTrack } from "../types";

export { isCompleteTrack, materializePlayableTrack } from "./playIntent";

export const PLAY_EVENT = "kd:play";
let waveformRequestTimer: number | null = null;

export interface PlayRequest {
  track: PlayableTrack;
  /** 单调递增的播放意图；所有异步回填必须同时核对它与 track id。 */
  intentId: number;
  /** performance.now() at the input-stack boundary. */
  receivedAt?: number;
  /** 缺省 true。false = 只装进主播放条，等用户按播放。 */
  autoPlay?: boolean;
  purpose?: "composition";
  position?: number;
}

export function playTrack(track: PlayableTrack, autoPlay = true, purpose?: "composition", position?: number): number {
  if (isImageTrack(track.format)) return 0;
  const intentId = issuePlayIntentId();
  const receivedAt = typeof performance !== "undefined" ? performance.now() : undefined;
  const playable = materializePlayableTrack(track);
  const pip = useVideoPip.getState();
  const returningFromNetworkVideo = Boolean(
    !isVideoTrack(playable.format) && pip.active && pip.session?.source === "network",
  );
  if (purpose === "composition") {
    if (pip.active) pip.clear();
  } else if (isVideoTrack(playable.format)) {
    requestLocalVideo(playable, autoPlay);
  } else if (pip.active) {
    pip.clear();
  }
  const detail: PlayRequest = { track, autoPlay, intentId, receivedAt, purpose, position };
  window.dispatchEvent(new CustomEvent<PlayRequest>(PLAY_EVENT, { detail }));
  // Network video previews temporarily own the bottom transport without replacing the Manager's
  // loaded track. Returning to that same song therefore takes PlayerBar's same-track fast path,
  // which deliberately skips a new source Load. Submit the visible overview from the play intent
  // itself so that path still starts (or promotes) waveform work. Keep it one task behind the
  // audio command: a cold full-track decode must never enter native IPC ahead of playback.
  if (waveformRequestTimer !== null) window.clearTimeout(waveformRequestTimer);
  waveformRequestTimer = null;
  if (returningFromNetworkVideo) {
    waveformRequestTimer = window.setTimeout(() => {
      waveformRequestTimer = null;
      void loadReleaseOverviewForTrack(playable, "player").catch(() => undefined);
    }, 0);
  }
  return intentId;
}

export function parsePlayRequest(detail: unknown): PlayRequest | null {
  if (!detail || typeof detail !== "object") return null;
  if ("id" in detail && "path" in detail && !("track" in detail)) {
    return {
      track: detail as PlayableTrack,
      autoPlay: true,
      intentId: issuePlayIntentId(),
      receivedAt: typeof performance !== "undefined" ? performance.now() : undefined,
    };
  }
  const req = detail as PlayRequest;
  if (!req.track) return null;
  const intentId = issuePlayIntentId(req.intentId);
  return {
    track: req.track,
    autoPlay: req.autoPlay !== false,
    intentId,
    receivedAt: req.receivedAt,
    purpose: req.purpose === "composition" ? "composition" : undefined,
    position: req.purpose === "composition" && Number.isFinite(req.position) ? Math.max(0, req.position!) : undefined,
  };
}
