import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { overlayAlpha, compositionUsesSections, compositionSectionVideoTime } from "../../lib/composition";
import { getCompositionClock, useCompositionClock, type CompositionClock, type CompositionSegment } from "../../lib/compositionPlayback";
import { VideoPlaybackEngine } from "../../lib/videoPlaybackEngine";
import type { LocalVideoClock } from "../../lib/mediaSync";
import type { CompositionTask, OverlayOptions } from "../../types/composition";
import { InlineNotice } from "../common";

export interface OverlayPreviewProps {
  task: CompositionTask;
  /** Raw placement of source zero, in milliseconds (not the trimmed segment start). */
  offset: number;
  options: OverlayOptions;
  disabled: boolean;
  segment?: CompositionSegment;
  /** Auditioning the secondary source in the main player also drives the composite. */
  followSecondary?: boolean;
  onPosition(x: number, y: number): void;
}

// Key the media subtree to discard codec fallback, pending play promises and geometry on replacement.
export function OverlayPreview(props: OverlayPreviewProps) {
  return <OverlayPreviewMedia key={`${props.task.id}:${props.task.video?.track_id}:${props.task.audio?.track_id}`} {...props} />;
}

function OverlayPreviewMedia({ task, offset, options, disabled, segment, followSecondary = true, onPosition }: OverlayPreviewProps) {
  const main = useRef<HTMLVideoElement>(null), inset = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const clock = useCompositionClock();
  const [shape, setShape] = useState({ w: 16, h: 9, aspect: 16 / 9 });
  const [error, setError] = useState("");
  const [decodedRevision, setDecodedRevision] = useState(0);
  const repaint = () => setDecodedRevision((revision) => revision + 1);
  const [compatibleMain, setCompatibleMain] = useState(false), [compatibleInset, setCompatibleInset] = useState(false);
  const pendingPlay = useRef(new WeakSet<HTMLVideoElement>());
  const shouldPlay = useRef(new WeakMap<HTMLVideoElement, boolean>());
  const synchronizer = useRef(new VideoPlaybackEngine());
  const lastTime = useRef(0);
  const lastGeometry = useRef("");
  const visibleMedia = useRef(new WeakMap<HTMLVideoElement, boolean>());
  const mainId = task.video?.track_id, insetId = task.audio?.track_id;
  const rawOffset = Number.isFinite(offset) ? offset / 1000 : 0;
  const mapped = compositionUsesSections(task);
  const mappedTime = (audioTime: number) => {
    if (audioTime < sourceStart || audioTime >= sourceEnd) return -1;
    const position = compositionSectionVideoTime(task, audioTime * 1000);
    return position === null ? -1 : position / 1000;
  };
  const duration = (task.video_duration_ms ?? task.video?.duration_ms ?? 0) / 1000;
  const clipDuration = (task.audio_duration_ms ?? task.audio?.duration_ms ?? 0) / 1000;
  const sourceStart = (segment?.source_start_ms ?? 0) / 1000;
  const sourceEnd = segment?.source_end_ms == null ? clipDuration : segment.source_end_ms / 1000;
  const start = Math.max(0, rawOffset + sourceStart), end = Math.min(duration, rawOffset + sourceEnd);
  const follows = (state: CompositionClock) => state.ready &&
    (state.trackId === mainId || (followSecondary && state.trackId === insetId));
  const mainTime = (state: CompositionClock) => state.trackId === mainId ? state.currentTime : mapped ? mappedTime(state.currentTime) : state.currentTime + rawOffset;
  const time = follows(clock) ? mainTime(clock) : lastTime.current;
  const alpha = overlayAlpha(time, start, end, options.opacity, options.fade_ms);
  const width = Math.min(shape.w * options.scale, shape.h * shape.aspect) / shape.w;
  const height = width * shape.w / shape.aspect / shape.h;
  const x = Math.max(0, Math.min(1 - width, options.x - width / 2));
  const y = Math.max(0, Math.min(1 - height, options.y - height / 2));
  const drag = useRef<{ pointer: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    const canvas = preview.current, video = main.current, overlay = inset.current;
    if (!canvas || !video) return;
    const context = canvas.getContext("2d"); if (!context) return;
    let frame = 0;
    const syncVideo = (element: HTMLVideoElement, target: number, inside: boolean, authority: LocalVideoClock | null) => {
      element.muted = true;
      const rate = authority?.rate ?? 0;
      // Reverse/scratch and rates unsupported by HTML media remain clock-driven still frames.
      const playableRate = Number.isFinite(rate) && rate >= 0.0625 && rate <= 16;
      const play = authority !== null && authority.playing && inside && playableRate;
      shouldPlay.current.set(element, play);
      if (!play) element.pause();
      // Loading and unrelated selections retain the last decoded frame. Hidden parts of a trim
      // do not keep seeking either; the first visible frame gets one authority alignment.
      if (!authority) return;
      if (!inside) { visibleMedia.current.set(element, false); return; }
      if (visibleMedia.current.get(element) === false) synchronizer.current.releaseClock(element);
      visibleMedia.current.set(element, true);
      if (Number.isFinite(target)) {
        const bounded = Math.max(0, Math.min(target, Number.isFinite(element.duration) ? element.duration : target));
        synchronizer.current.followClock(element, { ...authority, position: bounded, playing: play }, (video, position) => {
          void synchronizer.current.seek(video, position).catch(() => undefined);
        });
      }
      if (play && element.paused && element.readyState >= 2 && !pendingPlay.current.has(element)) {
        pendingPlay.current.add(element);
        void element.play().then(() => {
          if (!shouldPlay.current.get(element)) element.pause();
        }).catch((cause: unknown) => {
          if (shouldPlay.current.get(element) && !(cause instanceof DOMException && cause.name === "AbortError")) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }).finally(() => pendingPlay.current.delete(element));
      }
    };
    const draw = () => {
      // The videos never supply a clock; even repaint frames read the real main player.
      const state = getCompositionClock();
      const active = state.ready && (state.trackId === mainId || (followSecondary && state.trackId === insetId));
      const now = active ? mainTime(state) : lastTime.current;
      if (active) lastTime.current = now;
      const geometry = `${rawOffset}:${start}:${end}:${mapped}:${JSON.stringify(task.video_sections)}`;
      if (lastGeometry.current !== geometry) { synchronizer.current.reset(); lastGeometry.current = geometry; }
      const authority: LocalVideoClock | null = active && state.trackId !== null ? {
        trackId: state.trackId, sourceId: state.sourceId ?? 0, discontinuityRevision: state.discontinuityRevision,
        loopGeneration: state.loopGeneration, loopWrapCount: state.loopWrapCount,
        position: now, rate: state.rate, playing: state.playing, fresh: state.fresh,
      } : null;
      const insideMain = now >= 0 && now < duration;
      const insideOverlay = now >= start && now < end;
      const running = active && state.playing;
      syncVideo(video, now, insideMain, authority);
      // Offset always refers to source zero, including when the source is trimmed.
      if (overlay) syncVideo(overlay, now - rawOffset, insideOverlay, authority);
      const w = canvas.width, h = canvas.height;
      context.globalAlpha = 1; context.fillStyle = "#000"; context.fillRect(0, 0, w, h);
      if (insideMain && video.readyState >= 2) context.drawImage(video, 0, 0, w, h);
      const opacity = overlayAlpha(now, start, end, options.opacity, options.fade_ms);
      if (opacity > 0 && overlay && overlay.readyState >= 2) {
        context.globalAlpha = opacity; context.drawImage(overlay, x * w, y * h, width * w, height * h);
        context.globalAlpha = 1;
      }
      if (running) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [clock, mainId, insetId, rawOffset, start, end, sourceStart, sourceEnd, duration, mapped, task.video_sections, followSecondary, options.opacity, options.fade_ms, x, y, width, height, shape, decodedRevision, compatibleMain, compatibleInset]);

  useEffect(() => {
    const video = main.current, overlay = inset.current;
    const wanted = shouldPlay.current;
    return () => {
      synchronizer.current.dispose();
      for (const element of [video, overlay]) {
        if (element) { wanted.set(element, false); element.pause(); }
      }
    };
  }, []);

  if (!task.video) return null;
  return <div className="kd-composition-preview">
    <div ref={surface} className="kd-composition-preview-surface" style={{ aspectRatio: `${shape.w} / ${shape.h}` }}>
      <video ref={main} src={api.videoUrl(task.video.track_id, compatibleMain)} poster={api.coverUrl(task.video.track_id)} muted playsInline preload="auto"
        aria-hidden="true" onLoadedData={repaint} onSeeked={repaint}
        onLoadedMetadata={() => { const v = main.current!; setShape((old) => ({ ...old, w: v.videoWidth || 16, h: v.videoHeight || 9 })); }}
        onError={() => { if (!compatibleMain) setCompatibleMain(true); else setError("主视频暂时无法预览"); }} />
      {task.audio?.is_video && <video ref={inset} src={api.videoUrl(task.audio.track_id, compatibleInset)} poster={api.coverUrl(task.audio.track_id)} muted playsInline preload="auto"
        aria-hidden="true" onLoadedData={repaint} onSeeked={repaint}
        onLoadedMetadata={() => { const v = inset.current!; setShape((old) => ({ ...old, aspect: v.videoWidth / v.videoHeight || 16 / 9 })); }}
        onError={() => { if (!compatibleInset) setCompatibleInset(true); else setError("叠加视频暂时无法预览"); }} />}
      <canvas ref={preview} width={Math.min(640, shape.w)} height={Math.round(Math.min(640, shape.w) * shape.h / shape.w)} aria-label={task.audio?.is_video ? "视频叠加预览" : "主视频预览"} />
      {task.audio?.is_video && <div className="kd-composition-preview-inset" aria-label="叠加视频位置"
        style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`, visibility: alpha > 0 ? "visible" : "hidden", cursor: disabled ? "default" : "move" }}
        onPointerDown={(event) => {
          if (disabled) return;
          const bounds = surface.current!.getBoundingClientRect();
          drag.current = { pointer: event.pointerId, dx: (event.clientX - bounds.left) / bounds.width - options.x, dy: (event.clientY - bounds.top) / bounds.height - options.y };
          event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
        }}
        onPointerMove={(event) => {
          const current = drag.current; if (disabled || !current || current.pointer !== event.pointerId) return;
          const bounds = surface.current!.getBoundingClientRect();
          onPosition(Math.max(width / 2, Math.min(1 - width / 2, (event.clientX - bounds.left) / bounds.width - current.dx)), Math.max(height / 2, Math.min(1 - height / 2, (event.clientY - bounds.top) / bounds.height - current.dy)));
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />}
    </div>
    <InlineNotice text={error} onDismiss={() => setError("")} block />
  </div>;
}
