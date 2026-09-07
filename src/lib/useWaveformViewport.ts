import { useEffect, useLayoutEffect, useRef, useState } from "react";

type View = { start: number; span: number };

/** Keep waveform navigation independent of playback and edit selections. */
export function useWaveformViewport(total: number, selecting: () => boolean) {
  const surface = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ start: 0, span: total });
  const pending = useRef(view);
  const previousTotal = useRef(total);
  const latest = useRef({ total, selecting });
  latest.current = { total, selecting };
  const update = (next: View) => {
    const duration = Math.max(0.001, latest.current.total);
    const span = Math.max(Math.min(500, duration), Math.min(duration, next.span));
    pending.current = { start: Math.max(0, Math.min(duration - span, next.start)), span };
    setView(pending.current);
  };
  useLayoutEffect(() => {
    const fitted = pending.current.span >= previousTotal.current - 0.001;
    update(fitted ? { start: 0, span: total } : pending.current);
    previousTotal.current = total;
  }, [total]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    let pinch: { view: View; fraction: number } | null = null;
    const fraction = (clientX?: number) => {
      const rect = node.getBoundingClientRect();
      return clientX === undefined ? 0.5
        : Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    };
    const zoom = (base: View, scale: number, at: number) => {
      const duration = Math.max(0.001, latest.current.total);
      const span = Math.max(Math.min(500, duration), Math.min(duration, base.span / scale));
      update({ start: base.start + at * (base.span - span), span });
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (pinch || latest.current.selecting()) return;
      const width = Math.max(1, node.getBoundingClientRect().width);
      const unit = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? width : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.altKey || (!e.shiftKey && !e.ctrlKey && Math.abs(dx) > Math.abs(dy))) {
        const base = pending.current;
        update({ ...base, start: base.start + (dx || dy) / width * base.span });
      } else {
        // Windows pinch emits Ctrl+wheel; Shift wheel can be remapped to deltaX.
        zoom(pending.current, Math.exp(-(dy || dx) * (e.ctrlKey ? 0.012 : 0.003)), fraction(e.clientX));
      }
    };
    const gesture = (event: Event) => {
      const e = event as Event & { scale?: number; clientX?: number };
      e.preventDefault();
      e.stopPropagation();
      if (latest.current.selecting()) { pinch = null; return; }
      if (e.type === "gesturestart") {
        pinch = { view: pending.current, fraction: fraction(e.clientX) };
      } else {
        if (pinch && e.scale && Number.isFinite(e.scale) && e.scale > 0)
          zoom(pinch.view, e.scale, pinch.fraction);
        if (e.type === "gestureend") pinch = null;
      }
    };
    node.addEventListener("wheel", wheel, { passive: false });
    for (const name of ["gesturestart", "gesturechange", "gestureend"])
      node.addEventListener(name, gesture, { passive: false });
    return () => {
      node.removeEventListener("wheel", wheel);
      for (const name of ["gesturestart", "gesturechange", "gestureend"])
        node.removeEventListener(name, gesture);
    };
  }, []);
  return { surface, ...view, update };
}
