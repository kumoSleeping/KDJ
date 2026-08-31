import { create } from "zustand";
import type { LayoutMode } from "./useLayoutMode";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

/**
 * 曲目列表的点击手势偏好。
 *
 * - 横屏默认双击播放（单击留给选中 / 详情）
 * - 竖屏固定单击播放：全屏详情会盖住列表，不能再把单击留给详情
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
  prefs: Pick<TrackClickPrefs, "widePlay" | "narrowPlay">,
  layout: LayoutMode,
): TrackPlayClick {
  // 竖屏抽屉会整屏盖住列表，歌曲行不能再承担“打开详情”的职责；不读取
  // 旧的 narrowPlay 存档，所有本地/在线/视频列表统一单击播放。
  return layout === "narrow" ? "single" : prefs.widePlay;
}

/** 横屏单击是否还要延迟钉详情：单击播放时不抢。 */
export function shouldPinDetailOnClick(prefs: TrackClickPrefs, layout: LayoutMode): boolean {
  if (layout === "narrow") return false;
  if (playClickForLayout(prefs, layout) === "single") return false;
  return true;
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
