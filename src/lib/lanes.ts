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
  /** Fractions taken off: left, top, right, bottom. */
  crop?: [number, number, number, number];
}
export type LaneItem = LaneClip | { gap: number };
export type BranchSide = "out" | "in";
export interface LaneMarker { at: number; name?: string }
/** A title (字幕): its text, drawn as a picture (`src`), over the project from `at` for `length`. */
export interface LaneTitle {
  id: string; text: string; src: string; at: number; length: number;
  size?: number; color?: string; outline?: boolean; y?: number;
}
/** How an export differs from the render made for playing (kdjv.rs `RenderOptions`). */
export interface ExportOptions {
  width?: number; height?: number; fps?: number; quality?: number; from?: number; to?: number; audio_only?: boolean;
}
export interface LaneBranch { clip: string; side: BranchSide; length: number; opacity?: number; fade?: boolean }
export interface LaneSong { src: string; in?: number; out: number; volume?: number }
export interface LaneDocument {
  kdjv: 2;
  title: string;
  song?: LaneSong | null;
  /** Several songs one after another (one song is written as `song`). */
  songs?: LaneSong[];
  main: LaneItem[];
  branches?: LaneBranch[];
  markers?: LaneMarker[];
  titles?: LaneTitle[];
  [key: string]: unknown;
}

/** Where each stretch of the main lane and each branch is, in seconds of the project. */
export interface LaneLayout {
  duration: number;
  main_end: number;
  main: Array<{ index: number; at: number; length: number; gap?: true; id?: string; src?: string }>;
  branches: Array<{ clip: string; side: BranchSide; at: number; length: number }>;
  /** The song lane: each song's place in the project and where in its file it starts. */
  songs?: Array<{ index: number; at: number; length: number; src: string; in: number }>;
}

export interface LaneEdited {
  path: string;
  track_id: number | null;
  /** The first song's own library row (its bar lines), when it is in the library. */
  song_track_id: number | null;
  /** Each song's library row, in the order of the song lane. */
  song_track_ids?: Array<number | null>;
  document: LaneDocument;
  layout: LaneLayout;
  duration: number;
  /** How long each file the document names is, in seconds, by its name there. */
  lengths?: Record<string, number>;
  /** Why the project does not play as it is (only when opening it). */
  problem?: string | null;
}

/** One operation (lanes.rs `Op`). */
export type LaneOp =
  | { op: "new"; title: string; song?: NewLaneSong | null; canvas?: { width: number; height: number; fps?: number } }
  | { op: "title"; title: string }
  | { op: "add"; clip: Partial<LaneClip> & { src: string; out?: number }; at?: number; index?: number; over?: boolean }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; index: number }
  | { op: "trim"; id: string; in?: number; out?: number }
  | { op: "split"; id: string; at: number }
  | { op: "set"; id: string; fields: Partial<Pick<LaneClip, "speed" | "volume" | "muted" | "x" | "y" | "scale" | "opacity" | "fill" | "crop">> }
  | { op: "move_to"; id: string; at: number; over?: boolean }
  | { op: "restore"; document: LaneDocument }
  | { op: "markers"; markers: LaneMarker[] }
  | { op: "add_title"; title: Omit<LaneTitle, "id"> }
  | { op: "set_title"; id: string; fields: Partial<Omit<LaneTitle, "id">> }
  | { op: "remove_title"; id: string }
  | { op: "gap"; index: number; length: number }
  | { op: "branch"; clip: string; side: BranchSide; length: number; opacity?: number; fade?: boolean }
  | { op: "unbranch"; clip: string; side: BranchSide }
  | { op: "add_song"; song: NewLaneSong; index?: number }
  | { op: "remove_song"; index: number }
  | { op: "move_song"; from: number; to: number }
  | { op: "set_song"; index: number; fields: { volume?: number } };

/** A song (or a clip) put in without `out` is given its file's whole length by the server, which
 *  measures the file: the library does not always know it. */
export type NewLaneSong = Omit<LaneSong, "out"> & { out?: number };

export const isGap = (item: LaneItem): item is { gap: number } => "gap" in item;

/** Where something let go anywhere but on a lane goes: after the last thing in its own lane. */
export const LANE_END = Number.MAX_SAFE_INTEGER;

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

/**
 * The operations that branch `clip` on `side` for `length` seconds. A branch plays more of the
 * clip's file than the clip does (after its out, or before its in); when the file has not that
 * much more, the clip gives it up: it is cut back by as much, and the branch plays what was cut.
 * In a VJ a clip whose start is cut back also starts later by as much, so that its picture stays
 * on the song's beat. `sourceLength` is the file's length, when known.
 */
export function branchOps(clip: LaneClip, side: BranchSide, length: number, vj: boolean, at: number,
  sourceLength: number | undefined, keep: { opacity?: number; fade?: boolean } = {}): LaneOp[] {
  const speed = clip.speed ?? 1;
  const need = length * speed;
  const r = (value: number) => Math.round(value * 1000) / 1000;
  const branch: LaneOp = { op: "branch", clip: clip.id, side, length: r(length), ...keep };
  if (side === "out") {
    const spare = sourceLength === undefined ? Infinity : sourceLength - clip.out;
    if (spare + 0.05 >= need) return [branch];
    const out = r(clip.out - (need - Math.max(0, spare)));
    if (out - (clip.in ?? 0) <= 0.1) return [branch];
    return [{ op: "trim", id: clip.id, out }, branch];
  }
  const spare = clip.in ?? 0;
  if (spare + 1e-6 >= need) return [branch];
  const from = r(need);
  if (clip.out - from <= 0.1) return [branch];
  const ops: LaneOp[] = [{ op: "trim", id: clip.id, in: from }];
  if (vj) ops.push({ op: "move_to", id: clip.id, at: r(at + (from - spare) / speed) });
  return [...ops, branch];
}

/** One way a video lies in a song, as `/api/cli/align` answers it: ref = ref_at + (video - video_in) / speed. */
export interface AlignPlan {
  id: string;
  label: string;
  /** Sure enough to be applied without asking. */
  auto: boolean;
  similarity?: number;
  segments: Array<{ video_in: number; video_out: number; ref_at: number; speed: number }>;
}

/**
 * The operations that put `clip` where `plan` says it lies in the song placed at `song`: the clip
 * leaves its place and each matched stretch goes in at its time, kept inside that song.
 */
export function alignedOps(clip: LaneClip, plan: AlignPlan, song: { at: number; in: number; length: number }): LaneOp[] {
  const { id: _id, in: _in, out: _out, speed: _speed, ...keep } = clip;
  const ops: LaneOp[] = [{ op: "remove", id: clip.id }];
  for (const segment of plan.segments) {
    const speed = segment.speed > 0 ? segment.speed : 1;
    let from = segment.video_in, to = segment.video_out;
    let at = song.at + segment.ref_at - song.in;
    if (at < song.at) { from += (song.at - at) * speed; at = song.at; }
    const end = at + (to - from) / speed, limit = song.at + song.length;
    if (end > limit) to -= (end - limit) * speed;
    if ((to - from) / speed <= 0.05) continue;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    ops.push({ op: "add", clip: { ...keep, src: clip.src, in: round(from), out: round(to), speed: Math.round(speed * 10000) / 10000 }, at: round(at) });
  }
  return ops.length > 1 ? ops : [];
}

