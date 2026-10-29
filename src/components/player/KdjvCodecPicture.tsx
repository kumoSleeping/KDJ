/**
 * A `.kdjv` project's picture decoded with WebCodecs and drawn on one canvas in the page
 * (codecClip.ts; KdjvMpvPicture is the mpv one, KdjvLivePicture the WebView `<video>` one).
 *
 * Each video clip on screen or about to be (kdjvLive.ts `preparedClips`) has its own decoder. A
 * clip waits before its cut with its first frames decoded and comes in moving; while shown it
 * shows the frame of the project's clock mapped into its source (`sourceTime`), never sought
 * while the decode keeps up. Placement, crop and fades are the render's (`clipBox`, `clipAlpha`),
 * drawn every frame in track order, the first track on top. A clip not ready at its cut leaves
 * the clip before it on its last frame (`heldClips`): the picture waits, it never goes black.
 *
 * Being part of the page, the picture scrolls, moves, rounds and is covered like any element.
 * Still images stay HTML over the canvas, as in the mpv picture.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { CodecClip } from "../../lib/codecClip";
import { MEDIA_SYNC_EVENT, type MediaSyncDetail } from "../../lib/mediaSync";
import { clipAlpha, clipBox, heldClips, preparedClips, sourceTime, type LiveClip } from "../../lib/kdjvLive";
import { projectTime, type Heard, type LiveTransport } from "./KdjvLivePicture";
import type { KdjvLive } from "../../types";
import type { VideoSample } from "mediabunny";

interface ClipDecoder {
  n: number;
  clip: CodecClip;
}

/** Draws a clip's frame into its box on the canvas, less its crop, at its opacity. */
function drawClip(ctx: CanvasRenderingContext2D, project: KdjvLive, c: LiveClip, frame: VideoSample, alpha: number) {
  const canvas = ctx.canvas;
  const at = clipBox(project, c);
  const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
  const keepX = Math.max(0.01, 1 - l - r), keepY = Math.max(0.01, 1 - t - b);
  const fw = frame.displayWidth, fh = frame.displayHeight;
  ctx.globalAlpha = alpha;
  frame.draw(
    ctx,
    fw * l, fh * t, fw * keepX, fh * keepY,
    (at.left + l * at.width) / 100 * canvas.width, (at.top + t * at.height) / 100 * canvas.height,
    at.width * keepX / 100 * canvas.width, at.height * keepY / 100 * canvas.height,
  );
}

export function KdjvCodecPicture({ trackId, project, onTransport }: {
  trackId: number;
  project: KdjvLive;
  onTransport?: (transport: LiveTransport) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const sized = useRef(size);
  sized.current = size;
  const transport = useRef(onTransport);
  transport.current = onTransport;
  // Kept across edits of the project: a clip still drawn keeps its decoder.
  const decoders = useRef(new Map<string, ClipDecoder>());
  const images = useRef(new Map<number, HTMLImageElement>());

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const fit = () => {
      const scale = Math.min(node.clientWidth / project.width, node.clientHeight / project.height);
      setSize({ width: project.width * scale, height: project.height * scale });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [project.width, project.height]);

  useEffect(() => {
    let heard: Heard | null = null;
    const known: { current: Heard | null } = { current: null };
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== trackId) return;
      const playing = detail.action === "play" ? true : detail.action === "pause" ? false : heard?.playing ?? false;
      heard = { position: detail.position ?? heard?.position ?? 0, at: performance.now(), playing, rate: detail.rate ?? 1 };
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    // Drawn bottom first: the last track, and within a track the earlier clip under the later.
    const order = (a: number, b: number) =>
      (project.clips[b].track - project.clips[a].track) || (a - b);
    let frame = 0, lastReport = -Infinity, drawn = "";
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const t = projectTime(trackId, heard, known);
      const node = canvas.current;
      const ctx = node?.getContext("2d");

      const byClip = new Map<number, ClipDecoder>();
      const wanted = new Set<string>();
      const keep = (n: number) => {
        const c = project.clips[n];
        const source = c && project.sources[c.source];
        if (source?.kind !== "video") return;
        const url = source.proxy ? api.kdjvProxyUrl(trackId, c.source) : api.kdjvSourceUrl(trackId, c.source);
        const id = `${n}|${url}|${source.file ?? ""}`;
        wanted.add(id);
        let decoder = decoders.current.get(id);
        if (!decoder) {
          decoder = { n, clip: new CodecClip(url, `${n}`, reason => console.warn(`工程素材 ${n} 无法播放：${reason.message}`)) };
          decoders.current.set(id, decoder);
        }
        byClip.set(n, decoder);
      };
      for (const n of preparedClips(project, t.position, t.playing)) keep(n);

      // Each clip's frame for now: before its cut its first frames wait, inside it follows the clock.
      const frames = new Map<number, VideoSample>();
      for (const [n, decoder] of byClip) {
        const c = project.clips[n];
        const local = t.position - c.at;
        const sample = local < 0
          ? decoder.clip.prime(c.in)
          : local >= c.length
            ? decoder.clip.current
            : t.playing
              ? decoder.clip.play(sourceTime(c, local))
              : decoder.clip.still(sourceTime(c, local));
        if (sample && local >= 0 && local < c.length) frames.set(n, sample);
      }
      // A clip of now with no frame yet holds the one before it on its track, on its last frame.
      const held = heldClips(project, t.position, n => frames.has(n) || project.sources[project.clips[n].source]?.kind !== "video");
      for (const n of held) keep(n);

      for (const [id, decoder] of decoders.current) {
        if (wanted.has(id)) continue;
        decoder.clip.dispose();
        decoders.current.delete(id);
      }

      if (node && ctx) {
        const width = Math.max(1, Math.round(sized.current.width * devicePixelRatio));
        const height = Math.max(1, Math.round(sized.current.height * devicePixelRatio));
        const shown: [number, VideoSample, number][] = [];
        for (const n of [...frames.keys(), ...held].sort(order)) {
          const c = project.clips[n];
          const sample = frames.get(n) ?? byClip.get(n)?.clip.current;
          const alpha = frames.has(n) ? clipAlpha(c, t.position - c.at) : c.opacity;
          if (sample && alpha > 0) shown.push([n, sample, alpha]);
        }
        const key = `${width}x${height}|${shown.map(([n, s, a]) => `${n}:${s.timestamp}:${a.toFixed(3)}`).join(",")}`;
        if (key !== drawn) {
          drawn = key;
          if (node.width !== width || node.height !== height) {
            node.width = width;
            node.height = height;
          }
          ctx.globalAlpha = 1;
          ctx.clearRect(0, 0, width, height);
          for (const [n, sample, alpha] of shown) drawClip(ctx, project, project.clips[n], sample, alpha);
          ctx.globalAlpha = 1;
        }
      }

      for (const [n, image] of images.current) {
        const c = project.clips[n];
        image.style.opacity = c ? String(clipAlpha(c, t.position - c.at)) : "0";
      }
      if (now - lastReport >= 250) {
        lastReport = now;
        transport.current?.({ position: Math.min(project.duration, Math.max(0, t.position)), playing: t.playing });
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
    };
  }, [trackId, project]);

  useEffect(() => () => {
    for (const decoder of decoders.current.values()) decoder.clip.dispose();
    decoders.current.clear();
  }, []);

  const tracks = Math.max(0, ...project.clips.map(c => c.track)) + 1;
  return (
    <div ref={box} className="kd-kdjv-live" aria-hidden="true">
      <div className="kd-kdjv-live-canvas" style={{ width: size.width, height: size.height }}>
        <canvas ref={canvas} className="kd-kdjv-codec-canvas" />
        {project.clips.map((c, n) => {
          const source = project.sources[c.source];
          if (source?.kind === "video") return null;
          const at = clipBox(project, c);
          return <img key={`${n}:${source?.file ?? ""}`} ref={node => {
            if (node) images.current.set(n, node);
            else images.current.delete(n);
          }} className="kd-kdjv-live-clip" alt="" draggable={false} src={api.kdjvSourceUrl(trackId, c.source)}
            style={{
              left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%`, clipPath: at.clip,
              zIndex: (tracks - c.track) * 10_000 + n, opacity: 0,
            }} />;
        })}
      </div>
    </div>
  );
}
