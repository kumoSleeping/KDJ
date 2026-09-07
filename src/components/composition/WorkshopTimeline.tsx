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
import { GripVertical, Eye, EyeOff, X } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  adjustClip,
  cloneProject,
  clipDuration,
  clipQuantum,
  formatTime,
  visibleFade,
  moveLayer,
  projectDuration,
  snapTime,
} from "../../lib/workshop";
import type { ClipHandle, CompositionProject } from "../../types/workshop";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import {
  isTrackDrag,
  readTrackDragIds,
  finishTrackDrop,
} from "../../lib/trackDrag";
export function WorkshopTimeline({ playback, tools }: { playback: WorkshopPlayback; tools?: ReactNode }) {
  const scrollId = useId();
  const p = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    position = useWorkshopStore((s) => s.position),
    snap = useWorkshopStore((s) => s.snap),
    barSnap = useWorkshopStore((s) => s.barSnap),
    hiddenVideoLayers = useWorkshopStore(s => s.hiddenVideoLayers);
  const analyzing = useWorkshopStore(s => s.positions[s.draft?.id ?? ""]?.items.some(a => a.phase === "analyzing" || a.phase === "waiting"));
  const [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(800),
    [scrollLeft, setScrollLeft] = useState(0);
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
      const onWheel = (e: WheelEvent) => wheel.current(e),
        onGesture = (e: Event) => pinch.current(e);
      node.addEventListener("wheel", onWheel, { passive: false });
      for (const name of ["gesturestart", "gesturechange", "gestureend"])
        node.addEventListener(name, onGesture, { passive: false });
      cleanScroll.current = () => {
        node.removeEventListener("wheel", onWheel);
        for (const name of ["gesturestart", "gesturechange", "gestureend"])
          node.removeEventListener(name, onGesture);
      };
      setWidth(node.clientWidth || 800);
      observer.current = new ResizeObserver(([entry]) =>
        setWidth(entry.contentRect.width),
      );
      observer.current.observe(node);
    }
  }, []);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      cleanScroll.current();
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
  const duration = Math.max(
      1000,
      p ? projectDuration(drag.current?.project ?? p) : 1000,
    ),
    railWidth = Math.max(80, width - labelWidth) * zoom,
    scale = railWidth / duration;
  const frame = 1000 / (p?.canvas.fps ?? 30);
  const zoomAt = (next: number, clientX: number) => {
    const node = scroller.current;
    if (!node || drag.current || !Number.isFinite(next)) return;
    const bounded = Math.max(1, Math.min(64, next));
    if (bounded === pendingZoom.current) return;
    const x = Math.max(0, Math.min(width - labelWidth, clientX - node.getBoundingClientRect().left - labelWidth));
    // Keep the rendered anchor until React commits, but accumulate every input sample.
    anchor.current ??= { time: (node.scrollLeft + x) / scale, x };
    if (bounded === zoom) anchor.current = null;
    pendingZoom.current = bounded;
    setZoom(bounded);
  };
  wheel.current = (e) => {
    const node = scroller.current;
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    if (pinchStart.current !== null || drag.current || scrub.current || layerDrag.current) return;
    const pageWidth = Math.max(80, width - labelWidth);
    const dx = e.deltaX * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? pageWidth : 1);
    const dy = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? node.clientHeight || 200 : 1);
    // WebView2/Chromium reports precision-touchpad pinch as Ctrl+wheel.
    // Shift+wheel may arrive on deltaX after the OS remaps its axis.
    if (e.altKey || e.ctrlKey) {
      const delta = dy || dx;
      zoomAt(pendingZoom.current * Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.003)), e.clientX);
      return;
    }
    if (e.shiftKey) node.scrollLeft += dx || e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? pageWidth : 1);
    else {
      node.scrollLeft += dx;
      node.scrollTop += dy;
    }
    setScrollLeft(node.scrollLeft);
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
  if (!p) return null;
  const audioLayers = p.layers.filter(l => l.clips.length && p.sources.some(s => s.id === l.source_id && s.audio));
  const audioLayer = audioLayers.find(l => l.clips.some(c => c.id === selected)) ?? audioLayers[0];
  const audioSource = p.sources.find(s => s.id === audioLayer?.source_id);
  const audioSources = [...new Map(audioLayers.map(l => {
    const source = p.sources.find(s => s.id === l.source_id)!;
    return [rhythmKey(source), source] as const;
  })).values()];
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
    const beats = base.layers.flatMap(layer => {
      const source = base.sources.find(s => s.id === layer.source_id);
      if (!source?.audio) return [];
      const grid = workshopGrid(layer, source, results);
      if (!grid) return [];
      return layer.clips.filter(clip => handle === "move" ? clip.id !== id : clip.id === id)
        .flatMap(clip => clipBeatTimes(clip, grid, handle === "in" || handle === "out"));
    }).sort((a, b) => a - b);
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
    const source = p.sources.find(s => s.id === targetLayer?.source_id);
    const raw = at(e.clientX, scrub.current);
    const grid = source?.audio && targetLayer ? workshopGrid(targetLayer, source, useWorkshopRhythmStore.getState().results) : null;
    const beats = grid && targetLayer ? targetLayer.clips.flatMap(c => clipBeatTimes(c, grid)).sort((a, b) => a - b) : [];
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
        {audioLayer && audioSource && <WorkshopRhythmControls source={audioSource} layer={audioLayer} position={position} />}
        {analyzing && <WorkshopAnalysisControl projectId={p.id} />}
        <div className="vj-timeline-time">
          <span>{formatTime(position)} / {formatTime(projectDuration(p))}</span>
        </div>
      </div>
      {tools}
      <div
        className="vj-timeline-scroll"
        title="Shift + 滚轮：左右滚动；Alt/Option + 滚轮：缩放"
        id={scrollId}
        ref={observe}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div className="vj-time-ruler" style={{ width: railWidth + labelWidth }}>
          <div className="vj-track-label vj-track-label-heading"><span>素材 / 轨道</span><small>{p.layers.length}</small></div>
          <div
            data-vj-time-scale={scale} className="vj-ruler-rail"
            style={{ width: railWidth }}
            onPointerDown={scrubStart}
            onPointerMove={scrubMove}
            onPointerUp={scrubEnd}
            onPointerCancel={scrubEnd}
          >
            {Array.from(
              { length: Math.floor(duration / tickStep) + 1 },
              (_, i) => (p.markers ?? []).some(m => {
                const distance = (m.position_ms - i * tickStep) * scale;
                return distance > -14 && distance < 66;
              }) ? null : (
                <span key={i} style={{ left: i * tickStep * scale }}>
                  {formatTime(i * tickStep).replace(/\.000$/, "")}
                </span>
              ),
            )}
            {(p.markers ?? []).filter(m => m.position_ms <= duration).map(marker => <button
              key={marker.id} type="button" className="vj-marker" data-marker-id={marker.id}
              aria-label={`标记 ${marker.number} · ${formatTime(marker.position_ms)}`}
              title={`标记 ${marker.number} · ${formatTime(marker.position_ms)}`}
              style={{left: marker.position_ms * scale, "--vj-marker-color": workshopMarkerColor(marker.number)} as React.CSSProperties}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); playback.seek(marker.position_ms); }}
            ><i aria-hidden="true" /><small>{marker.number}</small></button>)}
            <i className="vj-playhead" style={{ left: position * scale }} />
          </div>
        </div>
        {p.layers.map((layer, index) => {
          const source = p.sources.find((s) => s.id === layer.source_id)!;
          const hidden = hiddenVideoLayers[p.id]?.includes(layer.id) ?? false;
          const ordered = [...layer.clips].sort((a,b) => a.start_ms-b.start_ms);
          const joints = source.video ? ordered.flatMap((right,i) => {
            const left=ordered[i-1];
            return left && Math.abs(left.start_ms+clipDuration(left)-right.start_ms)<.01 ? [{left,right}] : [];
          }) : [];
          const spans = joints.flatMap(j => {
            const span = videoTransitionSpan(j.left, j.right);
            return span ? [{...j, span}] : [];
          });
          const joinedIn = new Map(spans.map(j => [j.right.id, j.span]));
          const joinedOut = new Map(spans.map(j => [j.left.id, j.span]));
          return (
            <div
              className="vj-track-row"
              key={layer.id}
              data-layer-id={layer.id}
              data-layer-drop={layerDrop?.id === layer.id ? layerDrop.edge : undefined}
              data-video-hidden={hidden || undefined}
              data-rhythm={source.audio || undefined}
              data-audio-waveform={source.audio && !isVisualSource(source) || undefined}
              style={{ width: railWidth + labelWidth }}
            >
              <div
                className="vj-track-label"
                data-selected={
                  layer.clips.some((c) => c.id === selected) || undefined
                }
              >
                <div className="vj-layer-heading">
                <button
                  type="button"
                  aria-label={`拖动层级：${source.title}`}
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
                  title={source.title}
                  onClick={() =>
                    useWorkshopStore
                      .getState()
                      .select(layer.clips[0]?.id ?? null)
                  }
                >
                  {source.title}
                </button>
                <button type="button" className="vj-source-remove" aria-label={`移除素材 ${source.title}`} title="移除素材"
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
                  {source.audio && <WorkshopLayerAudio projectId={p.id} layer={layer} title={source.title} />}
                  {isVisualSource(source) && <button type="button" className="vj-layer-visibility" aria-pressed={hidden}
                    aria-label={`${hidden ? "显示" : "隐藏"}轨道画面：${source.title}`} title="临时隐藏画面（仅预览，声音不变）"
                    onClick={() => useWorkshopStore.getState().toggleVideoLayer(layer.id)}>{hidden ? <EyeOff size={13}/> : <Eye size={13}/>}</button>}
                  {source.video && source.audio && <WorkshopLayerAnalysis projectId={p.id} layerId={layer.id} sourceTitle={source.title} />}
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
                    void useWorkshopStore.getState().add(ids, time);
                  }
                }}
              >
                {layer.clips.map((c) => {
                  const d = clipDuration(c);
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
                      }}
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
                      <WorkshopClipMedia
                        project={p.id}
                        source={source}
                        clip={c}
                        scale={scale}
                        viewport={{ left: scrollLeft, width }}
                      />
                      {(isVisualSource(source) ? [false, ...(!c.sound.muted && source.audio ? [true] : [])] : [true]).map(audio => (
                        <svg key={String(audio)} className={`vj-fade-curve ${audio ? "vj-fade-audio" : ""}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-label={audio ? "声音淡化曲线" : "画面淡化曲线"}
                          style={!audio ? {clipPath: `inset(0 ${(joinedOut.get(c.id)?.before ?? 0) / d * 100}% 0 ${(joinedIn.get(c.id)?.after ?? 0) / d * 100}%)`} : undefined}>
                          <path d={workshopFadeCurvePath(audio ? c : {...c, fades:{...c.fades,
                            video_in_ms:joinedIn.has(c.id) ? 0 : c.fades.video_in_ms,
                            video_out_ms:joinedOut.has(c.id) ? 0 : c.fades.video_out_ms}}, audio, true)} vectorEffect="non-scaling-stroke" />
                        </svg>
                      ))}
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
                          if (!audio && (end ? joinedOut : joinedIn).has(c.id)) return null;
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
                {joints.map(({left,right}) => <WorkshopVideoTransition key={`join:${right.id}`} project={p} left={left} right={right} scale={scale}/>)}
                {source.audio && <WorkshopRhythmRuler source={source} layer={layer} scale={scale}
                  left={scrollLeft} width={Math.max(1, width - labelWidth)} />}
                <i
                  className="vj-playhead"
                  style={{ left: position * scale }}
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
