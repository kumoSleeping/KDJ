import { useEffect, useState } from "react";

/**
 * 布局拆成两条轴，不再用单个 820px 包办一切：
 *
 *   columns — 三栏工作台 vs 单栏（列表 + 抽屉）
 *   chrome  — 顶栏搜索「一行」还是「两段」（输入+入口 / 平台行）
 *
 * 竖屏手机该两段搜索，但横屏手机仍可能单栏；桌面窄窗该收栏，
 * 却未必需要两段搜索。两条轴分开，就不会再出现图二那种猎奇挤法。
 */
export type LayoutMode = "wide" | "narrow";
export type ChromeMode = "inline" | "stacked";

export interface LayoutSignals {
  columns: LayoutMode;
  chrome: ChromeMode;
}

/** 三栏至少要这个宽度；再窄就收成单栏 + Sheet。 */
const WIDE_COLUMNS = "(min-width: 960px)";
/**
 * 主栏仍够摆「输入 + 平台 + 登录/队列」时用一行。
 * 竖屏（或极窄）改两段，平台键落到第二行，避免和输入抢同一条。
 */
const INLINE_CHROME = "(min-width: 560px) and (orientation: landscape)";

function read(): LayoutSignals {
  const columns: LayoutMode = window.matchMedia(WIDE_COLUMNS).matches ? "wide" : "narrow";
  const chrome: ChromeMode = window.matchMedia(INLINE_CHROME).matches ? "inline" : "stacked";
  return { columns, chrome };
}

export function useLayoutSignals(): LayoutSignals {
  const [signals, setSignals] = useState(read);
  useEffect(() => {
    const wide = window.matchMedia(WIDE_COLUMNS);
    const inline = window.matchMedia(INLINE_CHROME);
    const onChange = () => setSignals(read());
    wide.addEventListener("change", onChange);
    inline.addEventListener("change", onChange);
    onChange();
    return () => {
      wide.removeEventListener("change", onChange);
      inline.removeEventListener("change", onChange);
    };
  }, []);
  return signals;
}

/** 兼容旧调用：只关心三栏/单栏。 */
export function useLayoutMode(): LayoutMode {
  return useLayoutSignals().columns;
}
