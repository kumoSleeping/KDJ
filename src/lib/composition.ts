import type { CompositionOptions, CompositionSegment, CompositionTask, CompositionTimeline } from "../types/composition";

export const COMPOSITION_DEFAULTS: CompositionOptions = {
  output_mode: "new_file", length_policy: "full_audio", output_dir: "",
  alignment_mode: "sections",
  overlay: { scale: 0.5, x: 0.5, y: 0.5, opacity: 1, fade_ms: 300, audio: "main" },
  acceleration: "auto", segment: { source_start_ms: 0, source_end_ms: null },
  audio: { mode: "replace", gain: 1, main_gain: 1, fade_in_ms: 0, fade_out_ms: 0 },
};
export function compositionEditable(task: CompositionTask): boolean {
  return !task.released && !["rendering", "validating", "committing", "importing", "import_failed"].includes(task.phase);
}
export function compositionUsesSections(task: CompositionTask, options = task.video?.options): boolean {
  return Boolean(task.video_sections?.length && !task.audio?.is_video && options?.alignment_mode !== "single_offset" && options?.length_policy === "full_audio");
}
export function compositionSectionsTimeline(task: CompositionTask, segment: CompositionSegment): CompositionTimeline | null {
  const duration = task.audio_duration_ms ?? task.audio?.duration_ms ?? 0;
  const start = segment.source_start_ms, end = segment.source_end_ms ?? duration;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > duration || end <= start) return null;
  const sections = (task.video_sections ?? []).filter(s => s.audio_start_ms < end && s.audio_start_ms + s.duration_ms > start);
  return { start_ms: 0, duration_ms: end - start, video_start_ms: 0, audio_start_ms: 0, silence_head_ms: 0, silence_tail_ms: 0,
    crop_head_ms: 0, crop_tail_ms: 0, black_head_ms: Math.max(start, sections[0]?.audio_start_ms ?? end) - start,
    black_tail_ms: sections.length ? Math.max(0, end - sections.at(-1)!.audio_start_ms - sections.at(-1)!.duration_ms) : 0 };
}
export function compositionSectionVideoTime(task: CompositionTask, audioMs: number): number | null {
  const section = task.video_sections?.find(s => audioMs >= s.audio_start_ms && audioMs < s.audio_start_ms + s.duration_ms);
  return section ? section.video_start_ms + audioMs - section.audio_start_ms : null;
}
export function compositionSectionSummary(task: CompositionTask, segment = task.video!.options.segment): string {
  const start = segment.source_start_ms, end = segment.source_end_ms ?? task.audio_duration_ms ?? task.audio?.duration_ms ?? 0;
  const sections = (task.video_sections ?? []).filter(s => s.audio_start_ms < end && s.audio_start_ms + s.duration_ms > start);
  const coverage = sections.reduce((sum,s) => sum + Math.max(0, Math.min(end,s.audio_start_ms+s.duration_ms)-Math.max(start,s.audio_start_ms)),0);
  return `${sections.length} 段画面 · 补黑 ${seconds(Math.max(0,end-start-coverage))}`;
}
export function compositionSegmentTimeline(video: number, audio: number, offset: number, full: boolean, segment: CompositionSegment): CompositionTimeline | null {
  const start = segment.source_start_ms, end = segment.source_end_ms ?? audio;
  if (![start, end, offset, offset + start].every(Number.isSafeInteger) || start < 0 || end <= start || end > audio) return null;
  return compositionTimeline(video, end - start, offset + start, full);
}
export function compositionTimeline(video: number, audio: number, offset: number, full: boolean): CompositionTimeline | null {
  if (![video, audio, offset].every(Number.isFinite) || video <= 0 || audio <= 0 || Math.min(video, offset + audio) <= Math.max(0, offset)) return null;
  const start = full ? Math.min(0, offset) : 0;
  const end = full ? Math.max(video, offset + audio) : video;
  return {
    start_ms: start, duration_ms: end - start, video_start_ms: -start, audio_start_ms: offset - start,
    silence_head_ms: Math.max(0, offset - start), silence_tail_ms: Math.max(0, end - offset - audio),
    crop_head_ms: Math.min(audio, Math.max(0, start - offset)), crop_tail_ms: Math.min(audio, Math.max(0, offset + audio - end)),
    black_head_ms: Math.max(0, -start), black_tail_ms: Math.max(0, end - video),
  };
}
export function compositionDifferences(timeline: CompositionTimeline, overlay = false): string[] {
  if (overlay) return [`叠加 ${seconds(Math.max(0, timeline.audio_start_ms))}–${seconds(timeline.duration_ms - timeline.silence_tail_ms)}`];
  return ([
    ["片头静音", timeline.silence_head_ms], ["片尾静音", timeline.silence_tail_ms],
    ["裁掉音频开头", timeline.crop_head_ms], ["裁掉音频结尾", timeline.crop_tail_ms],
    ["片头补黑", timeline.black_head_ms], ["片尾补黑", timeline.black_tail_ms],
  ] as const).filter(([, value]) => value > 0).map(([label, value]) => `${label} ${seconds(value)}`);
}
export function seconds(ms: number): string { return `${(ms / 1000).toFixed(3).replace(/\.?0+$/, "")} s`; }
export function offsetLabel(offset: number): string { return `${offset >= 0 ? "+" : "−"}${seconds(Math.abs(offset))}${offset === 0 ? "" : offset > 0 ? "（延后）" : "（提前）"}`; }

export function moveEntry(ids: string[], source: string, target: string): string[] {
  const from = ids.indexOf(source), to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids]; next.splice(from, 1); next.splice(to, 0, source); return next;
}

export function overlayAlpha(time: number, start: number, end: number, opacity: number, fadeMs: number): number {
  if (time < start || time >= end) return 0;
  const fade = Math.min(fadeMs / 1000, (end - start) / 2);
  return opacity * (fade > 0 ? Math.min(1, (time - start) / fade, (end - time) / fade) : 1);
}
