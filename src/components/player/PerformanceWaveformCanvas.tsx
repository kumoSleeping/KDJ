import { useEffect, useLayoutEffect, useRef } from "react";
import {
  PerformanceWaveformRenderer,
  type PerformanceWaveRenderLane,
  type PerformanceWaveRenderModel,
} from "../../lib/performanceWaveformRenderer";
import {
  performanceVisualClockPosition,
  updatePerformanceVisualClock,
  type PerformanceVisualClockState,
} from "../../lib/performanceVisualClock";
import { performanceWaveformViewportSeconds } from "../../lib/waveformViewport";
import { subscribePerformanceFrame } from "../../lib/performanceFrameScheduler";
import type { CuePoint, Waveform } from "../../types";

export interface PerformanceWaveLaneSource {
  key: string;
  waveform: Waveform | null;
  placeholder?: Waveform | null;
  opacity?: number;
  silenceThreshold?: number;
  verticalInsetRatio?: number;
}

interface PerformanceWaveformCanvasProps {
  trackId: number | null;
  position: number;
  duration: number;
  rate: number;
  playing: boolean;
  interactive: boolean;
  snap: boolean;
  lanes: PerformanceWaveLaneSource[];
  bpm: number | null;
  firstBeat: number | null;
  bpmConfidence: number | null;
  cuePoints: readonly CuePoint[];
  cueMs: number | null;
  endMs: number | null;
  loopStart: number | null;
  loopLength: number | null;
}

/**
 * React adapter for the dedicated Deck renderer. It publishes sparse state/data snapshots only;
 * no requestAnimationFrame tick enters React or writes a DOM transform.
 */
export function PerformanceWaveformCanvas({
  trackId,
  position,
  duration,
  rate,
  playing,
  interactive,
  snap,
  lanes,
  bpm,
  firstBeat,
  bpmConfidence,
  cuePoints,
  cueMs,
  endMs,
  loopStart,
  loopLength,
}: PerformanceWaveformCanvasProps) {
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PerformanceWaveformRenderer | null>(null);
  const clockRef = useRef<PerformanceVisualClockState | null>(null);

  useLayoutEffect(() => {
    clockRef.current = updatePerformanceVisualClock(clockRef.current, {
      trackId,
      position,
      duration,
      rate,
      playing,
      interactive,
      snap,
      loopStart,
      loopLength,
    }, performance.now());
    rendererRef.current?.invalidate();
  }, [duration, interactive, loopLength, loopStart, playing, position, rate, snap, trackId]);

  useLayoutEffect(() => {
    const glCanvas = glCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!glCanvas || !overlayCanvas) return;
    let renderer: PerformanceWaveformRenderer;
    try {
      renderer = new PerformanceWaveformRenderer(glCanvas, overlayCanvas);
    } catch {
      return;
    }
    rendererRef.current = renderer;
    const unsubscribeFrame = subscribePerformanceFrame((now) => {
      const clock = clockRef.current;
      if (clock && (clock.playing || renderer.needsDraw())) {
        renderer.draw(performanceVisualClockPosition(clock, now), clock.playing);
      }
    });
    return () => {
      unsubscribeFrame();
      rendererRef.current = null;
      renderer.destroy();
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = glCanvasRef.current;
    const host = canvas?.parentElement?.parentElement;
    if (!renderer || !host) return;

    const sync = () => {
      const hostRect = host.getBoundingClientRect();
      const elements = new Map<string, HTMLElement>();
      host.querySelectorAll<HTMLElement>("[data-kd-performance-wave-lane]").forEach((element) => {
        const key = element.dataset.kdPerformanceWaveLane;
        if (key) elements.set(key, element);
      });
      const renderLanes: PerformanceWaveRenderLane[] = lanes.flatMap((lane) => {
        const element = elements.get(lane.key);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [{
          ...lane,
          top: rect.top - hostRect.top,
          height: rect.height,
        }];
      });
      renderer.resize(hostRect.width, hostRect.height, window.devicePixelRatio || 1);
      const model: PerformanceWaveRenderModel = {
        duration,
        viewportSeconds: performanceWaveformViewportSeconds(rate),
        lanes: renderLanes,
        bpm,
        firstBeat,
        bpmConfidence,
        cuePoints,
        cueMs,
        endMs,
        loopStart,
        loopLength,
      };
      renderer.setModel(model);
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => observer.disconnect();
  }, [
    bpm,
    bpmConfidence,
    cueMs,
    cuePoints,
    duration,
    endMs,
    firstBeat,
    lanes,
    loopLength,
    loopStart,
    rate,
  ]);

  return (
    <span className="kd-performance-wave-renderer" aria-hidden="true">
      <canvas ref={glCanvasRef} className="kd-performance-wave-gpu" />
      <canvas ref={overlayCanvasRef} className="kd-performance-wave-overlay" />
    </span>
  );
}
