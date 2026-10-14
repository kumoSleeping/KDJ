import { useEffect, useRef, useState } from "react";
import "./PointerDemo.css";

/**
 * A little looping picture of a gesture: a small pointer does the thing on a drawn list, with the
 * key it needs beside it. One drawing serves every place that teaches the gesture — the empty download queue (`drag-in`), the tips drawer
 * (`src/components/download/SearchTipsPanel.tsx`) and the login by Cookie-Editor (`cookie-export`) — so a new lesson is a new scene here.
 *
 * It is a still picture under reduced motion, and it stops while it is out of sight.
 */
export type PointerDemoScene = "pick-range" | "pick-toggle" | "drag-in" | "search" | "viz-tune" | "pip" | "player-keys"
  | "menu-toss" | "multi-copy" | "add-folder" | "analyze"
  | "platforms" | "kind-switch" | "sidebar-online" | "viz-export" | "mini-player" | "cookie-export" | "login";

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
  chip?: "home" | "held" | "lift" | "landed";
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
  /** The right-click menu is open, and which of its items the pointer is on (menu-toss). */
  menu?: boolean;
  item?: number;
  /** What the held key says, in place of the scene's own (multi-copy: ⌘C, ⌘V). */
  keyText?: string;
  /** The folder that is copied into: chosen, then done (multi-copy). */
  folder?: "on" | "done";
  /** How many new folders have come into the list, 0–2 (add-folder). */
  added?: number;
  /** Key and tempo: 0 waiting, 1 working, 2 tempo in, 3 both in (analyze). */
  analysis?: number;
  /** The place of each source mark in the row, by mark; the one that is carried; the ones off (platforms). */
  order?: readonly number[];
  held?: number;
  off?: readonly number[];
  /** Which search type the field has, 0–2 (kind-switch). */
  kind?: number;
  /** The sidebar row that is open, or -1 (sidebar-online). */
  side?: number;
  /** The window is taken down to the desktop's corner (mini-player). */
  mini?: boolean;
  /** The floating window's size, 1 = as it opens (pip). */
  winScale?: number;
  /** The export has been asked for (viz-export); the login is on the clipboard (cookie-export). */
  exported?: boolean;
  /** The extension's little window is open, and what in it the pointer is on (cookie-export; `menu` is its Export menu). */
  pop?: boolean;
  over?: "export" | "json";
}

interface Scene {
  beats: readonly Beat[];
  /** The beat that is shown while nothing moves. */
  rest: number;
}

const ROWS = [0, 1, 2, 3, 4] as const;
const rowAt = (row: number): readonly [number, number] => [96, 15.5 + 20 * row];
const AWAY: readonly [number, number] = [200, 96];

const CHIP_HOME = [46, 40] as const;
const TRAY = [169, 56] as const;
const CORNER: readonly [number, number] = [30, 88];
const LIFT: readonly [number, number] = [100, 18];
const COOKIE: readonly [number, number] = [179, 19];
const mod = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
/** A key with the modifier, as the platform writes it: ⌘C on a Mac, Ctrl+C elsewhere. */
export const chord = (key: string) => mod() === "⌘" ? `⌘${key}` : `Ctrl+${key}`;

const SCENES: Record<PointerDemoScene, Scene> = {
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
      { move: 600, stay: 300, cursor: [20, 93], knob: 0 },
      { move: 80, stay: 250, cursor: [20, 93], press: true, knob: 0 },
      { move: 1100, stay: 300, cursor: [124, 93], press: true, knob: 1 },
      { move: 0, stay: 400, cursor: [124, 93], knob: 1 },
      { move: 0, stay: 1100, cursor: [124, 93], knob: 1 },
      { move: 900, stay: 300, cursor: [20, 93], knob: 0 },
    ],
  },
  pip: {
    rest: 6,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, win: [150, 66] },
      { move: 600, stay: 200, cursor: [160, 71], win: [150, 66] },
      { move: 80, stay: 250, cursor: [160, 71], press: true, win: [150, 66] },
      { move: 1000, stay: 250, cursor: [28, 19], press: true, win: [18, 14] },
      { move: 0, stay: 300, cursor: [28, 19], win: [18, 14] },
      { move: 500, stay: 150, cursor: [64, 44], win: [18, 14] },
      { move: 80, stay: 200, cursor: [64, 44], press: true, win: [18, 14] },
      { move: 700, stay: 200, cursor: [101, 68], press: true, win: [18, 14], winScale: 1.8 },
      { move: 0, stay: 1300, cursor: [101, 68], win: [18, 14], winScale: 1.8 },
      { move: 700, stay: 300, cursor: AWAY, win: [18, 14], winScale: 1.8 },
      { move: 400, stay: 100, cursor: AWAY, win: [150, 66], winScale: 1 },
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
  "menu-toss": {
    rest: 6,
    beats: [
      { move: 600, stay: 300, cursor: CORNER, chip: "home" },
      { move: 600, stay: 150, cursor: CHIP_HOME, chip: "home" },
      { move: 80, stay: 350, cursor: CHIP_HOME, press: true, chip: "home", menu: true },
      { move: 450, stay: 200, cursor: [66, 74], chip: "home", menu: true, item: 1 },
      { move: 80, stay: 150, cursor: [66, 74], press: true, chip: "home", menu: true, item: 1 },
      { move: 380, stay: 0, cursor: [66, 74], chip: "lift" },
      { move: 380, stay: 1000, cursor: [66, 74], chip: "landed" },
      { move: 600, stay: 300, cursor: CORNER, chip: "landed" },
      { move: 0, stay: 500, cursor: CORNER, chip: "home" },
    ],
  },
  "multi-copy": {
    rest: 10,
    beats: [
      { move: 600, stay: 300, cursor: AWAY },
      { move: 600, stay: 200, cursor: rowAt(0) },
      { move: 80, stay: 300, cursor: rowAt(0), press: true, picked: [0] },
      { move: 200, stay: 400, cursor: rowAt(0), key: true, picked: [0] },
      { move: 500, stay: 150, cursor: rowAt(2), key: true, picked: [0] },
      { move: 80, stay: 300, cursor: rowAt(2), key: true, press: true, picked: [0, 2] },
      { move: 0, stay: 600, cursor: rowAt(2), key: true, keyText: chord("C"), picked: [0, 2] },
      { move: 700, stay: 150, cursor: [186, 74], picked: [0, 2] },
      { move: 80, stay: 250, cursor: [186, 74], press: true, folder: "on", picked: [0, 2] },
      { move: 0, stay: 500, cursor: [186, 74], key: true, keyText: chord("V"), folder: "on", picked: [0, 2] },
      { move: 0, stay: 1300, cursor: [186, 74], key: true, keyText: chord("V"), folder: "done", picked: [0, 2] },
      { move: 300, stay: 300, cursor: [186, 74], folder: "done" },
    ],
  },
  "add-folder": {
    rest: 5,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, added: 0 },
      { move: 650, stay: 200, cursor: [138, 17], added: 0 },
      { move: 80, stay: 400, cursor: [138, 17], press: true, added: 1 },
      { move: 0, stay: 700, cursor: [138, 17], added: 1 },
      { move: 0, stay: 300, cursor: [138, 17], added: 2 },
      { move: 0, stay: 1300, cursor: [138, 17], added: 2 },
      { move: 500, stay: 300, cursor: AWAY, added: 2 },
    ],
  },
  analyze: {
    rest: 4,
    beats: [
      { move: 0, stay: 900, cursor: AWAY, analysis: 0 },
      { move: 0, stay: 1100, cursor: AWAY, analysis: 1 },
      { move: 0, stay: 600, cursor: AWAY, analysis: 2 },
      { move: 0, stay: 1800, cursor: AWAY, analysis: 3 },
    ],
  },
  platforms: {
    rest: 7,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, order: [0, 1, 2, 3] },
      { move: 600, stay: 150, cursor: [110, 40], order: [0, 1, 2, 3] },
      { move: 80, stay: 250, cursor: [110, 40], press: true, held: 2, order: [0, 1, 2, 3] },
      { move: 700, stay: 150, cursor: [30, 40], press: true, held: 2, order: [1, 2, 0, 3] },
      { move: 0, stay: 500, cursor: [30, 40], order: [1, 2, 0, 3] },
      { move: 500, stay: 150, cursor: [150, 40], order: [1, 2, 0, 3] },
      { move: 80, stay: 300, cursor: [150, 40], press: true, order: [1, 2, 0, 3], off: [3] },
      { move: 0, stay: 1300, cursor: [150, 40], order: [1, 2, 0, 3], off: [3] },
      { move: 500, stay: 300, cursor: AWAY, order: [1, 2, 0, 3], off: [3] },
      { move: 300, stay: 100, cursor: AWAY, order: [0, 1, 2, 3] },
    ],
  },
  "kind-switch": {
    rest: 5,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, kind: 0 },
      { move: 600, stay: 200, cursor: [36, 19], kind: 0 },
      { move: 80, stay: 450, cursor: [36, 19], press: true, kind: 1 },
      { move: 0, stay: 600, cursor: [36, 19], kind: 1, results: 3 },
      { move: 500, stay: 150, cursor: [70, 46], kind: 1, results: 3 },
      { move: 80, stay: 1300, cursor: [70, 46], press: true, kind: 1, results: 3, picked: [0] },
      { move: 500, stay: 300, cursor: AWAY, kind: 1, results: 3, picked: [0] },
      { move: 0, stay: 100, cursor: AWAY, kind: 0 },
    ],
  },
  "sidebar-online": {
    rest: 6,
    beats: [
      { move: 600, stay: 300, cursor: AWAY, side: -1 },
      { move: 600, stay: 200, cursor: [40, 46], side: -1 },
      { move: 80, stay: 300, cursor: [40, 46], press: true, side: 0 },
      { move: 0, stay: 900, cursor: [40, 46], side: 0, results: 3 },
      { move: 500, stay: 150, cursor: [40, 66], side: 0, results: 3 },
      { move: 80, stay: 200, cursor: [40, 66], press: true, side: 1 },
      { move: 0, stay: 1300, cursor: [40, 66], side: 1, results: 3 },
      { move: 500, stay: 300, cursor: AWAY, side: 1, results: 3 },
      { move: 0, stay: 100, cursor: AWAY, side: -1 },
    ],
  },
  "viz-export": {
    rest: 3,
    beats: [
      { move: 600, stay: 300, cursor: [196, 36] },
      { move: 700, stay: 200, cursor: [192, 92] },
      { move: 80, stay: 300, cursor: [192, 92], press: true, exported: true },
      { move: 0, stay: 1500, cursor: [192, 92], exported: true },
      { move: 500, stay: 300, cursor: [196, 36], exported: true },
      { move: 0, stay: 100, cursor: [196, 36] },
    ],
  },
  "mini-player": {
    rest: 3,
    beats: [
      { move: 600, stay: 300, cursor: AWAY },
      { move: 600, stay: 200, cursor: [198, 18] },
      { move: 80, stay: 300, cursor: [198, 18], press: true },
      { move: 650, stay: 1500, cursor: [198, 18], mini: true },
      { move: 500, stay: 150, cursor: [176, 92], mini: true },
      { move: 80, stay: 250, cursor: [176, 92], press: true, mini: true },
      { move: 650, stay: 1000, cursor: [176, 92] },
      { move: 400, stay: 100, cursor: AWAY },
    ],
  },
  login: {
    rest: 4,
    beats: [
      { move: 600, stay: 300, cursor: AWAY },
      { move: 650, stay: 200, cursor: [132, 25] },
      { move: 80, stay: 350, cursor: [132, 25], press: true },
      { move: 0, stay: 500, cursor: [132, 25], picked: [0] },
      { move: 0, stay: 1500, cursor: [132, 25], picked: [0], exported: true },
      { move: 500, stay: 400, cursor: AWAY, picked: [0], exported: true },
      { move: 0, stay: 100, cursor: AWAY },
    ],
  },
  "cookie-export": {
    rest: 7,
    beats: [
      { move: 600, stay: 300, cursor: [112, 76] },
      { move: 700, stay: 250, cursor: COOKIE },
      { move: 80, stay: 500, cursor: COOKIE, press: true, pop: true },
      { move: 650, stay: 250, cursor: [184, 96], pop: true, over: "export" },
      { move: 80, stay: 450, cursor: [184, 96], press: true, pop: true, over: "export", menu: true },
      { move: 400, stay: 250, cursor: [172, 62], pop: true, menu: true, over: "json" },
      { move: 80, stay: 300, cursor: [172, 62], press: true, pop: true, menu: true, over: "json" },
      { move: 0, stay: 1700, cursor: [172, 62], pop: true, exported: true },
      { move: 600, stay: 500, cursor: [112, 76], exported: true },
      { move: 0, stay: 200, cursor: [112, 76] },
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
function keyLabel(scene: PointerDemoScene): string | null {
  if (scene === "pick-range") return "Shift";
  if (scene === "pick-toggle") return isMac() ? "⌘" : "Ctrl";
  if (scene === "search") return "Enter";
  if (scene === "multi-copy") return mod();
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

export function PointerDemo({ scene, label, tray = "download", onLoop }: {
  scene: PointerDemoScene;
  /** Called each time the picture has played through and starts over. */
  onLoop?(): void;
  /** What the picture says, for assistive technology. */
  label?: string;
  /** The tray's mark in `drag-in`: what the thing is dropped on. */
  tray?: "download" | "export" | "visualize" | "share";
}) {
  const root = useRef<SVGSVGElement>(null);
  const seen = useSeen(root);
  const [still] = useState(prefersReducedMotion);
  const loop = useRef(onLoop);
  loop.current = onLoop;
  const { beats, rest } = SCENES[scene];
  const [place, setPlace] = useState({ scene, at: still ? rest : 0 });
  // A scene has its own number of beats: a place that belongs to another scene starts over.
  const at = place.scene === scene && place.at < beats.length ? place.at : still ? rest : 0;
  const moving = seen && !still;
  useEffect(() => {
    if (!moving) return;
    const beat = beats[at];
    const timer = window.setTimeout(() => {
      const next = (at + 1) % beats.length;
      setPlace({ scene, at: next });
      if (next === 0) loop.current?.();
    }, beat.move + beat.stay);
    return () => window.clearTimeout(timer);
  }, [moving, at, beats, scene]);

  const beat = beats[at];
  const picked = beat.picked ?? [];
  const press = !!beat.press;
  const key = keyLabel(scene);
  const keyText = beat.keyText ?? key;
  const duration = `${beat.move}ms`;
  const drag = scene === "drag-in" || scene === "menu-toss";
  const chip = beat.chip ?? "home";
  const carried: readonly [number, number] = chip === "held"
    ? [beat.cursor[0] - CHIP_HOME[0], beat.cursor[1] - CHIP_HOME[1]]
    : chip === "lift" ? [LIFT[0] - CHIP_HOME[0], LIFT[1] - CHIP_HOME[1]]
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
    </g> : scene === "platforms" ? <g>
      <rect className="kd-demo-row-base" x="8" y="20" width="204" height="40" rx="20" />
      {[0, 1, 2, 3].map(i => {
        const slot = (beat.order ?? [0, 1, 2, 3])[i];
        const held = beat.held === i;
        const x = held ? beat.cursor[0] : 30 + 40 * slot;
        return <g key={i} className="kd-demo-chip" style={{
          transform: `translate(${x}px, 40px) scale(${held ? 1.12 : 1})`,
          opacity: (beat.off ?? []).includes(i) ? 0.3 : 1,
          transitionDuration: `${held ? beat.move : Math.max(beat.move, 280)}ms, 260ms`,
        }}>
          <circle className="kd-demo-chip-body" r="12" />
          <text className="kd-demo-key-text" x="0" y="3.6" textAnchor="middle" style={{ fill: "var(--kd-text)" }}>{["●", "▲", "■", "◆"][i]}</text>
        </g>;
      })}
      <rect className="kd-demo-line" x="178" y="38" width="26" height="4" rx="2" />
    </g> : scene === "kind-switch" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="204" height="22" rx="11" />
      <rect className="kd-demo-chip-body" x="13" y="11.5" width="46" height="15" rx="7.5" />
      <text className="kd-demo-key-text" x="36" y="22.2" textAnchor="middle" style={{ fill: "var(--kd-text)" }}>{["单曲", "歌单", "艺术家"][beat.kind ?? 0]}</text>
      <rect className="kd-demo-line" x="68" y="17" width="56" height="4" rx="2" />
      {[0, 1, 2].map(i => <g key={i} transform={`translate(8 ${38 + 22 * i})`} className="kd-demo-result"
        style={{ opacity: (beat.results ?? 0) > i ? 1 : 0, transitionDelay: `${i * 90}ms` }}>
        <rect className="kd-demo-row-base" width="204" height="18" rx="5" />
        <rect className="kd-demo-row-pick" data-on={picked.includes(i) || undefined} width="204" height="18" rx="5" />
        <rect className="kd-demo-cover" x="5" y="4" width="10" height="10" rx="2" />
        <rect className="kd-demo-line" x="22" y="5" width="70" height="3.4" rx="1.7" />
        <rect className="kd-demo-line" data-faint="" x="22" y="11" width="40" height="2.8" rx="1.4" />
        <path className="kd-demo-tick" data-on={picked.includes(i) || undefined} d="M186 9 l3 3 l6 -6.6" />
      </g>)}
    </g> : scene === "sidebar-online" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="64" height="96" rx="8" />
      {[0, 1, 2, 3].map(i => <g key={i} transform={`translate(13 ${20 + 20 * i})`}>
        <rect className="kd-demo-row-pick" data-on={beat.side === i || undefined} width="54" height="15" rx="4" />
        <rect className="kd-demo-cover" x="4" y="3.5" width="8" height="8" rx="2" />
        <rect className="kd-demo-line" x="17" y="5.5" width={[26, 20, 30, 22][i]} height="3.4" rx="1.7" />
      </g>)}
      {[0, 1, 2].map(i => <g key={`${beat.side}-${i}`} transform={`translate(80 ${20 + 22 * i})`} className="kd-demo-result"
        style={{ opacity: (beat.results ?? 0) > i ? 1 : 0, transitionDelay: `${i * 90}ms` }}>
        <rect className="kd-demo-row-base" width="132" height="18" rx="5" />
        <rect className="kd-demo-cover" x="5" y="4" width="10" height="10" rx="2" />
        <rect className="kd-demo-line" x="22" y="5" width={[56, 44, 64][i]} height="3.4" rx="1.7" />
        <rect className="kd-demo-line" data-faint="" x="22" y="11" width="34" height="2.8" rx="1.4" />
      </g>)}
    </g> : scene === "viz-export" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="204" height="96" rx="8" />
      <g className="kd-demo-bars" style={{ transform: "scaleY(0.9)" }}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => <rect key={i} className="kd-demo-bar" x={20 + 17 * i} y="16" width="10" height="70" rx="5"
          style={{ animationDelay: `${-((i * 337) % 1000)}ms`, animationDuration: `${900 + (i * 131) % 500}ms` }} />)}
      </g>
      <g transform="translate(168 84)" className="kd-demo-folder" data-on={beat.exported || undefined}>
        <rect className="kd-demo-folder-body" width="38" height="15" rx="5" />
        <path className="kd-demo-tray-mark" data-gone={beat.exported || undefined} d="M19 3.5 V9.5 M16 7 L19 10 L22 7" />
        <path className="kd-demo-tick" data-on={beat.exported || undefined} d="M14 7.5 l3.4 3.4 l7 -7.4" />
      </g>
    </g> : scene === "login" ? <g>
      {/* The sources of the sidebar, signed out: 登录 beside one, and downloading comes within reach. */}
      {[0, 1, 2].map(i => <g key={i} transform={`translate(8 ${12 + 28 * i})`}>
        <rect className="kd-demo-row-base" width="140" height="22" rx="6" />
        <circle className="kd-demo-cover" cx="13" cy="11" r="6" />
        <rect className="kd-demo-line" x="26" y="9" width={[42, 54, 36][i]} height="4" rx="2" />
        <text className="kd-demo-key-text" x="124" y="14.6" textAnchor="middle"
          style={{ opacity: picked.includes(i) ? 0 : 1, transition: "opacity 180ms ease" }}>登录</text>
        <path className="kd-demo-tick" data-on={picked.includes(i) || undefined} d="M118 11 l3.6 3.6 l7.2 -7.8" />
      </g>)}
      <g transform="translate(184 51)" className="kd-demo-folder" data-on={beat.exported || undefined}>
        <rect className="kd-demo-folder-body" x="-24" y="-24" width="48" height="48" rx="12" />
        <path className="kd-demo-tray-mark" d="M0 -9 V6 M-6.5 0 L0 7 L6.5 0"
          style={{ opacity: beat.exported ? 1 : 0.3, stroke: beat.exported ? "var(--kd-text)" : undefined }} />
      </g>
    </g> : scene === "cookie-export" ? <g>
      {/* A browser's toolbar: the address, then its extensions, the cookie among them. */}
      <rect className="kd-demo-row-base" x="8" y="8" width="148" height="18" rx="9" />
      <rect className="kd-demo-line" x="18" y="15.2" width="64" height="3.6" rx="1.8" />
      <g transform="translate(176 17)">
        <circle className="kd-demo-cookie" r="9" />
        <circle className="kd-demo-cookie-bite" cx="7.8" cy="-6.8" r="4.2" />
        {[[-3.8, -2.6, 1.6], [2, 1.6, 1.5], [-3, 3.8, 1.4], [0.8, -4.6, 1.1], [4.6, 5, 1]].map(([cx, cy, r]) =>
          <circle key={`${cx}`} className="kd-demo-cookie-chip" cx={cx} cy={cy} r={r} />)}
      </g>
      <circle className="kd-demo-line" data-faint="" cx="202" cy="17" r="5" />
      {/* What ends up on the clipboard. */}
      <g transform="translate(22 44)" className="kd-demo-folder" data-on={beat.exported || undefined}>
        <rect className="kd-demo-folder-body" y="5" width="46" height="54" rx="7" />
        <rect className="kd-demo-folder-tab" x="14" width="18" height="10" rx="4" />
        {[18, 26, 14].map((w, i) => <rect key={i} className="kd-demo-line" x="9" y={20 + 9 * i} width={w} height="3.4" rx="1.7"
          style={{ opacity: beat.exported ? 1 : 0, transitionDelay: `${i * 70}ms` }} />)}
        <path className="kd-demo-tick" data-on={beat.exported || undefined} d="M14 47 l5 5 l11 -11.5" />
      </g>
      {/* The extension's window under the cookie: the site's cookies, and Export at its foot. */}
      <g className="kd-demo-menu" data-on={beat.pop || undefined}>
        <rect className="kd-demo-menu-body" x="98" y="32" width="114" height="76" rx="8" />
        {[62, 46, 70].map((w, i) => <rect key={i} className="kd-demo-line" data-faint={i === 1 ? "" : undefined} x="106" y={41 + 12 * i} width={w} height="3.6" rx="1.8" />)}
        <rect className="kd-demo-line" data-faint="" x="106" y="93" width="30" height="4" rx="2" />
        <rect className="kd-demo-menu-item" data-on={beat.over === "export" || undefined} x="160" y="87" width="46" height="16" rx="5" />
        <text className="kd-demo-key-text" x="183" y="98.4" textAnchor="middle" style={{ fill: "var(--kd-text)" }}>Export</text>
      </g>
      <g className="kd-demo-menu" data-on={beat.menu || undefined}>
        <rect className="kd-demo-menu-body" data-raised="" x="140" y="48" width="66" height="36" rx="7" />
        <rect className="kd-demo-menu-item" data-on={beat.over === "json" || undefined} x="144" y="52" width="58" height="14" rx="4" />
        <text className="kd-demo-key-text" x="152" y="62.4" style={{ fill: "var(--kd-text)" }}>JSON</text>
        <rect className="kd-demo-line" data-faint="" x="152" y="72" width="34" height="3.4" rx="1.7" />
      </g>
    </g> : scene === "mini-player" ? <g>
      <g className="kd-demo-chip" style={{
        transform: beat.mini ? "translate(122px, 80px) scale(0.42, 0.24)" : "translate(8px, 8px) scale(1, 1)",
        transitionDuration: `${beat.move}ms, 0ms`, transformBox: "view-box", transformOrigin: "0 0",
      }}>
        <rect className="kd-demo-chip-body" width="204" height="96" rx={beat.mini ? 20 : 8} />
        <g style={{ opacity: beat.mini ? 0 : 1, transition: "opacity 200ms" }}>
          <rect className="kd-demo-cover" x="12" y="12" width="36" height="36" rx="6" />
          <rect className="kd-demo-line" x="58" y="18" width="70" height="5" rx="2.5" />
          <rect className="kd-demo-line" data-faint="" x="58" y="30" width="44" height="4" rx="2" />
          <rect className="kd-demo-line" x="12" y="70" width="180" height="4" rx="2" />
          <circle className="kd-demo-line" cx="190" cy="10" r="4" />
        </g>
      </g>
      <g style={{ opacity: beat.mini ? 1 : 0, transition: "opacity 260ms 360ms" }}>
        <rect className="kd-demo-cover" x="128" y="85" width="14" height="14" rx="3" />
        <rect className="kd-demo-line" x="148" y="87" width="38" height="3.4" rx="1.7" />
        <rect className="kd-demo-line" data-faint="" x="148" y="94" width="24" height="2.8" rx="1.4" />
      </g>
    </g> : scene === "add-folder" ? <g>
      {[0, 1, 2, 3, 4].map(i => {
        const isNew = i >= 3;
        const shown = !isNew || (beat.added ?? 0) > i - 3;
        return <g key={i} transform={`translate(8 ${32 + 15.5 * i})`} className="kd-demo-result" style={{ opacity: shown ? 1 : 0 }}>
          <rect className="kd-demo-row-base" width="120" height="13" rx="4" />
          <path className="kd-demo-folder-tab" d="M5 3.4 h5 l2 2 h-7 Z" />
          <rect className="kd-demo-folder-body" x="4" y="4.6" width="10" height="6" rx="1.8" />
          <rect className="kd-demo-line" x="20" y="4.8" width={[56, 40, 64, 48, 36][i]} height="3.4" rx="1.7" />
          <path className="kd-demo-tick" data-on={isNew && (beat.added ?? 0) === 2 || undefined} d="M104 6.6 l2.6 2.6 l5 -5.6" />
        </g>;
      })}
      <g transform="translate(138 17)">
        <circle className="kd-demo-add" r="9" data-on={press || undefined} />
        <path className="kd-demo-tray-mark" d="M-4 0 H4 M0 -4 V4" />
      </g>
    </g> : scene === "analyze" ? <g>
      <rect className="kd-demo-row-base" x="8" y="38" width="204" height="36" rx="10" />
      <rect className="kd-demo-cover" x="16" y="46" width="20" height="20" rx="4" />
      <rect className="kd-demo-line" x="42" y="49" width="56" height="4" rx="2" />
      <rect className="kd-demo-line" data-faint="" x="42" y="58" width="34" height="3.4" rx="1.7" />
      {[0, 1].map(i => <g key={i} transform={`translate(${140 + 38 * i} 47)`}>
        <rect className="kd-demo-pill" data-work={(beat.analysis ?? 0) === 1 || undefined} width="32" height="18" rx="9" />
        <text className="kd-demo-pill-text" x="16" y="12.6" textAnchor="middle"
          style={{ opacity: (beat.analysis ?? 0) >= 2 + i ? 1 : 0 }}>{i === 0 ? "128" : "Am"}</text>
      </g>)}
    </g> : scene === "pip" ? <g>
      <rect className="kd-demo-row-base" x="8" y="8" width="204" height="96" rx="8" />
      <rect className="kd-demo-line" x="18" y="82" width="60" height="3.4" rx="1.7" />
      <rect className="kd-demo-line" data-faint="" x="18" y="90" width="38" height="3" rx="1.5" />
      <g className="kd-demo-chip" style={{
        transform: `translate(${(beat.win ?? [150, 66])[0]}px, ${(beat.win ?? [150, 66])[1]}px) scale(${beat.winScale ?? 1})`,
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
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => <rect key={i} className="kd-demo-bar" x={10 + 14.2 * i} y="6" width="9" height="76" rx="4.5"
          style={{ animationDelay: `${-((i * 337) % 1000)}ms`, animationDuration: `${900 + (i * 131) % 500}ms` }} />)}
      </g>
      <rect className="kd-demo-row-base" x="8" y="90" width="132" height="6" rx="3" />
      <rect className="kd-demo-fill" x="8" y="90" width="132" height="6" rx="3"
        style={{ transform: `scaleX(${0.12 + 0.76 * (beat.knob ?? 0)})`, transitionDuration: `${beat.move}ms` }} />
      <circle className="kd-demo-knob" cy="93" r="6.5" cx="20"
        style={{ transform: `translateX(${104 * (beat.knob ?? 0)}px)`, transitionDuration: `${beat.move}ms` }} />
    </g> : drag ? <g>
      <g className="kd-demo-tray" data-hot={hot || undefined} transform={`translate(${TRAY[0]} ${TRAY[1]})`}>
        <g className="kd-demo-tray-pop">
          <rect className="kd-demo-tray-box" x="-43" y="-42" width="86" height="84" rx="12" />
          <path className="kd-demo-tray-mark" data-gone={gone || undefined}
            d={tray === "download" ? "M0 -9 V6 M-6.5 0 L0 7 L6.5 0"
              : tray === "visualize" ? "M-7 7 V1 M-2.5 7 V-6 M2 7 V-2 M6.5 7 V-8"
              : tray === "share" ? "M5 -5 L-6 1 L5 8 M7 -5 a2 2 0 1 0 -4 0 a2 2 0 1 0 4 0 M-4 1 a2 2 0 1 0 -4 0 a2 2 0 1 0 4 0 M7 8 a2 2 0 1 0 -4 0 a2 2 0 1 0 4 0"
              : "M-6 6 L6 -6 M-1 -6.5 H6.5 V1"} />
          <path className="kd-demo-tick" data-on={gone || undefined} d="M-8 0 l5.5 5.5 l10.5 -11.5" />
        </g>
      </g>
      {[4, 60, 78].map(y => <rect key={y} className="kd-demo-ghost-row" x="8" y={y} width="76" height="14" rx="5" />)}
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
      {scene === "menu-toss" && <g className="kd-demo-menu" data-on={beat.menu || undefined}>
        <rect className="kd-demo-menu-body" x="52" y="52" width="70" height="52" rx="7" />
        {[0, 1, 2].map(i => <g key={i}>
          <rect className="kd-demo-menu-item" data-on={beat.item === i || undefined} x="56" y={56 + 15 * i} width="62" height="13" rx="4" />
          <rect className="kd-demo-line" x="62" y={60.5 + 15 * i} width={[34, 40, 28][i]} height="3.4" rx="1.7" />
        </g>)}
      </g>}
    </g> : <g>
      {ROWS.map(row => <g key={row} transform={`translate(8 ${8 + 20 * row})`}>
        <rect className="kd-demo-row-base" width="140" height="15" rx="4" />
        <rect className="kd-demo-row-pick" data-on={picked.includes(row) || undefined} width="140" height="15" rx="4" />
        <rect className="kd-demo-cover" x="4" y="3" width="9" height="9" rx="2" />
        <rect className="kd-demo-line" x="18" y="3.5" width="52" height="3" rx="1.5" />
        <rect className="kd-demo-line" data-faint="" x="18" y="9" width="32" height="2.5" rx="1.25" />
        <path className="kd-demo-tick" data-on={picked.includes(row) || undefined} d="M126 7.6 l3 3 l6 -6.6" />
      </g>)}
      {scene === "multi-copy" && <g transform="translate(162 48)" className="kd-demo-folder" data-on={beat.folder || undefined}>
        <path className="kd-demo-folder-tab" d="M0 8 a5 5 0 0 1 5 -5 h14 l5 5 Z" />
        <rect className="kd-demo-folder-body" y="8" width="50" height="38" rx="7" />
        <path className="kd-demo-tick" data-on={beat.folder === "done" || undefined} d="M17 28 l6 6 l11 -12" />
      </g>}
    </g>}
    {key && <g transform="translate(162 6)">
      <g className="kd-demo-key" data-down={beat.key || undefined}>
        <rect className="kd-demo-key-lip" y="3" width="50" height="20" rx="6" />
        <g className="kd-demo-key-top">
          <rect className="kd-demo-key-face" width="50" height="20" rx="6" />
          <text className="kd-demo-key-text" x="25" y="13.6" textAnchor="middle">{keyText}</text>
        </g>
      </g>
    </g>}
    {scene !== "analyze" && <g className="kd-demo-pointer" style={{ transform: `translate(${beat.cursor[0]}px, ${beat.cursor[1]}px)`, transitionDuration: duration }}>
      {press && <circle key={at} className="kd-demo-ping" r="7" />}
      <path className="kd-demo-cursor" d="M0 0 V12.5 L3.4 9.6 L5.6 14.6 L8 13.5 L5.8 8.7 H10 Z" />
    </g>}
  </svg>;
}

/**
 * What an empty download or export queue shows: the two ways a song gets in, one after the other —
 * dragged into the list, then thrown in from the right-click menu.
 */
export function QueueEmptyDemo({ tray, label }: { tray: "download" | "export"; label: string }) {
  const [scene, setScene] = useState<"drag-in" | "menu-toss">("drag-in");
  return <PointerDemo scene={scene} tray={tray} label={label}
    onLoop={() => setScene(current => current === "drag-in" ? "menu-toss" : "drag-in")} />;
}
