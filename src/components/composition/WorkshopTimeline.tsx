import { isVisualSource } from "../../lib/workshop";
import { workshopMarkerColor } from "../../lib/workshopMarkers";
import { workshopFadeCurvePath } from "../../lib/workshopFadeCurve";
import { videoTransitionSpan } from "../../lib/workshopTransitions";
import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  memo,
  type ReactNode,
} from "react";
import { WorkshopAnalysisControl, WorkshopLayerAnalysis } from "./WorkshopLayerAnalysis";
import { WorkshopClipMedia } from "./WorkshopClipMedia";
import { WorkshopVideoTransition } from "./WorkshopVideoTransition";
import { WorkshopLayerAudio } from "./WorkshopLayerAudio";
import { WorkshopTimelineOverview } from "./WorkshopTimelineOverview";
import { WorkshopRhythmSource, WorkshopRhythmControls, WorkshopRhythmRuler } from "./WorkshopRhythm";
import { useWorkshopRhythmStore } from "../../stores/workshopRhythmStore";
import { clipBeatTimes, nearestBeat, rhythmKey, workshopGrid } from "../../lib/workshopRhythm";
import { GripVertical, Eye, EyeOff, X, Square, SquareCheck, Maximize2, ArrowDownUp, ZoomIn, ZoomOut } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  adjustClip,
  cloneProject,
  clipDuration,
  clipQuantum,
  formatTime,
  visibleFade,
  moveLayer,
  sortLayers,
  clipLanes,
  layerSources,
  projectDuration,
  snapTime,
} from "../../lib/workshop";
import type { ClipHandle, CompositionProject, WorkshopClip } from "../../types/workshop";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import {
  isTrackDrag,
  readTrackDragIds,
  finishTrackDrop,
} from "../../lib/trackDrag";
const TimelineFadeCurve = memo(function TimelineFadeCurve({ clip, audio, incoming, outgoing }: {
  clip: WorkshopClip; audio: boolean;
  incoming?: NonNullable<ReturnType<typeof videoTransitionSpan>>;
  outgoing?: NonNullable<ReturnType<typeof videoTransitionSpan>>;
}) {
  const duration = clipDuration(clip);
  const curve = {...clip, fades: {...clip.fades,
    ...(audio ? {
      audio_in_ms: incoming ? 0 : clip.fades.audio_in_ms,
      audio_out_ms: outgoing ? 0 : clip.fades.audio_out_ms,
    } : {
      video_in_ms: incoming ? 0 : clip.fades.video_in_ms,
      video_out_ms: outgoing ? 0 : clip.fades.video_out_ms,
    }),
  }};
  return <svg className={`vj-fade-curve ${audio ? "vj-fade-audio" : ""}`} viewBox="0 0 100 30" preserveAspectRatio="none"
    aria-label={audio ? "声音淡化曲线" : "画面淡化曲线"}
    style={{clipPath: `inset(0 ${(outgoing?.before ?? 0) / duration * 100}% 0 ${(incoming?.after ?? 0) / duration * 100}%)`}}>
    <path d={workshopFadeCurvePath(curve, audio, true)} vectorEffect="non-scaling-stroke" />
  </svg>;
});
function TimelinePlayhead({ scale, ...props }: React.HTMLAttributes<HTMLElement> & { scale: number }) {
  const position = useWorkshopStore(s => s.position);
  return <i {...props} className="vj-playhead" style={{left: 0, transform: `translateX(${position * scale}px)`}} />;
}
function TimelineTime({ duration }: { duration: number }) {
  const position = useWorkshopStore(s => s.position);
  return <span>{formatTime(position)} / {formatTime(duration)}</span>;
}
function TimelineRhythmControls({ source, layer }: Omit<Parameters<typeof WorkshopRhythmControls>[0], "position">) {
  const position = useWorkshopStore(s => s.position);
  return <WorkshopRhythmControls source={source} layer={layer} position={position} />;
}
export function WorkshopTimeline({ playback, tools, checked, onCheckedChange: setChecked, workspace = false }: {
  playback: WorkshopPlayback; tools?: ReactNode; checked: string[]; onCheckedChange(ids: string[]): void;
  /** The editor window's toolbar owns the position readout; this row keeps the view controls. */
  workspace?: boolean;
}) {
  const scrollId = useId();
  const p = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    snap = useWorkshopStore((s) => s.snap),
    barSnap = useWorkshopStore((s) => s.barSnap),
    hiddenVideoLayers = useWorkshopStore(s => s.hiddenVideoLayers);
  const analyzing = useWorkshopStore(s => s.positions[s.draft?.id ?? ""]?.items.some(a => a.phase === "analyzing" || a.phase === "waiting"));
  const [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(0),
    [scrollLeft, setScrollLeft] = useState(0),
    [vertical, setVertical] = useState({ top: 0, height: 600 }),
    [baseScale, setBaseScale] = useState<number | null>(null),
    [extent, setExtent] = useState(0);
  const scrollFrame = useRef(0), zoomFrame = useRef(0);
  const publishScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setScrollLeft(node.scrollLeft);
    const top = Math.floor(node.scrollTop / 128) * 128;
    const height = node.clientHeight || 600;
    setVertical(old => old.top === top && old.height === height ? old : { top, height });
  }, []);
  const scheduleScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      publishScroll();
    });
  }, [publishScroll]);
  const scroller = useRef<HTMLDivElement | null>(null),
    wheel = useRef<(e: WheelEvent) => void>(() => {}),
    pinch = useRef<(e: Event) => void>(() => {}),
    cleanScroll = useRef<() => void>(() => {}),
    anchor = useRef<{ time: number; x: number } | null>(null),
    pendingZoom = useRef(1),
    pinchStart = useRef<{ zoom: number; clientX: number } | null>(null);
  const scrub = useRef<HTMLElement | null>(null);
  const latestPlayback = useRef(playback);
  latestPlayback.current = playback;
  const observer = useRef<ResizeObserver | null>(null);
  const observe = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    cleanScroll.current();
    scroller.current = node;
    if (node) {
      const ua = window.navigator.userAgent;
      // WKWebView exposes pinch separately. Its ordinary scroll listener can
      // therefore be passive, so a busy JS thread cannot hold up native pan.
      // WebView2 still needs cancelable Ctrl+wheel for precision-touchpad pinch.
      const nativeGestures = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|jsdom/i.test(ua);
      let modified = false, pointing = false, gesturing = false;
      let passive = nativeGestures;
      const onWheel = (e: WheelEvent) => wheel.current(e);
      const updateWheel = () => {
        const next = nativeGestures && !modified && !pointing && !gesturing;
        if (next === passive) return;
        node.removeEventListener("wheel", onWheel);
        passive = next;
        node.addEventListener("wheel", onWheel, { passive });
      };
      const modifiers = (e: KeyboardEvent | PointerEvent) => {
        modified = e.altKey || e.ctrlKey || e.shiftKey;
        updateWheel();
      };
      const pointerDown = () => { pointing = true; updateWheel(); };
      const pointerUp = () => { pointing = false; updateWheel(); };
      const blur = () => { modified = pointing = gesturing = false; pinchStart.current = null; updateWheel(); };
      const onGesture = (e: Event) => {
        gesturing = e.type !== "gestureend";
        updateWheel();
        pinch.current(e);
      };
      node.addEventListener("wheel", onWheel, { passive });
      node.addEventListener("pointerover", modifiers);
      node.addEventListener("pointerdown", pointerDown, true);
      window.addEventListener("pointerup", pointerUp, true);
      window.addEventListener("pointercancel", pointerUp, true);
      window.addEventListener("keydown", modifiers, true);
      window.addEventListener("keyup", modifiers, true);
      window.addEventListener("blur", blur);
      for (const name of ["gesturestart", "gesturechange", "gestureend"])
        node.addEventListener(name, onGesture, { passive: false });
      cleanScroll.current = () => {
        node.removeEventListener("wheel", onWheel);
        node.removeEventListener("pointerover", modifiers);
        node.removeEventListener("pointerdown", pointerDown, true);
        window.removeEventListener("pointerup", pointerUp, true);
        window.removeEventListener("pointercancel", pointerUp, true);
        window.removeEventListener("keydown", modifiers, true);
        window.removeEventListener("keyup", modifiers, true);
        window.removeEventListener("blur", blur);
        for (const name of ["gesturestart", "gesturechange", "gestureend"])
          node.removeEventListener(name, onGesture);
      };
      setWidth(node.clientWidth || 800);
      publishScroll();
      observer.current = new ResizeObserver(([entry]) => {
        setWidth(entry.contentRect.width);
        publishScroll();
      });
      observer.current.observe(node);
    }
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      cleanScroll.current();
      cancelAnimationFrame(scrollFrame.current);
      cancelAnimationFrame(zoomFrame.current);
      scrollFrame.current = zoomFrame.current = 0;
      useWorkshopStore.setState({ scrubbing: false, trimPreview: null });
    },
    [],
  );
  const drag = useRef<{
    id: string;
    handle: ClipHandle;
    x: number;
    start: number;
    duration: number;
    snapOrigin: number;
    scale: number;
    project: CompositionProject;
    quantum: number;
    beats: number[];
  } | null>(null);
  const layerDrag = useRef<string | null>(null);
  const [layerDrop, setLayerDrop] = useState<{ id: string; edge: "before" | "after"; to: number } | null>(null);
  const layerDropAt = (x: number, y: number) => {
    if (!p || !layerDrag.current) return null;
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-layer-id]");
    if (!row || !scroller.current?.contains(row)) return null;
    const from = p.layers.findIndex(l => l.id === layerDrag.current);
    const target = p.layers.findIndex(l => l.id === row.dataset.layerId);
    if (from < 0 || target < 0) return null;
    const rect = row.getBoundingClientRect();
    const edge = y < rect.top + rect.height / 2 ? "before" : "after";
    const boundary = target + (edge === "after" ? 1 : 0);
    const to = boundary - (from < boundary ? 1 : 0);
    return to === from ? null : { id: p.layers[target].id, edge, to } as const;
  };
  const endLayerDrag = () => { layerDrag.current = null; setLayerDrop(null); };
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") endLayerDrag(); };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);
  const labelWidth = Math.min(208, Math.max(144, Math.round(width * .32)));
  const contentDuration = useMemo(() => p ? projectDuration(p) : 0, [p]);
  const sourceById = useMemo(() => new Map(p?.sources.map(s => [s.id, s])), [p?.sources]);
  // Geometry depends on edits, not scroll events or playback clock samples.
  const rows = useMemo(() => {
    let top = 0;
    return p?.layers.map(layer => {
      const sources = layerSources(p, layer), title = sources.map(s => s.title).join(" / ");
      const hasAudio = sources.some(s => s.audio), hasVisual = sources.some(isVisualSource);
      const lanes = clipLanes(layer.clips), laneCount = Math.max(1, ...Array.from(lanes.values(), n => n + 1));
      const trackHeight = laneCount * 62;
      const ordered = [...layer.clips].sort((a, b) => a.start_ms - b.start_ms);
      const joints = ordered.flatMap((right, i) => {
        const left = ordered[i - 1];
        if (!left || Math.abs(left.start_ms + clipDuration(left) - right.start_ms) >= .01) return [];
        const media = [left, right].map(c => sourceById.get(c.source_id));
        const video = media.every(s => s?.video), audio = media.every(s => s?.audio);
        return video || audio ? [{left, right, video, audio}] : [];
      });
      const spans = joints.flatMap(j => {
        const span = videoTransitionSpan(j.left, j.right);
        return span ? [{...j, span}] : [];
      });
      const row = { layer, sources, title, hasAudio, hasVisual, lanes, laneCount, trackHeight, top, joints,
        joinedIn: new Map(spans.filter(j => j.video).map(j => [j.right.id, j.span])),
        joinedOut: new Map(spans.filter(j => j.video).map(j => [j.left.id, j.span])),
        audioJoinedIn: new Map(spans.filter(j => j.audio).map(j => [j.right.id, j.span])),
        audioJoinedOut: new Map(spans.filter(j => j.audio).map(j => [j.left.id, j.span])),
        rhythmLayers: sources.filter(s => s.audio).map(source => ({ source,
          layer: {...layer, clips: layer.clips.filter(c => c.source_id === source.id)} })),
      };
      top += trackHeight + 1;
      return row;
    }) ?? [];
  }, [p, sourceById]);
  const viewportWidth = Math.max(80, width - labelWidth);
  // Fit once after measuring this editor. Content edits must never change pixels/ms,
  // including pointer-up, keyboard nudges, property edits, undo and async alignment.
  const scale = (baseScale ?? viewportWidth / Math.max(1000, contentDuration)) * zoom;
  // Grow the canvas independently of scale; retain its extent when content shrinks
  // so the browser cannot clamp scrollLeft and move otherwise untouched clips.
  const duration = Math.max(1000, extent, contentDuration, viewportWidth / scale);
  const railWidth = duration * scale;
  useLayoutEffect(() => {
    if (baseScale === null && width > 0 && contentDuration > 0)
      setBaseScale(viewportWidth / Math.max(1000, contentDuration));
  }, [baseScale, width, viewportWidth, contentDuration]);
  useLayoutEffect(() => {
    if (contentDuration > extent) setExtent(contentDuration);
  }, [contentDuration, extent]);
  const fitTimeline = () => {
    if (drag.current || scrub.current || layerDrag.current) return;
    setBaseScale(viewportWidth / Math.max(1000, contentDuration));
    setExtent(contentDuration);
    pendingZoom.current = 1;
    cancelAnimationFrame(zoomFrame.current);
    zoomFrame.current = 0;
    setZoom(1);
    anchor.current = null;
    if (scroller.current) scroller.current.scrollLeft = 0;
    setScrollLeft(0);
  };
  const frame = 1000 / (p?.canvas.fps ?? 30);
  const zoomAt = (next: number, clientX: number, synchronous = false) => {
    const node = scroller.current;
    if (!node || drag.current || !Number.isFinite(next)) return;
    const bounded = Math.max(1, Math.min(64, next));
    if (bounded === pendingZoom.current) {
      if (bounded === 1 && extent !== contentDuration) {
        anchor.current = null;
        setExtent(contentDuration);
        node.scrollLeft = 0;
        setScrollLeft(0);
      }
      return;
    }
    if (bounded === 1) {
      anchor.current = null;
      setExtent(contentDuration);
      node.scrollLeft = 0;
      setScrollLeft(0);
    } else {
      const x = Math.max(0, Math.min(width - labelWidth, clientX - node.getBoundingClientRect().left - labelWidth));
      // Keep the rendered anchor until React commits, but accumulate every input sample.
      anchor.current ??= { time: (node.scrollLeft + x) / scale, x };
    }
    if (bounded === zoom) anchor.current = null;
    pendingZoom.current = bounded;
    if (synchronous || !zoomFrame.current) setZoom(bounded);
    if (!zoomFrame.current) zoomFrame.current = requestAnimationFrame(() => {
      zoomFrame.current = 0;
      setZoom(pendingZoom.current);
    });
  };
  /** Toolbar zoom keeps the playhead in place, or the view centre when it is off screen. */
  const zoomStep = (factor: number) => {
    const node = scroller.current;
    if (!node) return;
    const head = useWorkshopStore.getState().position * scale - node.scrollLeft;
    zoomAt(pendingZoom.current * factor,
      node.getBoundingClientRect().left + labelWidth + (head >= 0 && head <= viewportWidth ? head : viewportWidth / 2));
  };
  wheel.current = (e) => {
    const node = scroller.current;
    if (!node) return;
    // Leave ordinary two-finger motion to the native scroll view, including
    // momentum and diagonal scrolling. Never replay every delta through React.
    const blocked = pinchStart.current !== null || drag.current || scrub.current || layerDrag.current;
    // Programmatic wheel events have no browser default scroll to fall back to.
    // Native user input stays on the compositor's fast scrolling path.
    if (!blocked && !e.altKey && !e.ctrlKey && !e.shiftKey && e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    if (blocked) return;
    const pageWidth = Math.max(80, width - labelWidth);
    const dx = e.deltaX * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? pageWidth : 1);
    const dy = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? node.clientHeight || 200 : 1);
    // WebView2/Chromium reports precision-touchpad pinch as Ctrl+wheel.
    // Shift+wheel may arrive on deltaX after the OS remaps its axis.
    if (e.altKey || e.ctrlKey) {
      const delta = dy || dx;
      zoomAt(pendingZoom.current * Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.003)), e.clientX, !e.isTrusted);
      return;
    }
    if (e.shiftKey) node.scrollLeft += dx || e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? pageWidth : 1);
    else { node.scrollLeft += dx; node.scrollTop += dy; }
    if (!e.isTrusted) setScrollLeft(node.scrollLeft);
    else scheduleScroll();
  };
  pinch.current = (event) => {
    const e = event as Event & { scale: number; clientX?: number };
    e.preventDefault();
    e.stopPropagation();
    if (drag.current || scrub.current || layerDrag.current) {
      pinchStart.current = null;
      return;
    }
    // WKWebView supplies cumulative scale from gesturestart; keep its focal point fixed.
    if (e.type === "gesturestart") {
      pinchStart.current = {
        zoom: pendingZoom.current,
        clientX: e.clientX ?? scroller.current!.getBoundingClientRect().left + (width + labelWidth) / 2,
      };
    } else {
      const start = pinchStart.current;
      if (start && Number.isFinite(e.scale) && e.scale > 0)
        zoomAt(start.zoom * e.scale, start.clientX);
      if (e.type === "gestureend") pinchStart.current = null;
    }
  };
  useLayoutEffect(() => {
    const node = scroller.current,
      a = anchor.current;
    if (node) {
      const maximum = Math.max(0, railWidth - Math.max(1,width-labelWidth));
      node.scrollLeft = Math.min(maximum, Math.max(0, a ? a.time * scale - a.x : node.scrollLeft));
      setScrollLeft(node.scrollLeft);
      anchor.current = null;
    }
  }, [zoom, scale, railWidth, width]);
  // Overscan in stable pixel tiles: scrolling inside a tile must not rebuild
  // every waveform bar/filmstrip image. Rows outside the vertical window keep
  // their layout and labels but own no thumbnails, waveforms or beat rulers.
  const mediaLeft = Math.max(0, Math.floor(scrollLeft / 320) * 320 - 320);
  const mediaWidth = width + 960;
  if (!p) return null;
  const checkedIds = checked.filter(id => p.layers.some(l => l.id === id));
  // Checked tracks scope the automatic order to themselves; one track alone has
  // nowhere to move, so the control waits for a second one.
  const sortIds = checkedIds;
  const sortDisabled = sortIds.length ? sortIds.length < 2 : p.layers.length < 2;
  const audioLayers = p.layers.filter(l => l.clips.some(c => p.sources.find(s => s.id === c.source_id)?.audio));
  const audioLayer = audioLayers.find(l => l.clips.some(c => c.id === selected)) ?? audioLayers[0];
  const audioSource = p.sources.find(s => s.audio && s.id === audioLayer?.clips.find(c => c.id === selected)?.source_id)
    ?? (audioLayer && layerSources(p, audioLayer).find(s => s.audio));
  const audioSources = [...new Map(audioLayers.flatMap(l => layerSources(p, l).filter(s => s.audio).map(s => [rhythmKey(s), s] as const))).values()];
  const tickStep =
    [
      100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000,
      300000, 600000, 1800000,
    ].find((s) => s * scale >= 70) ?? 3600000;
  const at = (clientX: number, element: HTMLElement) =>
    Math.max(0, (clientX - element.getBoundingClientRect().left) / scale);
  const down = (
    event: React.PointerEvent<HTMLElement>,
    id: string,
    handle: ClipHandle,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const state = useWorkshopStore.getState();
    state.select(id, handle);
    state.begin();
    const base = state.draft!,
      c = base.layers.flatMap((l) => l.clips).find((c) => c.id === id)!;
    const results = useWorkshopRhythmStore.getState().results;
    const beats = base.layers.flatMap(layer => layer.clips
      .filter(clip => handle === "move" ? clip.id !== id : clip.id === id)
      .flatMap(clip => {
        const source = base.sources.find(s => s.id === clip.source_id);
        const grid = source?.audio ? workshopGrid(layer, source, results) : null;
        return grid ? clipBeatTimes(clip, grid, handle === "in" || handle === "out") : [];
      })).sort((a, b) => a - b);
    if (handle.includes("fade_")) {
      // A fade can always return to zero even when the clip edge is between beats.
      beats.push(c.start_ms, c.start_ms + clipDuration(c));
      beats.sort((a, b) => a - b);
    }
    const end = handle === "out" || handle.endsWith("_out");
    // Fade handles move their visible envelope endpoint, not the clip boundary.
    const fade = handle.includes("fade_") ? visibleFade(c, end, handle.startsWith("audio_")) : 0;
    const snapOrigin = c.start_ms + (end ? clipDuration(c) - fade : fade);
    drag.current = {
      id,
      handle,
      x: event.clientX,
      start: c.start_ms,
      duration: clipDuration(c),
      snapOrigin,
      scale,
      project: base,
      quantum: clipQuantum(base, c),
      beats,
    };
    if (
      (handle === "in" || handle === "out") &&
      isVisualSource(base.sources.find((s) => s.id === c.source_id))
    )
      useWorkshopStore.setState({ trimPreview: { clipId: id, edge: handle } });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const position = useWorkshopStore.getState().position;
    let delta = Math.round((event.clientX - d.x) / d.scale / d.quantum) * d.quantum;
    let barCorrection: number | null = null;
    if (barSnap && !event.altKey) {
      const origin = d.snapOrigin;
      const first = nearestBeat(d.beats, origin + delta, 10 / d.scale);
      if (first !== null) barCorrection = first - origin - delta;
      if (d.handle === "move") {
        const last = nearestBeat(d.beats, d.start + d.duration + delta, 10 / d.scale);
        const correction = last === null ? null : last - d.start - d.duration - delta;
        if (correction !== null && (barCorrection === null || Math.abs(correction) < Math.abs(barCorrection))) barCorrection = correction;
      }
    }
    if (barCorrection !== null) delta += barCorrection;
    else if (snap && !event.altKey) {
      const origin = d.snapOrigin;
      const a = snapTime(
        d.project,
        origin + delta,
        d.id,
        position,
        7 / d.scale,
      );
      let correction = a - origin - delta;
      if (d.handle === "move") {
        const b =
          snapTime(
            d.project,
            d.start + d.duration + delta,
            d.id,
            position,
            7 / d.scale,
          ) -
          (d.start + d.duration + delta);
        if (b !== 0 && (correction === 0 || Math.abs(b) < Math.abs(correction)))
          correction = b;
      }
      delta += correction;
    }
    useWorkshopStore
      .getState()
      .transient(adjustClip(d.project, d.id, d.handle, delta));
  };
  const up = () => {
    drag.current = null;
    useWorkshopStore.setState({ trimPreview: null });
    useWorkshopStore.getState().commit();
  };
  const cancel = () => {
    drag.current = null;
    useWorkshopStore.setState({ trimPreview: null });
    useWorkshopStore.getState().abort();
  };
  const scrubMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!scrub.current) return;
    e.preventDefault();
    e.stopPropagation();
    const targetLayer = p.layers.find(l => l.id === scrub.current?.closest<HTMLElement>("[data-layer-id]")?.dataset.layerId) ?? audioLayer;
    const raw = at(e.clientX, scrub.current);
    const source = p.sources.find(s => s.id === targetLayer?.clips.find(c => raw >= c.start_ms && raw < c.start_ms + clipDuration(c))?.source_id);
    const beats = (targetLayer?.clips.flatMap(c => {
      const source = p.sources.find(s => s.id === c.source_id);
      const grid = source?.audio ? workshopGrid(targetLayer, source, useWorkshopRhythmStore.getState().results) : null;
      return grid ? clipBeatTimes(c, grid) : [];
    }) ?? []).sort((a, b) => a - b);
    const target = barSnap && !e.altKey ? nearestBeat(beats, raw, 10 / scale) : null;
    latestPlayback.current.seek(target ?? (source?.audio && !isVisualSource(source) ? raw : Math.round(raw / frame) * frame));
  };
  const scrubStart = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const rail = e.currentTarget.closest<HTMLElement>(
      ".vj-track-rail,.vj-ruler-rail",
    );
    if (!rail) return;
    scrub.current = rail;
    useWorkshopStore.setState({ scrubbing: true });
    latestPlayback.current.beginScrub();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubMove(e);
  };
  const scrubEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (!scrub.current) return;
    scrubMove(e);
    scrub.current = null;
    useWorkshopStore.setState({ scrubbing: false });
    latestPlayback.current.endScrub();
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <section className="vj-timeline" aria-label="剪辑时间轴" style={{"--vj-label-width": `${labelWidth}px`} as React.CSSProperties}>
      {audioSources.map(source => <WorkshopRhythmSource key={rhythmKey(source)} source={source} />)}
      <div className="vj-timeline-scale">
        {audioLayer && audioSource && <TimelineRhythmControls source={audioSource} layer={{...audioLayer, clips: audioLayer.clips.filter(c => c.source_id === audioSource.id)}} />}
        {analyzing && <WorkshopAnalysisControl projectId={p.id} />}
        <div className="vj-timeline-time">
          {workspace && <>
            <button type="button" aria-label="缩小时间轴" title="缩小 · Alt/Option + 滚轮" disabled={contentDuration <= 0 || zoom <= 1}
              onClick={() => zoomStep(1 / 1.5)}><ZoomOut size={14} /></button>
            <button type="button" aria-label="放大时间轴" title="放大 · Alt/Option + 滚轮" disabled={contentDuration <= 0 || zoom >= 64}
              onClick={() => zoomStep(1.5)}><ZoomIn size={14} /></button>
          </>}
          <button type="button" aria-label="时间轴适应全长" title="适应全长" disabled={contentDuration <= 0}
            onClick={fitTimeline}><Maximize2 size={14} /></button>
          {!workspace && <TimelineTime duration={contentDuration} />}
        </div>
      </div>
      {tools}
      <div
        className="vj-timeline-scroll"
        title="Shift + 滚轮：左右滚动；Alt/Option + 滚轮：缩放"
        id={scrollId}
        ref={observe}
        onScroll={scheduleScroll}
      >
        <div className="vj-time-ruler" style={{ width: railWidth + labelWidth }}>
          <div className="vj-track-label vj-track-label-heading"><span>素材 / 轨道</span>
            <span className="vj-track-heading-tail"><small>{p.layers.length}</small>
              <button type="button" className="vj-layer-sort" data-active={sortIds.length > 1 || undefined}
                aria-label="自动排序轨道" disabled={sortDisabled}
                title={sortIds.length > 1 ? "重排所选轨道：按片段在歌曲中的位置，靠后的在上层，音频在最底部" : "按片段在歌曲中的位置重排轨道：靠后的在上层，音频在最底部；勾选轨道后只排所选"}
                onClick={() => useWorkshopStore.getState().edit(project => sortLayers(project, sortIds.length > 1 ? sortIds : undefined))}>
                <ArrowDownUp size={12} />
              </button>
            </span>
          </div>
          <div
            data-vj-time-scale={scale} className="vj-ruler-rail"
            style={{ width: railWidth }}
            onPointerDown={scrubStart}
            onPointerMove={scrubMove}
            onPointerUp={scrubEnd}
            onPointerCancel={scrubEnd}
          >
            {Array.from(
              { length: Math.max(0, Math.min(Math.floor(duration / tickStep), Math.ceil((mediaLeft + mediaWidth) / scale / tickStep)) - Math.floor(mediaLeft / scale / tickStep) + 1) },
              (_, n) => {
                const i = Math.floor(mediaLeft / scale / tickStep) + n;
                return (p.markers ?? []).some(m => {
                const distance = (m.position_ms - i * tickStep) * scale;
                return distance > -14 && distance < 66;
              }) ? null : (
                <span key={i} style={{ left: i * tickStep * scale }}>
                  {formatTime(i * tickStep).replace(/\.000$/, "")}
                </span>
              ); },
            )}
            {(p.markers ?? []).filter(m => m.position_ms <= duration).map(marker => <button
              key={marker.id} type="button" className="vj-marker" data-marker-id={marker.id}
              aria-label={`标记 ${marker.number} · ${formatTime(marker.position_ms)}`}
              title={`标记 ${marker.number} · ${formatTime(marker.position_ms)}`}
              style={{left: marker.position_ms * scale, "--vj-marker-color": workshopMarkerColor(marker.number)} as React.CSSProperties}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); playback.seek(marker.position_ms); }}
            ><i aria-hidden="true" /><small>{marker.number}</small></button>)}
            {p.output.out_ms !== null && <i className="vj-export-range" aria-hidden="true"
              style={{left: p.output.in_ms * scale, width: Math.max(1, (p.output.out_ms - p.output.in_ms) * scale)}} />}
            <TimelinePlayhead scale={scale} />
          </div>
        </div>
        {rows.map(({layer, sources, title, hasAudio, hasVisual, lanes, laneCount, trackHeight, top, joints,
          joinedIn, joinedOut, audioJoinedIn, audioJoinedOut, rhythmLayers}, index) => {
          const hidden = hiddenVideoLayers[p.id]?.includes(layer.id) ?? false;
          const rowVisible = top + trackHeight >= vertical.top - 256 && top <= vertical.top + vertical.height + 256;
          return (
            <div
              className="vj-track-row"
              key={layer.id}
              data-layer-id={layer.id}
              data-layer-drop={layerDrop?.id === layer.id ? layerDrop.edge : undefined}
              data-video-hidden={hidden || undefined}
              data-rhythm={hasAudio || undefined}
              data-audio-waveform={hasAudio && !hasVisual || undefined}
              style={{ width: railWidth + labelWidth, "--vj-track-height": `${trackHeight}px` } as React.CSSProperties}
            >
              <div
                className="vj-track-label"
                data-selected={
                  layer.clips.some((c) => c.id === selected) || undefined
                }
              >
                <div className="vj-layer-heading">
                <button type="button" role="checkbox" aria-checked={checkedIds.includes(layer.id)} aria-label={`选择轨道：${title}`}
                  className="vj-layer-check" onClick={() => setChecked(checkedIds.includes(layer.id) ? checkedIds.filter(id => id !== layer.id) : [...checkedIds, layer.id])}>
                  {checkedIds.includes(layer.id) ? <SquareCheck size={13} /> : <Square size={13} />}
                </button>
                <button
                  type="button"
                  aria-label={`拖动层级：${title}`}
                  className="vj-grip"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    layerDrag.current = layer.id;
                    setLayerDrop(null);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!layerDrag.current) return;
                    const next = layerDropAt(e.clientX, e.clientY);
                    setLayerDrop(old => old?.id === next?.id && old?.edge === next?.edge && old?.to === next?.to ? old : next);
                  }}
                  onPointerUp={(e) => {
                    const drop = layerDropAt(e.clientX, e.clientY);
                    const id = layerDrag.current;
                    endLayerDrag();
                    if (id && drop) useWorkshopStore.getState().edit(p => moveLayer(p, id, drop.to));
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onPointerCancel={endLayerDrag}
                  onLostPointerCapture={endLayerDrag}
                >
                  <GripVertical size={13} />
                </button>
                <button
                  type="button"
                  className="vj-layer-name"
                  title={title}
                  onClick={() =>
                    useWorkshopStore
                      .getState()
                      .select(layer.clips[0]?.id ?? null)
                  }
                >
                  {title}
                </button>
                <button type="button" className="vj-source-remove" aria-label={`移除轨道 ${title}`} title="移除轨道"
                  onClick={() => {
                    const state = useWorkshopStore.getState();
                    state.edit(p => {
                      const next = cloneProject(p);
                      next.layers = next.layers.filter(l => l.id !== layer.id);
                      return next;
                    });
                    if (layer.clips.some(c => c.id === selected)) state.select(null);
                  }}><X size={12} /></button>
                </div>
                <div className="vj-layer-details">
                  <small className="vj-layer-number">{index + 1}</small>
                  {hasAudio && <WorkshopLayerAudio projectId={p.id} layer={layer} title={title} />}
                  {hasVisual && <button type="button" className="vj-layer-visibility" aria-pressed={hidden}
                    aria-label={`${hidden ? "显示" : "隐藏"}轨道画面：${title}`} title="临时隐藏画面（仅预览，声音不变）"
                    onClick={() => useWorkshopStore.getState().toggleVideoLayer(layer.id)}>{hidden ? <EyeOff size={13}/> : <Eye size={13}/>}</button>}
                  {sources.length === 1 && sources[0].video && sources[0].audio && laneCount === 1 && <WorkshopLayerAnalysis projectId={p.id} layerId={layer.id} sourceTitle={title} />}
                </div>
              </div>
              <div
                data-vj-time-scale={scale} className="vj-track-rail"
                style={{ width: railWidth }}
                onPointerDown={(e) => {
                  useWorkshopStore.getState().select(null);
                  scrubStart(e);
                }}
                onPointerMove={scrubMove}
                onPointerUp={scrubEnd}
                onPointerCancel={scrubEnd}
                onDragOver={(e) => {
                  if (isTrackDrag(e)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDrop={(e) => {
                  const ids = readTrackDragIds(e.dataTransfer);
                  if (ids.length) {
                    e.preventDefault();
                    e.stopPropagation();
                    const time =
                      Math.round(at(e.clientX, e.currentTarget) / frame) *
                      frame;
                    finishTrackDrop();
                    void useWorkshopStore.getState().add(ids, time, p.id);
                  }
                }}
              >
                {layer.clips.map((c) => {
                  const source = sourceById.get(c.source_id)!;
                  const d = clipDuration(c);
                  const mediaVisible = rowVisible && (c.start_ms + d) * scale >= mediaLeft
                    && c.start_ms * scale <= mediaLeft + mediaWidth;
                  return (
                    <div
                      key={c.id}
                      className="vj-clip"
                      data-clip-id={c.id}
                      data-kind={isVisualSource(source) ? "video" : "audio"}
                      data-selected={c.id === selected || undefined}
                      style={{
                        left: c.start_ms * scale,
                        width: Math.max(2, d * scale),
                        top: (lanes.get(c.id) ?? 0) * 62 + (hasAudio && hasVisual ? 16 : 0),
                        "--vj-track-height": "62px",
                      } as React.CSSProperties}
                      role="button"
                      tabIndex={0}
                      aria-label={`${source.title}，${formatTime(c.start_ms)}，${formatTime(d)}`}
                      onFocus={() => {
                        if (useWorkshopStore.getState().selectedId !== c.id)
                          useWorkshopStore.getState().select(c.id);
                      }}
                      onPointerDown={(e) => down(e, c.id, "move")}
                      onPointerMove={move}
                      onPointerUp={up}
                      onPointerCancel={cancel}
                    >
                      {mediaVisible && <WorkshopClipMedia
                        project={p.id}
                        source={source}
                        clip={c}
                        scale={scale}
                        viewport={{ left: mediaLeft, width: mediaWidth }}
                      />}
                      {(isVisualSource(source) ? [false, ...(!c.sound.muted && source.audio ? [true] : [])] : [true]).map(audio => (
                        <TimelineFadeCurve key={String(audio)} clip={c} audio={audio}
                          incoming={(audio ? audioJoinedIn : joinedIn).get(c.id)}
                          outgoing={(audio ? audioJoinedOut : joinedOut).get(c.id)} />
                      ))}
                      {sources.length > 1 && <span className="vj-clip-source">{source.title}</span>}
                      {(c.speed.preset !== "constant" || c.speed.start !== 1) && <span className="vj-clip-rate"
                        title={c.speed.preset !== "constant" ? "曲线变速" : `播放速度 ${c.speed.start}×`}>
                        {c.speed.preset !== "constant" ? "∿" : `${Number(c.speed.start.toFixed(4))}×`}
                      </span>}
                      {(["in", "out"] as const).map((h) => (
                        <button
                          type="button"
                          key={h}
                          className={`vj-trim vj-trim-${h}`}
                          aria-label={
                            h === "in" ? "调整片段入点" : "调整片段出点"
                          }
                          onPointerDown={(e) => down(e, c.id, h)}
                          onPointerMove={move}
                          onPointerUp={up}
                          onPointerCancel={cancel}
                        />
                      ))}
                      {(isVisualSource(source) ? [false, ...(!c.sound.muted && source.audio ? [true] : [])] : [true]).flatMap(audio =>
                        ([false, true] as const).map(end => {
                          if ((audio ? (end ? audioJoinedOut : audioJoinedIn) : (end ? joinedOut : joinedIn)).has(c.id)) return null;
                          const h: ClipHandle = audio ? (end ? "audio_fade_out" : "audio_fade_in") : (end ? "fade_out" : "fade_in");
                          const px = Math.max(9, Math.min(d * scale / 2, visibleFade(c, end, audio) * scale));
                          return <button type="button" key={h} className={`vj-fade-handle ${audio && isVisualSource(source) ? "vj-fade-audio-handle" : ""}`}
                            style={end ? {right:px - 8} : {left:px - 8}}
                            aria-label={`调整${audio ? "声音" : "画面"}${end ? "淡出" : "淡入"}`}
                            title={`${audio ? "声音" : "画面"}${end ? "淡出" : "淡入"} ${(visibleFade(c,end,audio)/1000).toFixed(2)} s · 拖动曲线端点`}
                            onPointerDown={e => down(e,c.id,h)} onPointerMove={e => {e.stopPropagation(); move(e);}}
                            onPointerUp={e => {e.stopPropagation(); up();}} onPointerCancel={cancel} />;
                        }))}
                    </div>
                  );
                })}
                {joints.map(({left,right}) => <div key={`join:${right.id}`} className="vj-transition-lane" style={{top:(lanes.get(right.id) ?? 0) * 62}}>
                  <WorkshopVideoTransition project={p} left={left} right={right} scale={scale}/>
                </div>)}
                {rowVisible && rhythmLayers.map(({source, layer: rhythmLayer}) => <WorkshopRhythmRuler key={source.id} source={source}
                  layer={rhythmLayer} scale={scale}
                  left={mediaLeft} width={mediaWidth} />)}
                <TimelinePlayhead
                  scale={scale}
                  onPointerDown={scrubStart}
                  onPointerMove={scrubMove}
                  onPointerUp={scrubEnd}
                  onPointerCancel={scrubEnd}
                />
              </div>
            </div>
          );
        })}
      </div>
      {p.layers.length > 0 && <WorkshopTimelineOverview
        viewport={Math.max(1,width-labelWidth)} content={railWidth} offset={scrollLeft} controls={scrollId}
        onScroll={offset => {
          const node = scroller.current;
          if (!node) return;
          node.scrollLeft = offset;
          setScrollLeft(offset);
        }} />}
    </section>
  );
}
