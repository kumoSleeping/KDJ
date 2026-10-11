import { useLayoutEffect, useRef } from "react";

/** Both window shapes keep two rows. On a narrow bar the tools share the waveform's right end. */
export function usePlayerBarLayout() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const arrange = (width: number) => {
      if (width <= 0) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const compact = width < 64 * rem;
      if (compact) {
        if (bar.dataset.layout !== "compact") bar.dataset.layout = "compact";
      } else {
        delete bar.dataset.layout;
      }
    };
    arrange(bar.offsetWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) arrange(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(bar, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return ref;
}
