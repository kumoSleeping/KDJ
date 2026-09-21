import type { TrackSummary } from "../types";
import type { AudioVisualizerScene, VisualizerFeatureFrame, VisualizerFeatureTimeline } from "../types/audioVisualizer";
import { createAudioVisualizerScene, validateVisualizerScene } from "./audioVisualizerScene";
import { parseNeteaseWordLrc } from "./lrc";

export interface VisualizerProject {
  version: 1;
  track: Pick<TrackSummary, "id" | "path" | "title" | "artist" | "album" | "filename">;
  scene: AudioVisualizerScene;
  leftContent?: { x: number; y: number; scale: number };
  output: { fps: 30 | 60; acceleration: "auto" | "software"; directory: string; directoryMode?: "download" | "custom"; filename: string; watermark?: boolean };
  text: { visible: boolean; showAlbum?: boolean; title: string; artist: string; album: string; subtitle: string; collaboration: string; credit: string; scale: number; font: "sans" | "serif"; progress: boolean };
  look: { leftFit?: "auto" | "cover" | "contain"; rightFit?: "auto" | "cover" | "contain"; leftRotationRpm?: number; leftReflection?: number; mist?: number; accentMode?: "image" | "manual"; traceSpeed?: number; accent: string; leftVeil: number; mainSpectrum: boolean; smallSpectrum: "off" | "bars" | "line" | "mixed"; energyLine: boolean; spectrumGain: number; motion: number; glow: number; particles: number };
  lyrics: { mode: "off" | "subtitle" | "scroll" | "ring"; lrc: string; translation: string; showTranslation?: boolean; offset: number; size: number };
}
export interface VisualizerDraft { project: VisualizerProject; images: Blob[] }
export interface LyricLine { time: number; lines: string[] }
export interface StudioMotion { bass: number; pulse: number; energy: number; drift: number; phase: number }
export const STUDIO_IMAGE_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_STUDIO_LEFT_VEIL = .25;
export const STUDIO_FONTS = { sans: '"Arial", "Hiragino Sans", "Yu Gothic", "PingFang SC", "Microsoft YaHei", sans-serif', serif: '"Georgia", "Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "SimSun", serif' };
export const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
export function createVisualizerProject(track: TrackSummary): VisualizerProject {
  const scene = createAudioVisualizerScene();
  scene.canvas = { width: 1920, height: 1080, fps: 30 };
  scene.arc = { position: 0.615, bend: 0.105 };
  scene.left.rotation_deg = 180; scene.left.blur = 5; scene.left.zoom = 1.06;
  scene.disc = { mode: "cover", image: 0, x: 0.132, y: 0.245, size: 0.20, rpm: 5, direction: 1 };
  scene.spectrum = { bands: 64, length: 0.105, sensitivity: 1, smoothing: 0.72, color: [72, 223, 241, 255] };
  return {
    version: 1, track: { id: track.id, path: track.path, title: track.title, artist: track.artist, album: track.album, filename: track.filename }, scene,
    output: { fps: 30, acceleration: "auto", watermark: true, directory: "", directoryMode: "download", filename: `${safeVisualizerName(track.title || track.filename)}-可视化.mp4` },
    text: { visible: true, showAlbum: false, title: track.title || track.filename, artist: track.artist || "", album: track.album || "", subtitle: "", collaboration: "", credit: "", scale: 1, font: "sans", progress: true },
    look: { leftFit: "cover", rightFit: "auto", leftRotationRpm: .35, leftReflection: .42, mist: .38, accentMode: "image", traceSpeed: 7, accent: "#45dce8", leftVeil: DEFAULT_STUDIO_LEFT_VEIL, mainSpectrum: true, smallSpectrum: "mixed", energyLine: true, spectrumGain: 1, motion: 0.65, glow: 0.38, particles: 0.35 },
    lyrics: { mode: "off", lrc: "", translation: "", showTranslation: true, offset: 0, size: 1 },
    leftContent: { x: 0, y: 0, scale: 1 },
  };
}
export function safeVisualizerName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 100);
  return cleaned && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? cleaned : "KDJ-Visualizer";
}
export function syncVisualizerImages(project: VisualizerProject, count: number): void {
  project.scene.images = Array.from({ length: count }, (_, i) => `image:${i}`);
  for (const layer of [project.scene.left, project.scene.right, project.scene.disc]) layer.image = Math.max(0, Math.min(layer.image, count - 1));
}
export function validateVisualizerProject(p: VisualizerProject): void {
  if (!p || p.version !== 1 || !p.track || !Number.isSafeInteger(p.track.id)) throw new Error("不支持的可视化工程");
  validateVisualizerScene(p.scene);
  if (![30, 60].includes(p.output.fps) || !["auto", "software"].includes(p.output.acceleration)) throw new Error("输出参数无效");
  if (p.output.directoryMode !== undefined && !["download", "custom"].includes(p.output.directoryMode)) throw new Error("导出目录模式无效");
  if (p.output.watermark !== undefined && typeof p.output.watermark !== "boolean") throw new Error("水印参数无效");
  if (p.text.showAlbum !== undefined && typeof p.text.showAlbum !== "boolean") throw new Error("专辑信息开关无效");
  const finite = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (p.leftContent !== undefined && (!p.leftContent || !finite(p.leftContent.x, -.4, .4) || !finite(p.leftContent.y, -.4, .4) || !finite(p.leftContent.scale, .5, 1.5))) throw new Error("左侧内容布局无效");
  if (!/^#[a-f\d]{6}$/i.test(p.look.accent) || !["off", "bars", "line", "mixed"].includes(p.look.smallSpectrum) || !["off", "subtitle", "scroll", "ring"].includes(p.lyrics.mode)) throw new Error("样式参数无效");
  for (const fit of [p.look.leftFit, p.look.rightFit]) if (fit !== undefined && !["auto", "cover", "contain"].includes(fit)) throw new Error("图片适配方式无效");
  if (p.look.accentMode !== undefined && !["image", "manual"].includes(p.look.accentMode)) throw new Error("配色模式无效");
  if (p.look.traceSpeed !== undefined && !finite(p.look.traceSpeed, 1, 10)) throw new Error("连续线速度无效");
  for (const v of [p.look.leftRotationRpm, p.look.leftReflection, p.look.mist]) if (v !== undefined && !finite(v, 0, 1)) throw new Error("图层效果参数无效");
  for (const v of [p.look.leftVeil, p.look.motion, p.look.glow, p.look.particles]) if (!finite(v, 0, 1)) throw new Error("效果强度无效");
  if (!finite(p.look.spectrumGain, 0.1, 3) || !finite(p.text.scale, 0.5, 1.5) || !finite(p.lyrics.size, 0.5, 2) || !finite(p.lyrics.offset, -60, 60) || !["sans", "serif"].includes(p.text.font)) throw new Error("文本或响应参数无效");
  for (const s of [p.text.title, p.text.artist, p.text.album, p.text.subtitle, p.text.collaboration, p.text.credit]) if (typeof s !== "string" || s.length > 500) throw new Error("文字过长（最多 500 字）");
  if (p.lyrics.showTranslation !== undefined && typeof p.lyrics.showTranslation !== "boolean") throw new Error("歌词翻译开关无效");
  if (typeof p.lyrics.lrc !== "string" || typeof p.lyrics.translation !== "string" || p.lyrics.lrc.length + p.lyrics.translation.length > 500_000) throw new Error("歌词超过容量上限");
}

/** Prefer timed lyrics, not provider JSON credits; reuse the main player's YRC parser. */
export function studioLyricText(raw: string, word = ""): string {
  const text = raw.split(/\r?\n/).filter(line => !line.trimStart().startsWith("{")).join("\n").trim();
  const lines = parseNeteaseWordLrc(word || raw);
  if (!lines.length) return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text) ? text : "";
  const stamp = (time: number) => { const ms = Math.max(0, Math.round(time * 1000)); return `[${String(Math.floor(ms / 60000)).padStart(2, "0")}:${(ms % 60000 / 1000).toFixed(3).padStart(6, "0")}]`; };
  return lines.flatMap((line, i) => [stamp(line.time) + line.text, ...(line.endTime !== undefined && line.endTime < (lines[i + 1]?.time ?? Infinity) ? [stamp(line.endTime)] : [])]).join("\n");
}

/** Multi-tag LRC, millisecond fractions, global offsets, same-timestamp bilingual lines. */
export function parseVisualizerLyrics(lrc: string, translation = "", showTranslation = true): LyricLine[] {
  const parse = (raw: string): LyricLine[] => {
    const result = new Map<number, string[]>();
    const input = /^\s*\[-?\d+,-?\d+\]/m.test(raw) ? studioLyricText(raw) : raw;
    const offset = Number(input.match(/\[offset:\s*([+-]?\d+)\s*\]/i)?.[1] || 0) / 1000;
    for (const line of input.split(/\r?\n/)) {
      const tags = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      if (!tags.length) continue;
      const text = line.replace(/\[[^\]]*\]/g, "").replace(/<[^>]*>/g, "").trim();
      for (const tag of tags) {
        if (Number(tag[2]) >= 60) continue;
        const key = Math.max(0, Math.round((Number(tag[1]) * 60 + Number(tag[2]) + Number(`0.${tag[3] || 0}`) + offset) * 1000));
        const lines = result.get(key) || [];
        if (text && !lines.includes(text)) lines.push(text);
        result.set(key, lines);
      }
    }
    return [...result].sort((a, b) => a[0] - b[0]).map(([time, lines]) => ({ time: time / 1000, lines: lines.slice(0, 3) }));
  };
  const original = parse(lrc);
  if (!original.some(cue => cue.lines.length)) return [];
  // Extra same-timestamp lines are displayed as secondary text, just like
  // separately supplied translations. Keep blank timing boundaries intact.
  if (!showTranslation) return original.map(cue => ({ ...cue, lines: cue.lines.slice(0, 1) }));
  // Only the original owns cue changes and blank boundaries. A translation can
  // join an active/nearby original, never insert a cue that replaces that original.
  for (const translated of parse(translation)) {
    if (!translated.lines.length) continue;
    const index = lyricIndex(original, translated.time), active = original[index], upcoming = original[index + 1];
    let target = active?.lines.length ? active : undefined;
    const tolerance = upcoming ? Math.min(.6, (upcoming.time - (active?.time ?? 0)) * .25) : 0;
    if (upcoming?.lines.length && upcoming.time - translated.time <= tolerance && (!target || upcoming.time - translated.time < translated.time - target.time)) target = upcoming;
    if (!target) continue;
    for (const text of translated.lines) if (target.lines.length < 3 && !target.lines.includes(text)) target.lines.push(text);
  }
  return original;
}
export function hasStudioLyrics(lrc: string): boolean { return parseVisualizerLyrics(lrc).some(cue => cue.lines.length > 0); }
export function lyricIndex(lines: LyricLine[], time: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].time <= time) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
export function studioDuration(timeline: VisualizerFeatureTimeline): number { return timeline.sample_count / timeline.sample_rate; }
export function sampleStudioFeatures(timeline: VisualizerFeatureTimeline, time: number): VisualizerFeatureFrame {
  if (!timeline.frames.length) return { bands: Array(64).fill(0), bass: 0, rms: 0, onset: 0 };
  const at = clamp(time * timeline.fps, 0, timeline.frames.length - 1), i = Math.floor(at), a = timeline.frames[i], b = timeline.frames[Math.min(i + 1, timeline.frames.length - 1)], k = at - i;
  const mix = (x: number, y: number) => x + (y - x) * k;
  return { bands: a.bands.map((v, n) => mix(v, b.bands[n] || 0)), bass: mix(a.bass, b.bass), rms: mix(a.rms, b.rms), onset: mix(a.onset, b.onset) };
}
export function studioPercentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(clamp(fraction) * Math.max(0, values.length - 1))] || 0;
}
/** Precompute once. A seek to frame N is independent of previously drawn frames. */
export function prepareStudioMotion(timeline: VisualizerFeatureTimeline): StudioMotion[] {
  let bass = 0, velocity = 0, pulse = 0, energy = 0, drift = 0, phase = 0;
  const dt = 1 / timeline.fps;
  const rmsReference = Math.max(.025, studioPercentile(timeline.frames.map(f => f.rms), .95));
  const onsetFloor = studioPercentile(timeline.frames.map(f => f.onset), .5);
  const onsetRange = Math.max(.08, studioPercentile(timeline.frames.map(f => f.onset), .98) - onsetFloor);
  return timeline.frames.map(f => {
    const target = clamp(f.bass) ** 2;
    velocity += (105 * (target - bass) - 17 * velocity) * dt;
    bass += velocity * dt;
    const onset = clamp((f.onset - onsetFloor) / onsetRange);
    pulse = Math.max(onset, pulse * Math.exp(-dt * 10));
    energy += (1 - Math.exp(-f.rms / (rmsReference * .75)) - energy) * (1 - Math.exp(-dt * 5));
    // Music steers the speed of a continuous path, never a position/zoom impulse.
    // The slow envelope and integrated phase remain identical after any seek.
    drift += (energy - drift) * (1 - Math.exp(-dt * .55));
    phase += dt * (.28 + drift * .20);
    return { bass: clamp(bass), pulse, energy, drift, phase };
  });
}
export function sampleStudioMotion(frames: StudioMotion[], time: number, fps = 30): StudioMotion {
  const at = clamp(time * fps, 0, Math.max(0, frames.length - 1)), i = Math.floor(at), a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
  if (!a) return { bass: 0, pulse: 0, energy: 0, drift: 0, phase: 0 };
  const k = at - i;
  return { bass: a.bass + (b.bass - a.bass) * k, pulse: a.pulse + (b.pulse - a.pulse) * k, energy: a.energy + (b.energy - a.energy) * k, drift: a.drift + (b.drift - a.drift) * k, phase: a.phase + (b.phase - a.phase) * k };
}
export function studioClock(seconds: number): string { const n = Math.max(0, Math.floor(seconds)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; }

function studioDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kdj-visualizer-studio-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("无法打开本地设置存储"));
  });
}
interface StoredStudioImage { bytes: ArrayBuffer; type: string }
const storedStudioImages = new WeakMap<Blob, Promise<StoredStudioImage>>();
function storeStudioImage(blob: Blob): Promise<StoredStudioImage> {
  let stored = storedStudioImages.get(blob);
  if (!stored) {
    stored = blob.arrayBuffer().then(bytes => ({ bytes, type: blob.type })).catch(error => { storedStudioImages.delete(blob); throw error; });
    storedStudioImages.set(blob, stored);
  }
  return stored;
}
export async function saveVisualizerDraft(draft: VisualizerDraft): Promise<void> {
  // WebKit's IndexedDB Blob/File backing-file preparation can fail even when
  // the image decodes correctly. Store structured-cloneable bytes instead.
  const images = await Promise.all(draft.images.map(storeStudioImage));
  const db = await studioDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      const request = tx.objectStore("drafts").put({ project: draft.project, images }, draft.project.track.id);
      let failure: DOMException | null = null;
      // A request error bubbles before tx.error is populated in WebKit. Retain
      // the actual cause and settle only when the transaction commits or aborts.
      request.onerror = () => { failure = request.error; };
      tx.onerror = () => { failure ??= tx.error; };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure || tx.error || new Error("本地设置写入被中断"));
    });
  } finally { db.close(); }
}
export async function loadVisualizerDraft(id: number): Promise<VisualizerDraft | undefined> {
  const db = await studioDB();
  try {
    const stored = await new Promise<{ project: VisualizerProject; images: (Blob | StoredStudioImage)[] } | undefined>((resolve, reject) => {
      const request = db.transaction("drafts").objectStore("drafts").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法读取本地调整"));
    });
    if (!stored) return;
    const images = stored.images.map(image => {
      if (image instanceof Blob) return image; // Existing records remain readable.
      if (!(image.bytes instanceof ArrayBuffer) || image.bytes.byteLength > STUDIO_IMAGE_LIMIT || typeof image.type !== "string") throw new Error("本地图片数据无效");
      const blob = new Blob([image.bytes], { type: image.type });
      storedStudioImages.set(blob, Promise.resolve(image));
      return blob;
    });
    return { project: stored.project, images };
  } finally { db.close(); }
}
export async function studioBlobData(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(chunks.join(""))}`;
}
export async function serializeVisualizerDraft(draft: VisualizerDraft): Promise<string> {
  validateVisualizerProject(draft.project);
  return JSON.stringify({ kind: "kdj-visualizer", version: 1, project: draft.project, images: await Promise.all(draft.images.map(studioBlobData)) });
}
export function deserializeVisualizerDraft(text: string, track: TrackSummary): VisualizerDraft {
  if (text.length > STUDIO_IMAGE_LIMIT * 3) throw new Error("工程文件过大");
  const input = JSON.parse(text);
  if (input.kind !== "kdj-visualizer" || input.version !== 1 || !Array.isArray(input.images) || input.images.length < 1 || input.images.length > 2) throw new Error("无效的可视化工程文件");
  const images = input.images.map((data: unknown) => {
    if (typeof data !== "string" || !/^data:image\/(png|jpeg|webp|bmp);base64,/i.test(data)) throw new Error("工程图片无效");
    const [head, bytes] = data.split(",");
    if (bytes.length > STUDIO_IMAGE_LIMIT * 1.4) throw new Error("工程图片过大");
    const decoded = atob(bytes); return new Blob([Uint8Array.from(decoded, ch => ch.charCodeAt(0))], { type: head.slice(5, head.indexOf(";")) });
  });
  const project: VisualizerProject = input.project;
  // Import visual parameters only: never silently switch to a path/id embedded in a file.
  project.track = createVisualizerProject(track).track; project.output.directory = ""; project.output.directoryMode = "download";
  syncVisualizerImages(project, images.length); validateVisualizerProject(project);
  return { project, images };
}
