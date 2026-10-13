import { useEffect, useRef, useState } from "react";
import "./MouseDemo.css";

/**
 * A little looping picture of a gesture, drawn with a cute mouse: the pointer does the thing on a
 * list while the mouse on the side squeezes along with it. One drawing serves every place that
 * teaches the gesture — the empty download queue (`drag-in`) and the tips drawer
 * (`src/components/download/SearchTipsPanel.tsx`) — so a new lesson is a new scene here.
 *
 * It is a still picture under reduced motion, and it stops while it is out of sight.
 */
export type MouseDemoScene = "pick-range" | "pick-toggle" | "drag-in" | "search" | "viz-tune" | "pip" | "player-keys";

/** What the picture shows for one moment; the next moment is `move` + `stay` later. */
interface Beat {
  /** Milliseconds the pointer takes to arrive here. */
  move: number;
  /** Milliseconds it waits before the next beat. */
  stay: number;
  cursor: readonly [number, number];
  /** The left button is down. */
  press?: boolean;
  /** The modifier key is held. */
  key?: boolean;
  /** Rows that are picked (pick scenes). */
  picked?: readonly number[];
  /** The song chip (drag-in): at home, carried by the pointer, or gone into the tray. */
  chip?: "home" | "held" | "landed";
  /** How much of the query is typed, 0–3 (search). */
  typed?: number;
  /** How many results have come in (search). */
  results?: number;
  /** The slider knob's place along its track, 0–1 (viz-tune). */
  knob?: number;
  /** The floating window's top-left corner (pip). */
  win?: readonly [number, number];
  /** The player bar's toggle keys that are on, 0–2 (player-keys). */
  keys?: readonly number[];
}

interface Scene {
  beats: readonly Beat[];
  /** The beat that is shown while nothing moves. */
  rest: number;
}

const ROWS = [0, 1, 2, 3, 4] as const;
const rowAt = (row: number): readonly [number, number] => [96, 15.5 + 20 * row];
const AWAY: readonly [number, number] = [132, 64];

const CHIP_HOME = [46, 40] as const;
const TRAY = [169, 56] as const;
const CORNER: readonly [number, number] = [30, 88];

const SCENES: Record<MouseDemoScene, Scene> = {
  "pick-range": {
    rest: 7,
    beats: [
      { move: 600, stay: 400, cursor: AWAY },
      { move: 650, stay: 200, cursor: rowAt(0) },
      { move: 80, stay: 380, cursor: rowAt(0), press: true, picked: [0] },
      { move: 0, stay: 150, cursor: rowAt(0), picked: [0] },
      { move: 200, stay: 650, cursor: rowAt(0), key: true, picked: [0] },
      { move: 700, stay: 200, cursor: rowAt(3), key: true, picked: [0] },
      { move: 80, stay: 420, cursor: rowAt(3), key: true, press: true, picked: [0, 1, 2, 3] },
      { move: 0, stay: 1100, cursor: rowAt(3), key: true, picked: [0, 1, 2, 3] },
      { move: 200, stay: 900, cursor: rowAt(3), picked: [0, 1, 2, 3] },
    ],
  },
  "pick-toggle": {
    rest: 10,
    beats: [
      { move: 600, stay: 400, cursor: AWAY },
      { move: 650, stay: 200, cursor: rowAt(0) },
      { move: 80, stay: 380, cursor: rowAt(0), press: true, picked: [0] },
      { move: 0, stay: 150, cursor: rowAt(0), picked: [0] },
      { move: 200, stay: 600, cursor: rowAt(0), key: true, picked: [0] },
      { move: 600, stay: 150, cursor: rowAt(2), key: true, picked: [0] },
      { move: 80, stay: 380, cursor: rowAt(2), key: true, press: true, picked: [0, 2] },
      { move: 0, stay: 150, cursor: rowAt(2), key: true, picked: [0, 2] },
      { move: 500, stay: 150, cursor: rowAt(4), key: true, picked: [0, 2] },
      { move: 80, stay: 380, cursor: rowAt(4), key: true, press: true, picked: [0, 2, 4] },
      { move: 0, stay: 1100, cursor: rowAt(4), key: true, picked: [0, 2, 4] },
      { move: 200, stay: 900, cursor: rowAt(4), picked: [0, 2, 4] },
    ],
  },
  search: {
    rest: 7,
    beats: [
      { move: 600, stay: 300, cursor: AWAY },
      { move: 600, stay: 200, cursor: [60, 17] },
      { move: 80, stay: 300, cursor: [60, 17], press: true },
      { move: 0, stay: 320, cursor: [60, 17], typed: 1 },
      { move: 0, stay: 320, cursor: [60, 17], typed: 2 },
      { move: 0, stay: 420, cursor: [60, 17], typed: 3 },
      { move: 0, stay: 300, cursor: [60, 17], typed: 3, key: true },
      { move: 0, stay: 1400, cursor: [60, 17], typed: 3, key: true, results: 3 },
      { move: 0, stay: 800, cursor: [60, 17], typed: 3, results: 3 },
    ],
  },
  "viz-tune": {
    rest: 4,
    beats: [
      { move: 600, stay: 300, cursor: [20, 100], knob: 0 },
      { move: 80, stay: 250, cursor: [20, 100], press: true, knob: 0 },
      { move: 1100, stay: 300, cursor: [124, 100], press: true, knob: 1 },
      { move: 0, stay: 400, cursor: [124, 100], knob: 1 },
      { move: 0, stay: 1100, cursor: [124, 100], knob: 1 },
      { move: 900, stay: 300, cursor: [20, 100], knob: 0 },
    ],
  },
  pip: {
    rest: 4,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, win: [100, 66] },
      { move: 600, stay: 200, cursor: [110, 71], win: [100, 66] },
      { move: 80, stay: 250, cursor: [110, 71], press: true, win: [100, 66] },
      { move: 1000, stay: 250, cursor: [28, 19], press: true, win: [18, 14] },
      { move: 0, stay: 1400, cursor: [28, 19], win: [18, 14] },
      { move: 700, stay: 300, cursor: AWAY, win: [18, 14] },
      { move: 400, stay: 100, cursor: AWAY, win: [100, 66] },
    ],
  },
  "player-keys": {
    rest: 5,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, keys: [] },
      { move: 600, stay: 150, cursor: [140, 56], keys: [] },
      { move: 80, stay: 400, cursor: [140, 56], press: true, keys: [0] },
      { move: 400, stay: 150, cursor: [164, 56], keys: [0] },
      { move: 80, stay: 400, cursor: [164, 56], press: true, keys: [0, 1] },
      { move: 400, stay: 150, cursor: [188, 56], keys: [0, 1] },
      { move: 80, stay: 400, cursor: [188, 56], press: true, keys: [0, 1, 2] },
      { move: 0, stay: 1300, cursor: [188, 56], keys: [0, 1, 2] },
      { move: 600, stay: 300, cursor: AWAY, keys: [] },
    ],
  },
  "drag-in": {
    rest: 4,
    beats: [
      { move: 600, stay: 300, cursor: CORNER, chip: "home" },
      { move: 600, stay: 150, cursor: CHIP_HOME, chip: "home" },
      { move: 80, stay: 250, cursor: CHIP_HOME, press: true, chip: "held" },
      { move: 1100, stay: 200, cursor: TRAY, press: true, chip: "held" },
      { move: 300, stay: 1000, cursor: TRAY, chip: "landed" },
      { move: 700, stay: 300, cursor: CORNER, chip: "landed" },
      { move: 0, stay: 500, cursor: CORNER, chip: "home" },
    ],
  },
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier key a scene holds, as it is written on the keycap. */
function keyLabel(scene: MouseDemoScene): string | null {
  if (scene === "pick-range") return "Shift";
  if (scene === "pick-toggle") return isMac() ? "⌘" : "Ctrl";
  if (scene === "search") return "Enter";
  return null;
}

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** True while the picture is on screen and the window is in view. */
function useSeen(node: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    let visible = true, shown = typeof document === "undefined" || document.visibilityState !== "hidden";
    const update = () => setSeen(visible && shown);
    const onVisibility = () => { shown = document.visibilityState !== "hidden"; update(); };
    document.addEventListener("visibilitychange", onVisibility);
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(entries => {
        const last = entries[entries.length - 1];
        if (last) { visible = last.isIntersecting; update(); }
      });
      observer.observe(element);
    }
    update();
    return () => { document.removeEventListener("visibilitychange", onVisibility); observer?.disconnect(); };
  }, [node]);
  return seen;
}

/** The mouse's face alone, small: where a place wants the character without a scene. */
export function MouseFace({ className }: { className?: string }) {
  return <svg className={`kd-demo-face ${className ?? ""}`} viewBox="-14 -19 28 52" aria-hidden="true" focusable="false">
    <path className="kd-demo-cable" d="M0 15 q0 7 7 8 t9 6" />
    <path className="kd-demo-mouse-body" d="M-11 -5 A11 11 0 0 1 11 -5 V5 A11 11 0 0 1 -11 5 Z" />
    <path className="kd-demo-mouse-btn" d="M-11 -5 A11 11 0 0 1 0 -16 V-4 H-11 Z" />
    <path className="kd-demo-mouse-seam" d="M-11 -4 H11 M0 -16 V-4" />
    <circle className="kd-demo-eye" cx="-4" cy="5" r="1.4" />
    <circle className="kd-demo-eye" cx="4" cy="5" r="1.4" />
    <circle className="kd-demo-blush" cx="-7.4" cy="8.4" r="1.7" />
    <circle className="kd-demo-blush" cx="7.4" cy="8.4" r="1.7" />
    <path className="kd-demo-smile" d="M-2.4 8.6 Q0 11 2.4 8.6" />
  </svg>;
}

/** The cute mouse at the side: it follows the pointer a little and squeezes when it clicks. */
function Buddy({ at, cursor, press }: { at: readonly [number, number]; cursor: readonly [number, number]; press: boolean }) {
  const lean = [(cursor[0] - 110) / 22, (cursor[1] - 56) / 20] as const;
  return <g className="kd-demo-buddy" style={{ transform: `translate(${at[0] + lean[0]}px, ${at[1] + lean[1]}px)` }}>
    <g className="kd-demo-mouse" data-press={press || undefined}>
      <path className="kd-demo-cable" d="M0 15 q0 7 7 8 t9 6" />
      <path className="kd-demo-mouse-body" d="M-11 -5 A11 11 0 0 1 11 -5 V5 A11 11 0 0 1 -11 5 Z" />
      <path className="kd-demo-mouse-btn" data-on={press || undefined} d="M-11 -5 A11 11 0 0 1 0 -16 V-4 H-11 Z" />
      <path className="kd-demo-mouse-seam" d="M-11 -4 H11 M0 -16 V-4" />
      <circle className="kd-demo-eye" cx="-4" cy="5" r="1.4" />
      <circle className="kd-demo-eye" cx="4" cy="5" r="1.4" />
      <circle className="kd-demo-blush" cx="-7.4" cy="8.4" r="1.7" />
      <circle className="kd-demo-blush" cx="7.4" cy="8.4" r="1.7" />
      <path className="kd-demo-smile" d="M-2.4 8.6 Q0 11 2.4 8.6" />
    </g>
  </g>;
}

export function MouseDemo({ scene, label, tray = "download" }: {
  scene: MouseDemoScene;
  /** What the picture says, for assistive technology. */
  label?: string;
  /** The tray's mark in `drag-in`: what the thing is dropped on. */
  tray?: "download" | "export";
}) {
  const root = useRef<SVGSVGElement>(null);
  const seen = useSeen(root);
  const [still] = useState(prefersReducedMotion);
  const { beats, rest } = SCENES[scene];
  const [at, setAt] = useState(still ? rest : 0);
  const moving = seen && !still;
  useEffect(() => {
    if (!moving) return;
    const beat = beats[at];
    const timer = window.setTimeout(() => setAt((at + 1) % beats.length), beat.move + beat.stay);
    return () => window.clearTimeout(timer);
  }, [moving, at, beats]);
  useEffect(() => { if (still) setAt(rest); }, [still, rest]);

  const beat = beats[at];
  const picked = beat.picked ?? [];
  const press = !!beat.press;
  const key = keyLabel(scene);
  const duration = `${beat.move}ms`;
  const drag = scene === "drag-in";
  const chip = beat.chip ?? "home";
  const carried: readonly [number, number] = chip === "held"
    ? [beat.cursor[0] - CHIP_HOME[0], beat.cursor[1] - CHIP_HOME[1]]
    : chip === "landed" ? [TRAY[0] - CHIP_HOME[0], TRAY[1] - CHIP_HOME[1]] : [0, 0];
  const gone = chip === "landed";
  const hot = drag && (chip === "held" && at >= 3 || gone);
  return <svg ref={root} className="kd-demo" viewBox="0 0 220 112" role={label ? "img" : undefined}
    aria-label={label} aria-hidden={label ? undefined : true} data-scene={scene}>
    {scene === "search" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="140" height="18" rx="9" />
      <circle className="kd-demo-glass" cx="21" cy="17" r="3.6" />
      <path className="kd-demo-glass" d="M23.8 19.8 L27 23" />
      {[18, 40, 62].map((w, i) => <rect key={w} className="kd-demo-line" x="34" y="15.2" width={w} height="3.6" rx="1.8"
        style={{ opacity: (beat.typed ?? 0) > i ? 1 : 0 }} />)}
      <rect className="kd-demo-caret" x={34 + [0, 18, 40, 62][beat.typed ?? 0] + 3} y="12.5" width="1.4" height="9" rx="0.7" />
      {[0, 1, 2].map(i => <g key={i} transform={`translate(8 ${36 + 22 * i})`} className="kd-demo-result"
        style={{ opacity: (beat.results ?? 0) > i ? 1 : 0, transitionDelay: `${i * 90}ms` }}>
        <rect className="kd-demo-row-base" width="140" height="17" rx="4" />
        <rect className="kd-demo-cover" x="4" y="3.5" width="10" height="10" rx="2" />
        <rect className="kd-demo-line" x="20" y="4.5" width="60" height="3" rx="1.5" />
        <rect className="kd-demo-line" data-faint="" x="20" y="10" width="36" height="2.5" rx="1.25" />
      </g>)}
    </g> : scene === "pip" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="140" height="96" rx="8" />
      <rect className="kd-demo-line" x="18" y="82" width="60" height="3.4" rx="1.7" />
      <rect className="kd-demo-line" data-faint="" x="18" y="90" width="38" height="3" rx="1.5" />
      <g className="kd-demo-chip" style={{
        transform: `translate(${(beat.win ?? [100, 66])[0]}px, ${(beat.win ?? [100, 66])[1]}px)`,
        transitionDuration: `${beat.win && beat.win[0] > 90 && beat.move === 400 ? 0 : beat.move}ms, 0ms`,
        transformBox: "view-box", transformOrigin: "0 0",
      }}>
        <rect className="kd-demo-chip-body" width="46" height="30" rx="6" />
        <rect className="kd-demo-key-lip" x="0" y="0" width="46" height="8" rx="4" />
        <path className="kd-demo-playmark" d="M19 13 V25 L29 19 Z" />
      </g>
    </g> : scene === "player-keys" ? <g>
      <rect className="kd-demo-row-base" x="8" y="38" width="204" height="36" rx="10" />
      <rect className="kd-demo-cover" x="16" y="46" width="20" height="20" rx="4" />
      <rect className="kd-demo-line" x="42" y="50" width="34" height="4" rx="2" />
      <rect className="kd-demo-line" data-faint="" x="42" y="58" width="22" height="3.4" rx="1.7" />
      <path className="kd-demo-playmark" d="M96 49 V63 L108 56 Z" />
      <circle className="kd-demo-line" cx="120" cy="56" r="0" />
      {[0, 1, 2].map(i => <g key={i} transform={`translate(${140 + 24 * i} 56)`} className="kd-demo-togglekey"
        data-on={(beat.keys ?? []).includes(i) || undefined}>
        {i === 0 && <path d="M-5 -2 H4 M1 -5 L4.5 -2 L1 1 M5 3 H-4 M-1 0 L-4.5 3 L-1 6" />}
        {i === 1 && <path d="M-5 -4 H5 M-5 0 H3 M-5 4 H5" />}
        {i === 2 && <><rect x="-6" y="-4.5" width="12" height="9" rx="2" /><rect x="0" y="0" width="5" height="3.5" rx="1" /></>}
      </g>)}
    </g> : scene === "viz-tune" ? <g>
      <g className="kd-demo-bars" style={{ transform: `scaleY(${0.35 + 0.65 * (beat.knob ?? 0)})`, transitionDuration: `${beat.move}ms` }}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => <rect key={i} className="kd-demo-bar" x={10 + 14.2 * i} y="8" width="9" height="78" rx="4.5"
          style={{ animationDelay: `${-((i * 337) % 1000)}ms`, animationDuration: `${900 + (i * 131) % 500}ms` }} />)}
      </g>
      <rect className="kd-demo-row-base" x="8" y="97" width="132" height="6" rx="3" />
      <rect className="kd-demo-fill" x="8" y="97" width="132" height="6" rx="3"
        style={{ transform: `scaleX(${0.12 + 0.76 * (beat.knob ?? 0)})`, transitionDuration: `${beat.move}ms` }} />
      <circle className="kd-demo-knob" cy="100" r="6.5" cx="20"
        style={{ transform: `translateX(${104 * (beat.knob ?? 0)}px)`, transitionDuration: `${beat.move}ms` }} />
    </g> : drag ? <g>
      <g className="kd-demo-tray" data-hot={hot || undefined} transform={`translate(${TRAY[0]} ${TRAY[1]})`}>
        <g className="kd-demo-tray-pop">
          <rect className="kd-demo-tray-box" x="-43" y="-42" width="86" height="84" rx="12" />
          <path className="kd-demo-tray-mark" data-gone={gone || undefined}
            d={tray === "download" ? "M0 -9 V6 M-6.5 0 L0 7 L6.5 0" : "M-6 6 L6 -6 M-1 -6.5 H6.5 V1"} />
          <path className="kd-demo-tick" data-on={gone || undefined} d="M-8 0 l5.5 5.5 l10.5 -11.5" />
        </g>
      </g>
      <g className="kd-demo-chip" style={{
        transform: `translate(${carried[0]}px, ${carried[1]}px) scale(${gone ? 0.5 : chip === "held" ? 1.05 : 1})`,
        opacity: gone ? 0 : 1,
        transitionDuration: `${chip === "home" ? 0 : beat.move}ms, 260ms`,
      }}>
        <g transform={`translate(${CHIP_HOME[0] - 38} ${CHIP_HOME[1] - 15})`}>
          <rect className="kd-demo-chip-body" width="76" height="30" rx="8" />
          <rect className="kd-demo-cover" x="6" y="6" width="18" height="18" rx="4" />
          <rect className="kd-demo-line" x="30" y="9" width="36" height="4" rx="2" />
          <rect className="kd-demo-line" data-faint="" x="30" y="17" width="24" height="3.4" rx="1.7" />
        </g>
      </g>
    </g> : <g>
      {ROWS.map(row => <g key={row} transform={`translate(8 ${8 + 20 * row})`}>
        <rect className="kd-demo-row-base" width="140" height="15" rx="4" />
        <rect className="kd-demo-row-pick" data-on={picked.includes(row) || undefined} width="140" height="15" rx="4" />
        <rect className="kd-demo-cover" x="4" y="3" width="9" height="9" rx="2" />
        <rect className="kd-demo-line" x="18" y="3.5" width="52" height="3" rx="1.5" />
        <rect className="kd-demo-line" data-faint="" x="18" y="9" width="32" height="2.5" rx="1.25" />
        <path className="kd-demo-tick" data-on={picked.includes(row) || undefined} d="M126 7.6 l3 3 l6 -6.6" />
      </g>)}
    </g>}
    {key && <g transform="translate(162 6)">
      <g className="kd-demo-key" data-down={beat.key || undefined}>
        <rect className="kd-demo-key-lip" y="3" width="50" height="20" rx="6" />
        <g className="kd-demo-key-top">
          <rect className="kd-demo-key-face" width="50" height="20" rx="6" />
          <text className="kd-demo-key-text" x="25" y="13.6" textAnchor="middle">{key}</text>
        </g>
      </g>
    </g>}
    <Buddy at={drag ? [92, 88] : scene === "player-keys" ? [110, 94] : scene === "viz-tune" || scene === "pip" ? [188, 62] : [190, 76]} cursor={beat.cursor} press={press} />
    <g className="kd-demo-pointer" style={{ transform: `translate(${beat.cursor[0]}px, ${beat.cursor[1]}px)`, transitionDuration: duration }}>
      {press && <circle key={at} className="kd-demo-ping" r="7" />}
      <path className="kd-demo-cursor" d="M0 0 V12.5 L3.4 9.6 L5.6 14.6 L8 13.5 L5.8 8.7 H10 Z" />
    </g>
  </svg>;
}
