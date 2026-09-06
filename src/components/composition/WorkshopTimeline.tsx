import { isVisualSource } from "../../lib/workshop";
import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
} from "react";
import { WorkshopAnalysisControl, WorkshopLayerAnalysis } from "./WorkshopLayerAnalysis";
import { WorkshopClipMedia } from "./WorkshopClipMedia";
import { WorkshopTimelineOverview } from "./WorkshopTimelineOverview";
import { GripVertical, Music2, Eye, EyeOff, X } from "lucide-react";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  adjustClip,
  cloneProject,
  clipDuration,
  formatTime,
  fadeAlpha,
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
export function WorkshopTimeline({ playback }: { playback: WorkshopPlayback }) {
  const scrollId = useId();
  const p = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    position = useWorkshopStore((s) => s.position),
    snap = useWorkshopStore((s) => s.snap),
    hiddenVideoLayers = useWorkshopStore(s => s.hiddenVideoLayers),
    auditionAfterLayer = useWorkshopStore(s => s.auditionAfterLayer);
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
    scale: number;
    project: CompositionProject;
  } | null>(null);
  const layerDrag = useRef<string | null>(null);
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
    if (e.shiftKey || e.ctrlKey) {
      const delta = dy || dx;
      zoomAt(pendingZoom.current * Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.003)), e.clientX);
      return;
    }
    if (e.altKey) node.scrollLeft += dx || e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? pageWidth : 1);
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
    drag.current = {
      id,
      handle,
      x: event.clientX,
      start: c.start_ms,
      duration: clipDuration(c),
      scale,
      project: base,
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
    let delta = Math.round((event.clientX - d.x) / d.scale / frame) * frame;
    if (snap && !event.altKey && !d.handle.includes("fade_")) {
      const origin = d.handle === "out" ? d.start + d.duration : d.start;
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
    latestPlayback.current.seek(
      Math.round(at(e.clientX, scrub.current) / frame) * frame,
    );
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
      <div className="vj-timeline-scale">
        {analyzing && <WorkshopAnalysisControl projectId={p.id} />}
        <span>
          {formatTime(position)} / {formatTime(projectDuration(p))}
        </span>
      {p.layers.length > 0 && <WorkshopTimelineOverview
        project={p} viewport={Math.max(1,width-labelWidth)} content={railWidth} offset={scrollLeft} controls={scrollId} position={position}
        onSeek={ms => {
          latestPlayback.current.seek(ms);
          const node=scroller.current, visible=Math.max(1,width-labelWidth);
          if(node) { const next=Math.max(0,Math.min(railWidth-visible,ms*scale-visible/2)); node.scrollLeft=next; setScrollLeft(next); }
        }}
        onSeekStart={() => {useWorkshopStore.setState({scrubbing:true}); latestPlayback.current.beginScrub();}}
        onSeekEnd={() => {useWorkshopStore.setState({scrubbing:false}); latestPlayback.current.endScrub();}}
        onScroll={offset => {
          const node = scroller.current;
          if (!node) return;
          node.scrollLeft = offset;
          setScrollLeft(offset);
        }} />}
      </div>
      <div
        className="vj-timeline-scroll"
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
              (_, i) => (
                <span key={i} style={{ left: i * tickStep * scale }}>
                  {formatTime(i * tickStep).replace(/\.000$/, "")}
                </span>
              ),
            )}
            <i className="vj-playhead" style={{ left: position * scale }} />
          </div>
        </div>
        {p.layers.map((layer, index) => {
          const source = p.sources.find((s) => s.id === layer.source_id)!;
          const hidden = hiddenVideoLayers[p.id]?.includes(layer.id) ?? false;
          const audioOff = auditionAfterLayer[p.id] === layer.id;
          const nextAudioLayer = p.layers.slice(index + 1).find(l => l.clips.length > 0 && p.sources.some(s => s.id === l.source_id && s.audio));
          const nextAudioSource = p.sources.find(s => s.id === nextAudioLayer?.source_id);
          return (
            <div
              className="vj-track-row"
              key={layer.id}
              data-layer-id={layer.id}
              data-video-hidden={hidden || undefined}
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
                    layerDrag.current = layer.id;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerUp={(e) => {
                    const target = document
                      .elementFromPoint(e.clientX, e.clientY)
                      ?.closest<HTMLElement>("[data-layer-id]")
                      ?.dataset.layerId;
                    if (layerDrag.current && target) {
                      const to = p.layers.findIndex((l) => l.id === target);
                      if (to >= 0)
                        useWorkshopStore
                          .getState()
                          .edit((p) => moveLayer(p, layerDrag.current!, to));
                    }
                    layerDrag.current = null;
                  }}
                >
                  <GripVertical size={13} />
                </button>
                {isVisualSource(source) ? <button type="button" className="vj-layer-visibility" aria-pressed={hidden}
                  aria-label={`${hidden ? "显示" : "隐藏"}轨道画面：${source.title}`} title="临时隐藏画面（仅预览，声音不变）"
                  onClick={() => useWorkshopStore.getState().toggleVideoLayer(layer.id)}>{hidden ? <EyeOff size={13}/> : <Eye size={13}/>}</button> : <button
                    type="button" className="vj-layer-audio" aria-pressed={!audioOff}
                    aria-label={`${audioOff ? "恢复" : "关闭"}音乐试听：${source.title}`}
                    title={audioOff ? "恢复原混音（仅预览）" : nextAudioSource ? `临时关闭音乐，试听：${nextAudioSource.title}（仅预览）` : "临时静音（仅预览）"}
                    onClick={() => useWorkshopStore.getState().toggleAudioLayer(layer.id)}>
                    <Music2 size={13}>{audioOff && <path d="m3 3 18 18"/>}</Music2>
                  </button>}
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
                <small>{index + 1}</small>
                <button type="button" className="vj-source-remove" aria-label={`移除素材 ${source.title}`}
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
                <WorkshopLayerAnalysis projectId={p.id} layerId={layer.id} sourceTitle={source.title} />
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
                        <svg key={String(audio)} className={`vj-fade-curve ${audio ? "vj-fade-audio" : ""}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-label={audio ? "声音淡化曲线" : "画面淡化曲线"}>
                          <path d={Array.from({length:81}, (_,i) => `${i ? "L" : "M"}${i * 1.25},${27 - fadeAlpha(c, d * i / 80, audio) * 23}`).join(" ")} vectorEffect="non-scaling-stroke" />
                        </svg>
                      ))}
                      <span className="vj-clip-title">
                        {source.title}
                        {c.speed.preset !== "constant"
                          ? " · ∿"
                          : c.speed.start !== 1
                            ? ` · ${c.speed.start}×`
                            : ""}
                      </span>
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
    </section>
  );
}
