import { useEffect, useState } from "react";

/**
 * 所有响应式部件只认同一组判据。
 *
 * 桌面窗口无论拖成什么形状，版面都不换：侧栏、顶栏、搜索和列表保持原位，
 * 侧栏宽窄只取决于用户上一次的选择。窗口变成竖长时只有底栏播放条改成多层
 * （tall）。单栏竖屏版面（portrait）只属于手机。
 */
export type LayoutMode = "wide" | "narrow";
export type ChromeMode = "inline" | "stacked";

export interface LayoutSignals {
  columns: LayoutMode;
  chrome: ChromeMode;
  /** 手机竖屏版面：单栏、两段式顶栏，旁路内容进抽屉。 */
  portrait: boolean;
  /** 竖长窗口：宽:高不超过 3:4（宽是 3，高是 4）。桌面只用它给播放条分层。 */
  tall: boolean;
}

/** 只有明显的竖长才算；接近方形的桌面窄窗仍是普通横向播放条。 */
const PORTRAIT = "(max-aspect-ratio: 3/4)";

function read(): LayoutSignals {
  const tall = window.matchMedia(PORTRAIT).matches;
  const platform = window.kdj?.platform;
  const portrait = tall && (platform === "android" || platform === "ios");
  const columns: LayoutMode = portrait ? "narrow" : "wide";
  const chrome: ChromeMode = portrait ? "stacked" : "inline";
  return { columns, chrome, portrait, tall };
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
