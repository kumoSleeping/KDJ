import type { CompositionProject, RhythmResponse, WorkshopBeatGrid, WorkshopClip, WorkshopLayer, WorkshopSource } from "../types/workshop";
import { clipDuration, clipQuantum, outputAt } from "./workshop";
import { analysisGrid, projectBeats } from "./workstation";

export type WorkshopRhythmResults = Record<string, RhythmResponse | undefined>;
export const rhythmKey = (source: WorkshopSource) => `${source.track_id}:${source.signature}`;
export function workshopGrid(layer: WorkshopLayer, source: WorkshopSource, results: WorkshopRhythmResults): WorkshopBeatGrid | null {
  const saved = layer.grid?.source_signature === source.signature ? layer.grid : null;
  if (saved?.locked) return saved;
  const analysis = results[rhythmKey(source)]?.analysis;
  return analysis ? analysisGrid(analysis, source.signature) : saved;
}

/** Snap to every rendered beat (1/4 bar in 4/4), not just downbeats.
 * Include retained source handles so trimmed clips can snap while extending again. */
export function clipBeatTimes(clip: WorkshopClip, grid: WorkshopBeatGrid, extend = false): number[] {
  const full = extend ? {...clip, source_in_ms: clip.speed.domain_start_ms, source_out_ms: clip.speed.domain_end_ms} : clip;
  const base = extend ? clip.start_ms - outputAt(full, clip.source_in_ms) : clip.start_ms;
  return projectBeats({id: "snap", source_id: clip.source_id, clips: [{...full, start_ms: base}]}, grid)
    .map(b => b.time);
}
export function nearestBeat(times: readonly number[], time: number, tolerance = Infinity): number | null {
  if (!times.length) return null;
  let a = 0, b = times.length;
  while (a < b) { const m = (a + b) >>> 1; if (times[m] < time) a = m + 1; else b = m; }
  const left = times[Math.max(0, a - 1)], right = times[Math.min(times.length - 1, a)];
  const target = Math.abs(time - left) <= Math.abs(right - time) ? left : right;
  return Math.abs(target - time) <= tolerance ? target : null;
}
export function workshopCutTime(p: CompositionProject, id: string, time: number, results: WorkshopRhythmResults, enabled: boolean): number {
  if (!enabled) return time;
  const layer = p.layers.find(l => l.clips.some(c => c.id === id));
  const clip = layer?.clips.find(c => c.id === id);
  const source = p.sources.find(s => s.id === clip?.source_id);
  if (!layer || !clip || !source?.audio) return time;
  // Never pull an out-of-clip playhead into the selected clip merely to make a cut.
  if (time <= clip.start_ms || time >= clip.start_ms + clipDuration(clip)) return time;
  const grid = workshopGrid(layer, source, results);
  if (!grid) return time;
  const quantum = clipQuantum(p, clip);
  const beats = clipBeatTimes(clip, grid).filter(t => t >= clip.start_ms + quantum && t <= clip.start_ms + clipDuration(clip) - quantum);
  return nearestBeat(beats, time) ?? time;
}
