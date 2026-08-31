import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  EQ_GRAPH_BAND_COUNT,
  EQ_GRAPH_FREQUENCIES,
  channelFilterCutoffHz,
  channelFilterDbAtRatio,
  eqCurveDbAtRatio,
  eqDbToGraphRatio,
  eqGestureWeights,
  eqSpectrumLevelToRatio,
  type EqGraphValues,
} from "../../lib/eqGraph";
import { getLiveDeckSpectrum } from "../../lib/unifiedPlayer";
import { knobBias, snapKnobToCenter } from "../../lib/stemDeckLog";

export interface ManagerMixerValues {
  gain: number;
  high: number;
  mid: number;
  low: number;
  filter: number;
  volume: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function ArcKnob({
  label,
  value,
  min = -1,
  max = 1,
  step = 0.01,
  onChange,
  onReset,
  size = "md",
  disabled = false,
  format,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  disabled?: boolean;
  format?: (value: number) => string;
}) {
  const shown = snapKnobToCenter(value, min, max);
  const ratio = clamp((shown - min) / (max - min), 0, 1);
  const bipolar = min < 0 && max > 0;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; y: number; value: number } | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const latestRef = useRef({ min, max, step, disabled, onChange });
  latestRef.current = { min, max, step, disabled, onChange };
  const [showValue, setShowValue] = useState(false);
  const revertRef = useRef(0);
  const previousRef = useRef(value);

  useEffect(() => {
    if (previousRef.current === value) return;
    previousRef.current = value;
    setShowValue(true);
    window.clearTimeout(revertRef.current);
    revertRef.current = window.setTimeout(() => setShowValue(false), 3_000);
  }, [value]);
  useEffect(() => () => window.clearTimeout(revertRef.current), []);

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (latestRef.current.disabled || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, y: event.clientY, value: shownRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = rootRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !element) return;
    event.preventDefault();
    const { min: low, max: high, step: stride, onChange: commit } = latestRef.current;
    const travel = (drag.y - event.clientY) / (element.getBoundingClientRect().height * 1.35);
    const raw = drag.value + travel * (high - low);
    const stepped = Math.round((raw - low) / stride) * stride + low;
    commit(snapKnobToCenter(clamp(Number(stepped.toFixed(6)), low, high), low, high));
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit may release capture before pointercancel.
    }
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const { min: low, max: high, step: stride, disabled: off, onChange: commit } = latestRef.current;
    if (off) return;
    const delta = event.key === "ArrowUp" || event.key === "ArrowRight"
      ? stride * (event.shiftKey ? 5 : 1)
      : event.key === "ArrowDown" || event.key === "ArrowLeft"
        ? -stride * (event.shiftKey ? 5 : 1)
        : 0;
    if (delta === 0) return;
    event.preventDefault();
    commit(snapKnobToCenter(clamp(shownRef.current + delta, low, high), low, high));
  };

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const { min: low, max: high, step: stride, disabled: off, onChange: commit } = latestRef.current;
      if (off) return;
      event.preventDefault();
      const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      const direction = (raw < 0 ? 1 : -1) * (event.shiftKey ? 5 : 1);
      commit(snapKnobToCenter(clamp(shownRef.current + direction * stride, low, high), low, high));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const bias = bipolar ? knobBias(shown, min, max) : null;
  const text = format
    ? format(shown)
    : bipolar
      ? shown === 0 ? "0" : `${shown > 0 ? "+" : ""}${Math.round(shown * 100)}`
      : String(Math.round(ratio * 100));
  const radius = 19;
  const circumference = 2 * Math.PI * radius;
  const track = 0.75 * circumference;
  let arcLength = 0;
  let arcRotate = 135;
  if (bipolar) {
    const halfRange = shown >= 0 ? max : Math.abs(min);
    const span = halfRange > 0 ? Math.abs(shown) / halfRange * 135 : 0;
    arcLength = span / 360 * circumference;
    arcRotate = shown >= 0 ? 270 : 270 - span;
  } else {
    arcLength = ratio * track;
  }
  const needle = -135 + ratio * 270;

  return (
    <div
      ref={rootRef}
      className="kd-dj-arcknob"
      data-size={size}
      data-control={label.toLowerCase()}
      data-boost={bias === "boost" ? "true" : undefined}
      data-cut={bias === "cut" ? "true" : undefined}
      data-disabled={disabled || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={text}
      title={`${label} ${text}：竖拖调整，双击回中`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={disabled ? undefined : onReset}
    >
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle className="kd-dj-arcknob-track" cx="24" cy="24" r={radius} fill="none"
          strokeDasharray={`${track.toFixed(2)} ${circumference.toFixed(2)}`} transform="rotate(135 24 24)" />
        {arcLength > 0.5 ? (
          <circle className="kd-dj-arcknob-value" cx="24" cy="24" r={radius} fill="none"
            strokeDasharray={`${arcLength.toFixed(2)} ${circumference.toFixed(2)}`} transform={`rotate(${arcRotate.toFixed(2)} 24 24)`} />
        ) : null}
        <circle className="kd-dj-arcknob-body" cx="24" cy="24" r="12.5" />
        <line className="kd-dj-arcknob-needle" x1="24" y1="24" x2="24" y2="14"
          transform={`rotate(${needle.toFixed(2)} 24 24)`} />
      </svg>
      <b>{showValue ? text : label}</b>
    </div>
  );
}

type ChartPoint = { x: number; y: number };

function smoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.slice(0, -1).reduce((path, point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[index + 1];
    const after = points[Math.min(points.length - 1, index + 2)];
    const control1 = {
      x: point.x + (next.x - previous.x) / 6,
      y: clamp(point.y + (next.y - previous.y) / 6, 0, 1_000),
    };
    const control2 = {
      x: next.x - (after.x - point.x) / 6,
      y: clamp(next.y - (after.y - point.y) / 6, 0, 1_000),
    };
    return `${path} C ${control1.x.toFixed(2)} ${control1.y.toFixed(2)} ${control2.x.toFixed(2)} ${control2.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }, `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`);
}

export function EqSpectrumChart({ side, values, filter, resonanceQ, playing, onAdjust, onReset }: {
  side: 0 | 1;
  values: EqGraphValues;
  filter: number;
  resonanceQ: number;
  playing: boolean;
  onAdjust: (delta: EqGraphValues) => void;
  onReset: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const spectrumPathRef = useRef<SVGPathElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const latestRef = useRef({ onAdjust, onReset });
  latestRef.current = { onAdjust, onReset };
  const dragRef = useRef<{ pointerId: number; pointerType: string; x: number; y: number; distance: number } | null>(null);
  const lastTouchTapRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const shown = new Array<number>(EQ_GRAPH_BAND_COUNT).fill(0);
    const painted = new Array<number>(EQ_GRAPH_BAND_COUNT).fill(-1);
    let frame = 0;
    let previousAt = performance.now();
    const tick = (at: number) => {
      const elapsed = Math.min(0.1, Math.max(0, (at - previousAt) / 1_000));
      previousAt = at;
      const live = playingRef.current ? getLiveDeckSpectrum(side) : null;
      let changed = false;
      for (let band = 0; band < EQ_GRAPH_BAND_COUNT; band += 1) {
        const target = eqSpectrumLevelToRatio(live?.[band] ?? 0);
        shown[band] = target >= shown[band]
          ? target
          : Math.max(target, shown[band] - elapsed / (playingRef.current ? 0.19 : 0.1));
        const level = Math.round(shown[band] * 1_000) / 1_000;
        if (level !== painted[band]) {
          painted[band] = level;
          changed = true;
        }
      }
      if (changed && spectrumPathRef.current) {
        const points = painted.map((level, index) => ({
          x: (index + 0.5) / EQ_GRAPH_BAND_COUNT * 1_000,
          y: (1 - Math.max(0, level)) * 1_000,
        }));
        spectrumPathRef.current.setAttribute("d", smoothPath([
          { x: 0, y: points[0].y },
          ...points,
          { x: 1_000, y: points[points.length - 1].y },
        ]));
        spectrumPathRef.current.style.opacity = String(clamp(Math.max(...painted) * 4, 0, 1));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [side]);

  const ratios = EQ_GRAPH_FREQUENCIES.map((_, index) => (index + 0.5) / EQ_GRAPH_BAND_COUNT);
  const curve = ratios.map((ratio) => ({
    x: ratio * 1_000,
    y: eqDbToGraphRatio(eqCurveDbAtRatio(values, ratio)) * 1_000,
  }));
  const curvePath = smoothPath([{ x: 0, y: curve[0].y }, ...curve, { x: 1_000, y: curve[curve.length - 1].y }]);
  const filterActive = channelFilterCutoffHz(filter) != null;
  const filterCurve = Array.from({ length: 41 }, (_, index) => index / 40).map((ratio) => ({
    x: ratio * 1_000,
    y: eqDbToGraphRatio(channelFilterDbAtRatio(filter, resonanceQ, ratio)) * 1_000,
  }));
  const filterPath = filterActive
    ? smoothPath([{ x: 0, y: filterCurve[0].y }, ...filterCurve, { x: 1_000, y: filterCurve[filterCurve.length - 1].y }])
    : "";

  const applySamples = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const native = event.nativeEvent;
    const samples = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    let low = 0;
    let mid = 0;
    let high = 0;
    for (const sample of samples.length > 0 ? samples : [native]) {
      const dx = sample.clientX - drag.x;
      const dy = sample.clientY - drag.y;
      if (dx === 0 && dy === 0) continue;
      const weights = eqGestureWeights((drag.x - rect.left) / rect.width, (sample.clientX - rect.left) / rect.width);
      const delta = -dy / (rect.height * 0.65);
      low += delta * weights.low;
      mid += delta * weights.mid;
      high += delta * weights.high;
      drag.distance += Math.hypot(dx, dy);
      drag.x = sample.clientX;
      drag.y = sample.clientY;
    }
    if (low !== 0 || mid !== 0 || high !== 0) latestRef.current.onAdjust({ low, mid, high });
  };
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, distance: 0 };
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!cancelled) applySamples(event);
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // WebKit may release capture before pointercancel.
    }
    if (!cancelled && drag.pointerType !== "mouse" && drag.distance < 8) {
      const now = performance.now();
      if (now - lastTouchTapRef.current <= 320) {
        lastTouchTapRef.current = Number.NEGATIVE_INFINITY;
        latestRef.current.onReset();
      } else {
        lastTouchTapRef.current = now;
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className="kd-dj-eq-chart"
      data-side={side === 0 ? "a" : "b"}
      role="group"
      aria-label="三段手绘 EQ 与十五段实时响度"
      title="相对拖动手绘 EQ；双击恢复平直"
      onPointerDown={onDown}
      onPointerMove={applySamples}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onDoubleClick={(event) => { event.preventDefault(); latestRef.current.onReset(); }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <svg className="kd-dj-eq-spectrum" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`kd-manager-eq-spectrum-${side}`} gradientUnits="userSpaceOnUse" x1="0" y1="1000" x2="0" y2="0">
            <stop offset="0%" stopColor="#22d85b" />
            <stop offset="52%" stopColor="#a8e53b" />
            <stop offset="72%" stopColor="#e8e632" />
            <stop offset="86%" stopColor="#ffb52f" />
            <stop offset="100%" stopColor="#f04452" />
          </linearGradient>
        </defs>
        <path ref={spectrumPathRef} style={{ stroke: `url(#kd-manager-eq-spectrum-${side})` }} />
      </svg>
      <i className="kd-dj-eq-zero" aria-hidden="true" />
      <span className="kd-dj-eq-guides" aria-hidden="true">
        <i data-kind="minor" style={{ left: `${100 / 6}%` }} />
        <i data-kind="major" style={{ left: `${100 / 3}%` }} />
        <i data-kind="minor" style={{ left: "50%" }} />
        <i data-kind="major" style={{ left: `${200 / 3}%` }} />
        <i data-kind="minor" style={{ left: `${500 / 6}%` }} />
      </span>
      <svg className="kd-dj-eq-curve" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d={curvePath} /></svg>
      {filterActive ? (
        <svg className="kd-dj-eq-filter" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d={filterPath} /></svg>
      ) : null}
    </div>
  );
}
