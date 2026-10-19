/**
 * A `.kdjv` project's picture drawn live (docs/kdjv.md): one <video> or <img> per clip on screen
 * or about to be, placed, scaled and faded as the render would, each following the player's
 * clock through the shared scheduling layer (VideoPlaybackEngine), as the old workshop's preview
 * did. Nothing is rendered: the sources are the system decoder's own playback. WebKit composes
 * the layers; no pixels are copied.
 *
 * The sound is the project's mix, played by the player as the row's file (kdjvPlay.ts); this
 * only follows its clock. Gifs animate on their own.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  getLatestPlayerSync,
  getLocalVideoClock,
  usesLocalVideoDeviceClock,
  MEDIA_SYNC_EVENT,
  type LocalVideoClock,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { configurePictureVideo, VideoPlaybackEngine } from "../../lib/videoPlaybackEngine";
import { clipAlpha, clipBox, clipSpeed, preparedClips, sourceTime } from "../../lib/kdjvLive";
import type { KdjvLive } from "../../types";

export interface LiveTransport {
  position: number;
  playing: boolean;
}

/** Where the project is: the player's device clock, else its last word (web and Android). */
function projectTime(trackId: number, heard: { position: number; at: number; playing: boolean; rate: number } | null) {
  if (usesLocalVideoDeviceClock()) {
    const clock = getLocalVideoClock(trackId);
    if (clock) return { position: clock.position, playing: clock.playing && clock.rate > 0, rate: clock.rate, clock };
    const last = getLatestPlayerSync(trackId);
    return { position: last?.position ?? 0, playing: false, rate: 1, clock: null };
  }
  if (!heard) return { position: 0, playing: false, rate: 1, clock: null };
  const position = heard.position + (heard.playing ? (performance.now() - heard.at) / 1000 * heard.rate : 0);
  return { position, playing: heard.playing, rate: heard.rate, clock: null };
}

export function KdjvLivePicture({ trackId, project, onTransport }: {
  trackId: number;
  project: KdjvLive;
  onTransport?: (transport: LiveTransport) => void;
}) {
  const [prepared, setPrepared] = useState<number[]>([]);
  const nodes = useRef(new Map<number, HTMLVideoElement | HTMLImageElement>());
  const engine = useRef<VideoPlaybackEngine | null>(null);
  if (!engine.current) engine.current = new VideoPlaybackEngine();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const transport = useRef(onTransport);
  transport.current = onTransport;

  // The canvas is contain-fitted into whatever box the surface gives it.
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
    let heard: { position: number; at: number; playing: boolean; rate: number } | null = null;
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== trackId) return;
      const playing = detail.action === "play" ? true : detail.action === "pause" ? false : heard?.playing ?? false;
      heard = { position: detail.position ?? heard?.position ?? 0, at: performance.now(), playing, rate: detail.rate ?? 1 };
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    const sync = engine.current!;
    const seeks = new WeakMap<HTMLVideoElement, number>();
    const running = new WeakMap<HTMLVideoElement, boolean>();
    let frame = 0, lastAlign = -Infinity, lastReport = -Infinity, shown = "";
    const seek = (video: HTMLVideoElement, target: number) => { void sync.seek(video, target).catch(() => undefined); };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const t = projectTime(trackId, heard);
      const want = preparedClips(project, t.position, t.playing);
      const key = want.join(",");
      if (key !== shown) { shown = key; setPrepared(want); }
      const align = !t.playing || now - lastAlign >= 100;
      if (align) lastAlign = now;
      for (const [n, node] of nodes.current) {
        const c = project.clips[n];
        if (!c) continue;
        const local = t.position - c.at;
        node.style.opacity = String(clipAlpha(c, local));
        if (!(node instanceof HTMLVideoElement)) continue;
        const target = Math.max(0, sourceTime(c, local));
        const speed = clipSpeed(c);
        // Before its cut a clip runs muted and transparent on the same clock, from where its
        // source allows; one that cannot start early waits on its first frame.
        const early = local < 0 && c.in + local * speed >= 0;
        const shouldPlay = t.playing && (local >= 0 || early) && local < c.length;
        // A stop takes the decoder off the clock once; releasing it every frame would also
        // cancel the seek that shows the paused frame.
        if (!shouldPlay && running.get(node)) sync.releaseClock(node);
        running.set(node, shouldPlay);
        if (!shouldPlay && !node.paused) node.pause();
        if (!align || node.readyState < 1) continue;
        if (shouldPlay && t.clock) {
          const clock: LocalVideoClock = { ...t.clock, position: target, rate: t.clock.rate * speed };
          sync.followClock(node, clock, seek, undefined, early && local < -1);
        } else if (shouldPlay) {
          sync.sync(node, target, "heartbeat", t.rate * speed, seek);
        } else {
          sync.setBaseRate(node, speed);
          const at = seeks.get(node) ?? -Infinity;
          if (!node.seeking && Math.abs(node.currentTime - target) > 0.02 && now - at > 80) {
            seeks.set(node, now);
            seek(node, target);
          }
        }
        if (shouldPlay && node.paused && node.readyState >= 2) void node.play().catch(() => undefined);
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

  useEffect(() => () => engine.current?.dispose(), []);

  // One ref callback per clip for as long as its element lives: a new callback makes React detach
  // and attach again, which unloads the decoder and loads it from the start. The parent renders
  // several times a second (the transport report), so a callback that went missing from this map
  // once — a detach deleting it, as StrictMode's mount-time detach did — kept every clip black.
  // A detach is the callback's cleanup and leaves the map alone; entries of clips no longer drawn
  // are dropped below, in the render that stops drawing them.
  const refs = useRef(new Map<string, (node: HTMLVideoElement | HTMLImageElement | null) => (() => void) | undefined>());
  const refFor = (n: number, src: string) => {
    const id = `${n}:${src}`;
    let bind = refs.current.get(id);
    if (!bind) {
      bind = node => {
        if (!node) return undefined;
        if (node instanceof HTMLVideoElement) {
          configurePictureVideo(node);
          node.src = src;
          node.load();
        }
        nodes.current.set(n, node);
        return () => {
          if (node instanceof HTMLVideoElement) {
            engine.current?.releaseClock(node);
            node.pause();
            node.removeAttribute("src");
            node.load();
          }
          if (nodes.current.get(n) === node) nodes.current.delete(n);
        };
      };
      refs.current.set(id, bind);
    }
    return bind;
  };
  const drawn = new Set(prepared.map(n => `${n}:${api.kdjvSourceUrl(trackId, project.clips[n].source)}`));
  for (const id of refs.current.keys()) if (!drawn.has(id)) refs.current.delete(id);

  // The first track is on top; within a track a later clip covers an earlier one.
  const tracks = Math.max(0, ...project.clips.map(c => c.track)) + 1;
  return (
    <div ref={box} className="kd-kdjv-live" aria-hidden="true">
      <div className="kd-kdjv-live-canvas" style={{ width: size.width, height: size.height }}>
        {prepared.map(n => {
          const c = project.clips[n];
          const at = clipBox(project, c);
          const style = {
            left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%`,
            zIndex: (tracks - c.track) * 10_000 + n, opacity: 0,
          };
          const src = api.kdjvSourceUrl(trackId, c.source);
          return project.sources[c.source]?.kind === "video"
            ? <video key={`${n}:${src}`} ref={refFor(n, src)} className="kd-kdjv-live-clip" style={style}
                crossOrigin="anonymous" muted playsInline preload="auto" />
            : <img key={`${n}:${src}`} ref={refFor(n, src)} className="kd-kdjv-live-clip" style={style}
                src={src} alt="" draggable={false} />;
        })}
      </div>
    </div>
  );
}
