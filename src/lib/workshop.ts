import type {
  ClipHandle,
  ClipSpeed,
  CompositionProject,
  WorkshopClip,
  WorkshopSource,
} from "../types/workshop";
export const cloneProject = (p: CompositionProject): CompositionProject =>
  structuredClone(p);
export const isImageSource = (s: WorkshopSource | undefined) => s?.kind === "image" || s?.kind === "gif";
export const isVisualSource = (s: WorkshopSource | undefined) => Boolean(s?.video || isImageSource(s));
// Match CompositionProject::sync_output_format so drafts and persisted edits agree.
export function syncOutputFormat(p: CompositionProject, previous: CompositionProject): void {
  if (p.output.format !== previous.output.format) return;
  const hasPicture = (project: CompositionProject) => project.layers.some(layer =>
    layer.clips.some(clip => isVisualSource(project.sources.find(s => s.id === clip.source_id))));
  const before = hasPicture(previous), after = hasPicture(p);
  if (!before && after) p.output.format = "mp4";
  else if (before && !after && (p.output.format ?? "mp4") === "mp4") p.output.format = "wav";
}
export function imageTime(c: WorkshopClip, local: number): number { return (c.animation_offset_ms ?? 0) + clamp(local, 0, clipDuration(c)); }
export const uid = () => crypto.randomUUID();
export const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));
export const smooth = (v: number) => {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
};
export function speedAt(speed: ClipSpeed, source: number): number {
  if (speed.preset === "constant") return speed.start;
  const x = clamp(
    (source - speed.domain_start_ms) /
      (speed.domain_end_ms - speed.domain_start_ms),
    0,
    1,
  );
  if (speed.preset === "ramp")
    return speed.start + (speed.end - speed.start) * smooth(x);
  return x < 0.5
    ? speed.start + (speed.middle - speed.start) * smooth(x * 2)
    : speed.middle + (speed.end - speed.middle) * smooth(x * 2 - 1);
}
export interface TimePart {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  rate: number;
}
// Keep the source-domain quadrature in sync with kdj_core::workshop::Clip::parts.
const maps = new WeakMap<WorkshopClip, { key: string; parts: TimePart[] }>();
export function timeParts(c: WorkshopClip): TimePart[] {
  if (c.display_duration_ms != null) return [{sourceStart: c.animation_offset_ms ?? 0, sourceEnd: (c.animation_offset_ms ?? 0) + c.display_duration_ms, outputStart: 0, outputEnd: c.display_duration_ms, rate: 1}];
  const signature = JSON.stringify([c.source_in_ms, c.source_out_ms, c.speed]);
  const cached = maps.get(c);
  if (cached?.key === signature) return cached.parts;
  const count = c.speed.preset === "constant" ? 1 : 256,
    step = (c.speed.domain_end_ms - c.speed.domain_start_ms) / count;
  let output = 0;
  const parts: TimePart[] = [];
  for (let i = 0; i < count; i++) {
    const lo = c.speed.domain_start_ms + i * step,
      hi = lo + step,
      a = Math.max(lo, c.source_in_ms),
      b = Math.min(hi, c.source_out_ms);
    if (b <= a) continue;
    const rate = speedAt(c.speed, (lo + hi) / 2),
      end = output + (b - a) / rate;
    parts.push({
      sourceStart: a,
      sourceEnd: b,
      outputStart: output,
      outputEnd: end,
      rate,
    });
    output = end;
  }
  maps.set(c, { key: signature, parts });
  return parts;
}
export const clipDuration = (c: WorkshopClip) =>
  timeParts(c).at(-1)?.outputEnd ?? 0;
export function sourceAt(c: WorkshopClip, local: number): number {
  if (c.display_duration_ms != null) return imageTime(c, local);
  const parts = timeParts(c),
    p = parts.find((p) => local < p.outputEnd) ?? parts.at(-1);
  return p
    ? clamp(
        p.sourceStart + (local - p.outputStart) * p.rate,
        c.source_in_ms,
        c.source_out_ms,
      )
    : c.source_in_ms;
}
export function outputAt(c: WorkshopClip, source: number): number {
  if (c.display_duration_ms != null) return clamp(source - (c.animation_offset_ms ?? 0), 0, c.display_duration_ms);
  const parts = timeParts(c),
    p = parts.find((p) => source < p.sourceEnd) ?? parts.at(-1);
  return p
    ? p.outputStart +
        (clamp(source, c.source_in_ms, c.source_out_ms) - p.sourceStart) /
          p.rate
    : 0;
}
export const projectDuration = (p: CompositionProject) =>
  Math.max(
    0,
    ...p.layers.flatMap((l) =>
      l.clips.map((c) => c.start_ms + clipDuration(c)),
    ),
  );
export const findClip = (p: CompositionProject, id: string | null) =>
  p.layers.flatMap((l) => l.clips).find((c) => c.id === id);
export function fadeAlpha(
  c: WorkshopClip,
  local: number,
  audio = false,
): number {
  const f = c.fades,
    age = f.offset_ms + local,
    i = audio ? f.audio_in_ms : f.video_in_ms,
    o = audio ? f.audio_out_ms : f.video_out_ms;
  const ramp = f.linear ? (v: number) => clamp(v, 0, 1) : smooth;
  return (
    (i > 0 ? ramp(age / i) : 1) * (o > 0 ? ramp((f.span_ms - age) / o) : 1)
  );
}
export function visibleFade(c: WorkshopClip, end: boolean, audio = false): number {
  const f = c.fades, d = clipDuration(c);
  const value = audio ? (end ? f.audio_out_ms : f.audio_in_ms) : (end ? f.video_out_ms : f.video_in_ms);
  return Math.max(0, Math.min(d, value - (end ? f.span_ms - f.offset_ms - d : f.offset_ms)));
}
export function setClipFade(c: WorkshopClip, end: boolean, audio: boolean, value: number): void {
  const d = clipDuration(c);
  // Rebase from the envelope actually visible on this cut. A hidden parent
  // fade must not reappear at the opposite edge when the user drags a handle.
  c.fades = {...c.fades,
    video_in_ms: visibleFade(c, false), video_out_ms: visibleFade(c, true),
    audio_in_ms: visibleFade(c, false, true), audio_out_ms: visibleFade(c, true, true),
    offset_ms: 0, span_ms: d, linear: false};
  const field = audio ? (end ? "audio_out_ms" : "audio_in_ms") : (end ? "video_out_ms" : "video_in_ms");
  c.fades[field] = clamp(value, 0, d / 2);
}
export function resetFadeSpan(c: WorkshopClip): void {
  const d = clipDuration(c);
  c.fades = { ...c.fades, offset_ms: 0, span_ms: d };
  for (const k of [
    "video_in_ms",
    "video_out_ms",
    "audio_in_ms",
    "audio_out_ms",
  ] as const)
    c.fades[k] = Math.min(c.fades[k], d / 2);
}
export function validateProject(p: CompositionProject): string {
  const markers = p.markers ?? [];
  if (markers.length > 5000 || new Set(markers.map(m => m.id)).size !== markers.length
    || new Set(markers.map(m => m.number)).size !== markers.length
    || markers.some(m => !m.id || !Number.isFinite(m.position_ms) || m.position_ms < 0 || m.position_ms > 21_600_000
      || !Number.isInteger(m.number) || m.number < 1 || m.number > 4294967295)) return "标记参数无效";
  const layout = p.canvas.import_picture;
  if (layout && !([
    [layout.x, 0, 1], [layout.y, 0, 1],
    [layout.scale, .1, 2], [layout.opacity, 0, 1],
  ].every(([value, min, max]) => Number.isFinite(value) && value >= min && value <= max)))
    return "新素材画面参数无效";
  for (const l of p.layers) {
    let end = 0;
    for (const c of [...l.clips].sort((a, b) => a.start_ms - b.start_ms)) {
      const s = p.sources.find((s) => s.id === c.source_id);
      if (
        !s ||
        !Number.isFinite(c.start_ms) ||
        c.start_ms < 0 ||
        c.source_in_ms < 0 ||
        c.source_out_ms > s.duration_ms + 0.001 ||
        c.source_out_ms <= c.source_in_ms
      )
        return "片段区间越界";
      if (
        ![c.speed.start, c.speed.middle, c.speed.end].every(
          (v) => Number.isFinite(v) && v >= 0.5 && v <= 2,
        )
      )
        return "速度必须在 0.5×–2× 之间";
      const crop = c.picture.crop ?? [0,0,0,0];
      if (!crop.every(n => Number.isFinite(n) && n >= 0 && n <= .99) || crop[0] + crop[2] >= .99 || crop[1] + crop[3] >= .99) return "裁剪范围无效";
      if (![c.picture.x, c.picture.y, c.picture.scale, c.picture.opacity, c.picture.rotation ?? 0].every(Number.isFinite)) return "画面参数无效";
      if (isImageSource(s) !== (c.display_duration_ms != null)) return "图片显示时长无效";
      if (c.video_transition && (!s.video || !Number.isFinite(c.video_transition.duration_ms)
        || c.video_transition.duration_ms < 0 || c.video_transition.duration_ms > 10000
        || ![-1, 0, 1].includes(c.video_transition.alignment))) return "画面过渡参数无效";
      const duration = clipDuration(c);
      if (duration < 0.001 || !Number.isFinite(duration)) return "片段区间无效";
      if (c.start_ms + 0.001 < end) return "本行片段重叠，请先移动后续片段";
      end = c.start_ms + duration;
    }
  }
  return "";
}
export function updateClip(
  p: CompositionProject,
  id: string,
  edit: (c: WorkshopClip) => void,
): CompositionProject {
  const next = cloneProject(p),
    c = findClip(next, id);
  if (c) edit(c);
  return next;
}
export function splitClip(
  p: CompositionProject,
  id: string,
  position: number,
): CompositionProject {
  const next = cloneProject(p),
    layer = next.layers.find((l) => l.clips.some((c) => c.id === id)),
    c = layer?.clips.find((c) => c.id === id);
  if (!layer || !c) return p;
  const local = position - c.start_ms,
    min = clipQuantum(p, c);
  if (local < min - 0.001 || clipDuration(c) - local < min - 0.001) return p;
  const cut = sourceAt(c, local),
    right = structuredClone(c);
  right.id = uid();
  delete right.video_transition;
  right.start_ms = position;
  if (c.display_duration_ms != null) {
    right.display_duration_ms = c.display_duration_ms - local;
    right.animation_offset_ms = cut;
    c.display_duration_ms = local;
  } else right.source_in_ms = cut;
  right.fades.offset_ms += local;
  if (c.display_duration_ms == null) c.source_out_ms = cut;
  layer.clips.splice(layer.clips.indexOf(c) + 1, 0, right);
  return next;
}
export function deleteClip(
  p: CompositionProject,
  id: string,
  ripple = activeLayerCount(p) === 1,
): CompositionProject {
  const next = cloneProject(p),
    layer = next.layers.find((l) => l.clips.some((c) => c.id === id)),
    c = layer?.clips.find((c) => c.id === id);
  if (!layer || !c) return p;
  const end = c.start_ms + clipDuration(c),
    d = clipDuration(c);
  layer.clips = layer.clips
    .filter((c) => c.id !== id)
    .map((c) =>
      ripple && c.start_ms >= end ? { ...c, start_ms: c.start_ms - d } : c,
    );
  return next;
}
export function duplicateClip(
  p: CompositionProject,
  id: string,
): CompositionProject {
  const c = findClip(p, id);
  if (!c) return p;
  const next = cloneProject(p);
  next.layers.push({
    id: uid(),
    source_id: c.source_id,
    grid: structuredClone(p.layers.find(l => l.clips.some(clip => clip.id === id))?.grid),
    clips: [{ ...structuredClone(c), id: uid() }],
  });
  return next;
}
export function moveLayer(
  p: CompositionProject,
  id: string,
  target: number,
): CompositionProject {
  const next = cloneProject(p),
    from = next.layers.findIndex((l) => l.id === id);
  if (from < 0) return p;
  const [layer] = next.layers.splice(from, 1);
  next.layers.splice(clamp(target, 0, next.layers.length), 0, layer);
  return next;
}
export function snapTime(
  p: CompositionProject,
  value: number,
  exclude: string,
  playhead: number,
  tolerance: number,
): number {
  const candidates = [
    0,
    playhead,
    ...p.layers.flatMap((l) =>
      l.clips
        .filter((c) => c.id !== exclude)
        .flatMap((c) => [c.start_ms, c.start_ms + clipDuration(c)]),
    ),
  ];
  const target = candidates.reduce(
    (best, t) => (Math.abs(t - value) < Math.abs(best - value) ? t : best),
    Infinity,
  );
  return Math.abs(target - value) <= tolerance ? target : value;
}
export function adjustClip(
  p: CompositionProject,
  id: string,
  handle: ClipHandle,
  delta: number,
): CompositionProject {
  return updateClip(p, id, (c) => {
    const frame = clipQuantum(p, c);
    if (handle === "move") {
      c.start_ms = Math.max(0, c.start_ms + delta);
      return;
    }
    if (handle.includes("fade_")) {
      const audio = handle.startsWith("audio_"), end = handle.endsWith("out");
      const value = visibleFade(c, end, audio) + (end ? -delta : delta);
      setClipFade(c, end, audio, value);
      return;
    }
    if (c.display_duration_ms != null) {
      if (handle === "in") {
        const d = clamp(delta, Math.max(-c.start_ms, -(c.animation_offset_ms ?? 0)), c.display_duration_ms - frame);
        c.start_ms += d; c.animation_offset_ms = (c.animation_offset_ms ?? 0) + d; c.display_duration_ms -= d;
        const offset = c.fades.offset_ms + d;
        if (offset < 0) c.fades.span_ms -= offset;
        c.fades.offset_ms = Math.max(0, offset);
      } else c.display_duration_ms = clamp(c.display_duration_ms + delta, frame, 21_600_000 - c.start_ms);
      c.fades.span_ms = Math.max(c.fades.span_ms, c.fades.offset_ms + c.display_duration_ms);
      return;
    }
    // Evaluate extension against the retained parent speed domain, not the trimmed clip.
    const full = {
      ...c,
      source_in_ms: c.speed.domain_start_ms,
      source_out_ms: c.speed.domain_end_ms,
    };
    if (handle === "in") {
      const old = outputAt(full, c.source_in_ms),
        max = outputAt(full, c.source_out_ms) - frame;
      const t = clamp(old + delta, Math.max(0, old - c.start_ms), max);
      c.source_in_ms = sourceAt(full, t);
      c.start_ms += t - old;
    } else {
      const old = outputAt(full, c.source_out_ms),
        min = outputAt(full, c.source_in_ms) + frame;
      c.source_out_ms = sourceAt(
        full,
        clamp(old + delta, min, clipDuration(full)),
      );
    }
    resetFadeSpan(c);
  });
}
export const SPEED_PRESETS = [
  { label: "0.5×", preset: "constant", start: 0.5, middle: 0.5, end: 0.5 },
  { label: "0.75×", preset: "constant", start: 0.75, middle: 0.75, end: 0.75 },
  { label: "1×", preset: "constant", start: 1, middle: 1, end: 1 },
  { label: "1.25×", preset: "constant", start: 1.25, middle: 1.25, end: 1.25 },
  { label: "1.5×", preset: "constant", start: 1.5, middle: 1.5, end: 1.5 },
  { label: "2×", preset: "constant", start: 2, middle: 2, end: 2 },
  { label: "渐快", preset: "ramp", start: 0.5, middle: 1, end: 2 },
  { label: "渐慢", preset: "ramp", start: 2, middle: 1, end: 0.5 },
  { label: "慢快慢", preset: "pulse", start: 0.5, middle: 2, end: 0.5 },
  { label: "快慢快", preset: "pulse", start: 2, middle: 0.5, end: 2 },
] as const;
export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(3).padStart(6, "0")}`;
}

export const activeLayerCount = (p: CompositionProject) => p.layers.filter(l => l.clips.length > 0).length;
export const clipQuantum = (p: CompositionProject, c: WorkshopClip) => isVisualSource(p.sources.find(s => s.id === c.source_id)) ? 1000 / p.canvas.fps : 1000 / 48000;
