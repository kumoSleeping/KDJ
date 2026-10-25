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
 * frames advancing in step with the clock, or paused on the frame the clock is about to reach
 * (a cue, `cueClip`). WebKit holds a seek's first frame for hundreds of milliseconds and starts
 * late, so a clip shown at its cut regardless flashed black or a wrong frame and then jumped, and
 * one chased with seeks while running took seconds to come. Before its cut a clip may seek freely
 * (preparing); while it is shown it is never sought: a small drift is caught up by its tempo
 * (VideoPlaybackEngine `trimPhase`), one too large to watch is cued again. A clip not yet shown at its cut leaves the clip before it on its last frame
 * (heldClips): the picture waits, it never jumps.
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
import { clipAlpha, clipBox, clipSpeed, heldClips, preparedClips, sourceTime, type LiveClip } from "../../lib/kdjvLive";
import { tracePlayback } from "../../lib/playbackTrace";
import type { KdjvLive } from "../../types";

/** A shown clip is cued again while playing only when it is this far off the clock. */
const VISIBLE_DRIFT_SEC = 0.35;
/** A clip already running near the clock at its cut shows once its frames advance this many ticks. */
const SETTLED_TICKS = 2;
const SETTLED_PLAYING_SEC = 0.12;
/** A cue whose seek landed this far behind the clock is made again further ahead. */
const CUE_MISSED_SEC = 0.25;
/** A cue's seek that has not landed after this long is sent again. */
const CUE_GIVE_UP_MS = 4_000;
/** After a cued clip starts, the engine leaves it to run this long, and its start delay is measured then. */
const START_SETTLE_MS = 400;
const SETTLED_PAUSED_SEC = 0.05;

export interface LiveTransport {
  position: number;
  playing: boolean;
}

type Heard = { position: number; at: number; playing: boolean; rate: number };
/**
 * A clip waiting for the clock: paused on `at` (source seconds), the frame due at `local` seconds
 * into the clip, which the clock reaches only after the seek there has landed.
 */
type Cue = { local: number; at: number; sent: number; landed: number | null };
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
  // What is known of each element, kept across edits: an element still drawn after the project
  // changed stays shown and on its clock, instead of going dark and settling again.
  const decoders = useRef({
    seeks: new WeakMap<HTMLVideoElement, number>(),
    running: new WeakMap<HTMLVideoElement, boolean>(),
    // Whether each element has been shown; once shown it stays shown for as long as it lives.
    revealed: new WeakMap<HTMLVideoElement | HTMLImageElement, boolean>(),
    motion: new WeakMap<HTMLVideoElement, { at: number; ticks: number }>(),
    // When each element was first wanted on screen (performance.now), for the reveal's trace.
    wanted: new WeakMap<HTMLVideoElement, number>(),
    cues: new WeakMap<HTMLVideoElement, Cue>(),
    // When a cued element was started (performance.now).
    started: new WeakMap<HTMLVideoElement, number>(),
    // Elements started on their first frame just before their cut (no cue): shown at the cut.
    primed: new WeakSet<HTMLVideoElement>(),
    // What this window's decoders take, learned as they go, in seconds: a seek to land, a start
    // to show moving frames.
    lead: { seek: 0.3, play: 0.05 },
  });
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
    const { seeks, running, revealed, motion, wanted, cues, started, primed, lead } = decoders.current;
    let frame = 0, lastAlign = -Infinity, lastReport = -Infinity, shown = "";
    const seek = (video: HTMLVideoElement, target: number) => { void sync.seek(video, target).catch(() => undefined); };
    const reveal = (node: HTMLVideoElement, n: number, local: number, now: number) => {
      revealed.set(node, true);
      primed.delete(node);
      // waitMs: how long the picture of now was missing; lateMs: how far into the clip that was.
      const waited = Math.round(now - (wanted.get(node) ?? now));
      if (waited > 50) tracePlayback("kdjv-reveal", { track: trackId, clip: n, waitMs: waited, lateMs: Math.round(local * 1000) });
    };
    /**
     * Playing, a clip whose picture of now is missing — just come on screen, or thrown off by a
     * seek — is cued instead of chased: paused and seeked once to the frame the clock will be at
     * when that seek has landed (`lead.seek`, learned from the ones before), shown there as soon
     * as it lands, and started just before the clock gets to it (`lead.play`). The picture is
     * there after one seek and runs in step from its first moving frame; chasing a running
     * decoder with seeks took seconds. False once it has been started this tick.
     */
    const cueClip = (node: HTMLVideoElement, n: number, c: LiveClip, local: number, speed: number, rate: number, now: number) => {
      let cue = cues.get(node);
      if (cue && cue.landed !== null && local > cue.local + CUE_MISSED_SEC) { cues.delete(node); cue = undefined; }
      if (cue && cue.landed === null && now - cue.sent > CUE_GIVE_UP_MS) { cues.delete(node); cue = undefined; }
      if (!cue) {
        if (node.readyState < 1) return true;
        const ahead = local + lead.seek * rate;
        // It ends before a seek could land: it is not shown.
        if (ahead >= c.length) return true;
        if (running.get(node)) sync.releaseClock(node);
        running.set(node, false);
        if (!node.paused) node.pause();
        const mine: Cue = { local: ahead, at: sourceTime(c, ahead), sent: now, landed: null };
        cues.set(node, mine);
        void sync.seek(node, mine.at).then(done => {
          if (cues.get(node) !== mine) return;
          if (!done) { cues.delete(node); return; }
          mine.landed = performance.now();
          const took = (mine.landed - mine.sent) / 1000;
          lead.seek = Math.min(1.5, Math.max(0.12, lead.seek * 0.5 + (took * 1.3 + 0.05) * 0.5));
        }).catch(() => { if (cues.get(node) === mine) cues.delete(node); });
        return true;
      }
      if (cue.landed === null || node.seeking || node.readyState < 2) return true;
      // The frame the clock is coming to, still, until it gets there.
      if (!revealed.get(node)) reveal(node, n, local, now);
      if (local < cue.local - lead.play * rate) return true;
      cues.delete(node);
      sync.setBaseRate(node, rate * speed);
      started.set(node, now);
      running.set(node, true);
      void node.play().catch(() => undefined);
      return false;
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
        if (holding || local >= c.length) {
          // The clip before a cut that is still settling: its last frame, still. One just ended
          // (kept a moment, kdjvLive.ts LINGER_SEC) is out of sight and left where it stopped.
          if (!node.paused) node.pause();
          if (running.get(node)) sync.releaseClock(node);
          running.set(node, false);
          node.style.opacity = holding && revealed.get(node) ? String(c.opacity) : "0";
          continue;
        }
        const target = Math.max(0, sourceTime(c, local));
        const speed = clipSpeed(c);
        // Before its cut a clip runs muted and transparent on the same clock, from where its
        // source allows; one that cannot start early waits on its first frame.
        const early = local < 0 && c.in + local * speed >= 0;
        // One whose source starts at its in point waits paused on that first frame, and is started
        // just before its cut by the start delay learned (lead.play): it comes in moving, where a
        // cue at the cut held a still frame further on and sought it there.
        const before = -lead.play * t.rate;
        if (!t.playing || local < before - 0.25 || revealed.get(node)) primed.delete(node);
        else if (local < 0 && !early && local >= before && !primed.has(node) && !node.seeking
          && node.readyState >= 2 && Math.abs(node.currentTime - target) <= SETTLED_PAUSED_SEC) {
          primed.add(node);
          sync.setBaseRate(node, t.rate * speed);
          started.set(node, now);
          running.set(node, true);
          void node.play().catch(() => undefined);
        }
        const leading = local < 0 && primed.has(node);
        const shouldPlay = t.playing && (local >= 0 || early || leading) && local < c.length;
        const since = started.get(node);
        const starting = since !== undefined && now - since < START_SETTLE_MS;
        if (since !== undefined && !starting) {
          // How late its frames came after the start: the next cue starts that much earlier.
          started.delete(node);
          if (shouldPlay && !node.paused && !node.seeking) {
            lead.play = Math.min(0.3, Math.max(0, lead.play + (target - node.currentTime) / Math.max(0.1, t.rate * speed) * 0.5));
          }
        }
        if (!revealed.get(node)) {
          // Counted while it prepares before its cut too, so one running in step shows at the cut itself.
          const step = motion.get(node) ?? { at: node.currentTime, ticks: 0 };
          step.ticks = !node.paused && node.currentTime > step.at + 0.002 ? step.ticks + 1 : 0;
          step.at = node.currentTime;
          motion.set(node, step);
        }
        if (!revealed.get(node) && local >= 0 && local < c.length) {
          if (!wanted.has(node)) wanted.set(node, now);
          const step = motion.get(node)!;
          const settled = !node.seeking && node.readyState >= 2 && (primed.has(node)
            ? Math.abs(target - node.currentTime) <= VISIBLE_DRIFT_SEC
            : shouldPlay
            ? !node.paused && step.ticks >= SETTLED_TICKS && Math.abs(target - node.currentTime) <= SETTLED_PLAYING_SEC
            : Math.abs(target - node.currentTime) <= SETTLED_PAUSED_SEC);
          if (settled) reveal(node, n, local, now);
        }
        // A shown clip running far off the clock (the project was seeked) is cued again.
        const thrown = revealed.get(node) === true && running.get(node) === true && !starting && !node.seeking
          && node.readyState >= 2 && Math.abs(target - node.currentTime) > VISIBLE_DRIFT_SEC;
        if (thrown) tracePlayback("kdjv-realign", { track: trackId, clip: n, error: Math.round((target - node.currentTime) * 1000) });
        if (shouldPlay && local >= 0 && (cues.has(node) || !revealed.get(node) || thrown)) {
          if (cueClip(node, n, c, local, speed, t.rate, now)) {
            node.style.opacity = revealed.get(node) ? String(clipAlpha(c, local)) : "0";
            continue;
          }
        } else if (cues.has(node)) {
          cues.delete(node);
        }
        node.style.opacity = revealed.get(node) ? String(clipAlpha(c, local)) : "0";
        // A stop takes the decoder off the clock once; releasing it every frame would also
        // cancel the seek that shows the paused frame.
        if (!shouldPlay && running.get(node)) sync.releaseClock(node);
        running.set(node, shouldPlay);
        if (!shouldPlay && !node.paused) node.pause();
        if (!align || node.readyState < 1) continue;
        if (shouldPlay && starting) {
          // Just started by its cue: left to run until its frames come.
        } else if (shouldPlay && t.clock) {
          const clock: LocalVideoClock = { ...t.clock, position: target, rate: t.clock.rate * speed };
          // Unseen, it prepares: sought as soon as it drifts. Shown, it is never sought (a seek
          // froze it while its source decoded from a keyframe, again and again over the first
          // seconds of playing): it is caught up by its tempo, and a jump too large for that is
          // cued again (`thrown`).
          if (revealed.get(node) === true) sync.trimPhase(node, clock);
          else sync.followClock(node, clock, seek, undefined, true);
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
