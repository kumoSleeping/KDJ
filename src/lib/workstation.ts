import type { Waveform } from "../types";
import type {
  CompositionProject,
  WorkshopLayer,
  WorkshopBeatGrid,
  RhythmAnalysis,
  WorkshopClip,
} from "../types/workshop";
import {
  activeLayerCount,
  clipDuration,
  clipQuantum,
  cloneProject,
  outputAt,
  sourceAt,
  uid,
} from "./workshop";
export type TimeRange = [number, number];
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [Math.max(0, a), b] as TimeRange)
    .sort((a, b) => a[0] - b[0]);
  const result: TimeRange[] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range[0] <= last[1] + 0.00001)
      last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}
export function analysisGrid(
  analysis: RhythmAnalysis,
  signature: string,
): WorkshopBeatGrid {
  return {
    analysis_revision: analysis.revision,
    source_signature: signature,
    beats: analysis.beats,
    downbeats: analysis.downbeats,
    segments: analysis.segments,
    beats_per_bar: 4,
    downbeat_confidence: analysis.downbeat_confidence,
    locked: false,
  };
}
export function layerEnd(layer: WorkshopLayer): number {
  return Math.max(0, ...layer.clips.map((c) => c.start_ms + clipDuration(c)));
}
export function clipAt(
  layer: WorkshopLayer,
  time: number,
): WorkshopClip | undefined {
  return layer.clips.find(
    (c) => time >= c.start_ms && time < c.start_ms + clipDuration(c),
  );
}
export function sliceClip(
  c: WorkshopClip,
  start: number,
  end: number,
): WorkshopClip {
  const a = start - c.start_ms,
    b = end - c.start_ms;
  const next = { ...structuredClone(c), id: uid(), start_ms: start };
  if (c.display_duration_ms != null) {
    next.animation_offset_ms = sourceAt(c, a);
    next.display_duration_ms = b - a;
  } else {
    next.source_in_ms = sourceAt(c, a);
    next.source_out_ms = sourceAt(c, b);
  }
  next.fades.offset_ms += a;
  return next;
}
/** One transaction for disjoint selection; video and sound remain in the same clip. */
export function editRanges(
  p: CompositionProject,
  layerId: string,
  ranges: TimeRange[],
  action: "split" | "delete" | "keep",
  ripple = activeLayerCount(p) === 1,
): CompositionProject {
  const intervals = mergeRanges(ranges);
  if (!intervals.length) return p;
  const next = cloneProject(p),
    layer = next.layers.find((l) => l.id === layerId);
  if (!layer) return p;
  const removed: TimeRange[] = [],
    pieces: WorkshopClip[] = [];
  for (const c of layer.clips) {
    const end = c.start_ms + clipDuration(c),
      quantum = clipQuantum(p, c);
    const points = [
      c.start_ms,
      ...intervals
        .flat()
        .filter((t) => t > c.start_ms + quantum / 2 && t < end - quantum / 2),
      end,
    ].sort((a, b) => a - b);
    const unique = points.filter(
      (t, i) => !i || t - points[i - 1] >= quantum * 0.99,
    );
    for (let i = 0; i + 1 < unique.length; i++) {
      const a = unique[i],
        b = unique[i + 1],
        mid = (a + b) / 2;
      const selected = intervals.some(([lo, hi]) => mid >= lo && mid < hi);
      if (action === "split" || (action === "keep" ? selected : !selected)) {
        pieces.push(unique.length === 2 ? c : sliceClip(c, a, b));
      } else removed.push([a, b]);
    }
  }
  const gaps = mergeRanges(removed);
  if (ripple && action !== "split")
    for (const c of pieces)
      c.start_ms -= gaps.reduce(
        (sum, [a, b]) => sum + (b <= c.start_ms + 0.00001 ? b - a : 0),
        0,
      );
  layer.clips = pieces.sort((a, b) => a.start_ms - b.start_ms);
  return next;
}
export interface ProjectBeat {
  time: number;
  source: number;
  bar: number;
  downbeat: boolean;
}
function lowerBound(values: readonly number[], value: number): number {
  let a = 0,
    b = values.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (values[m] < value) a = m + 1;
    else b = m;
  }
  return a;
}
export function projectBeats(
  layer: WorkshopLayer,
  grid: WorkshopBeatGrid,
  start = 0,
  end = Infinity,
): ProjectBeat[] {
  const events: ProjectBeat[] = [];
  const firstDown = grid.downbeats[0];
  const origin =
    firstDown === undefined ? 0 : lowerBound(grid.beats, firstDown - 0.03);
  for (const c of layer.clips) {
    if (c.start_ms + clipDuration(c) < start || c.start_ms > end) continue;
    const a = lowerBound(grid.beats, c.source_in_ms / 1000 - 0.000001);
    for (
      let i = a;
      i < grid.beats.length &&
      grid.beats[i] <= c.source_out_ms / 1000 + 0.000001;
      i++
    ) {
      const source = grid.beats[i] * 1000,
        time = c.start_ms + outputAt(c, source);
      if (time < start || time > end) continue;
      const downIndex = lowerBound(grid.downbeats, grid.beats[i] - 0.03);
      const actual =
        grid.downbeats[downIndex] !== undefined &&
        Math.abs(grid.downbeats[downIndex] - grid.beats[i]) < 0.03;
      const phase =
        (((i - origin) % grid.beats_per_bar) + grid.beats_per_bar) %
        grid.beats_per_bar;
      events.push({
        time,
        source,
        downbeat: grid.downbeats.length ? actual : phase === 0,
        bar: Math.floor((i - origin) / grid.beats_per_bar) + 1,
      });
    }
  }
  return events
    .sort((a, b) => a.time - b.time)
    .filter((e, i, a) => !i || e.time - a[i - 1].time > 0.001);
}
export function gridSnap(
  time: number,
  beats: ProjectBeat[],
  mode: "bar" | "beat" | "free",
): number {
  if (mode === "free") return time;
  const candidates = mode === "bar" ? beats.filter((b) => b.downbeat) : beats;
  if (!candidates.length) return time;
  let a = 0,
    b = candidates.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (candidates[m].time < time) a = m + 1;
    else b = m;
  }
  const left = candidates[Math.max(0, a - 1)],
    right = candidates[Math.min(a, candidates.length - 1)];
  return Math.abs(left.time - time) <= Math.abs(right.time - time)
    ? left.time
    : right.time;
}
/** Compose only the requested output window from the cached source waveform. */
export function layerWaveform(
  wave: Waveform,
  layer: WorkshopLayer,
  start: number,
  end: number,
  columns: number,
  audioOffsetMs = 0,
): Waveform {
  const amp = new Float32Array(columns),
    r = new Uint8Array(columns),
    g = new Uint8Array(columns),
    b = new Uint8Array(columns);
  const step = (end - start) / columns,
    sourceStep = (wave.duration * 1000) / wave.amp.length;
  for (let i = 0; i < columns; i++) {
    const lo = start + i * step,
      hi = lo + step;
    for (const c of layer.clips) {
      const a = Math.max(lo, c.start_ms),
        z = Math.min(hi, c.start_ms + clipDuration(c));
      if (z <= a) continue;
      if (sourceAt(c, z - c.start_ms) <= audioOffsetMs) continue;
      const from = Math.max(
        0,
        Math.floor((sourceAt(c, a - c.start_ms) - audioOffsetMs) / sourceStep),
      );
      const to = Math.min(
        wave.amp.length,
        Math.max(
          from + 1,
          Math.ceil((sourceAt(c, z - c.start_ms) - audioOffsetMs) / sourceStep),
        ),
      );
      for (let j = from; j < to; j++)
        if (wave.amp[j] >= amp[i]) {
          amp[i] = wave.amp[j];
          r[i] = wave.r[j];
          g[i] = wave.g[j];
          b[i] = wave.b[j];
        }
    }
  }
  return {
    track_id: wave.track_id,
    duration: (end - start) / 1000,
    amp,
    r,
    g,
    b,
  };
}
/** Explicit edits regenerate only the changed region. No audio times are modified. */
export function rebuildGridRegion(
  grid: WorkshopBeatGrid,
  index: number,
  bpm: number,
  anchor: number,
  beatsPerBar = grid.beats_per_bar,
): WorkshopBeatGrid {
  const next = structuredClone(grid),
    segment = next.segments[index];
  if (!segment) return grid;
  if (
    !Number.isFinite(bpm) ||
    bpm < 20 ||
    bpm > 400 ||
    !Number.isFinite(anchor)
  )
    return grid;
  next.beats_per_bar = Math.max(1, Math.min(32, Math.round(beatsPerBar)));
  next.locked = true;
  next.downbeat_confidence = 1;
  segment.bpm = bpm;
  segment.confidence = 1;
  const a = segment.start_seconds,
    z = segment.end_seconds,
    period = 60 / bpm;
  next.beats = next.beats.filter((t) => t < a - 0.000001 || t >= z - 0.000001);
  next.downbeats = next.downbeats.filter(
    (t) => t < a - 0.000001 || t >= z - 0.000001,
  );
  for (
    let n = Math.ceil((a - anchor) / period - 1e-8);
    anchor + n * period < z - 1e-8;
    n++
  ) {
    const t = anchor + n * period;
    if (t < 0) continue;
    next.beats.push(t);
    if (
      ((n % next.beats_per_bar) + next.beats_per_bar) % next.beats_per_bar ===
      0
    )
      next.downbeats.push(t);
  }
  next.beats.sort((a, b) => a - b);
  next.downbeats.sort((a, b) => a - b);
  next.beats = next.beats.filter((t, i, a) => !i || t - a[i - 1] > 0.000001);
  next.downbeats = next.downbeats.filter(
    (t, i, a) => !i || t - a[i - 1] > 0.000001,
  );
  return next;
}
