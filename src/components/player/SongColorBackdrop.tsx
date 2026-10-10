import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { getLatestPlayerSync, MEDIA_SYNC_EVENT, type MediaSyncDetail } from "../../lib/mediaSync";
import { MOTION_MICRO_OUT_MS, MOTION_REDUCED_MS, prefersReducedMotion } from "../../lib/motion";
import { getPlayerSession } from "../../lib/playerSession";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { getSongColorField, subscribeSongColorField, useSongColor, type SongColorField } from "../../lib/songColor";
import {
  beatCorrection,
  beatCycleIndex,
  beatSteps,
  songBeat,
  waveEnergy,
  waveLoudness,
  type BeatAnchor,
} from "../../lib/songColorBeat";
import { GLOW_PEAK_ALPHA, parseHex } from "../../lib/songColorPalette";
import { SONG_SWAP_IN_MS } from "../../lib/songSwapMotion";
import { useThemePack } from "../../lib/themePack";
import { cachedReleaseOverviewWaveform } from "../../lib/waveformCache";
import { useBackdropInk } from "../common/SurfaceBackdrop";
import "./SongColorBackdrop.css";

/**
 * 歌曲色彩: the living field of colour behind the lyrics and the playing song's bubble, taken
 * from the song's cover. It goes in a surface's backdrop slot (SurfaceBackdrop.tsx) and draws
 * nothing, loads nothing and listens to nothing while the look is off.
 *
 * How it is drawn. The floor is one flat colour. Over it lie four masses, each a small bitmap
 * of soft blobs that is painted once per song and stretched over the surface, so the blur is
 * in the picture and costs nothing afterwards; each drifts on a slow loop of its own by
 * `transform` alone (SongColorBackdrop.css). A lighter glow swells on the beat. Nothing here
 * runs per frame: the beat is one animation as long as a bar, set to the song's place when
 * it starts, is sought or changes tempo (songColorBeat.ts), and the song's energy is read from
 * its overview once a bar. Everything stops while the song is paused, the window is hidden or
 * the surface is not drawn, and under reduced motion the field is still.
 *
 * A theme pack draws these surfaces its own way (Sakura98: small 98 windows on a face colour),
 * so the look is not offered under one: `useSongColorAvailable`.
 */

/** The look is offered: no theme pack is drawing the surfaces. */
export function useSongColorAvailable(): boolean {
  return useThemePack(state => state.active === null);
}

/** One side of a mass's bitmap, in px. The blobs have no detail to lose. */
const BITMAP = 96;
/** The blobs of each mass in its bitmap: centre x, centre y, radius, as shares of the side. The
 *  bitmap is stretched to 170 % of the surface about its centre. */
const MASS_BLOBS: readonly (readonly (readonly [number, number, number])[])[] = [
  [[0.34, 0.36, 0.36], [0.6, 0.22, 0.2]],
  [[0.68, 0.62, 0.34], [0.42, 0.8, 0.2]],
  [[0.7, 0.3, 0.27]],
  [[0.3, 0.7, 0.28]],
];
const GLOW_BLOB: readonly (readonly [number, number, number])[] = [[0.5, 0.5, 0.5]];
/** How a blob fades from its centre to its rim: a bell, so two that overlap blend. */
const FALLOFF: readonly (readonly [number, number])[] = [[0, 1], [0.2, 0.92], [0.45, 0.6], [0.7, 0.24], [0.88, 0.06], [1, 0]];

/** The glow between beats, as a share of its peak; how far it and the field grow on a beat. */
const GLOW_REST = 0.3;
const GLOW_SWELL = 0.09;
const FIELD_SWELL = 0.024;

/** The front of the wash: px per ms, and the limits of how long it may take. */
const SPREAD_SPEED = 1.5;
const SPREAD_MS = [420, 900] as const;
const DRAIN_SPEED = 2.8;
const DRAIN_MS = [220, 420] as const;
/** The curves of the front, as numbers, so that the moment it passes a point can be found. The
 *  spread starts at a pace the eye can follow across the bubble and slows to its end (the
 *  arriving curve of src/motion.css is over the bubble in two frames); the drain is that
 *  sheet's leaving curve, --kd-ease-in. */
const SPREAD_EASE = [0.3, 0.25, 0.35, 1] as const;
const DRAIN_EASE = [0.55, 0, 0.8, 0.35] as const;

/** Every layer that is on screen: one wash is one circle over all of them. */
const layers = new Set<HTMLElement>();
const loudness = new WeakMap<object, number>();

function paintBlobs(canvas: HTMLCanvasElement, colour: string, blobs: readonly (readonly [number, number, number])[], strength = 1): void {
  // No canvas (a test's document): the floor colour is the whole field.
  if (typeof CanvasRenderingContext2D === "undefined") return;
  const context = canvas.getContext("2d");
  const rgb = parseHex(colour);
  if (!context || !rgb) return;
  context.clearRect(0, 0, BITMAP, BITMAP);
  for (const [x, y, radius] of blobs) {
    const gradient = context.createRadialGradient(x * BITMAP, y * BITMAP, 0, x * BITMAP, y * BITMAP, radius * BITMAP);
    for (const [stop, alpha] of FALLOFF) gradient.addColorStop(stop, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(alpha * strength).toFixed(3)})`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, BITMAP, BITMAP);
  }
}

function Blobs({ colour, blobs, strength, className }: {
  colour: string;
  blobs: readonly (readonly [number, number, number])[];
  strength?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => { if (canvas.current) paintBlobs(canvas.current, colour, blobs, strength); }, [colour, blobs, strength]);
  return <canvas ref={canvas} className={className} width={BITMAP} height={BITMAP} />;
}

/** y of a CSS cubic-bezier at x. */
function easeAt([x1, y1, x2, y2]: readonly [number, number, number, number], x: number): number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let low = 0, high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    if (at(x1, x2, middle) < x) low = middle; else high = middle;
  }
  return at(y1, y2, (low + high) / 2);
}

/** The share of the curve's time at which it has covered `y` of its way. */
function easeTime(curve: readonly [number, number, number, number], y: number): number {
  let low = 0, high = 1;
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    if (easeAt(curve, middle) < y) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

/**
 * One wash seen from one layer: a circle about the key that was pressed, large enough to cover
 * every layer on screen, so the lyrics and the bubble show the same front at the same moment.
 * Measured once, before it moves. `centre` is the share of the reach at which the front is over
 * the middle of this layer.
 */
function washFrom(node: HTMLElement, origin: { x: number; y: number }) {
  let reach = 0;
  for (const layer of layers.has(node) ? layers : [node]) {
    const box = layer.getBoundingClientRect();
    reach = Math.max(reach, Math.hypot(Math.max(origin.x - box.left, box.right - origin.x), Math.max(origin.y - box.top, box.bottom - origin.y)));
  }
  const box = node.getBoundingClientRect();
  const centre = Math.hypot(box.left + box.width / 2 - origin.x, box.top + box.height / 2 - origin.y);
  return { x: origin.x - box.left, y: origin.y - box.top, reach: Math.max(1, reach), centre: Math.min(1, centre / Math.max(1, reach)) };
}

/** Hands the circle to the stylesheet, which moves it (SongColorBackdrop.css). */
function startWash(node: HTMLElement, way: "in" | "out", wash: ReturnType<typeof washFrom>, ms: number, curve: readonly number[]): void {
  node.style.setProperty("--kd-songcolor-x", `${wash.x.toFixed(1)}px`);
  node.style.setProperty("--kd-songcolor-y", `${wash.y.toFixed(1)}px`);
  node.style.setProperty("--kd-songcolor-reach", `${Math.ceil(wash.reach)}px`);
  node.style.setProperty("--kd-songcolor-wash", `${Math.round(ms)}ms`);
  node.style.setProperty("--kd-songcolor-ease", `cubic-bezier(${curve.join(", ")})`);
  node.dataset.wash = way;
}

const within = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

function SongColorLayer({ surface, leaving, onGone }: { surface: "bubble" | "lyrics"; leaving: boolean; onGone(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const swell = useRef<HTMLDivElement>(null);
  const level = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const setInk = useBackdropInk();
  const reduced = prefersReducedMotion();
  const [mountedAt] = useState(() => performance.now());

  // The colours of the playing song. Subscribed before the first paint, so a song whose colours
  // are already known is drawn in the layer's first frame.
  const [field, setField] = useState<SongColorField | null>(getSongColorField);
  useLayoutEffect(() => {
    const read = () => setField(getSongColorField());
    const stop = subscribeSongColorField(read);
    read();
    return stop;
  }, []);
  // The field that is shown, and under it the one it is replacing while the new one fades in.
  const [fields, setFields] = useState<readonly SongColorField[]>(() => field ? [field] : []);
  if (field && fields[fields.length - 1]?.key !== field.key) setFields([...fields.slice(-1), field]);
  const current = fields[fields.length - 1] ?? null;
  const settle = useCallback(() => setFields(list => list.length > 1 ? list.slice(-1) : list), []);
  useEffect(() => {
    if (fields.length < 2) return;
    // The fade's own end is the usual one; the timer covers a window in the background.
    const timer = window.setTimeout(settle, SONG_SWAP_IN_MS + 120);
    return () => window.clearTimeout(timer);
  }, [fields, settle]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    layers.add(node);
    return () => { layers.delete(node); };
  }, []);
  useLayoutEffect(() => () => setInk(null), [setInk]);

  // Arriving. A layer the key has just switched on spreads from the key; one that comes with
  // its surface (the drawer opening while the look is on) is simply there, or fades in when
  // its colours were not known yet. The surface takes the field's ink as the front passes its
  // middle, so its text is never light on the panel colour for long.
  const arrived = useRef(false);
  const inkTimer = useRef(0);
  const ink = current ? { ...current.palette.ink, base: current.palette.base } : null;
  const inkRef = useRef(ink);
  inkRef.current = ink;
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !current || leaving) return;
    if (arrived.current) {
      // Back from a drain that was cut short, or another song's colours.
      if (node.dataset.wash === "out" || node.dataset.wash === "fade-out") node.removeAttribute("data-wash");
      window.clearTimeout(inkTimer.current);
      setInk(inkRef.current);
      return;
    }
    arrived.current = true;
    const press = useSongColor.getState().wash;
    const pressed = press?.on && mountedAt - press.at < 400 && performance.now() - press.at < 2_000 ? press : null;
    if (!pressed || reduced) {
      if (pressed || performance.now() - mountedAt > 50) node.dataset.wash = "fade";
      setInk(inkRef.current);
      return;
    }
    // Every layer of this press is in the document when the commit is over: only then is the
    // circle that covers them all known.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !node.isConnected) return;
      const wash = washFrom(node, pressed);
      const ms = within(wash.reach / SPREAD_SPEED, SPREAD_MS);
      startWash(node, "in", wash, ms, SPREAD_EASE);
      inkTimer.current = window.setTimeout(() => setInk(inkRef.current), ms * easeTime(SPREAD_EASE, wash.centre));
    });
    return () => { cancelled = true; };
    // The palette is read through the ref: only another field, or a return from leaving, is news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, leaving]);
  useEffect(() => () => window.clearTimeout(inkTimer.current), []);

  // Leaving: the colour drains back into the key, quicker than it came, and the layer is taken
  // out when it is gone. Switched off any other way (a theme pack applied), it fades.
  useLayoutEffect(() => {
    if (!leaving) return;
    const node = root.current;
    const press = useSongColor.getState().wash;
    const pressed = press && !press.on && performance.now() - press.at < 1_000 ? press : null;
    let ms: number;
    window.clearTimeout(inkTimer.current);
    if (!node || !pressed || reduced || !arrived.current) {
      ms = reduced ? MOTION_REDUCED_MS : MOTION_MICRO_OUT_MS;
      if (node) node.dataset.wash = "fade-out";
      setInk(null);
    } else {
      const wash = washFrom(node, pressed);
      ms = within(wash.reach / DRAIN_SPEED, DRAIN_MS);
      startWash(node, "out", wash, ms, DRAIN_EASE);
      inkTimer.current = window.setTimeout(() => setInk(null), ms * easeTime(DRAIN_EASE, 1 - wash.centre));
    }
    const timer = window.setTimeout(onGone, ms + 30);
    return () => window.clearTimeout(timer);
  }, [leaving, onGone, reduced, setInk]);

  // In time with the song. The grid is the playing track's; the player's own reports say where
  // the song is, how fast it runs and whether it runs at all.
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const beat = songBeat(track);
  const trackId = track?.id ?? null;
  const shown = current !== null;
  useEffect(() => {
    const node = root.current, glowNode = glow.current, swellNode = swell.current, levelNode = level.current;
    if (!shown || reduced || !node || !glowNode || !swellNode || !levelNode || typeof glowNode.animate !== "function") return;
    const steps = beatSteps(beat);
    const timing = { duration: beat.cycleSec * 1000, iterations: Infinity };
    const pulses = [
      glowNode.animate(steps.map(step => ({
        offset: step.offset, easing: step.easing,
        opacity: GLOW_REST + (1 - GLOW_REST) * step.level,
        transform: `scale(${(1 + GLOW_SWELL * step.level).toFixed(4)})`,
      })), timing),
      swellNode.animate(steps.map(step => ({
        offset: step.offset, easing: step.easing,
        transform: `scale(${(1 + FIELD_SWELL * step.level).toFixed(4)})`,
      })), timing),
    ];
    for (const pulse of pulses) pulse.pause();

    const session = getPlayerSession();
    const latest = trackId === null ? null : getLatestPlayerSync(trackId);
    let playing = latest ? latest.action === "play" : session.trackId === trackId && session.playing;
    let position = latest?.position ?? (session.trackId === trackId ? session.position : 0);
    let rate = latest?.rate && latest.rate > 0 ? latest.rate : 1;
    let anchor: BeatAnchor | null = null, live = false, cycle = Number.NaN;
    // A layer that is in the document but not drawn (a sheet that is kept while closed) rests.
    let seen = true;

    const run = (on: boolean) => {
      if (on === live) return;
      live = on;
      // The drifting masses run and stop with the same word (SongColorBackdrop.css).
      node.toggleAttribute("data-live", on);
      for (const pulse of pulses) { if (on) pulse.play(); else pulse.pause(); }
      if (!on) anchor = null;
    };
    // Once a bar: how strong the pulse is and how fast the masses drift follow the song's
    // loudness there, read from its overview.
    const feel = () => {
      const index = beatCycleIndex(position, beat);
      if (index === cycle) return;
      cycle = index;
      const wave = trackId === null ? null : cachedReleaseOverviewWaveform(trackId);
      let energy = 0.6;
      if (wave && wave.source_start === undefined && wave.source_end === undefined) {
        let loud = loudness.get(wave);
        if (loud === undefined) { loud = waveLoudness(wave.amp); loudness.set(wave, loud); }
        energy = waveEnergy(wave.amp, loud, wave.duration, position, beat.cycleSec);
      }
      levelNode.style.opacity = (0.35 + 0.65 * energy).toFixed(2);
      const drift = 0.55 + 1.1 * energy;
      for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
        // The masses only: the wash and the change of song keep their own time.
        if ((animation as CSSAnimation).animationName?.startsWith("kd-songcolor-move")) animation.updatePlaybackRate(drift);
      }
    };
    const hear = () => {
      if (!playing || !seen || document.hidden) { run(false); return; }
      const now = performance.now();
      const to = beat.synced ? beatCorrection(anchor, position, rate, now, beat) : anchor ? null : 0;
      if (to !== null) {
        for (const pulse of pulses) {
          pulse.currentTime = to;
          if (Math.abs(pulse.playbackRate - rate) > 0.002) pulse.playbackRate = rate;
        }
        anchor = { time: to, at: now, rate };
      }
      run(true);
      feel();
    };
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || (detail.trackId != null && detail.trackId !== trackId)) return;
      if (detail.action === "play") playing = true;
      else if (detail.action === "pause") playing = false;
      if (typeof detail.position === "number") position = detail.position;
      if (typeof detail.rate === "number" && detail.rate > 0) rate = detail.rate;
      if (detail.action === "seek") anchor = null;
      hear();
    };
    hear();
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    document.addEventListener("visibilitychange", hear);
    const watcher = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      seen = entries[entries.length - 1].isIntersecting;
      hear();
    }) : null;
    watcher?.observe(node);
    return () => {
      watcher?.disconnect();
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
      document.removeEventListener("visibilitychange", hear);
      for (const pulse of pulses) pulse.cancel();
      node.removeAttribute("data-live");
    };
    // `beat` is rebuilt every render; its four values are what the animation is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduced, trackId, beat.cycleSec, beat.originSec, beat.synced, beat.accented]);

  return <div ref={root} className="kd-songcolor" data-surface={surface} data-source={current?.palette.source}
    onAnimationEnd={event => {
      // The spread leaves nothing on the layer once it is over; the drain holds its end until
      // the layer is taken out.
      if (event.target === event.currentTarget && (event.currentTarget.dataset.wash === "in" || event.currentTarget.dataset.wash === "fade")) {
        event.currentTarget.removeAttribute("data-wash");
      }
    }}>
    <div ref={swell} className="kd-songcolor-swell">
      {fields.map((shownField, index) => <div key={shownField.key} className="kd-songcolor-field"
        data-arriving={index > 0 || undefined} style={{ backgroundColor: shownField.palette.base } as CSSProperties}
        onAnimationEnd={event => { if (event.target === event.currentTarget) settle(); }}>
        {shownField.palette.masses.map((colour, mass) => <span key={mass} className="kd-songcolor-drift" data-mass={mass}>
          <Blobs colour={colour} blobs={MASS_BLOBS[mass]} />
        </span>)}
      </div>)}
    </div>
    <div ref={level} className="kd-songcolor-level">
      <div ref={glow} className="kd-songcolor-glow">
        {fields.map((shownField, index) => <Blobs key={shownField.key} className={index > 0 ? "kd-songcolor-arriving" : undefined}
          colour={shownField.palette.glow} blobs={GLOW_BLOB} strength={GLOW_PEAK_ALPHA} />)}
      </div>
    </div>
  </div>;
}

/**
 * The backdrop itself: give it to a surface's backdrop slot. `surface` says which of the two
 * it lies under, for where the glow sits. While the look is off it renders nothing; switched
 * off, it stays for the length of the drain.
 */
export function SongColorBackdrop({ surface }: { surface: "bubble" | "lyrics" }) {
  const on = useSongColor(state => state.on);
  const wanted = useSongColorAvailable() && on;
  const [present, setPresent] = useState(wanted);
  if (wanted && !present) setPresent(true);
  const gone = useCallback(() => setPresent(false), []);
  return present ? <SongColorLayer surface={surface} leaving={!wanted} onGone={gone} /> : null;
}
