import { useEffect, useState } from "react";

/**
 * 所有响应式部件只认同一组判据。
 *
 * 桌面窗口无论拖成什么形状，版面都不换：侧栏、顶栏、搜索和列表保持原位。
 * 窗口变成竖长（tall）时，底栏播放条改成多层，聚合搜索排成两行（类型和来源一行、
 * 输入框一行，见 SearchBar.css）；侧栏的宽窄换成用户在竖长窗口里调过的那一份——
 * 横向和竖长各记各的，见 sidebarShape。单栏竖屏版面（portrait）只属于手机。
 */
export type LayoutMode = "wide" | "narrow";
export type ChromeMode = "inline" | "stacked";

export interface LayoutSignals {
  columns: LayoutMode;
  chrome: ChromeMode;
  /** 手机竖屏版面：单栏、两段式顶栏，旁路内容进抽屉。 */
  portrait: boolean;
  /** 竖长窗口：宽:高不超过 3:4（宽是 3，高是 4）。桌面用它给播放条分层、把搜索排成两行、给侧栏换一份宽窄；播放条在竖长窗口里默认收起（playerBarAway.ts）。 */
  tall: boolean;
}

/**
 * 只有明显的竖长才算；接近方形的桌面窄窗仍是普通横向播放条。
 * 全应用判断“竖长”只用这一条，React 之外要知道窗口形状的地方也读它。
 */
export const TALL_WINDOW_QUERY = "(max-aspect-ratio: 3/4)";

/** 窗口现在是不是竖长。没有 matchMedia 的环境（单元测试）按横向算。 */
export function windowIsTall(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(TALL_WINDOW_QUERY).matches;
}

/** 窗口跨过竖长界线时通知一次；返回取消订阅。 */
export function watchWindowTall(listener: (tall: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(TALL_WINDOW_QUERY);
  const onChange = () => listener(query.matches);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function read(): LayoutSignals {
  const tall = windowIsTall();
  const platform = window.kdj?.platform;
  const portrait = tall && (platform === "android" || platform === "ios");
  const columns: LayoutMode = portrait ? "narrow" : "wide";
  const chrome: ChromeMode = portrait ? "stacked" : "inline";
  return { columns, chrome, portrait, tall };
}

export function useLayoutSignals(): LayoutSignals {
  const [signals, setSignals] = useState(read);
  useEffect(() => {
    const onChange = () => setSignals(read());
    const stop = watchWindowTall(onChange);
    onChange();
    return stop;
  }, []);
  return signals;
}

/** 兼容旧调用：只关心三栏/单栏。 */
export function useLayoutMode(): LayoutMode {
  return useLayoutSignals().columns;
}
