import { useEffect, useState } from "react";

/**
 * 竖屏 / 窄屏的判据。
 *
 * 用宽度而不是 `orientation: portrait`：真正决定"三栏摆不摆得下"的是宽度。
 * 竖着的 iPad（768px）摆得下两栏，横过来的手机（844px）反而摆不下三栏——
 * 按朝向判会把这两种情况判反。
 *
 * 940px 这个数是量出来的：文件夹栏 13rem + 详情栏 22rem = 560px，
 * 中间的曲目表再留 380px 才够放下标题+BPM+KEY+时长，加起来正好 940。
 */
const NARROW_QUERY = "(max-width: 940px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mq.addEventListener("change", onChange);
    // 挂载和事件之间窗口可能已经变了，补一次
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
