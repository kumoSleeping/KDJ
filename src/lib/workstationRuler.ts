import type { WorkshopBeatGrid, WorkshopLayer } from "../types/workshop";
import { clipDuration, sourceAt } from "./workshop";
import { mergeRanges, type ProjectBeat, type TimeRange } from "./workstation";

export function spacedRulerBeats(beats: readonly ProjectBeat[], start: number, end: number, width: number): ProjectBeat[] {
  if (width <= 0 || end <= start) return [];
  const visible = beats.filter(b => b.time >= start && b.time < end);
  const px = width / (end - start);
  let lastBar = -Infinity;
  const bars = visible.filter(b => {
    if (!b.downbeat || (b.time - lastBar) * px < 24) return false;
    lastBar = b.time;
    return true;
  });
  const kept = new Set(bars);
  let nextBar = 0, last = -Infinity;
  return visible.filter((b, i) => {
    while (nextBar < bars.length && bars[nextBar].time < b.time) nextBar++;
    if (kept.has(b)) { last = b.time; return true; }
    if (b.downbeat) return false;
    // Only show subdivisions where local spacing is readable; reserve room for bars.
    const before = visible[i - 1]?.time ?? -Infinity;
    const after = visible[i + 1]?.time ?? Infinity;
    if (Math.min(b.time - before, after - b.time, b.time - last,
      (bars[nextBar]?.time ?? Infinity) - b.time) * px < 12) return false;
    last = b.time;
    return true;
  });
}

/** Pixel-space culling is independent of waveform availability and playback. */
export function spacedRulerLabels<T extends { time: number; label: string }>(
  items: readonly T[], start: number, end: number, width: number,
  reserved: readonly { left: number; label: string }[] = [],
): (T & { left: number })[] {
  if (width <= 0 || end <= start) return [];
  const result: (T & { left: number })[] = [];
  let nextLeft = 0;
  for (const item of items) {
    if (item.time < start || item.time >= end) continue;
    const left = (item.time - start) / (end - start) * width;
    // 10px tabular text, with generous separation even for long bar numbers.
    const textWidth = item.label.length * 7 + 6;
    if (left < nextLeft || left + textWidth > width) continue;
    // Tempo and bar labels share one row; preserve tempo labels first.
    if (reserved.some(r => left < r.left + r.label.length * 7 + 6 + 14
      && left + textWidth + 14 > r.left)) continue;
    result.push({ ...item, left });
    nextLeft = left + Math.max(36, textWidth + 14);
  }
  return result;
}

/** Integrate source beat phase, not seconds / current BPM (tempo may change). */
export function selectedBarCount(layer: WorkshopLayer, grid: WorkshopBeatGrid, ranges: TimeRange[]): number {
  if (!grid.beats.length || grid.beats_per_bar <= 0) return 0;
  const phase = (seconds: number) => {
    const beats = grid.beats;
    let lo = 0, hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beats[mid] <= seconds) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(0, lo - 1);
    const segment = grid.segments.find(s => seconds >= s.start_seconds && seconds <= s.end_seconds);
    const period = i + 1 < beats.length ? beats[i + 1] - beats[i]
      : segment ? 60 / segment.bpm : beats.length > 1 ? beats[i] - beats[i - 1] : 0;
    return period > 0 ? i + (seconds - beats[i]) / period : i;
  };
  let count = 0;
  for (const [a, b] of mergeRanges(ranges)) {
    for (const clip of layer.clips) {
      const first = Math.max(a, clip.start_ms), last = Math.min(b, clip.start_ms + clipDuration(clip));
      if (last <= first) continue;
      count += phase(sourceAt(clip, last - clip.start_ms) / 1000)
        - phase(sourceAt(clip, first - clip.start_ms) / 1000);
    }
  }
  return count / grid.beats_per_bar;
}

export function formatBarCount(count: number): string {
  const whole = Math.floor(count), fraction = count - whole;
  for (let denominator = 1; denominator <= 64; denominator++) {
    const numerator = Math.round(fraction * denominator);
    if (Math.abs(fraction - numerator / denominator) > 0.00001) continue;
    if (!numerator) return String(whole);
    if (numerator === denominator) return String(whole + 1);
    return `${whole ? `${whole} + ` : ""}${numerator}/${denominator}`;
  }
  return `≈${count.toFixed(3)}`;
}
