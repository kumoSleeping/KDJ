/**
 * A `.kdjv` project's picture drawn live (docs/kdjv.md): one <video> or <img> per clip on screen
 * or about to be, placed, scaled and faded as the render would, each following the player's
 * clock through the shared scheduling layer (VideoPlaybackEngine), as the old workshop's preview
 * did. Nothing is rendered: the sources are the system decoder's own playback. WebKit composes
 * the layers; no pixels are copied.
 *
 * The sound is the project's mix, played by the player as the row's file (kdjvPlay.ts); this
 * only follows its clock. Gifs animate on their own.
 *
 * A clip is shown only once its decoder is truly there: paused, on the frame of now; playing,
 * frames advancing in step with the clock. WebKit holds a seek's first frame for hundreds of
 * milliseconds and starts late, so a clip shown at its cut regardless flashed black or a wrong
 * frame and then jumped. Until a clip is shown it may seek freely (preparing); while it is shown it
 * is never seeked for a small drift, only for one too large to watch. A clip not yet shown at its
 * cut leaves the clip before it on its last frame (heldClips): the picture waits, it never jumps.
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
import { clipAlpha, clipBox, clipSpeed, heldClips, preparedClips, sourceTime } from "../../lib/kdjvLive";
import { tracePlayback } from "../../lib/playbackTrace";
import type { KdjvLive } from "../../types";

/** A shown clip is seeked while playing only when it is this far off the clock. */
const VISIBLE_DRIFT_SEC = 0.35;
/** Playing frames have to advance this many ticks in a row, near the clock, before a clip shows. */
const SETTLED_TICKS = 6;
const SETTLED_PLAYING_SEC = 0.12;
const SETTLED_PAUSED_SEC = 0.05;

export interface LiveTransport {
  position: number;
  playing: boolean;
}

type Heard = { position: number; at: number; playing: boolean; rate: number };
/** How long a clock gone quiet is carried on from where it was, before the picture waits. */
const CARRY_MS = 1_500;

/**
 * Where the project is: the player's device clock, else its last word (web and Android). The
 * device clock is unreadable for moments — while a seek swaps the decks, or the other deck holds
 * the next song — and the last word may be about another row: then the time last known is carried
 * on (and held after a while), never put back to 0, which threw the picture and the window's
 * progress back to the start and forth again.
 */
function projectTime(trackId: number, heard: Heard | null, known: { current: Heard | null }) {
  const carried = () => {
    const last = known.current;
    if (!last) return null;
    const age = performance.now() - last.at;
    const position = last.position + (last.playing ? Math.min(age, CARRY_MS) / 1000 * last.rate : 0);
    return { position, playing: last.playing && age <= CARRY_MS, rate: last.rate, clock: null };
  };
  if (usesLocalVideoDeviceClock()) {
    const clock = getLocalVideoClock(trackId);
    if (clock) {
      const playing = clock.playing && clock.rate > 0;
      known.current = { position: clock.position, at: performance.now(), playing, rate: clock.rate };
      return { position: clock.position, playing, rate: clock.rate, clock };
    }
    const last = getLatestPlayerSync(trackId);
    const kept = carried();
    if (kept) return kept;
    return { position: last?.position ?? 0, playing: false, rate: 1, clock: null };
  }
  if (!heard) return carried() ?? { position: 0, playing: false, rate: 1, clock: null };
  const position = heard.position + (heard.playing ? (performance.now() - heard.at) / 1000 * heard.rate : 0);
  known.current = { position, at: performance.now(), playing: heard.playing, rate: heard.rate };
  return { position, playing: heard.playing, rate: heard.rate, clock: null };
}

export function KdjvLivePicture({ trackId, project, onTransport }: {
  trackId: number;
  project: KdjvLive;
  onTransport?: (transport: LiveTransport) => void;
}) {
  // The clips drawn, as indices into the project they were picked from. When the project changes
  // (an edit refreshes the one playing) an index is kept only while it still names a clip of the
  // same file, until the new project's own are picked: never a clip it does not have.
  const [picked, setPicked] = useState<{ project: KdjvLive | null; clips: number[] }>({ project: null, clips: [] });
  const sourceOf = (p: KdjvLive, n: number) => {
    const c = p.clips[n];
    return c ? `${api.kdjvSourceUrl(trackId, c.source)}|${p.sources[c.source]?.file ?? ""}` : null;
  };
  const prepared = picked.project === project ? picked.clips
    : picked.project ? picked.clips.filter(n => sourceOf(project, n) !== null && sourceOf(project, n) === sourceOf(picked.project!, n)) : [];
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
    let heard: Heard | null = null;
    const known: { current: Heard | null } = { current: null };
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
    // Whether each element has been shown; once shown it stays shown for as long as it lives.
    const revealed = new WeakMap<HTMLVideoElement | HTMLImageElement, boolean>();
    const motion = new WeakMap<HTMLVideoElement, { at: number; ticks: number }>();
    const targets = new WeakMap<HTMLVideoElement, number>();
    let frame = 0, lastAlign = -Infinity, lastReport = -Infinity, shown = "";
    const seek = (video: HTMLVideoElement, target: number) => { void sync.seek(video, target).catch(() => undefined); };
    // A shown clip drifting a little is left to run: a seek would freeze and jump it on screen.
    const alignShown = (video: HTMLVideoElement) => {
      const target = targets.get(video);
      if (target !== undefined && Math.abs(target - video.currentTime) > VISIBLE_DRIFT_SEC) {
        tracePlayback("kdjv-realign", { track: trackId, error: Math.round((target - video.currentTime) * 1000) });
        seek(video, target);
      }
    };
    const isShown = (n: number) => {
      const node = nodes.current.get(n);
      return node ? revealed.get(node) === true : false;
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const t = projectTime(trackId, heard, known);
      const held = heldClips(project, t.position, isShown);
      const want = [...new Set([...preparedClips(project, t.position, t.playing), ...held])].sort((a, b) => a - b);
      const key = want.join(",");
      if (key !== shown) { shown = key; setPicked({ project, clips: want }); }
      const align = !t.playing || now - lastAlign >= 100;
      if (align) lastAlign = now;
      for (const [n, node] of nodes.current) {
        const c = project.clips[n];
        if (!c) continue;
        const local = t.position - c.at;
        const holding = held.includes(n) && local >= c.length;
        if (!(node instanceof HTMLVideoElement)) {
          if (!revealed.get(node) && node.complete && node.naturalWidth > 0) revealed.set(node, true);
          node.style.opacity = revealed.get(node) ? String(holding ? c.opacity : clipAlpha(c, local)) : "0";
          continue;
        }
        if (holding) {
          // The clip before a cut that is still settling: its last frame, still.
          if (!node.paused) node.pause();
          if (running.get(node)) sync.releaseClock(node);
          running.set(node, false);
          node.style.opacity = revealed.get(node) ? String(c.opacity) : "0";
          continue;
        }
        const target = Math.max(0, sourceTime(c, local));
        targets.set(node, target);
        const speed = clipSpeed(c);
        // Before its cut a clip runs muted and transparent on the same clock, from where its
        // source allows; one that cannot start early waits on its first frame.
        const early = local < 0 && c.in + local * speed >= 0;
        const shouldPlay = t.playing && (local >= 0 || early) && local < c.length;
        if (!revealed.get(node) && local >= 0 && local < c.length) {
          const step = motion.get(node) ?? { at: node.currentTime, ticks: 0 };
          step.ticks = !node.paused && node.currentTime > step.at + 0.002 ? step.ticks + 1 : 0;
          step.at = node.currentTime;
          motion.set(node, step);
          const settled = !node.seeking && node.readyState >= 2 && (shouldPlay
            ? !node.paused && step.ticks >= SETTLED_TICKS && Math.abs(target - node.currentTime) <= SETTLED_PLAYING_SEC
            : Math.abs(target - node.currentTime) <= SETTLED_PAUSED_SEC);
          if (settled) {
            revealed.set(node, true);
            if (local > 0.1) tracePlayback("kdjv-reveal", { track: trackId, clip: n, lateMs: Math.round(local * 1000) });
          }
        }
        node.style.opacity = revealed.get(node) ? String(clipAlpha(c, local)) : "0";
        // A stop takes the decoder off the clock once; releasing it every frame would also
        // cancel the seek that shows the paused frame.
        if (!shouldPlay && running.get(node)) sync.releaseClock(node);
        running.set(node, shouldPlay);
        if (!shouldPlay && !node.paused) node.pause();
        if (!align || node.readyState < 1) continue;
        if (shouldPlay && t.clock) {
          const clock: LocalVideoClock = { ...t.clock, position: target, rate: t.clock.rate * speed };
          // Unseen, it prepares: aligned as soon as it drifts. Shown, only a large drift aligns it.
          const shownNow = revealed.get(node) === true;
          sync.followClock(node, clock, seek, shownNow ? alignShown : undefined, !shownNow);
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
  const refFor = (id: string, n: number, src: string) => {
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
  const drawn = new Set(prepared.map(n => `${n}:${sourceOf(project, n)}`));
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
            left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%`, clipPath: at.clip,
            zIndex: (tracks - c.track) * 10_000 + n, opacity: 0,
          };
          const src = api.kdjvSourceUrl(trackId, c.source);
          // Keyed by the file too: the same source number turned into another file is a new element.
          const id = `${n}:${sourceOf(project, n)}`;
          return project.sources[c.source]?.kind === "video"
            ? <video key={id} ref={refFor(id, n, src)} className="kd-kdjv-live-clip" style={style}
                crossOrigin="anonymous" muted playsInline preload="auto" />
            : <img key={id} ref={refFor(id, n, src)} className="kd-kdjv-live-clip" style={style}
                src={src} alt="" draggable={false} />;
        })}
      </div>
    </div>
  );
}
