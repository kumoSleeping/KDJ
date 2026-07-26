import { useEffect, useState } from "react";

/**
 * 布局档位。**只有两档**：三栏，或者一栏。
 *
 * 中间那档（列表 + 详情两栏）删掉了。有它的时候，窗口一变成偏正方形
 * 左边文件夹栏就先收进抽屉，可那个宽度明明还摆得下三栏——收得太急了。
 * 而且"两栏"这个中间态本身也没什么价值：文件夹栏是这个软件的导航，
 * 它在不在，决定的是"我还能不能一眼看到自己有哪些包"，
 * 不该因为窗口窄了一点就消失。
 *
 * 现在的判据：只有真的窄到平板竖屏那个量级（≤820px），
 * 才把两侧一起收进抽屉、只留列表。在那之上一律三栏——
 * 曲目表装不下就自己横向滚动（见 design.css 的 min-width: 46rem），
 * 有了横滚就不需要靠"砍掉侧栏"来给表腾地方。
 *
 * 用宽度而不是 `orientation: portrait`：真正决定摆不摆得下的是宽度。
 * 竖着的 iPad（768）和横着的手机（844）都在这条线附近，按朝向判会判反。
 */
export type LayoutMode = "wide" | "narrow";

const WIDE = "(min-width: 821px)";

function read(): LayoutMode {
  return window.matchMedia(WIDE).matches ? "wide" : "narrow";
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setMode(read());
    mq.addEventListener("change", onChange);
    onChange(); // 挂载和事件之间窗口可能已经变了，补一次
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mode;
}
