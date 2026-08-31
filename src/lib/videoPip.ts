/**
 * 本地视频呈现模式（底栏按钮两态切换）：
 * - panel：曲库详情里的 LocalVideoPlayer
 * - float：自研浮动小窗
 *
 * 网络搜索/下载结果的双击预览固定使用浮动小窗，不读取也不修改这项本地偏好。
 * 系统画中画不是底栏模式：在浮动小窗里手动开，或切走应用时自动开。
 */

import { create } from "zustand";
import type { Track } from "../types";
import {
  readLocalStorage,
  removeLocalStorage,
  writeLocalStorageNow,
} from "./storageWrite";

const STORAGE_KEY = "kdj.videoPreviewMode";
const LOCAL_PRESENTATION_KEY = "kdj.localVideoPresentationV1";

export type VideoPreviewMode = "panel" | "float";

export type VideoPipHostLifecycle = "present" | "suspend-local" | "stop";

/**
 * Decides whether the floating host should render, retain a dormant local source, or fully tear
 * down. Switching a local video to the detail panel is presentation-only: destroying and
 * recreating both WebKit media pipelines on every toggle can leave the final pipeline black after
 * an aborted load/play cycle.
 */
export function videoPipHostLifecycle(
  session: VideoPipSession | null,
  active: boolean,
  mode: VideoPreviewMode,
): VideoPipHostLifecycle {
  if (!session || !active) return "stop";
  if (session.source === "local" && mode === "panel") return "suspend-local";
  return "present";
}

/** A terminally failed network preview must release the global transport back to audio. */
export function networkVideoOwnsTransport(
  session: VideoPipSession | null,
  active: boolean,
  failed: boolean,
): boolean {
  return active && !failed && session?.source === "network";
}

/** 默认浮动小窗；底栏按钮只在这两态之间切换。 */
export const VIDEO_PREVIEW_MODES: VideoPreviewMode[] = ["float", "panel"];

export const VIDEO_PREVIEW_MODE_UI: Record<
  VideoPreviewMode,
  { label: string; hint: string }
> = {
  float: { label: "浮动小窗", hint: "本地视频用自研小窗播放" },
  panel: { label: "详情面板", hint: "本地视频在曲目详情中播放" },
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
      platform: "bilibili" | "youtube";
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
  const raw = readLocalStorage(STORAGE_KEY);
  // 旧三态存档：system / "1" 都归到浮动小窗
  if (raw === "0" || raw === "1" || raw === "system") return "float";
  return isMode(raw) ? raw : "float";
}

/** 只记录“本地视频画面是否仍打开”；网络预览不跨启动保存短效会话。 */
export function rememberedLocalVideoTrackId(): number | null {
  try {
    const value: unknown = JSON.parse(readLocalStorage(LOCAL_PRESENTATION_KEY) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 1 &&
      typeof (value as { trackId?: unknown }).trackId === "number" &&
      Number.isSafeInteger((value as { trackId: number }).trackId) &&
      (value as { trackId: number }).trackId > 0
    ) {
      return (value as { trackId: number }).trackId;
    }
  } catch {
    // 损坏状态在下方统一删除，避免每次启动重复解析。
  }
  removeLocalStorage(LOCAL_PRESENTATION_KEY);
  return null;
}

function rememberLocalPresentation(session: VideoPipSession | null): void {
  if (session?.source === "local") {
    writeLocalStorageNow(
      LOCAL_PRESENTATION_KEY,
      JSON.stringify({ version: 1, trackId: session.trackId }),
    );
    return;
  }
  removeLocalStorage(LOCAL_PRESENTATION_KEY);
}

interface VideoPipState {
  mode: VideoPreviewMode;
  active: boolean;
  failed: boolean;
  systemPip: boolean;
  playing: boolean;
  position: number;
  duration: number;
  error: string;
  session: VideoPipSession | null;
  setMode(mode: VideoPreviewMode): void;
  cycleMode(): VideoPreviewMode;
  setSession(session: VideoPipSession | null): void;
  setFailed(on: boolean): void;
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
  failed: false,
  systemPip: false,
  playing: false,
  position: 0,
  duration: 0,
  error: "",
  session: null,
  setMode(mode) {
    writeLocalStorageNow(STORAGE_KEY, mode);
    set({ mode });
  },
  cycleMode() {
    const next: VideoPreviewMode = get().mode === "float" ? "panel" : "float";
    get().setMode(next);
    broadcastApply(next);
    return next;
  },
  setSession(session) {
    rememberLocalPresentation(session);
    set({
      session,
      active: session !== null,
      failed: false,
      error: "",
      position: 0,
      duration: 0,
      playing: false,
      systemPip: false,
    });
  },
  setFailed(on) {
    set({ failed: on });
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
    rememberLocalPresentation(null);
    set({
      active: false,
      failed: false,
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
