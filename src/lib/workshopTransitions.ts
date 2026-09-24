import type { CompositionProject, VideoTransition, WorkshopClip } from "../types/workshop";
import { cloneProject, clipDuration, outputAt, sourceAt, visibleFade } from "./workshop";

export function videoTransitionSpan(left: WorkshopClip, right: WorkshopClip): {before: number; after: number} | null {
  const t = right.video_transition;
  if (!t || t.duration_ms <= 0 || Math.abs(left.start_ms + clipDuration(left) - right.start_ms) > .01) return null;
  const full = (c: WorkshopClip): WorkshopClip => ({...c, source_in_ms:c.speed.domain_start_ms, source_out_ms:c.speed.domain_end_ms});
  const a = full(left), b = full(right), beforeFraction = (1 - t.alignment) / 2, afterFraction = 1 - beforeFraction;
  const beforeMax = Math.min(outputAt(b, right.source_in_ms), clipDuration(left) / 2);
  const afterMax = Math.min(clipDuration(a) - outputAt(a, left.source_out_ms), clipDuration(right) / 2);
  let duration = t.duration_ms;
  if (beforeFraction > 0) duration = Math.min(duration, beforeMax / beforeFraction);
  if (afterFraction > 0) duration = Math.min(duration, afterMax / afterFraction);
  return duration > .01 ? {before:duration * beforeFraction, after:duration * afterFraction} : null;
}

/** Derived clocks only; the saved edit points and clip parameters stay unchanged.
 * The legacy video_transition field now describes a joint for either media type. */
export function videoProject(p: CompositionProject): CompositionProject {
  return transitionProject(p, false);
}
export function audioProject(p: CompositionProject): CompositionProject {
  return transitionProject(p, true);
}
function transitionProject(p: CompositionProject, audio: boolean): CompositionProject {
  const projected = cloneProject(p);
  for (const layer of projected.layers) {
    layer.clips.sort((a, b) => a.start_ms - b.start_ms);
    const original = layer.clips.map(c => structuredClone(c));
    const heads = new Map<number, {before:number; duration:number}>(), tails = new Map<number, {after:number; duration:number}>();
    for (let i = 1; i < original.length; i++) {
      if (![original[i-1], original[i]].every(c => {
        const source = p.sources.find(s => s.id === c.source_id);
        return audio ? source?.audio : source?.video;
      })) continue;
      const span = videoTransitionSpan(original[i-1], original[i]);
      if (span) {
        heads.set(i, {before:span.before, duration:span.before + span.after});
        tails.set(i-1, {after:span.after, duration:span.before + span.after});
      }
    }
    layer.clips.forEach((c, i) => {
      if (!heads.has(i) && !tails.has(i)) return;
      const old = original[i], full = {...old, source_in_ms:old.speed.domain_start_ms, source_out_ms:old.speed.domain_end_ms};
      const before = heads.get(i)?.before ?? 0, after = tails.get(i)?.after ?? 0;
      c.source_in_ms = sourceAt(full, outputAt(full, old.source_in_ms) - before);
      c.source_out_ms = sourceAt(full, outputAt(full, old.source_out_ms) + after);
      c.start_ms -= before;
      c.fades = {...c.fades, offset_ms:0, span_ms:clipDuration(c), linear:false,
        ...(audio ? {
          audio_in_ms:heads.get(i)?.duration ?? visibleFade(old, false, true),
          audio_out_ms:tails.get(i)?.duration ?? visibleFade(old, true, true),
        } : {
          video_in_ms:heads.get(i)?.duration ?? visibleFade(old, false),
          // Source-over needs an opaque outgoing plane, not two dimmed planes.
          video_out_ms:tails.has(i) ? 0 : visibleFade(old, true),
        })};
    });
  }
  return projected;
}

export function setVideoTransition(p: CompositionProject, rightId: string, value: VideoTransition | null): CompositionProject {
  const next = cloneProject(p);
  const clip = next.layers.flatMap(l => l.clips).find(c => c.id === rightId);
  if (clip) {
    if (value) clip.video_transition = {...value, duration_ms:Math.max(0, Math.min(10000, value.duration_ms))};
    else delete clip.video_transition;
  }
  return next;
}
