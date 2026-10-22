/**
 * The editor's side of a `.kdjv` 2 project (docs/kdjv.md, "格式 2"): the document, the operations
 * the server applies to it (crates/kdj-server/src/compositions/workshop/lanes.rs) and where
 * everything in it sits. The editor never writes the file itself: every key sends operations,
 * and what comes back is the document as saved.
 */

export interface LaneClip {
  id: string;
  src: string;
  in?: number;
  out: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  fill?: boolean;
}
export type LaneItem = LaneClip | { gap: number };
export type BranchSide = "out" | "in";
export interface LaneBranch { clip: string; side: BranchSide; length: number; opacity?: number; fade?: boolean }
export interface LaneSong { src: string; in?: number; out: number; volume?: number }
export interface LaneDocument {
  kdjv: 2;
  title: string;
  song?: LaneSong | null;
  main: LaneItem[];
  branches?: LaneBranch[];
  [key: string]: unknown;
}

/** Where each stretch of the main lane and each branch is, in seconds of the project. */
export interface LaneLayout {
  duration: number;
  main_end: number;
  main: Array<{ index: number; at: number; length: number; gap?: true; id?: string; src?: string }>;
  branches: Array<{ clip: string; side: BranchSide; at: number; length: number }>;
}

export interface LaneEdited {
  path: string;
  track_id: number | null;
  /** The song's own library row (its bar lines), when it is in the library. */
  song_track_id: number | null;
  document: LaneDocument;
  layout: LaneLayout;
  duration: number;
}

/** One operation (lanes.rs `Op`). */
export type LaneOp =
  | { op: "new"; title: string; song?: LaneSong | null; canvas?: { width: number; height: number; fps?: number } }
  | { op: "title"; title: string }
  | { op: "add"; clip: Partial<LaneClip> & { src: string; out: number }; at?: number; index?: number }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; index: number }
  | { op: "trim"; id: string; in?: number; out?: number }
  | { op: "split"; id: string; at: number }
  | { op: "set"; id: string; fields: Partial<Pick<LaneClip, "speed" | "volume" | "muted" | "x" | "y" | "scale" | "opacity" | "fill">> }
  | { op: "gap"; index: number; length: number }
  | { op: "branch"; clip: string; side: BranchSide; length: number; opacity?: number; fade?: boolean }
  | { op: "unbranch"; clip: string; side: BranchSide };

export const isGap = (item: LaneItem): item is { gap: number } => "gap" in item;

/** The bar line at or before `t`, else `t`: where a drop on the ruler snaps to in a VJ. */
export function snapToBar(downbeats: readonly number[], t: number, songIn = 0): number {
  let best = t;
  let distance = Infinity;
  for (const beat of downbeats) {
    const at = beat - songIn;
    const d = Math.abs(at - t);
    if (d < distance) { distance = d; best = at; }
  }
  return Math.max(0, best);
}

/** The bar a project time falls in (1 = the first bar line of the song), or null before it. */
export function barAt(downbeats: readonly number[], t: number, songIn = 0): number | null {
  const at = t + songIn;
  let bar: number | null = null;
  downbeats.forEach((beat, n) => { if (beat <= at + 1e-3) bar = n + 1; });
  return bar;
}

/** m:ss.s of the project. */
export function laneClock(seconds: number): string {
  const whole = Math.max(0, seconds);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

export function fileLabel(src: string): string {
  const name = src.split(/[\\/]/).pop() ?? src;
  return name.replace(/\.[^.]+$/, "");
}
