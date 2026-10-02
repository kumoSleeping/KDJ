import { memo, useLayoutEffect, useRef } from "react";
import type { Waveform } from "../../types";
import { WaveformTileCache } from "../../lib/waveformTileCache";
import { useThemePack } from "../../lib/themePack";
import { drawWaveformCanvas } from "../library/WaveformCanvas";

/** Raster work happens only on asset/tile/size changes, never on playback frames. */
export const StaticWaveformCanvas = memo(function StaticWaveformCanvas({ wave, start, end, cache, warmAhead = false }:
  { wave: Waveform | null; start: number; end: number; cache: WaveformTileCache<HTMLCanvasElement>; warmAhead?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useThemePack(state => state.epoch);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let idle: number | null = null;
    let timer: number | null = null;
    let resizeTimer: number | null = null;
    let paintedSize = "";
    const sizeKey = () => `${canvas.clientWidth}:${canvas.clientHeight}:${window.devicePixelRatio || 1}`;
    const cancelWarm = () => {
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
      idle = timer = null;
    };
    const render = () => {
      if (!alive) return;
      if (!wave || end <= start) { canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height); return; }
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (!width || !height) return;
      const size = sizeKey();
      if (size === paintedSize) return;
      cancelWarm();
      const keyFor = (from: number, to: number) => `${theme}:${from}:${to}:${width}:${height}:${window.devicePixelRatio || 1}`;
      const prepare = (from: number, to: number) => {
        const key = keyFor(from, to);
        const cached = cache.get(key);
        if (cached) return cached;
        const bitmap = document.createElement("canvas");
        drawWaveformCanvas(bitmap, wave, width, height, wave.known, from, to, "performance-detail");
        cache.set(key, bitmap);
        return bitmap;
      };
      const paint = (bitmap: HTMLCanvasElement) => {
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        ctx?.drawImage(bitmap, 0, 0);
      };
      // Prepare offscreen, then publish synchronously in the layout phase. Clearing
      // here and deferring paint by a timer exposed empty tiles on every uncached seek.
      paint(prepare(start, end));
      paintedSize = size;
      // The rightmost tile owns a bounded runway. Bake one neighbor per idle turn,
      // before React needs it at the next boundary; never rasterize an entire song in one task.
      let remaining = 2;
      let nextStart = end;
      const queue = () => {
        if (!alive || !warmAhead || remaining <= 0 || nextStart >= wave.duration) return;
        const warm = () => {
          idle = timer = null;
          if (!alive || document.hidden) return;
          prepare(nextStart, nextStart + end - start);
          nextStart += end - start;
          remaining -= 1;
          queue();
        };
        if (typeof window.requestIdleCallback === "function") {
          idle = window.requestIdleCallback(warm, { timeout: 1000 });
        } else timer = window.setTimeout(warm, 100);
      };
      queue();
    };
    // Keep the existing bitmap scrolling/scaling while layout changes. Baking three
    // Retina tiles on every ResizeObserver delivery blocks dragging and churns the LRU.
    const scheduleResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = null;
      if (sizeKey() === paintedSize) return;
      cancelWarm();
      resizeTimer = window.setTimeout(() => { resizeTimer = null; render(); }, 120);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(canvas);
    window.addEventListener("resize", scheduleResize);
    let query: MediaQueryList | null = null;
    const dprChanged = () => { scheduleResize(); watchDpr(); };
    const watchDpr = () => {
      query?.removeEventListener("change", dprChanged);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener("change", dprChanged);
    };
    watchDpr(); render();
    return () => { alive = false; cancelWarm(); observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", scheduleResize); query?.removeEventListener("change", dprChanged); };
  }, [wave, start, end, cache, theme, warmAhead]);
  return <canvas ref={canvasRef} aria-hidden="true" />;
});
