import { WorkshopImage } from "./WorkshopImage";
import { pictureBox as box, pictureResizeEdges, resizePictureLayout, type PictureResizeEdge } from "../../lib/workshopPicture";
import { isVisualSource, isImageSource } from "../../lib/workshop";
import { useEffect, useMemo, useRef, useState } from "react";
import { videoProject } from "../../lib/workshopTransitions";
import { api } from "../../lib/api";
import { captureDiagnostic, mediaDiagnostic } from "../../lib/diagnostics";
import { useWorkshopStore } from "../../stores/workshopStore";
import {
  clamp,
  clipDuration,
  fadeAlpha,
  findClip,
  updateClip,
} from "../../lib/workshop";
import { configurePictureVideo, VideoPlaybackEngine } from "../../lib/videoPlaybackEngine";
import { getLocalVideoClock } from "../../lib/mediaSync";
import { prepareVideoClips, previewVideoTiming, WorkshopSeekGate, registerWorkshopPlaybackAcquirer } from "../../lib/workshopPreviewPolicy";
import type { WorkshopPlayback } from "../../lib/workshopPlayback";
import { requestWorkshopFolderAccess, workshopAccessDirectory } from "../../lib/workshopFolderAccess";
import type {
  CompositionProject,
} from "../../types/workshop";
const pictureEdgeLabels: Record<PictureResizeEdge, string> = { nw: "左上角", n: "上边", ne: "右上角", e: "右边", se: "右下角", s: "下边", sw: "左下角", w: "左边" };

function PreviewVideo({ register, src, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & { register(node: HTMLVideoElement): () => void }) {
  const node = useRef<HTMLVideoElement>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  useEffect(() => {
    const video = node.current;
    if (!video) return;
    // React StrictMode replays effects after cleanup without replacing the DOM.
    // Restore the source that cleanup unloaded, or the second mount stays black.
    configurePictureVideo(video);
    if (src && video.getAttribute("src") !== src) { video.src = src; video.load(); }
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
    attempts.current = 0;
    props.onLoadedData?.(event);
  }} onError={event => {
    if (!event.currentTarget.getAttribute("src") || retry.current !== null) return;
    if (attempts.current >= 2) { props.onError?.(event); return; }
    const video = event.currentTarget;
    retry.current = setTimeout(() => {
      retry.current = null;
      video.load();
    }, ++attempts.current * 400);
  }} />;
}
function waitForPreviewMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (video.readyState >= 1) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
      resolve(ready);
    };
    const loaded = () => finish(true), failed = () => finish(false);
    const timer = setTimeout(failed, 4000);
    video.addEventListener("loadedmetadata", loaded, {once: true});
    video.addEventListener("error", failed, {once: true});
    signal.addEventListener("abort", failed, {once: true});
  });
}
function PreviewVideoPair({ synchronizer, alignmentOwner, register, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & {
  synchronizer: VideoPlaybackEngine;
  alignmentOwner: React.MutableRefObject<AbortController | null>;
  register(node: HTMLVideoElement, correct: () => void): () => void;
}) {
  const nodes = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const active = useRef(0), generation = useRef(0);
  const preparation = useRef<AbortController | null>(null);
  const unregister = useRef<(() => void) | null>(null);
  const denied = useRef(new WeakSet<HTMLVideoElement>());
  const priming = useRef(new WeakSet<HTMLVideoElement>());
  const retryAt = useRef(0), retryDelay = useRef(5000);
  const unload = (node: HTMLVideoElement) => {
    synchronizer.releaseClock(node);
    node.pause();
    if (node.hasAttribute("src")) { node.removeAttribute("src"); node.load(); }
  };
  useEffect(() => registerWorkshopPlaybackAcquirer(() => {
    const spare = nodes.current[1 - active.current];
    const source = props.src ?? nodes.current[active.current]?.currentSrc;
    if (!spare || !source || priming.current.has(spare) || preparation.current) return;
    denied.current.delete(spare);
    retryAt.current = 0; retryDelay.current = 5000;
    // WebKit grants permission per element. Authorize the parked spare in the
    // real click too, then release its decoder; do not keep two streams running.
    configurePictureVideo(spare);
    priming.current.add(spare);
    spare.src = source;
    spare.load();
    void spare.play().then(() => {
      captureDiagnostic("playback", "workshop.video.spare-gesture", "Spare playback acquired during a user gesture", mediaDiagnostic(spare), "info");
    }).catch(error => {
      if (!nodes.current.includes(spare) || error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError") denied.current.add(spare);
      captureDiagnostic("playback", "workshop.video.spare-gesture", error, mediaDiagnostic(spare));
    }).finally(() => {
      priming.current.delete(spare);
      if (nodes.current.includes(spare) && nodes.current[active.current] !== spare && !preparation.current) unload(spare);
    });
  }), []);
  const correct = () => {
    const old = nodes.current[active.current], next = nodes.current[1 - active.current];
    const owner = generation.current;
    if (!old || !next || alignmentOwner.current || denied.current.has(next) || priming.current.has(next) || performance.now() < retryAt.current) return;
    const controller = new AbortController();
    preparation.current = alignmentOwner.current = controller;
    const isCurrent = () => !controller.signal.aborted && owner === generation.current && nodes.current[active.current] === old;
    // The spare owns no source/decoder until correction is actually needed.
    // Serialize temporary spares across layers; steady playback needs one decoder
    // per prepared picture, not two full-resolution HEVC streams per clip.
    configurePictureVideo(next);
    next.src = props.src ?? old.currentSrc;
    next.load();
    let adopted = false;
    void (async () => {
      if (!await waitForPreviewMetadata(next, controller.signal) || !isCurrent()) return;
      adopted = await synchronizer.alignStandby(old, next, isCurrent, () => {
        if (!isCurrent()) return false;
        next.style.cssText = old.style.cssText;
        old.style.opacity = '0';
        active.current = 1 - active.current;
        unregister.current?.();
        unregister.current = register(next, correct);
        old.pause();
        return true;
      }, error => {
        if (isCurrent() && typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError") denied.current.add(next);
      });
    })().finally(() => {
      if (adopted) { retryAt.current = 0; retryDelay.current = 5000; }
      else if (isCurrent()) {
        retryAt.current = performance.now() + retryDelay.current;
        retryDelay.current = Math.min(60_000, retryDelay.current * 2);
      }
      for (const node of [old, next]) {
        if (nodes.current.includes(node) && nodes.current[active.current] !== node) unload(node);
      }
      if (preparation.current === controller) preparation.current = null;
      if (alignmentOwner.current === controller) alignmentOwner.current = null;
    }).catch(() => {});
  };
  // URL changes remount the pair. After adoption the pair, not React, owns src;
  // keeping the initial slot props stable avoids reloading the former decoder.
  return <>{([0, 1] as const).map(slot => <PreviewVideo {...props} src={slot === 0 ? props.src : undefined} key={slot} register={node => {
    nodes.current[slot] = node;
    if (slot === active.current) unregister.current = register(node, correct);
    return () => {
      preparation.current?.abort();
      generation.current++;
      nodes.current[slot] = null;
      if (slot === active.current) { unregister.current?.(); unregister.current = null; }
      synchronizer.releaseClock(node);
    };
  }} onError={event => { if (slot === active.current) props.onError?.(event); }} />)}</>;
}
export function WorkshopPreview({ playback, editable = true }: { playback: WorkshopPlayback; editable?: boolean }) {
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
  const alignmentOwner = useRef<AbortController | null>(null);
  const wake = useRef<() => void>(() => {}), seekGate = useRef(new WorkshopSeekGate());
  const [compat, setCompat] = useState<Set<string>>(() => new Set()),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [retryVersion, setRetryVersion] = useState(0);
  const clearError = (slot: string) => setErrors(old => {
    if (!(slot in old)) return old;
    const next = {...old}; delete next[slot]; return next;
  });
  const visual = useMemo(() => project ? videoProject(project) : null, [project]);
  const previewProject = trimPreview ? project : visual;
  const pictures = useMemo(() => {
    const sources = new Map(previewProject?.sources.map(s => [s.id, s]));
    return new Map(previewProject?.layers.flatMap(l => l.clips.flatMap(c => {
      const source = sources.get(c.source_id);
      if (!source || !isVisualSource(source)) return [];
      const geometry = box(previewProject!, trimPreview
        ? {...c, picture: {...c.picture, x: .5, y: .5, scale: 1, opacity: 1}} : c, source);
      return [[c.id, { clip: c, source, geometry }] as const];
    })));
  }, [previewProject, Boolean(trimPreview)]);
  const stack = useMemo(() => [...(project?.layers ?? [])].reverse()
    .flatMap(l => [...l.clips].sort((a, b) => a.start_ms - b.start_ms)), [project]);
  const stackOrder = useMemo(() => new Map(stack.map((c, i) => [c.id, i + 1])), [stack]);
  const latest = useRef({ project, visual, playback, trimPreview, pictures });
  latest.current = { project, visual, playback, trimPreview, pictures };
  const accessDirectory = workshopAccessDirectory(playback.error);
  const [authorizing, setAuthorizing] = useState(false);
  const [accessError, setAccessError] = useState("");
  const accessRequest = useRef(0);
  useEffect(() => () => { accessRequest.current++; }, []);
  const authorize = async (manual = false) => {
    const pickFolder = window.kdj?.pickFolder;
    if (!accessDirectory || !pickFolder || !project) return;
    const request = ++accessRequest.current;
    const owner = project.id, revision = project.revision, failure = playback.error;
    const isCurrent = () => accessRequest.current === request && latest.current.project?.id === owner
      && latest.current.project.revision === revision && latest.current.playback.error === failure;
    setAuthorizing(true);
    setAccessError("");
    try {
      const folder = await requestWorkshopFolderAccess(accessDirectory, pickFolder, manual);
      if (folder && isCurrent()) {
        latest.current.playback.retry();
        setRetryVersion(v => v + 1);
      }
    } catch (e) {
      if (isCurrent()) setAccessError(String(e));
    } finally {
      if (accessRequest.current === request) setAuthorizing(false);
    }
  };
  useEffect(() => {
    void authorize();
  }, [accessDirectory, project?.id, project?.revision]);
  const gesture = useRef<{
    x: number;
    y: number;
    edge?: PictureResizeEdge;
    id: string;
    rect: DOMRect;
    started: boolean;
    project: CompositionProject;
  } | null>(null);
  useEffect(() => () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.started && useWorkshopStore.getState().draft?.id === g.project.id) useWorkshopStore.getState().abort();
  }, [project?.id, editable]);
  const trimClip =
    project && trimPreview ? findClip(project, trimPreview.clipId) : null;
  const hiddenLayers = project ? hiddenVideoLayers[project.id] ?? [] : [];
  const active = trimClip
    ? [trimClip]
    : (visual?.layers.slice().reverse()
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
        ) ?? []);
  const prepared = trimClip ? [trimClip] : visual ? prepareVideoClips(visual, position, hiddenLayers, playback.playing) : [];
  const error = active.map(c => {
    const proxy = !trimPreview && playback.ticket && c.speed.preset !== "constant";
    const part = Math.max(0, Math.floor((position - c.start_ms) / 8000));
    return errors[`${c.id}:${proxy ? part : "raw"}`];
  }).find(Boolean);
  useEffect(() => {
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let lastSync = -Infinity, lastTick = -Infinity;
    const layouts = new WeakMap<HTMLVideoElement, ReturnType<typeof box>>();
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      frame = 0;
      const { project, visual, playback: pb, trimPreview: inspecting, pictures } = latest.current;
      const p = inspecting ? project : visual;
      if (!p || document.hidden) return;
      const state = useWorkshopStore.getState();
      const playing = pb.playing && !pb.pendingSeek?.() && !inspecting && !state.scrubbing && !state.gesture;
      if (playing && now - lastTick < 1000 / 30) { schedule(); return; }
      lastTick = now;
      const time = pb.time(), align = !playing || now - lastSync >= 100;
      if (align) lastSync = now;
      let retry = false;
      const authority = align ? (pb.clock ? pb.clock() : pb.trackId !== null ? getLocalVideoClock(pb.trackId) : null) : null;
      // Video layers are composed by WebKit. No per-frame pixel copies to a
      // canvas, and no full-resolution readback onto the JavaScript thread.
      for (const video of videos.current.values()) {
        const picture = pictures.get(video.dataset.clip ?? "");
        if (!picture?.source.video) continue;
        const { clip: c, source: s, geometry: b } = picture;
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
          void video.play().then(() => { if (!wanted.current.get(video)) video.pause(); }).catch(error => {
            if (!wanted.current.get(video) || error?.name === "AbortError") return;
            captureDiagnostic("playback", "workshop.video.play", error, mediaDiagnostic(video));
            const slot = [...videos.current].find(([, node]) => node === video)?.[0];
            if (slot) {
              const message = `${s.title} 无法播放`;
              setErrors(old => old[slot] === message ? old : {...old, [slot]: message});
            }
          }).finally(() => pending.current.delete(video));
        }
        // Geometry changes with edits, not with the audio clock. Do not dirty
        // layout/clip-path on every frame of an otherwise unchanged video.
        if (layouts.get(video) !== b) {
          layouts.set(video, b);
          video.style.left = `${(b.x + b.mediaX * b.width) * 100}%`; video.style.top = `${(b.y + b.mediaY * b.height) * 100}%`;
          video.style.width = `${b.width * b.mediaWidth * 100}%`; video.style.height = `${b.height * b.mediaHeight * 100}%`;
          video.style.clipPath = b.clipPath;
        }
        const opacity = String(!visible ? 0 : inspecting ? 1 : c.picture.opacity * fadeAlpha(c, local));
        if (video.style.opacity !== opacity) video.style.opacity = opacity;
        if (video.readyState >= 2) decoded.current.add(video);
        // WebKit can temporarily drop readyState during a corrective seek.
        // Keep its last decoded frame visible while ordinary playback catches up.
        const retained = shouldPlay && video.seeking && decoded.current.has(video);
        const visibility = retained || (video.readyState >= 2 && (!video.seeking || shouldPlay)) ? "visible" : "hidden";
        if (video.style.visibility !== visibility) video.style.visibility = visibility;
      }
      if (playing) schedule();
      else if (retry) { clearTimeout(timer); timer = setTimeout(schedule, 80); }
    };
    wake.current = schedule;
    const acquirePlayback = () => {
      // Low-power/media policies can require a real user gesture even for muted
      // pictures. Acquire it synchronously, not after async audio preparation.
      for (const video of videos.current.values()) {
        if (!video.hasAttribute("src")) continue;
        configurePictureVideo(video);
        pending.current.add(video);
        void video.play().then(() => {
          captureDiagnostic("playback", "workshop.video.gesture", "Picture playback acquired during a user gesture", mediaDiagnostic(video), "info");
          if (!wanted.current.get(video)) video.pause();
        }).catch(error => {
          captureDiagnostic("playback", "workshop.video.gesture", error, mediaDiagnostic(video));
        }).finally(() => { pending.current.delete(video); schedule(); });
      }
    };
    const releasePlaybackAcquirer = registerWorkshopPlaybackAcquirer(acquirePlayback);
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
      releasePlaybackAcquirer();
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
  const down = (e: React.PointerEvent<HTMLDivElement>, id: string, edge?: PictureResizeEdge) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!editable || e.button !== 0 || !rect?.width || !rect.height) return;
    e.stopPropagation();
    e.preventDefault();
    const store = useWorkshopStore.getState();
    if (store.selectedId !== id) store.select(id);
    gesture.current = { x: e.clientX, y: e.clientY, edge, id, rect, started: false, project };
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || useWorkshopStore.getState().draft?.id !== g.project.id) return;
    if (!g.started) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 2) return;
      g.started = true;
      useWorkshopStore.getState().begin();
    }
    const dx = (e.clientX - g.x) / g.rect.width, dy = (e.clientY - g.y) / g.rect.height;
    useWorkshopStore.getState().transient(updateClip(g.project, g.id, c => {
      const source = g.project.sources.find(s => s.id === c.source_id)!;
      if (g.edge) Object.assign(c.picture, resizePictureLayout(g.project, c, source, g.edge,
        dx * g.project.canvas.width, dy * g.project.canvas.height, e.altKey));
      else {
        const b = box(g.project, c, source);
        c.picture.x = clamp(b.x + b.width / 2 + dx, 0, 1);
        c.picture.y = clamp(b.y + b.height / 2 + dy, 0, 1);
      }
    }));
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.started) useWorkshopStore.getState().commit();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const cancel = () => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.started) useWorkshopStore.getState().abort();
  };
  const keyPicture = (e: React.KeyboardEvent<HTMLDivElement>, id: string, edge?: PictureResizeEdge) => {
    if (e.key === "Escape" && gesture.current) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || gesture.current) return;
    e.preventDefault(); e.stopPropagation();
    const store = useWorkshopStore.getState();
    if (store.selectedId !== id) store.select(id);
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
    const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
    useWorkshopStore.getState().edit(p => updateClip(p, id, c => {
      const source = p.sources.find(s => s.id === c.source_id)!;
      if (edge) Object.assign(c.picture, resizePictureLayout(p, c, source, edge, dx, dy, e.altKey));
      else {
        const b = box(p, c, source);
        c.picture.x = clamp(b.x + b.width / 2 + dx / p.canvas.width, 0, 1);
        c.picture.y = clamp(b.y + b.height / 2 + dy / p.canvas.height, 0, 1);
      }
    }));
  };
  return (
    <div className="vj-preview" ref={container}>
      <div
        ref={surface}
        className="vj-preview-surface"
        role="group"
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
        {/* Keep decoder DOM order independent of layer order. Moving an active
            video node can stall WKWebView; z-index alone owns layer stacking.
            Within a track, incoming clips cover outgoing clips across sources too. */}
        {[...prepared].sort((a, b) => a.source_id.localeCompare(b.source_id)
          || a.start_ms - b.start_ms || a.id.localeCompare(b.id)).flatMap((c) => {
          const s = project.sources.find((s) => s.id === c.source_id)!,
            proxy = Boolean(
              !trimPreview &&
              playback.ticket &&
              // Native muted video can play a constant rate continuously. Only
              // speed curves need retimed chunks; reloading every 8 s flashes black.
              c.speed.preset !== "constant",
            ),
            part = Math.max(0, Math.floor((position - c.start_ms) / 8000));
          const zIndex = stackOrder.get(c.id) ?? 0;
          if (isImageSource(s)) return <WorkshopImage key={`${c.id}:${retryVersion}`} onError={message => setErrors(old => ({...old,[`${c.id}:raw`]:message}))} onReady={() => clearError(`${c.id}:raw`)} project={project} clip={c} source={s} playback={playback} inspect={trimPreview?.edge} zIndex={zIndex} />;
          const parts = proxy && playback.playing && position - c.start_ms >= (part + 1) * 8000 - 1000 && (part + 1) * 8000 < clipDuration(c) ? [part, part + 1] : [part];
          return parts.map(part => {
            const slot = `${c.id}:${proxy ? part : "raw"}`;
            const url = proxy ? api.workshopVideoUrl(playback.ticket!, c.id, part) : api.videoUrl(s.track_id, compat.has(s.id));
            return (
            <PreviewVideoPair
              key={`${slot}:${url}:${retryVersion}`}
              synchronizer={sync.current}
              alignmentOwner={alignmentOwner}
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
              onCanPlay={() => { wake.current(); }}
              onPlaying={() => { clearError(slot); wake.current(); }}
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
                  zIndex: stack.length + 1,
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
                tabIndex={editable ? 0 : undefined}
                role={editable ? "button" : undefined}
                aria-label={editable ? `移动画面：${s.title}` : undefined}
                onPointerDown={e => down(e, c.id)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
                onKeyDown={e => keyPicture(e, c.id)}
              />
            );
          })}
        {bounds && (
          <div
            className="vj-picture-selection"
            data-clip-id={selectedClip?.id}
            style={{
              zIndex: stack.length + 2,
              transform: `rotate(${bounds.rotation}deg)`,
              left: `${bounds.x * 100}%`,
              top: `${bounds.y * 100}%`,
              width: `${bounds.width * 100}%`,
              height: `${bounds.height * 100}%`,
            }}
            role="group"
            tabIndex={0}
            aria-label="画面布局"
            onPointerDown={e => down(e, selectedClip!.id)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onKeyDown={e => keyPicture(e, selectedClip!.id)}
          >
            {pictureResizeEdges.map(edge => <div key={edge} role="button" tabIndex={0}
              aria-label={`缩放画面：${pictureEdgeLabels[edge]}`} className="vj-resize" data-edge={edge}
              onPointerDown={e => down(e, selectedClip!.id, edge)}
              onKeyDown={e => keyPicture(e, selectedClip!.id, edge)} />)}
          </div>
        )}
      </div>
      {(error || playback.error) && (
        <div className="vj-error" role="status">
          {accessError || playback.error || error}
          {accessDirectory && typeof window.kdj?.pickFolder === "function" && (
            <button type="button" disabled={authorizing} onClick={() => { void authorize(true); }}>授权文件夹</button>
          )}
          {error && <button type="button" onClick={() => setRetryVersion(v => v + 1)}>重试</button>}
        </div>
      )}
    </div>
  );
}
