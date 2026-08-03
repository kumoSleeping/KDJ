import { create } from "zustand";
import type { LayoutMode } from "./useLayoutMode";

/**
 * 曲目列表的点击手势偏好。
 *
 * - 横屏默认双击播放（单击留给选中 / 详情 / 插入下一首待播）
 * - 竖屏固定单击播放：全屏详情会盖住列表，不能再把单击留给详情
 * - 「单击插入下一首待播」默认关，只在横屏播放手势为双击时生效
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
  /**
   * 单击插入下一首待播（临时列表队头）。默认关。
   * 只对横屏「播放手势 = 双击」生效；移动端固定单击播放时强制关掉。
   */
  clickAddNext: boolean;
}

const DEFAULTS: TrackClickPrefs = {
  widePlay: "double",
  narrowPlay: "single",
  clickAddNext: false,
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
    // 旧存档可能留下「竖屏双击」；移动端详情会占满列表，不能让它再改变
    // 单击即播这一条硬规则，所以读取时一律归一为 single。
    const narrowPlay = DEFAULTS.narrowPlay;
    const clickAddNext =
      typeof data.clickAddNext === "boolean" ? data.clickAddNext : DEFAULTS.clickAddNext;
    return {
      widePlay,
      narrowPlay,
      // 移动端单击永远播放；只有横屏双击时单击才有空档插入下一首。
      clickAddNext: clickAddNext && widePlay === "double",
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
  // 竖屏抽屉会整屏盖住列表，歌曲行不能再承担“打开详情”的职责；不读取
  // 旧的 narrowPlay 存档，所有本地/在线/视频列表统一单击播放。
  return layout === "narrow" ? "single" : prefs.widePlay;
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
    const clickAddNext = get().clickAddNext && widePlay === "double";
    const next = { ...get(), widePlay, clickAddNext };
    set(next);
    save(next);
  },
  setNarrowPlay(_narrowPlay) {
    // 兼容仍在调用这一 setter 的旧入口；移动端的实际手势固定为 single。
    const next = { ...get(), narrowPlay: "single" as const };
    set(next);
    save(next);
  },
  setClickAddNext(clickAddNext) {
    const { widePlay } = get();
    if (clickAddNext && widePlay !== "double") return;
    const next = { ...get(), clickAddNext };
    set(next);
    save(next);
  },
}));
