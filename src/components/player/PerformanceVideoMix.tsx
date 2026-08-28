import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "../../lib/api";
import { isVideoTrack } from "../../lib/format";
import { LocalVideoSynchronizer } from "../../lib/localVideoSync";
import { mediaUrlForTrack } from "../../lib/streamTrack";
import {
  clampVideoFloatBox,
  clampVideoFloatWidth,
  videoFloatHeight,
  type VideoFloatBox,
} from "../../lib/videoFloatBox";
import { vjMixSourceOverAlphas, vjMixWeights } from "../../lib/vjMix";
import type { Track } from "../../types";

export type PerformanceVideoRefs = MutableRefObject<[
  HTMLVideoElement | null,
  HTMLVideoElement | null,
]>;

export interface PerformanceVideoDeckState {
  track: Track | null;
  position: number;
  rate: number;
  playing: boolean;
  transportRunning: boolean;
  scratchHeld: boolean;
  discontinuityRevision: number;
}

function sourceForTrack(track: Track, compatible: boolean): string {
  return track.id >= 0 ? api.videoUrl(track.id, compatible) : mediaUrlForTrack(track);
}

/** Muted picture follower for one native audio Deck. The Rust callback remains the clock owner. */
export function PerformanceDeckVideo({
  deck,
  side,
  videoRefs,
}: {
  deck: PerformanceVideoDeckState;
  side: 0 | 1;
  videoRefs: PerformanceVideoRefs;
}) {
  const track = deck.track;
  const videoTrack = Boolean(track && isVideoTrack(track.format));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const synchronizerRef = useRef<LocalVideoSynchronizer | null>(null);
  if (!synchronizerRef.current) synchronizerRef.current = new LocalVideoSynchronizer();
  const [compatTrackId, setCompatTrackId] = useState<number | null>(null);
  const [failedTrackId, setFailedTrackId] = useState<number | null>(null);
  const compatible = track?.id === compatTrackId;
  const source = track && videoTrack ? sourceForTrack(track, compatible) : "";
  const shouldPlay = deck.transportRunning && !deck.scratchHeld;

  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    videoRefs.current[side] = video;
  }, [side, videoRefs]);

  useEffect(() => () => {
    const video = videoRef.current;
    synchronizerRef.current?.reset(video);
    synchronizerRef.current?.dispose();
    video?.pause();
    videoRefs.current[side] = null;
  }, [side, videoRefs]);

  useEffect(() => {
    const video = videoRef.current;
    synchronizerRef.current?.reset(video);
    setFailedTrackId(null);
    if (!video || !source) return;
    video.load();
  }, [source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    const align = () => {
      const target = Math.max(0, Number.isFinite(deck.position) ? deck.position : 0);
      synchronizerRef.current?.sync(video, target, "explicit", deck.rate);
      if (shouldPlay) void video.play().catch(() => undefined);
      else video.pause();
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) align();
    else video.addEventListener("loadedmetadata", align, { once: true });
    return () => video.removeEventListener("loadedmetadata", align);
  }, [
    source,
    shouldPlay,
    deck.discontinuityRevision,
    deck.scratchHeld,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    synchronizerRef.current?.setBaseRate(video, deck.rate);
  }, [deck.rate]);

  if (!track || !videoTrack) return null;
  return (
    <span className="kd-performance-deck-video" data-error={failedTrackId === track.id || undefined}>
      <video
        ref={bindVideo}
        src={source}
        muted
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        aria-label={`Deck ${side === 0 ? "A" : "B"} 视频画面`}
        onLoadedMetadata={(event) => {
          const target = Math.max(0, Number.isFinite(deck.position) ? deck.position : 0);
          synchronizerRef.current?.sync(event.currentTarget, target, "explicit", deck.rate);
        }}
        onCanPlay={(event) => {
          if (shouldPlay) void event.currentTarget.play().catch(() => undefined);
        }}
        onError={() => {
          if (track.id >= 0 && compatTrackId !== track.id) {
            setCompatTrackId(track.id);
            return;
          }
          setFailedTrackId(track.id);
        }}
      />
    </span>
  );
}

export interface PerformanceVideoOutputState {
  playing: readonly [boolean, boolean];
  crossfaderEnabled: boolean;
  crossfader: number;
  channelFaders: readonly [number, number];
}

function defaultOutputBox(): VideoFloatBox {
  const width = 352;
  const margin = 16;
  return clampVideoFloatBox({
    w: width,
    x: window.innerWidth - width - margin,
    y: window.innerHeight - videoFloatHeight(width) - margin,
  }, window.innerWidth, window.innerHeight);
}

interface ContainedVideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function containedVideoRect(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
): ContainedVideoRect | null {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    || video.videoWidth <= 0
    || video.videoHeight <= 0
  ) return null;
  const scale = Math.min(
    context.canvas.width / video.videoWidth,
    context.canvas.height / video.videoHeight,
  );
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return {
    x: (context.canvas.width - width) / 2,
    y: (context.canvas.height - height) / 2,
    width,
    height,
  };
}

/** Draw one complete source frame: video pixels plus the theme matte around (or instead of) it. */
function drawVideoLayer(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  alpha: number,
  matte: string,
): void {
  if (alpha <= 0) return;
  const rect = video ? containedVideoRect(context, video) : null;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = alpha;
  context.fillStyle = matte;
  if (!rect) {
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
    return;
  }
  // The outside matte and the contained video form one opaque source frame. Drawing the matte
  // only outside the image avoids applying this layer's alpha twice over the picture itself.
  context.beginPath();
  context.rect(0, 0, context.canvas.width, context.canvas.height);
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.fill("evenodd");
  context.drawImage(
    video!,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
  context.restore();
}

/** Canvas-backed, draggable 16:9 monitor containing only the final A/B dissolve. */
export function PerformanceVideoOutput({
  videoRefs,
  state,
  onClose,
}: {
  videoRefs: PerformanceVideoRefs;
  state: PerformanceVideoOutputState;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const matteRef = useRef("#000000");
  const [box, setBox] = useState(defaultOutputBox);
  const gestureRef = useRef<
    | { kind: "drag"; pointerId: number; clientX: number; clientY: number; box: VideoFloatBox }
    | { kind: "resize"; pointerId: number; clientX: number; clientY: number; box: VideoFloatBox }
    | null
  >(null);

  useEffect(() => {
    const root = document.documentElement;
    const updateMatte = () => {
      matteRef.current = getComputedStyle(root).getPropertyValue("--kd-video-matte").trim()
        || (root.dataset.theme === "light" ? "#ffffff" : "#000000");
    };
    updateMatte();
    const observer = new MutationObserver(updateMatte);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    let previousAt = Number.NEGATIVE_INFINITY;
    const draw = (at: number) => {
      if (at - previousAt >= 1000 / 30) {
        previousAt = at;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false });
        if (canvas && context) {
          const weights = vjMixWeights(latestStateRef.current);
          const matte = matteRef.current;
          context.globalCompositeOperation = "source-over";
          context.globalAlpha = 1;
          context.fillStyle = matte;
          context.fillRect(0, 0, canvas.width, canvas.height);
          try {
            const left = videoRefs.current[0];
            const right = videoRefs.current[1];
            // Convert the two desired linear weights into source-over alphas. This produces
            // matte*(1-A-B) + videoA*A + videoB*B for both black and white themes.
            const [leftAlpha, rightAlpha] = vjMixSourceOverAlphas(weights);
            drawVideoLayer(context, left, leftAlpha, matte);
            drawVideoLayer(context, right, rightAlpha, matte);
          } catch {
            // Keep the monitor on its theme matte if a source disappears during replacement.
          }
          context.globalCompositeOperation = "source-over";
          context.globalAlpha = 1;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [videoRefs]);

  useEffect(() => {
    const onResize = () => setBox((current) =>
      clampVideoFloatBox(current, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // WebKit can release capture before pointercancel reaches React.
    }
  };

  return createPortal(
    <div
      className="kd-performance-vj-output"
      role="dialog"
      aria-label="VJ 混合输出"
      style={{ left: box.x, top: box.y, width: box.w }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button, [data-vj-resize]")) return;
        gestureRef.current = {
          kind: "drag",
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          box,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const dx = event.clientX - gesture.clientX;
        const dy = event.clientY - gesture.clientY;
        if (gesture.kind === "drag") {
          setBox(clampVideoFloatBox({
            ...gesture.box,
            x: gesture.box.x + dx,
            y: gesture.box.y + dy,
          }, window.innerWidth, window.innerHeight));
          return;
        }
        const fromWidth = gesture.box.w + dx;
        const fromHeight = (videoFloatHeight(gesture.box.w) + dy) * 16 / 9;
        const requested = Math.abs(fromHeight - gesture.box.w) > Math.abs(fromWidth - gesture.box.w)
          ? fromHeight
          : fromWidth;
        setBox(clampVideoFloatBox({
          ...gesture.box,
          w: clampVideoFloatWidth(requested, window.innerWidth, window.innerHeight),
        }, window.innerWidth, window.innerHeight));
      }}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
    >
      <canvas ref={canvasRef} width={1280} height={720} />
      <span className="kd-performance-vj-output-bar">
        <b>VJ OUT</b>
        <button type="button" aria-label="关闭 VJ 混合输出" onClick={onClose}>
          <X size={13} />
        </button>
      </span>
      <i
        data-vj-resize="true"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          gestureRef.current = {
            kind: "resize",
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            box,
          };
          event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
        }}
      />
    </div>,
    document.body,
  );
}
