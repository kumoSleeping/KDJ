import { useEffect, useState } from "react";

/**
 * 所有响应式部件只认同一个移动端判据。
 *
 * 拖窄桌面窗口时，侧栏、顶栏和播放器必须一直保持桌面形态；跨过移动端
 * 临界点后再一起切换，不能各自在不同宽度先后跳变。
 */
export type LayoutMode = "wide" | "narrow";
export type ChromeMode = "inline" | "stacked";

export interface LayoutSignals {
  columns: LayoutMode;
  chrome: ChromeMode;
  /** 统一竖屏判据：宽:高不超过 3:4（宽是 3，高是 4）。 */
  portrait: boolean;
}

/** 只有明显的竖长屏才进入竖屏布局；接近方形的桌面窄窗仍按普通布局处理。 */
const PORTRAIT = "(max-aspect-ratio: 3/4)";

function read(): LayoutSignals {
  const portrait = window.matchMedia(PORTRAIT).matches;
  const columns: LayoutMode = portrait ? "narrow" : "wide";
  const chrome: ChromeMode = portrait ? "stacked" : "inline";
  return { columns, chrome, portrait };
}

export function useLayoutSignals(): LayoutSignals {
  const [signals, setSignals] = useState(read);
  useEffect(() => {
    const portrait = window.matchMedia(PORTRAIT);
    const onChange = () => setSignals(read());
    portrait.addEventListener("change", onChange);
    onChange();
    return () => {
      portrait.removeEventListener("change", onChange);
    };
  }, []);
  return signals;
}

/** 兼容旧调用：只关心三栏/单栏。 */
export function useLayoutMode(): LayoutMode {
  return useLayoutSignals().columns;
}
