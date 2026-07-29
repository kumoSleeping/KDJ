import { create } from "zustand";
import type { LayoutMode } from "./useLayoutMode";

/**
 * 曲目列表的点击手势偏好。
 *
 * - 横屏默认双击播放（单击留给选中 / 详情 / 插入下一首待播）
 * - 竖屏默认单击播放（触屏上双击不自然）
 * - 「单击插入下一首待播」默认开，只在播放手势为双击时生效：单击插队到临时列表队头
 */
export type TrackPlayClick = "single" | "double";

const STORAGE_KEY = "kd-track-click";

export interface TrackClickPrefs {
  /** 横屏 / 宽栏列表：默认双击播放 */
  widePlay: TrackPlayClick;
  /** 竖屏 / 窄栏列表：默认单击播放 */
  narrowPlay: TrackPlayClick;
  /**
   * 单击插入下一首待播（临时列表队头）。默认开。
   * 只对「播放手势 = 双击」的布局生效；两边都是单击时强制关掉。
   */
  clickAddNext: boolean;
}

const DEFAULTS: TrackClickPrefs = {
  widePlay: "double",
  narrowPlay: "single",
  clickAddNext: true,
};

function isPlayClick(value: unknown): value is TrackPlayClick {
  return value === "single" || value === "double";
}

function load(): TrackClickPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const data = raw as Partial<TrackClickPrefs>;
    const widePlay = isPlayClick(data.widePlay) ? data.widePlay : DEFAULTS.widePlay;
    const narrowPlay = isPlayClick(data.narrowPlay) ? data.narrowPlay : DEFAULTS.narrowPlay;
    const clickAddNext =
      typeof data.clickAddNext === "boolean" ? data.clickAddNext : DEFAULTS.clickAddNext;
    return {
      widePlay,
      narrowPlay,
      // 两边都是单击时开关没有意义，读档就收掉，避免设置页显示「开」却永远不生效。
      clickAddNext: clickAddNext && (widePlay === "double" || narrowPlay === "double"),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: TrackClickPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface TrackClickPrefsState extends TrackClickPrefs {
  setWidePlay(value: TrackPlayClick): void;
  setNarrowPlay(value: TrackPlayClick): void;
  setClickAddNext(value: boolean): void;
}

export function playClickForLayout(
  prefs: Pick<TrackClickPrefs, "widePlay" | "narrowPlay">,
  layout: LayoutMode,
): TrackPlayClick {
  return layout === "narrow" ? prefs.narrowPlay : prefs.widePlay;
}

/** 当前布局下，单击是否应插队到「下一首」。 */
export function clickAddsNext(
  prefs: TrackClickPrefs,
  layout: LayoutMode,
): boolean {
  return prefs.clickAddNext && playClickForLayout(prefs, layout) === "double";
}

/** 横屏单击是否还要延迟钉详情：单击已有明确动作（播放 / 加入下一首）时不抢。 */
export function shouldPinDetailOnClick(prefs: TrackClickPrefs, layout: LayoutMode): boolean {
  if (layout === "narrow") return false;
  if (playClickForLayout(prefs, layout) === "single") return false;
  if (clickAddsNext(prefs, layout)) return false;
  return true;
}

export const useTrackClickPrefs = create<TrackClickPrefsState>((set, get) => ({
  ...load(),
  setWidePlay(widePlay) {
    const narrowPlay = get().narrowPlay;
    const clickAddNext =
      get().clickAddNext && (widePlay === "double" || narrowPlay === "double");
    const next = { ...get(), widePlay, clickAddNext };
    set(next);
    save(next);
  },
  setNarrowPlay(narrowPlay) {
    const widePlay = get().widePlay;
    const clickAddNext =
      get().clickAddNext && (widePlay === "double" || narrowPlay === "double");
    const next = { ...get(), narrowPlay, clickAddNext };
    set(next);
    save(next);
  },
  setClickAddNext(clickAddNext) {
    const { widePlay, narrowPlay } = get();
    if (clickAddNext && widePlay !== "double" && narrowPlay !== "double") return;
    const next = { ...get(), clickAddNext };
    set(next);
    save(next);
  },
}));
