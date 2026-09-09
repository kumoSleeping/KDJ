import { WorkshopImage } from "./WorkshopImage";
import { pictureBox as box } from "../../lib/workshopPicture";
import { isVisualSource, isImageSource } from "../../lib/workshop";
import { useEffect, useMemo, useRef, useState } from "react";
import { videoProject } from "../../lib/workshopTransitions";
import { api } from "../../lib/api";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  clamp,
  clipDuration,
  fadeAlpha,
  findClip,
  updateClip,
} from "../../lib/workshop";
import { VideoPlaybackEngine } from "../../lib/videoPlaybackEngine";
import { getLocalVideoClock } from "../../lib/mediaSync";
import { prepareVideoClips, previewVideoTiming, WorkshopSeekGate } from "../../lib/workshopPreviewPolicy";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import type {
  CompositionProject,
} from "../../types/workshop";
function PreviewVideo({ register, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & { register(node: HTMLVideoElement): () => void }) {
  const node = useRef<HTMLVideoElement>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  useEffect(() => {
    const video = node.current;
    if (!video) return;
    // React StrictMode replays effects after cleanup without replacing the DOM.
    // Restore the source that cleanup unloaded, or the second mount stays black.
    if (props.src && video.getAttribute("src") !== props.src) video.src = props.src;
    const unregister = register(video);
    return () => {
      if (retry.current !== null) clearTimeout(retry.current);
      retry.current = null;
      unregister(); video.pause(); video.removeAttribute("src"); video.load();
    };
  }, []);
  return <video {...props} ref={node} onLoadedData={event => {
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
    props.onLoadedData?.(event);
  }} onError={event => {
    if (retry.current !== null) return;
    if (attempts.current >= 2) { props.onError?.(event); return; }
    const video = event.currentTarget;
    retry.current = setTimeout(() => {
      retry.current = null;
      video.load();
    }, ++attempts.current * 400);
  }} />;
}
function PreviewVideoPair({ synchronizer, register, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & {
  synchronizer: VideoPlaybackEngine;
  register(node: HTMLVideoElement, correct: () => void): () => void;
}) {
  const nodes = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const active = useRef(0), generation = useRef(0);
  const unregister = useRef<(() => void) | null>(null);
  const correct = () => {
    const old = nodes.current[active.current], next = nodes.current[1 - active.current];
    const owner = generation.current;
    if (!old || !next) return;
    const isCurrent = () => owner === generation.current && nodes.current[active.current] === old;
    void synchronizer.alignStandby(old, next, isCurrent, () => {
      if (!isCurrent()) return false;
      next.style.cssText = old.style.cssText;
      old.style.opacity = '0';
      active.current = 1 - active.current;
      unregister.current?.();
      unregister.current = register(next, correct);
      old.pause();
      return true;
    });
  };
  return <>{([0, 1] as const).map(slot => <PreviewVideo {...props} key={slot} register={node => {
    nodes.current[slot] = node;
    if (slot === active.current) unregister.current = register(node, correct);
    return () => {
      generation.current++;
      nodes.current[slot] = null;
      if (slot === active.current) { unregister.current?.(); unregister.current = null; }
    };
  }} />)}</>;
}
export function WorkshopPreview({ playback, editable = true }: { playback: WorkshopPlayback; editable?: boolean }) {
  const cropId = useWorkshopStore(s => s.cropId);
  const project = useWorkshopStore((s) => s.draft),
    selected = useWorkshopStore((s) => s.selectedId),
    position = useWorkshopStore((s) => s.position),
    trimPreview = useWorkshopStore((s) => s.trimPreview),
    hiddenVideoLayers = useWorkshopStore(s => s.hiddenVideoLayers);
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 640, height: 360 });
  const surface = useRef<HTMLDivElement>(null),
    videos = useRef(new Map<string, HTMLVideoElement>()),
    sync = useRef(new VideoPlaybackEngine()),
    wanted = useRef(new WeakMap<HTMLVideoElement, boolean>()),
    decoded = useRef(new WeakSet<HTMLVideoElement>()),
    pending = useRef(new WeakSet<HTMLVideoElement>());
  const corrections = useRef(new WeakMap<HTMLVideoElement, () => void>());
  const wake = useRef<() => void>(() => {}), seekGate = useRef(new WorkshopSeekGate());
  const [compat, setCompat] = useState<Set<string>>(() => new Set()),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [retryVersion, setRetryVersion] = useState(0);
  const clearError = (slot: string) => setErrors(old => {
    if (!(slot in old)) return old;
    const next = {...old}; delete next[slot]; return next;
  });
  const visual = useMemo(() => project ? videoProject(project) : null, [project]);
  const latest = useRef({ project, visual, playback, trimPreview });
  latest.current = { project, visual, playback, trimPreview };
  const gesture = useRef<{
    x: number;
    y: number;
    mode: "move" | "scale" | "crop_l" | "crop_t" | "crop_r" | "crop_b";
    id: string;
    project: CompositionProject;
  } | null>(null);
  const trimClip =
    project && trimPreview ? findClip(project, trimPreview.clipId) : null;
  const hiddenLayers = project ? hiddenVideoLayers[project.id] ?? [] : [];
  const active = trimClip
    ? [trimClip]
    : (visual?.layers
        .filter(l => !hiddenLayers.includes(l.id))
        .flatMap((l) =>
          l.clips.filter((c) => {
            const s = visual.sources.find((s) => s.id === c.source_id);
            return (
              isVisualSource(s) &&
              position >= c.start_ms &&
              position < c.start_ms + clipDuration(c)
            );
          }),
        )
        .reverse() ?? []);
  const prepared = trimClip ? [trimClip] : visual ? prepareVideoClips(visual, position, hiddenLayers) : [];
  const error = active.map(c => {
    const proxy = !trimPreview && playback.ticket && c.speed.preset !== "constant";
    const part = Math.max(0, Math.floor((position - c.start_ms) / 8000));
    return errors[`${c.id}:${proxy ? part : "raw"}`];
  }).find(Boolean);
  useEffect(() => {
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let lastSync = -Infinity, lastTick = -Infinity;
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      frame = 0;
      const { project, visual, playback: pb, trimPreview: inspecting } = latest.current;
      const p = inspecting ? project : visual;
      if (!p || document.hidden) return;
      const state = useWorkshopStore.getState();
      const playing = pb.playing && !pb.pendingSeek?.() && !inspecting && !state.scrubbing && !state.gesture;
      if (playing && now - lastTick < 1000 / 30) { schedule(); return; }
      lastTick = now;
      const time = pb.time(), align = !playing || now - lastSync >= 100;
      if (align) lastSync = now;
      let retry = false;
      // Video layers are composed by WebKit. No per-frame pixel copies to a
      // canvas, and no full-resolution readback onto the JavaScript thread.
      for (const video of videos.current.values()) {
        const c = findClip(p, video.dataset.clip ?? null);
        const s = c && p.sources.find(s => s.id === c.source_id);
        if (!c || !s?.video) continue;
        const local = inspecting ? 0 : Math.max(0, time - c.start_ms);
        const proxy = video.dataset.proxy === "true", part = Number(video.dataset.part ?? 0);
        const timing = previewVideoTiming(c, time, proxy, part, playing);
        const visible = inspecting ? c.id === inspecting.clipId : timing.visible;
        const target = inspecting
          ? (inspecting.edge === "in" ? c.source_in_ms : Math.max(c.source_in_ms, c.source_out_ms - 1000 / s.fps)) / 1000
          : timing.target;
        // Pre-roll stays muted and transparent, but uses the same shared clock
        // as visible playback. Crossing the edit must not pause/reseek the node.
        const shouldPlay = playing && timing.running;
        // A scrub/seek takes ownership from background drift correction immediately.
        // Otherwise a standby decoder can still adopt a frame from the old clock.
        if (!shouldPlay && wanted.current.get(video)) sync.current.releaseClock(video);
        wanted.current.set(video, shouldPlay);
        if (!shouldPlay && !video.paused) video.pause();
        if (align && video.readyState >= 1) {
          const authority = pb.trackId !== null ? getLocalVideoClock(pb.trackId) : null;
          const sourceRate = proxy || c.speed.preset !== "constant" ? 1 : c.speed.start;
          if (shouldPlay && authority) sync.current.followClock(video, {...authority, position: Math.max(0, target), rate: authority.rate * sourceRate}, (v, t) => { void sync.current.seek(v, t).catch(() => undefined); }, corrections.current.get(video), timing.preparing);
          else {
            sync.current.setBaseRate(video, sourceRate);
            const seek = seekGate.current.request(video, target, shouldPlay, s.fps, now);
            if (seek !== null) void sync.current.seek(video, seek).catch(() => undefined);
            // A seek already decoding is awakened by seeked, not a busy loop.
            else if (!video.seeking && Math.abs(video.currentTime - target) > 0.5 / Math.max(1, s.fps)) retry = true;
          }
        }
        if (shouldPlay && video.paused && !video.seeking && video.readyState >= 2 && !pending.current.has(video)) {
          pending.current.add(video);
          void video.play().then(() => { if (!wanted.current.get(video)) video.pause(); }).catch(() => {}).finally(() => pending.current.delete(video));
        }
        const b = inspecting ? box(p, {...c, picture: {x: .5, y: .5, scale: 1, opacity: 1}}, s) : box(p, c, s);
        video.style.left = `${b.x * 100}%`; video.style.top = `${b.y * 100}%`;
        video.style.width = `${b.width * 100}%`; video.style.height = `${b.height * 100}%`;
        video.style.opacity = String(!visible ? 0 : inspecting ? 1 : c.picture.opacity * fadeAlpha(c, local));
        if (video.readyState >= 2) decoded.current.add(video);
        // WebKit can temporarily drop readyState during a corrective seek.
        // Keep its last decoded frame visible while ordinary playback catches up.
        const retained = shouldPlay && video.seeking && decoded.current.has(video);
        video.style.visibility = retained || (video.readyState >= 2 && (!video.seeking || shouldPlay)) ? "visible" : "hidden";
      }
      if (playing) schedule();
      else if (retry) { clearTimeout(timer); timer = setTimeout(schedule, 80); }
    };
    wake.current = schedule;
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame); frame = 0; clearTimeout(timer);
        for (const v of videos.current.values()) { wanted.current.set(v, false); v.pause(); }
      } else schedule();
    };
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      wake.current = () => {};
      cancelAnimationFrame(frame); clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      for (const v of videos.current.values()) { wanted.current.set(v, false); v.pause(); }
      sync.current.dispose();
    };
  }, []);
  useEffect(() => { wake.current(); }, [project, position, trimPreview, playback.playing, hiddenVideoLayers]);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setAvailable({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [Boolean(project)]);
  if (!project) return <div className="vj-preview" ref={container} />;
  const selectedClip = findClip(project, selected),
    selectedSource =
      selectedClip &&
      project.sources.find((s) => s.id === selectedClip.source_id),
    selectionVisible =
      editable &&
      !trimPreview &&
      selectedClip &&
      selectedSource && isVisualSource(selectedSource) &&
      active.some(c => c.id === selectedClip.id) &&
      position >= selectedClip.start_ms &&
      position < selectedClip.start_ms + clipDuration(selectedClip);
  const bounds = selectionVisible
    ? box(project, selectedClip, selectedSource)
    : null;
  const down = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "move" | "scale" | "crop_l" | "crop_t" | "crop_r" | "crop_b",
  ) => {
    if (e.button !== 0 || !selectedClip) return;
    e.stopPropagation();
    e.preventDefault();
    useWorkshopStore.getState().begin();
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      mode,
      id: selectedClip.id,
      project,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current,
      rect = surface.current?.getBoundingClientRect();
    if (!g || !rect) return;
    useWorkshopStore.getState().transient(
      updateClip(g.project, g.id, (c) => {
        if (g.mode === "move") {
          c.picture.x = clamp(
            c.picture.x + (e.clientX - g.x) / rect.width,
            0,
            1,
          );
          c.picture.y = clamp(
            c.picture.y + (e.clientY - g.y) / rect.height,
            0,
            1,
          );
        } else if (g.mode.startsWith("crop_")) {
          const source = g.project.sources.find(s => s.id === c.source_id)!;
          const b = box(g.project,c,source), theta = -(c.picture.rotation ?? 0)*Math.PI/180;
          const dx=e.clientX-g.x, dy=e.clientY-g.y;
          const sx=(dx*Math.cos(theta)-dy*Math.sin(theta))/(b.width*rect.width)*b.sw/source.width;
          const sy=(dx*Math.sin(theta)+dy*Math.cos(theta))/(b.height*rect.height)*b.sh/source.height;
          const crop = [...(c.picture.crop ?? [0,0,0,0])] as [number,number,number,number];
          let index = ({crop_l:0,crop_t:1,crop_r:2,crop_b:3} as Record<string,number>)[g.mode];
          const flip = index%2===0 ? c.picture.flip_x : c.picture.flip_y;
          if(flip) index=(index+2)%4;
          const delta=(index%2===0?sx:sy)*(flip?-1:1)*(index<2?1:-1);
          crop[index]=clamp(crop[index]+delta,0,.98-crop[(index+2)%4]); c.picture.crop=crop;
        } else
          c.picture.scale = clamp(
            c.picture.scale + ((e.clientX - g.x) / rect.width) * 2,
            0.1,
            2,
          );
      }),
    );
  };
  const up = () => {
    gesture.current = null;
    useWorkshopStore.getState().commit();
  };
  return (
    <div className="vj-preview" ref={container}>
      <div
        ref={surface}
        className="vj-preview-surface"
        role="img"
        aria-label="作品合成预览"
        style={{
          width: Math.max(
            1,
            Math.min(
              available.width,
              (available.height * project.canvas.width) / project.canvas.height,
            ),
          ),
          aspectRatio: `${project.canvas.width}/${project.canvas.height}`,
        }}
        onPointerDown={() => { if (editable) useWorkshopStore.getState().select(null); }}
      >
        {prepared.flatMap((c) => {
          const s = project.sources.find((s) => s.id === c.source_id)!,
            proxy = Boolean(
              !trimPreview &&
              playback.ticket &&
              // Native muted video can play a constant rate continuously. Only
              // speed curves need retimed chunks; reloading every 8 s flashes black.
              c.speed.preset !== "constant",
            ),
            part = Math.max(0, Math.floor((position - c.start_ms) / 8000));
          const zIndex = project.layers.length - project.layers.findIndex(l => l.source_id === c.source_id && l.clips.some(v => v.id === c.id));
          if (isImageSource(s)) return <WorkshopImage key={`${c.id}:${retryVersion}`} onError={message => setErrors(old => ({...old,[`${c.id}:raw`]:message}))} onReady={() => clearError(`${c.id}:raw`)} project={project} clip={c} source={s} playback={playback} inspect={trimPreview?.edge} zIndex={zIndex} />;
          const parts = proxy && playback.playing && position - c.start_ms >= (part + 1) * 8000 - 1000 && (part + 1) * 8000 < clipDuration(c) ? [part, part + 1] : [part];
          return parts.map(part => {
            const slot = `${c.id}:${proxy ? part : "raw"}`;
            const url = proxy ? api.workshopVideoUrl(playback.ticket!, c.id, part) : api.videoUrl(s.track_id, compat.has(s.id));
            return (
            <PreviewVideoPair
              key={`${slot}:${url}:${retryVersion}`}
              synchronizer={sync.current}
              register={(node, correct) => {
                corrections.current.set(node, correct);
                videos.current.set(slot, node); wake.current();
                return () => { corrections.current.delete(node); wanted.current.set(node, false); sync.current.releaseClock(node); if (videos.current.get(slot) === node) videos.current.delete(slot); clearError(slot); };
              }}
              onLoadedData={() => { clearError(slot); wake.current(); }}
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = proxy || trimPreview || c.speed.preset !== "constant" ? 1 : c.speed.start;
                wake.current();
              }}
              onSeeked={() => { wake.current(); }}
              data-clip={c.id}
              data-proxy={proxy}
              data-part={part}
              src={url}
              style={{opacity: 0, zIndex}}
              muted
              playsInline
              preload="auto"
              aria-hidden="true"
              onError={() => {
                if (!proxy && !compat.has(s.id))
                  setCompat((old) => new Set([...old, s.id]));
                else setErrors(old => ({...old, [slot]: `${s.title} 无法预览`}));
              }}
            />
          ); });
        })}
        {!trimPreview &&
          active.map((c) => {
            const s = project.sources.find((s) => s.id === c.source_id)!,
              b = box(project, c, s);
            return (
              <div
                key={c.id}
                className="vj-picture-hit"
                data-clip-id={c.id}
                style={{
                  zIndex: project.layers.length + 1,
                  transform: `rotate(${b.rotation}deg)`,
                  left: `${b.x * 100}%`,
                  top: `${b.y * 100}%`,
                  width: `${b.width * 100}%`,
                  height: `${b.height * 100}%`,
                  pointerEvents:
                    fadeAlpha(c, position - c.start_ms) * c.picture.opacity > 0
                      ? "auto"
                      : "none",
                }}
                onPointerDown={(e) => {
                  if (!editable) return;
                  e.stopPropagation();
                  useWorkshopStore.getState().select(c.id);
                }}
              />
            );
          })}
        {bounds && (
          <div
            className="vj-picture-selection"
            data-clip-id={selectedClip?.id}
            style={{
              zIndex: project.layers.length + 2,
              transform: `rotate(${bounds.rotation}deg)`,
              left: `${bounds.x * 100}%`,
              top: `${bounds.y * 100}%`,
              width: `${bounds.width * 100}%`,
              height: `${bounds.height * 100}%`,
            }}
            onPointerDown={(e) => down(e, "move")}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              gesture.current = null;
              useWorkshopStore.getState().abort();
            }}
          >
            {cropId === selectedClip?.id && (["crop_l","crop_t","crop_r","crop_b"] as const).map((mode,index) => <div key={mode} role="button" aria-label={["裁剪左边","裁剪上边","裁剪右边","裁剪下边"][index]} className={`vj-crop-edge ${mode}`} onPointerDown={e => down(e,mode)} onPointerMove={move} onPointerUp={up} />)}
            <div
              role="button"
              aria-label="缩放选中画面"
              className="vj-resize"
              onPointerDown={(e) => down(e, "scale")}
              onPointerMove={move}
              onPointerUp={up}
            />
          </div>
        )}
      </div>
      {(error || playback.error) && (
        <div className="vj-error" role="status">
          {error || playback.error}
          {error && <button type="button" onClick={() => setRetryVersion(v => v + 1)}>重试</button>}
        </div>
      )}
    </div>
  );
}
