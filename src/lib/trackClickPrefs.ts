import { create } from "zustand";
import type { LayoutMode } from "./useLayoutMode";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

/**
 * 曲目列表的点击手势偏好。
 *
 * 旧偏好仅保留存档兼容。实际手势由布局决定：竖屏单击播放，桌面双击播放。
 */
export type TrackPlayClick = "single" | "double";

const STORAGE_KEY = "kd-track-click";

export interface TrackClickPrefs {
  /** 横屏 / 宽栏列表：默认双击播放 */
  widePlay: TrackPlayClick;
  /**
   * 旧版本存档兼容字段。移动端现在固定单击播放，保留它只为平滑读取已有偏好。
   */
  narrowPlay: TrackPlayClick;
}

const DEFAULTS: TrackClickPrefs = {
  widePlay: "double",
  narrowPlay: "single",
};

function isPlayClick(value: unknown): value is TrackPlayClick {
  return value === "single" || value === "double";
}

function load(): TrackClickPrefs {
  try {
    const raw: unknown = JSON.parse(readLocalStorage(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const data = raw as Partial<TrackClickPrefs>;
    const widePlay = isPlayClick(data.widePlay) ? data.widePlay : DEFAULTS.widePlay;
    // 旧存档可能留下「竖屏双击」；移动端详情会占满列表，不能让它再改变
    // 单击即播这一条硬规则，所以读取时一律归一为 single。
    const narrowPlay = DEFAULTS.narrowPlay;
    return {
      widePlay,
      narrowPlay,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: TrackClickPrefs): void {
  writeLocalStorageNow(STORAGE_KEY, JSON.stringify(prefs));
}

interface TrackClickPrefsState extends TrackClickPrefs {
  setWidePlay(value: TrackPlayClick): void;
  setNarrowPlay(value: TrackPlayClick): void;
}

export function playClickForLayout(
  _prefs: Pick<TrackClickPrefs, "widePlay" | "narrowPlay">,
  layout: LayoutMode,
): TrackPlayClick {
  // 竖屏直接单击触发；旧偏好不改变桌面的双击行为。
  return layout === "narrow" ? "single" : "double";
}

/** 横屏单击是否还要延迟钉详情：单击播放时不抢。 */
export function shouldPinDetailOnClick(_prefs: TrackClickPrefs, _layout: LayoutMode): boolean {
  return false;
}

export const useTrackClickPrefs = create<TrackClickPrefsState>((set, get) => ({
  ...load(),
  setWidePlay(widePlay) {
    const next = { ...get(), widePlay };
    set(next);
    save(next);
  },
  setNarrowPlay(_narrowPlay) {
    // 兼容仍在调用这一 setter 的旧入口；移动端的实际手势固定为 single。
    const next = { ...get(), narrowPlay: "single" as const };
    set(next);
    save(next);
  },
}));
