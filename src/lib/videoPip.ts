/**
 * 网络 / 本地视频预览呈现模式（底栏按钮两态切换）：
 * - panel：网络→右栏 VideoPreview；本地→曲库详情里的 LocalVideoPlayer
 * - float：自研浮动小窗
 *
 * 系统画中画不是底栏模式：在浮动小窗里手动开，或切走应用时自动开。
 */

import { create } from "zustand";
import type { Track } from "../types";

const STORAGE_KEY = "kdj.videoPreviewMode";

export type VideoPreviewMode = "panel" | "float";

/** 默认浮动小窗；底栏按钮只在这两态之间切换。 */
export const VIDEO_PREVIEW_MODES: VideoPreviewMode[] = ["float", "panel"];

export const VIDEO_PREVIEW_MODE_UI: Record<
  VideoPreviewMode,
  { label: string; hint: string }
> = {
  float: { label: "浮动小窗", hint: "视频用自研小窗播放" },
  panel: { label: "右栏面板", hint: "视频在右侧面板播放" },
};

export const APPLY_VIDEO_MODE_EVENT = "kd:apply-video-mode";
/** 曲库本地视频：双击播放时发出，和网络 VIDEO_PREVIEW_EVENT 对称。 */
export const LOCAL_VIDEO_EVENT = "kd:local-video";
/** 底栏进度条拖视频进度。 */
export const VIDEO_PIP_SEEK_EVENT = "kd:video-pip-seek";
/** 底栏播放键控制视频预览启停。 */
export const VIDEO_PIP_TOGGLE_EVENT = "kd:video-pip-toggle";

export interface ApplyVideoModeDetail {
  mode: VideoPreviewMode;
}

export interface VideoPipSeekDetail {
  position: number;
}

export type VideoPipSession =
  | {
      source: "network";
      bvid: string;
      page: number;
      title: string;
      author: string;
      cover?: string;
    }
  | {
      source: "local";
      trackId: number;
      title: string;
      author: string;
      autoPlay: boolean;
    };

function isMode(value: string | null): value is VideoPreviewMode {
  return value === "panel" || value === "float";
}

function readMode(): VideoPreviewMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  // 旧三态存档：system / "1" 都归到浮动小窗
  if (raw === "0" || raw === "1" || raw === "system") return "float";
  return isMode(raw) ? raw : "float";
}

interface VideoPipState {
  mode: VideoPreviewMode;
  active: boolean;
  systemPip: boolean;
  playing: boolean;
  position: number;
  duration: number;
  error: string;
  session: VideoPipSession | null;
  setMode(mode: VideoPreviewMode): void;
  cycleMode(): VideoPreviewMode;
  setSession(session: VideoPipSession | null): void;
  setSystemPip(on: boolean): void;
  setPlaying(on: boolean): void;
  setPosition(sec: number): void;
  setDuration(sec: number): void;
  setError(message: string): void;
  clear(): void;
}

function broadcastApply(mode: VideoPreviewMode): void {
  window.dispatchEvent(
    new CustomEvent<ApplyVideoModeDetail>(APPLY_VIDEO_MODE_EVENT, { detail: { mode } }),
  );
}

export interface LocalVideoRequest {
  track: Track;
  autoPlay: boolean;
}

export function requestLocalVideo(track: Track, autoPlay = true): void {
  window.dispatchEvent(
    new CustomEvent<LocalVideoRequest>(LOCAL_VIDEO_EVENT, { detail: { track, autoPlay } }),
  );
}

export function seekVideoPip(position: number): void {
  window.dispatchEvent(
    new CustomEvent<VideoPipSeekDetail>(VIDEO_PIP_SEEK_EVENT, { detail: { position } }),
  );
}

export function toggleVideoPip(): void {
  window.dispatchEvent(new Event(VIDEO_PIP_TOGGLE_EVENT));
}

export const useVideoPip = create<VideoPipState>((set, get) => ({
  mode: readMode(),
  active: false,
  systemPip: false,
  playing: false,
  position: 0,
  duration: 0,
  error: "",
  session: null,
  setMode(mode) {
    localStorage.setItem(STORAGE_KEY, mode);
    set({ mode });
  },
  cycleMode() {
    const next: VideoPreviewMode = get().mode === "float" ? "panel" : "float";
    get().setMode(next);
    broadcastApply(next);
    return next;
  },
  setSession(session) {
    set({
      session,
      active: session !== null,
      error: "",
      position: 0,
      duration: 0,
      playing: false,
      systemPip: false,
    });
  },
  setSystemPip(on) {
    set({ systemPip: on });
  },
  setPlaying(on) {
    set({ playing: on });
  },
  setPosition(sec) {
    set({ position: sec });
  },
  setDuration(sec) {
    set({ duration: sec });
  },
  setError(message) {
    set({ error: message });
  },
  clear() {
    set({
      active: false,
      systemPip: false,
      playing: false,
      position: 0,
      duration: 0,
      error: "",
      session: null,
    });
  },
}));

export const videoPipApi = {
  get: () => useVideoPip.getState(),
  subscribe: useVideoPip.subscribe,
};
