import { useLayoutEffect, useState } from "react";

/**
 * The height of the player bar (`.kd-app > .kd-player`) in px, kept up to date while it is
 * resized, mounted or taken out; 0 without a bar. Where the bar stands — up or put away — is
 * src/lib/playerBarAway.ts.
 */
export function usePlayerBarHeight(root: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!root) return;
    let bar: HTMLElement | null = null;
    const size = new ResizeObserver(() => setHeight(bar?.offsetHeight ?? 0));
    const find = () => {
      const next = root.querySelector<HTMLElement>(":scope > .kd-player");
      if (next === bar) return;
      if (bar) size.unobserve(bar);
      bar = next;
      if (bar) size.observe(bar);
      setHeight(bar?.offsetHeight ?? 0);
    };
    find();
    const children = new MutationObserver(find);
    children.observe(root, { childList: true });
    return () => { children.disconnect(); size.disconnect(); };
  }, [root]);
  return height;
}
