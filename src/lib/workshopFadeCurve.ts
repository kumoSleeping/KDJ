import type { WorkshopClip } from "../types/workshop";
import { clipDuration, fadeAlpha } from "./workshop";

/** Sample each visible fade, not the whole clip: short ramps on long clips
 * must end at the same time as their drag handles. Retain inherited phase. */
export function workshopFadeCurvePath(clip: WorkshopClip, audio: boolean, rampsOnly = false): string {
  const duration = clipDuration(clip);
  if (duration <= 0) return "";
  const f = clip.fades;
  const fadeIn = audio ? f.audio_in_ms : f.video_in_ms;
  const fadeOut = audio ? f.audio_out_ms : f.video_out_ms;
  const ranges = [
    [-f.offset_ms, fadeIn - f.offset_ms],
    [f.span_ms - f.offset_ms - fadeOut, f.span_ms - f.offset_ms],
  ].map(([a, b]) => [Math.max(0, a), Math.min(duration, b)])
    .filter(([a, b]) => b > a);
  const point = (time: number, i: number) =>
    `${i ? "L" : "M"}${time / duration * 100},${27 - fadeAlpha(clip, time, audio) * 23}`;
  // Timeline controls show only changing gain/opacity. The unity plateau is
  // not an edit and must not draw a line through the whole waveform/filmstrip.
  if (rampsOnly) return ranges.map(([a, b]) =>
    Array.from({length: 33}, (_, i) => point(a + (b - a) * i / 32, i)).join(" "),
  ).join(" ");
  const times = new Set([0, duration]);
  for (const [a, b] of ranges) {
    for (let i = 0; i <= 32; i++) times.add(a + (b - a) * i / 32);
  }
  return [...times].sort((a, b) => a - b).map(point).join(" ");
}
