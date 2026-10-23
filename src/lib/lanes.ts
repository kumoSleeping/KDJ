/**
 * The editor's side of a `.kdjv` 3 project (docs/kdjv.md, "格式 3"): free tracks. The document,
 * the operations the server applies to it (crates/kdj-server/src/compositions/workshop/tracks.rs)
 * and where everything in it sits. The editor never writes the file itself: every key sends
 * operations, and what comes back is the document as saved.
 */

export type TrackKind = "picture" | "sound";

/** One clip of a track: `at` where it starts in the project, `in`/`out` the part of its file. */
export interface LaneClip {
  id: string;
  src: string;
  at: number;
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
  /** Seconds of the project it fades in and out over (over another track's clip: a crossfade). */
  fade_in?: number;
  fade_out?: number;
}
/** A track: picture tracks cover the ones below them; every sound track is heard. */
export interface LaneTrack {
  id: string;
  kind: TrackKind;
  name?: string;
  /** A picture track not shown. */
  hidden?: boolean;
  /** A track not heard. */
  muted?: boolean;
  clips: LaneClip[];
}
/** Tracks side by side shown as one row; nothing in them changes. */
export interface LaneFold { id: string; tracks: string[] }
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
export interface LaneDocument {
  kdjv: 3;
  title: string;
  canvas?: { width: number; height: number; fps?: number };
  tracks: LaneTrack[];
  folds?: LaneFold[];
  markers?: LaneMarker[];
  titles?: LaneTitle[];
  [key: string]: unknown;
}

/** Where everything is, in seconds of the project. */
export interface LaneLayout {
  duration: number;
  tracks: Array<{ index: number; id: string; kind: TrackKind; clips: Array<{ id: string; src: string; at: number; length: number; in: number; out: number }> }>;
  folds: LaneFold[];
  /** The songs the bar lines come from: the first sound track's clips. */
  songs: Array<{ index: number; at: number; length: number; src: string; in: number }>;
}

export interface LaneEdited {
  path: string;
  track_id: number | null;
  /** The first song's own library row (its bar lines), when it is in the library. */
  song_track_id: number | null;
  /** Each song's library row, in the order of `layout.songs`. */
  song_track_ids?: Array<number | null>;
  document: LaneDocument;
  layout: LaneLayout;
  duration: number;
  /** How long each file the document names is, in seconds, by its name there. */
  lengths?: Record<string, number>;
  /** Why the project does not play as it is (only when opening it). */
  problem?: string | null;
  /** The clips its live preview draws, as `/api/kdjv/preview` gives them; none for an empty draft. */
  live?: import("../types").KdjvLive | null;
}

/** A clip as it is put in: no id yet, and `out` may be left to the server, which measures the file. */
export type NewClip = Partial<Omit<LaneClip, "id" | "at">> & { src: string };

/** One operation (tracks.rs `Op`). */
export type LaneOp =
  | { op: "new"; title: string; canvas?: { width: number; height: number; fps?: number } }
  | { op: "title"; title: string }
  | { op: "add_track"; kind: TrackKind; index?: number; name?: string }
  | { op: "remove_track"; id: string }
  | { op: "move_track"; id: string; index: number }
  | { op: "set_track"; id: string; fields: { name?: string | null; hidden?: boolean; muted?: boolean } }
  | { op: "add"; clip: NewClip; track?: string; new_track?: number; kind?: TrackKind; at?: number }
  | { op: "move"; id: string; at: number; track?: string; new_track?: number }
  | { op: "remove"; id: string; ripple?: boolean }
  | { op: "trim"; id: string; in?: number; out?: number }
  | { op: "split"; id: string; at: number }
  | { op: "set"; id: string; fields: Partial<Pick<LaneClip, "speed" | "volume" | "muted" | "x" | "y" | "scale" | "opacity" | "fill" | "crop" | "fade_in" | "fade_out">> }
  | { op: "fold"; tracks: string[] }
  | { op: "unfold"; id: string }
  | { op: "restore"; document: LaneDocument }
  | { op: "markers"; markers: LaneMarker[] }
  | { op: "add_title"; title: Omit<LaneTitle, "id"> }
  | { op: "set_title"; id: string; fields: Partial<Omit<LaneTitle, "id">> }
  | { op: "remove_title"; id: string };

/** Every clip of a document with the track it is in. */
export function allClips(doc: LaneDocument): Array<{ clip: LaneClip; track: LaneTrack }> {
  return doc.tracks.flatMap(track => track.clips.map(clip => ({ clip, track })));
}

/** The clip `id` and its track, if it is there. */
export function findClip(doc: LaneDocument, id: string | null): { clip: LaneClip; track: LaneTrack } | null {
  if (!id) return null;
  return allClips(doc).find(found => found.clip.id === id) ?? null;
}

/** How long a clip lasts in the project. */
export const clipLength = (clip: Pick<LaneClip, "in" | "out" | "speed">) => (clip.out - (clip.in ?? 0)) / (clip.speed ?? 1);

/** A track's name as the editor shows it: its own, else 画面 1, 声音 2… by its place among its kind. */
export function trackName(doc: LaneDocument, track: LaneTrack): string {
  if (track.name) return track.name;
  const n = doc.tracks.filter(t => t.kind === track.kind).indexOf(track) + 1;
  return `${track.kind === "sound" ? "声音" : "画面"} ${n}`;
}

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
 * leaves its place and each matched stretch goes into its track at its time, kept inside that song.
 */
export function alignedOps(clip: LaneClip, track: string, plan: AlignPlan, song: { at: number; in: number; length: number }): LaneOp[] {
  const { id: _id, at: _at, in: _in, out: _out, speed: _speed, ...keep } = clip;
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
    ops.push({ op: "add", clip: { ...keep, src: clip.src, in: round(from), out: round(to), speed: Math.round(speed * 10000) / 10000 }, track, at: round(at) });
  }
  return ops.length > 1 ? ops : [];
}
