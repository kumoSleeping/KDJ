import { isVisualSource } from "./workshop";
import type { CompositionProject, WorkshopClip } from "../types/workshop";
import { clipDuration } from "./workshop";
/** Coalesce requests while WebKit is decoding a seek; never flush it every RAF. */
export class WorkshopSeekGate {
  private last = new WeakMap<object, number>();
  request(video: { seeking: boolean; currentTime: number }, target: number, playing: boolean, fps: number, now: number): number | null {
    if (video.seeking || !Number.isFinite(target)) return null;
    const tolerance = playing ? 0.25 : 0.5 / Math.max(1, fps);
    if (Math.abs(video.currentTime - target) <= tolerance) return null;
    if (now - (this.last.get(video) ?? -Infinity) < (playing ? 500 : 80)) return null;
    this.last.set(video, now);
    return Math.max(0, target);
  }
}

/** Prewarm two upcoming clips so a subframe cut cannot hide the following clip. */
export function prepareVideoClips(p: CompositionProject, ms: number, hiddenLayers: readonly string[] = []): WorkshopClip[] {
  return [...p.layers].reverse().flatMap(layer => {
    if (hiddenLayers.includes(layer.id)) return [];
    if (!isVisualSource(p.sources.find(s => s.id === layer.source_id))) return [];
    const current = layer.clips.filter(c => ms >= c.start_ms && ms < c.start_ms + clipDuration(c));
    const next = layer.clips.filter(c => c.start_ms > ms && c.start_ms <= ms + 1000)
      .sort((a,b) => a.start_ms - b.start_ms).slice(0, 2);
    return [...current, ...next].sort((a, b) => a.start_ms - b.start_ms);
  });
}
