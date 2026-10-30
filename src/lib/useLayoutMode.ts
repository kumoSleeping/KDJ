import { useEffect, useState } from "react";

/**
 * 窗口形状只有一条判据：竖长（tall）。
 *
 * 版面在任何形状下都不换：侧栏、顶栏、搜索、列表和右侧抽屉保持原位，手机也一样
 * （Android 锁横屏，见 scripts/android-postinit.sh）。桌面窗口变成竖长时，底栏播放条改成
 * 多层，聚合搜索排成两行（类型和来源一行、输入框一行，见 SearchBar.css）；侧栏的宽窄换成
 * 用户在竖长窗口里调过的那一份——横向和竖长各记各的，见 sidebarShape。
 */
export interface LayoutSignals {
  /** 竖长桌面窗口：宽:高不超过 3:4（宽是 3，高是 4）。手机永远不是。播放条在竖长窗口里默认收起（playerBarAway.ts）。 */
  tall: boolean;
}

/**
 * 只有明显的竖长才算；接近方形的桌面窄窗仍是普通横向播放条。
 * 全应用判断“竖长”只用这一条，React 之外要知道窗口形状的地方也读它。
 */
export const TALL_WINDOW_QUERY = "(max-aspect-ratio: 3/4)";

/**
 * 手机锁横屏，只用横向版面；分屏时的竖长也不算。桥接层（window.kdj）就位之前就有模块
 * 要读窗口形状（playerBarAway.ts 在导入时），所以也认 WebView 自己报的系统。
 */
function phone(): boolean {
  const platform = window.kdj?.platform;
  if (platform) return platform === "android" || platform === "ios";
  return typeof navigator !== "undefined" && /Android|iPhone|iPad/.test(navigator.userAgent ?? "");
}

/** 窗口现在是不是竖长。没有 matchMedia 的环境（单元测试）按横向算。 */
export function windowIsTall(): boolean {
  return typeof window !== "undefined" && !phone() && !!window.matchMedia?.(TALL_WINDOW_QUERY).matches;
}

/**
 * 窗口跨过竖长界线时通知一次；返回取消订阅。通知时才读平台：模块可能在桥接层就位
 * （window.kdj）之前就订阅了。
 */
export function watchWindowTall(listener: (tall: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(TALL_WINDOW_QUERY);
  const onChange = () => listener(windowIsTall());
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function read(): LayoutSignals {
  return { tall: windowIsTall() };
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
