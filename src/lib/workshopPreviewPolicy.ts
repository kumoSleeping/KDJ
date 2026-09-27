import { isVisualSource } from "./workshop";
import type { CompositionProject, WorkshopClip } from "../types/workshop";
import { clipDuration, sourceAt } from "./workshop";

const PREWARM_MS = 2500;

/** Run incoming constant-rate media through its source handles before exposing it.
 * Loading a paused first frame is not decoder warmup: WebKit can hold that frame
 * on play(). Keep the same source clock/owner across the cut, with no seek there.
 * Proxy chunks have no pre-in-point media and must not use raw-source handles. */
export function previewVideoTiming(c: WorkshopClip, time: number, proxy: boolean, part = 0, allowPreroll = true) {
  const local = time - c.start_ms;
  const inRange = time >= c.start_ms && time < c.start_ms + clipDuration(c);
  const currentPart = !proxy || Math.floor(Math.max(0, local) / 8000) === part;
  const preroll = allowPreroll && !proxy && c.speed.preset === "constant" && local < 0
    && local >= -PREWARM_MS && c.source_in_ms + local * c.speed.start >= 0;
  const target = proxy ? Math.max(0, local / 1000 - part * 8)
    : preroll ? (c.source_in_ms + local * c.speed.start) / 1000
    : sourceAt(c, Math.max(0, local)) / 1000;
  return { target, visible: inRange && currentPart, running: (inRange || preroll) && currentPart,
    preparing: preroll && local < -1000 };
}
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

/** Prewarm two upcoming clips so a subframe cut cannot hide the following clip.
 * Paused/scrubbing previews keep only the current picture, not future decoders. */
export function prepareVideoClips(p: CompositionProject, ms: number, hiddenLayers: readonly string[] = [], prewarm = true): WorkshopClip[] {
  const visualSources = new Set(p.sources.filter(isVisualSource).map(s => s.id));
  const hidden = new Set(hiddenLayers);
  return [...p.layers].reverse().flatMap(layer => {
    if (hidden.has(layer.id)) return [];
    const current: WorkshopClip[] = [], next: WorkshopClip[] = [];
    for (const c of layer.clips) {
      if (!visualSources.has(c.source_id)) continue;
      if (ms >= c.start_ms && ms < c.start_ms + clipDuration(c)) current.push(c);
      else if (prewarm && c.start_ms > ms && c.start_ms <= ms + PREWARM_MS) {
        // Keep only the two nearest successors instead of sorting every future
        // clip. Stable ties preserve the layer's original stacking order.
        const index = next.findIndex(n => n.start_ms > c.start_ms);
        if (index < 0) next.push(c); else next.splice(index, 0, c);
        if (next.length > 2) next.pop();
      }
    }
    return current.concat(next).sort((a, b) => a.start_ms - b.start_ms);
  });
}
