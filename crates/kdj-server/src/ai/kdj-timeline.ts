/**
 * A draft's forks (ask_user's `timeline`, docs/ai-dock.md): the places of a saved .kdjv draft
 * where the listener picks one of a few fillings the AI prepared — a gap without picture, the
 * seam between two pieces of footage, how strong an effect is. The AI names each place by the
 * song's bars, never by seconds; the arithmetic that turns bars into the project's time, puts an
 * option into the draft and finds the picture shown at a moment lives here, without files or
 * KDJ, so tests/aiTimeline.test.ts can check it.
 *
 * Written into KDJ's own pi directory by kdj-server; edits here, not there.
 */
import { basename, extname, isAbsolute, resolve } from "node:path";

/** One clip of a `.kdjv` track (docs/kdjv.md): seconds; other fields are kept as they are. */
export type Clip = { src: string; at: number; in?: number; out: number; speed?: number; [key: string]: unknown };
export type Doc = { tracks?: { clips?: Clip[]; [key: string]: unknown }[]; [key: string]: unknown };

export interface ForkOption { id: string; label: string; note?: string; clips: Clip[] }
export interface Fork {
  id: string;
  kind?: string;
  /** The first bar of the place and the bar after it: 1 is the song's first downbeat. */
  from_bar: number;
  to_bar: number;
  /** The track whose clips in the place an option replaces; 0 is the top one. */
  track: number;
  question: string;
  options: ForkOption[];
  default?: string;
}

/** Where the song sits in the project: project time = at + (song time − in) / speed. */
export interface SongPlace { at: number; in: number; out: number; speed: number }

/** A clip's start or end this close to a place's edge is on it: rounding between bars and frames. */
const EDGE = 0.05;
/** Two uses of one source overlapping by more than this repeat it. */
const REPEAT = 0.5;
const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|flv|ts|mts|m2ts|wmv|mpg|mpeg)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

const round = (value: number) => Math.round(value * 1000) / 1000;
export const clipLength = (clip: Clip) => (clip.out - (clip.in ?? 0)) / (clip.speed ?? 1);
export const isImage = (src: string) => IMAGE.test(src);
export const isPicture = (src: string) => VIDEO.test(src) || IMAGE.test(src);
const sourcePath = (base: string, src: string) => isAbsolute(src) ? src : resolve(base, src);

/** The song time where bar `n` starts; the bar after the last downbeat is reckoned from the one before. */
export function barTime(downbeats: readonly number[], n: number): number {
  if (downbeats.length < 2) throw new Error("这首歌没有小节线，不能按小节标岔口：用 question 或 body 问");
  if (!Number.isInteger(n) || n < 1) throw new Error(`小节号 ${n} 无效：从 1 开始的整数`);
  const last = downbeats.length - 1;
  if (n - 1 <= last) return downbeats[n - 1];
  if (n - 1 === last + 1) return downbeats[last] + (downbeats[last] - downbeats[last - 1]);
  throw new Error(`第 ${n} 小节超出这首歌的小节线（共 ${downbeats.length} 小节）`);
}

/** The first clip of the project that plays the song, by its file. */
export function songPlace(doc: Doc, songPath: string, base: string): SongPlace {
  for (const track of doc.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (typeof clip?.src === "string" && sourcePath(base, clip.src) === resolve(songPath)) {
        return { at: clip.at, in: clip.in ?? 0, out: clip.out, speed: clip.speed ?? 1 };
      }
    }
  }
  throw new Error(`这首歌（${songPath}）不在草稿里：岔口的小节按草稿里这首歌的位置换算`);
}

export const toProject = (place: SongPlace, songTime: number) => round(place.at + (songTime - place.in) / place.speed);

/** A fork's place in the project's time. */
export function forkSpan(fork: Fork, downbeats: readonly number[], place: SongPlace) {
  if (fork.to_bar <= fork.from_bar) throw new Error(`岔口 ${fork.id}：to_bar（${fork.to_bar}）要大于 from_bar（${fork.from_bar}）`);
  const start = toProject(place, barTime(downbeats, fork.from_bar));
  const end = toProject(place, barTime(downbeats, fork.to_bar));
  return { start, end };
}

/**
 * The draft with `clips` in place of what `track` holds between `start` and `end`: a clip across
 * an edge keeps its part outside, without the fade on the cut side; the rest of the draft, its
 * unknown fields included, is left as it was.
 */
export function replaceRange(doc: Doc, track: number, start: number, end: number, clips: readonly Clip[]): Doc {
  const copy = structuredClone(doc);
  const tracks = copy.tracks ?? [];
  if (!Number.isInteger(track) || track < 0 || track >= tracks.length) {
    throw new Error(`track ${track} 不在草稿里（共 ${tracks.length} 条轨道，0 是最上层）`);
  }
  const kept: Clip[] = [];
  for (const clip of tracks[track].clips ?? []) {
    const from = clip.at, to = clip.at + clipLength(clip), speed = clip.speed ?? 1, source = clip.in ?? 0;
    if (to <= start + EDGE || from >= end - EDGE) {
      kept.push(clip);
      continue;
    }
    if (from < start - EDGE) {
      const left: Clip = { ...clip, out: round(source + (start - from) * speed) };
      delete left.fade_out;
      delete left.audio_fade_out;
      kept.push(withinFades(left));
    }
    if (to > end + EDGE) {
      const right: Clip = { ...clip, at: end, in: round(source + (end - from) * speed) };
      delete right.fade_in;
      delete right.audio_fade_in;
      kept.push(withinFades(right));
    }
  }
  tracks[track].clips = [...kept, ...structuredClone([...clips])].sort((a, b) => a.at - b.at);
  return copy;
}

/** A cut piece's remaining fades, at most half its length each (docs/kdjv.md). */
function withinFades(clip: Clip): Clip {
  const half = clipLength(clip) / 2;
  for (const field of ["fade_in", "fade_out", "audio_fade_in", "audio_fade_out"]) {
    const value = clip[field];
    if (typeof value === "number" && value > half) clip[field] = round(half);
  }
  return clip;
}

/** What is wrong with the forks as given, or nothing: each message names the fork and the field. */
export function forkProblems(forks: readonly Fork[], spans: readonly { start: number; end: number }[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  forks.forEach((fork, n) => {
    const name = `岔口 ${fork.id || n + 1}`;
    if (!fork.id) problems.push(`${name}：没有 id`);
    else if (ids.has(fork.id)) problems.push(`${name}：id 重复`);
    ids.add(fork.id);
    if (fork.options.length < 2 || fork.options.length > 4) problems.push(`${name}：要 2–4 个选项，现在是 ${fork.options.length} 个`);
    const optionIds = new Set<string>();
    const fillings = new Set<string>();
    for (const option of fork.options) {
      if (!option.id || optionIds.has(option.id)) problems.push(`${name}：选项 id「${option.id}」为空或重复`);
      optionIds.add(option.id);
      if (!option.label.trim()) problems.push(`${name}：选项 ${option.id} 没有 label`);
      const filling = JSON.stringify(option.clips);
      if (fillings.has(filling)) problems.push(`${name}：选项 ${option.id} 和前面的选项 clips 一样`);
      fillings.add(filling);
      const { start, end } = spans[n];
      option.clips.forEach((clip, j) => {
        const where = `${name} 选项 ${option.id} 的 clips[${j}]`;
        if (typeof clip.src !== "string" || !Number.isFinite(clip.at) || !Number.isFinite(clip.out)) {
          problems.push(`${where}：src、at、out 不全`);
          return;
        }
        const clipEnd = clip.at + clipLength(clip);
        if (clip.at < start - EDGE || clipEnd > end + EDGE) {
          problems.push(`${where}：在成片 ${round(clip.at)}–${round(clipEnd)} 秒，超出岔口 ${start}–${end} 秒（第 ${fork.from_bar}–${fork.to_bar - 1} 小节）`);
        }
      });
    }
    if (fork.default !== undefined && !optionIds.has(fork.default)) problems.push(`${name}：default「${fork.default}」不是它的选项`);
  });
  forks.forEach((fork, n) => {
    for (let m = n + 1; m < forks.length; m++) {
      const other = forks[m];
      if (other.track !== fork.track) continue;
      if (spans[n].start < spans[m].end - EDGE && spans[m].start < spans[n].end - EDGE) {
        problems.push(`岔口 ${fork.id} 和 ${other.id} 在同一条轨道上重叠`);
      }
    }
  });
  return problems;
}

/**
 * The option clips that show a stretch of footage the draft also shows elsewhere: a clip is
 * never played twice to fill time (the kdj-video skill), and the listener would see it twice.
 */
export function repeats(doc: Doc, clips: readonly Clip[], base: string): string[] {
  const out: string[] = [];
  for (const clip of clips) {
    if (!isPicture(clip.src) || isImage(clip.src)) continue;
    const path = sourcePath(base, clip.src);
    const from = clip.in ?? 0, to = clip.out;
    (doc.tracks ?? []).forEach((track, i) => (track.clips ?? []).forEach((other, j) => {
      if (other.at === clip.at && other.src === clip.src && (other.in ?? 0) === from) return; // The clip itself.
      if (typeof other.src !== "string" || sourcePath(base, other.src) !== path) return;
      const overlap = Math.min(to, other.out) - Math.max(from, other.in ?? 0);
      if (overlap > REPEAT) {
        out.push(`${basename(clip.src)} 的 ${round(from)}–${round(to)} 秒和 tracks[${i}].clips[${j}]（${round(other.in ?? 0)}–${round(other.out)} 秒）重复了 ${round(overlap)} 秒`);
      }
    }));
  }
  return out;
}

/** The picture on screen at `t`: the top track's clip there, and the time inside its source. */
export function visibleAt(doc: Doc, t: number, base: string): { src: string; at: number; image: boolean } | null {
  for (const track of doc.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (typeof clip?.src !== "string" || !isPicture(clip.src) || clip.opacity === 0) continue;
      if (clip.at - 1e-6 <= t && t < clip.at + clipLength(clip)) {
        return { src: sourcePath(base, clip.src), at: round((clip.in ?? 0) + (t - clip.at) * (clip.speed ?? 1)), image: isImage(clip.src) };
      }
    }
  }
  return null;
}

/** The moments a fork is shown at: just before it, three inside it, just after it. */
export function forkMoments(start: number, end: number, duration: number) {
  const span = end - start;
  return {
    before: start > 0.2 ? round(start - 0.2) : null,
    inside: [start + span / 6, start + span / 2, end - span / 6].map(round),
    after: end + 0.2 < duration ? round(end + 0.2) : null,
  };
}

export const projectDuration = (doc: Doc) =>
  round(Math.max(0, ...(doc.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => clip.at + clipLength(clip)))));

/** A clip as the window draws it on its lane. */
export function laneClip(clip: Clip) {
  const src = typeof clip.src === "string" ? clip.src : "";
  return {
    at: round(clip.at),
    length: round(clipLength(clip)),
    label: basename(src, extname(src)),
    kind: isImage(src) ? "image" : isPicture(src) ? "video" : "audio",
  };
}
