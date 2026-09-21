import type { VisualizerFeatureTimeline, VisualizerFeatureFrame } from "../types/audioVisualizer";
import { defaultVisualizerTransform } from "./audioVisualizerScene";
import { fitVisualizerImage, type VisualizerImage } from "./audioVisualizerImage";
import { extractStudioPalette, type StudioPalette } from "./visualizerStudioPalette";
import { clamp, lyricIndex, parseVisualizerLyrics, prepareStudioMotion, sampleStudioFeatures, sampleStudioMotion, studioClock, studioDuration, studioPercentile, STUDIO_FONTS, validateVisualizerProject, type LyricLine, type StudioMotion, type VisualizerProject } from "./visualizerStudio";

const LYRIC_ACTIVE_SCALE = 1.2;
const LYRIC_PREVIEW_SCALE = .88;

interface RollingLyric extends LyricLine { start: number; end: number }
interface LyricCard { canvas: HTMLCanvasElement }
interface DiscLayers { back: HTMLCanvasElement; front: HTMLCanvasElement; x: number; y: number }
interface ClockLayer { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; key: string; top: number }
interface LyricViewport {
  canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; mask: CanvasGradient;
  top: number; padding: number; leadY: number; gap: number; size: number; cardHeight: number;
}
export interface PreparedStudio {
  project: VisualizerProject; timeline: VisualizerFeatureTimeline; motion: StudioMotion[]; lyrics: LyricLine[];
  left: HTMLCanvasElement; reflection: HTMLCanvasElement; leftWidth: number;
  right: HTMLCanvasElement; rightX: number; disc: HTMLCanvasElement; cover: HTMLCanvasElement;
  light: HTMLCanvasElement; mist: HTMLCanvasElement; energyTrace: Float32Array; spectrumScale: number;
  palette: StudioPalette; leftShade: StudioPalette["shade"]; rail: HTMLCanvasElement; railX: number; information: HTMLCanvasElement;
  arcBars: { point: [number, number, number, number]; frequency: number; envelope: number }[];
  arcBarWidth: number; arcLengths: Float64Array; discLayers: DiscLayers | null; clockLayer: ClockLayer | null;
  lyricCards: Map<number, LyricCard>; lyricFlow: RollingLyric[]; lyricViewport: LyricViewport | null;
  contentScale: number; watermark: HTMLCanvasElement | null;
}
const imageLayers = new WeakMap<VisualizerImage, Map<string, HTMLCanvasElement>>();
function cachedLayer(image: VisualizerImage, key: unknown[], render: () => HTMLCanvasElement): HTMLCanvasElement {
  let layers = imageLayers.get(image);
  if (!layers) { layers = new Map(); imageLayers.set(image, layers); }
  const id = JSON.stringify(key), cached = layers.get(id);
  if (cached) { layers.delete(id); layers.set(id, cached); return cached; }
  const layer = render(); layers.set(id, layer);
  // Bound retained textures even while dragging, resizing or changing presets.
  // One complete scene uses ten layers, including the two small disc caches.
  if (layers.size > 10) layers.delete(layers.keys().next().value!);
  return layer;
}
const timelineData = new WeakMap<VisualizerFeatureTimeline, { motion: StudioMotion[]; energyTrace: Float32Array; spectrumScale: number }>();
function prepareTimeline(timeline: VisualizerFeatureTimeline) {
  const cached = timelineData.get(timeline); if (cached) return cached;
  const rmsReference = Math.max(.025, studioPercentile(timeline.frames.map(f => f.rms), .95));
  const peak = studioPercentile(timeline.frames.map(f => Math.max(...f.bands)), .95);
  const spectrumScale = .85 / Math.max(.25, Math.expm1(peak * 5.5) / Math.expm1(5.5));
  const follow = 1 - Math.exp(-6 / timeline.fps); let baseline = 0;
  // AC energy, not fabricated PCM or a clipped, filled volume meter.
  const energyTrace = Float32Array.from(timeline.frames, f => {
    baseline += (f.rms - baseline) * follow;
    return Math.tanh((f.rms - baseline) / rmsReference * 6.5);
  });
  const result = { motion: prepareStudioMotion(timeline), energyTrace, spectrumScale };
  timelineData.set(timeline, result); return result;
}
let lightSprites: { light: HTMLCanvasElement; mist: HTMLCanvasElement } | undefined;
export async function loadStudioImages(blobs: Blob[]): Promise<HTMLImageElement[]> {
  if (blobs.length < 1 || blobs.length > 2) throw new Error("需要一至两张图片");
  return Promise.all(blobs.map(blob => new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob), image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 32_000_000) reject(new Error("图片超过 3200 万像素")); else resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片无法解码，请使用 PNG / JPEG / WebP / BMP")); };
    image.src = url;
  })));
}
function fitStudioPicture(image: VisualizerImage, transform: Parameters<typeof fitVisualizerImage>[1], width: number, height: number, fit = "cover"): HTMLCanvasElement {
  const iw = "naturalWidth" in image ? image.naturalWidth : image.width;
  const ih = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (fit === "cover" || (fit === "auto" && iw / ih >= .85)) return fitVisualizerImage(image, transform, width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const c = canvas.getContext("2d")!;
  const angle = transform.rotation_deg * Math.PI / 180, co = Math.abs(Math.cos(angle)), si = Math.abs(Math.sin(angle));
  // A little safe margin keeps a complete portrait inside the independently
  // moving panel. The user can still zoom and move it intentionally.
  const scale = .94 * Math.min(width / (iw * co + ih * si), height / (iw * si + ih * co)) * transform.zoom;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
  c.save(); c.translate(width / 2 + (.5 - transform.focus_x) * width * .5, height / 2 + (.5 - transform.focus_y) * height * .5);
  c.rotate(angle); c.scale(transform.mirror_x ? -1 : 1, transform.mirror_y ? -1 : 1);
  if (transform.blur) c.filter = `blur(${transform.blur}px)`;
  c.drawImage(image, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  c.restore();
  return canvas;
}

/** Small baked sprites keep diffusion soft without full-resolution per-frame filters. */
function lightTexture(mist: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas"); canvas.width = 384; canvas.height = 384;
  const c = canvas.getContext("2d")!;
  const lobes = mist ? [[.37, .48, .34, .34], [.60, .42, .29, .30], [.51, .63, .30, .26], [.66, .59, .22, .20], [.29, .38, .21, .18]] : [[.5, .5, .49, 1]];
  for (const [x, y, radius, alpha] of lobes) {
    const g = c.createRadialGradient(x * 384, y * 384, 0, x * 384, y * 384, radius * 384);
    g.addColorStop(0, `rgba(250,255,255,${alpha})`);
    g.addColorStop(.22, `rgba(237,255,255,${alpha * .86})`);
    g.addColorStop(.50, `rgba(163,241,255,${alpha * .40})`);
    g.addColorStop(.82, `rgba(95,216,246,${alpha * .08})`);
    g.addColorStop(1, "rgba(95,216,246,0)");
    c.fillStyle = g; c.fillRect(0, 0, 384, 384);
  }
  return canvas;
}

/** Preview may use a smaller backing store; export always omits previewWidth.
 * Geometry/time/color stay shared. Expensive immutable layers survive text/color edits. */
export function prepareStudio(project: VisualizerProject, images: VisualizerImage[], timeline: VisualizerFeatureTimeline, previewWidth?: number): PreparedStudio {
  validateVisualizerProject(project);
  if (images.length !== project.scene.images.length || !timeline.frames.length) throw new Error("图片或音频尚未准备完成");
  const p = structuredClone(project), scale = previewWidth ? Math.min(1, previewWidth / p.scene.canvas.width) : 1;
  p.scene.canvas.width = Math.max(2, Math.round(p.scene.canvas.width * scale));
  p.scene.canvas.height = Math.max(2, Math.round(p.scene.canvas.height * scale));
  p.scene.left.blur *= scale; p.scene.right.blur *= scale;
  const { width: w, height: h } = p.scene.canvas;
  const source = images[p.scene.right.image], palette = extractStudioPalette(source);
  if ((p.look.accentMode ?? "image") === "image") p.look.accent = palette.accent;
  const arc = studioArc(p), rightX = Math.floor(arc.cx - arc.radius), leftWidth = Math.ceil(p.scene.arc.position * w);
  const backingSize = Math.ceil(Math.hypot(leftWidth, h) * 1.04), leftSource = images[p.scene.left.image];
  const leftShade = extractStudioPalette(leftSource).shade;
  const left = cachedLayer(leftSource, ["left", p.scene.left, backingSize, p.look.leftFit], () => fitStudioPicture(leftSource, p.scene.left, backingSize, backingSize, p.look.leftFit || "cover"));
  const reflection = cachedLayer(leftSource, ["reflection", p.scene.left, leftWidth, h, p.look.leftFit, scale], () => {
    const layer = fitStudioPicture(leftSource, { ...p.scene.left, rotation_deg: p.scene.left.rotation_deg - 180, mirror_x: !p.scene.left.mirror_x, blur: Math.max(4 * scale, p.scene.left.blur * 1.6) }, leftWidth, h, p.look.leftFit || "cover");
    const rc = layer.getContext("2d")!, mask = rc.createLinearGradient(0, 0, 0, h);
    mask.addColorStop(0, "rgba(0,0,0,.08)"); mask.addColorStop(.45, "rgba(0,0,0,.55)"); mask.addColorStop(1, "rgba(0,0,0,.9)");
    rc.globalCompositeOperation = "destination-in"; rc.fillStyle = mask; rc.fillRect(0, 0, leftWidth, h); rc.globalCompositeOperation = "source-over";
    return layer;
  });
  const right = cachedLayer(source, ["right", p.scene.right, w - rightX, h, p.look.rightFit], () => fitStudioPicture(source, p.scene.right, w - rightX, h, p.look.rightFit || "auto"));
  const contentScale = clamp(rightX / w / .51, .2, 1.35);
  const size = Math.max(2, Math.round(Math.min(w, h) * p.scene.disc.size * Math.min(1, contentScale))), discSource = images[p.scene.disc.image];
  // Anchor the entire sleeve/disc group to the album's left gutter, not a
  // separately remembered disc center. Size/aspect changes must not push the
  // sleeve off the left edge. Rotation below remains local to the disc center.
  p.scene.disc.x = (w * .035 * contentScale + size * (p.scene.disc.mode === "cover" ? .86 : .51)) / w;
  if (!p.text.showAlbum || !p.text.visible) p.scene.disc.y = Math.max(size / (2 * h) + .02, p.scene.disc.y - .03);
  const disc = cachedLayer(discSource, ["disc", size], () => {
    const layer = fitVisualizerImage(discSource, defaultVisualizerTransform(), size, size), c = layer.getContext("2d")!;
    c.globalCompositeOperation = "destination-in"; c.beginPath(); c.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = "source-over";
    return layer;
  });
  const cover = cachedLayer(discSource, ["cover", size], () => {
    const layer = fitStudioPicture(discSource, defaultVisualizerTransform(), size, size, "auto"), c = layer.getContext("2d")!;
    c.globalCompositeOperation = "destination-over"; c.fillStyle = "#eff4ef"; c.fillRect(0, 0, size, size); c.globalCompositeOperation = "source-over";
    return layer;
  });
  const railX = Math.floor(rightX - h * .06);
  const rail = cachedLayer(source, ["rail", w, h, p.scene.arc, p.look.accent], () => {
    const layer = document.createElement("canvas"); layer.width = Math.ceil(leftWidth - railX + h * .06); layer.height = h;
    const c = layer.getContext("2d")!; c.translate(-railX, 0); paintArcRail(c, p); return layer;
  });
  const lyrics = parseVisualizerLyrics(p.lyrics.lrc, p.lyrics.translation, p.lyrics.showTranslation !== false);
  const lyricFlow: RollingLyric[] = [];
  for (const [index, cue] of lyrics.entries()) {
    if (!cue.lines.length) continue;
    // Blank source cues end the old sentence, but never become empty display rows.
    // Promote the upcoming sentence at that boundary, dimmed until its actual start.
    lyricFlow.push({ ...cue, time: lyricFlow.at(-1)?.end ?? 0, start: cue.time, end: lyrics[index + 1]?.time ?? studioDuration(timeline) });
  }
  const lyricViewport = lyricFlow.length ? prepareLyricViewport(p, contentScale, lyricFlow) : null;
  const lyricLayout = p.lyrics.mode !== "off" && lyrics.length > 0;
  const information = cachedLayer(source, ["text", w, h, p.text, p.look.accent, lyricLayout, contentScale], () => {
    const layer = document.createElement("canvas"); layer.width = Math.ceil(w * .51 * contentScale); layer.height = Math.ceil(h * .75);
    paintInformation(layer.getContext("2d")!, p, lyricLayout, contentScale); return layer;
  });
  const watermark = p.output.watermark === false ? null : cachedLayer(source, ["watermark", "@KDJ", w, h], () => {
    const layer = document.createElement("canvas"); layer.width = Math.ceil(h * .14); layer.height = Math.ceil(h * .046);
    const c = layer.getContext("2d")!; c.textAlign = "right"; c.shadowColor = "rgba(9,24,30,.8)"; c.shadowBlur = h * .003;
    // Fade the entire mark, including its outline, rather than just the fill.
    c.globalAlpha = .55;
    paintText(c, "@KDJ", layer.width - h * .004, h * .034, h * .026, layer.width - h * .008, STUDIO_FONTS.sans, "500");
    return layer;
  });
  lightSprites ??= { light: lightTexture(false), mist: lightTexture(true) };
  // Extra off-canvas bars continue the radial tips through both image edges.
  const arcBars = Array.from({ length: 100 }, (_, i) => {
    const u = (i + .5) / 100 * 1.24 - .12, distance = Math.abs(u - .5);
    return { point: arcPoint(p, u, 0), frequency: .08 + distance * (u < .5 ? 1.65 : 1.84), envelope: .16 + .84 * Math.cos(clamp(distance * 2) * Math.PI / 2) ** .65 };
  });
  const arcBarWidth = arc.radius * arc.angle * 2 * 1.24 / arcBars.length;
  const discLayers = p.scene.disc.mode === "hidden" ? null : prepareDiscLayers(p, discSource, cover, size);
  return { project: p, timeline, ...prepareTimeline(timeline), lyrics, lyricCards: new Map(), lyricFlow, lyricViewport, contentScale, left, reflection, leftWidth, right, rightX, disc, cover, ...lightSprites, palette, leftShade, rail, railX, information, arcBars, arcBarWidth, arcLengths: new Float64Array(arcBars.length), discLayers, clockLayer: null, watermark };
}

/** Circular segment of the large right-hand disc; all rails and bars share it.
 * Older drafts may have a negative bend: retain their depth, but face the left
 * half of the circle rather than reverting to an S-curve or a parabola. */
function studioArc(p: VisualizerProject) {
  const { width: w, height: h } = p.scene.canvas;
  const sag = Math.min(h * .48, w * Math.max(.015, Math.abs(p.scene.arc.bend)));
  const radius = (h * h / 4 + sag * sag) / (2 * sag);
  return { cx: p.scene.arc.position * w - sag + radius, cy: h / 2, radius, angle: Math.asin(h / (2 * radius)) };
}
/** Hit-test the same circular boundary used by the preview and export. */
export function studioPictureSideAt(p: VisualizerProject, x: number, y: number): "left" | "right" {
  const arc = studioArc(p), dy = y - arc.cy;
  const edge = arc.cx - Math.sqrt(Math.max(0, arc.radius * arc.radius - dy * dy));
  return x < edge ? "left" : "right";
}
function arcPoint(p: VisualizerProject, u: number, shift: number, offset = 0): [number, number, number, number] {
  const a = studioArc(p), angle = (u * 2 - 1) * a.angle;
  const nx = Math.cos(angle), ny = -Math.sin(angle);
  return [a.cx + shift - (a.radius - offset) * nx, a.cy - (a.radius - offset) * ny, nx, ny];
}
function arcPath(c: CanvasRenderingContext2D, p: VisualizerProject, shift: number, side?: "left" | "right", offset = 0): void {
  const { width: w, height: h } = p.scene.canvas, a = studioArc(p);
  const angle = side ? a.angle : Math.asin(Math.min(1, (h / 2 + h * .06) / (a.radius - offset)));
  c.beginPath(); c.arc(a.cx + shift, a.cy, a.radius - offset, Math.PI + angle, Math.PI - angle, true);
  if (side) { const x = side === "right" ? w + 4 : -4; c.lineTo(x, h); c.lineTo(x, 0); c.closePath(); }
}
function paintLeftLayers(c: CanvasRenderingContext2D, s: PreparedStudio, t: number, m: StudioMotion): void {
  const { project: p, left, reflection, leftWidth } = s, h = p.scene.canvas.height, power = p.look.motion;
  c.save(); c.translate(leftWidth / 2, h / 2);
  c.rotate(t * Math.PI * 2 / 60 * (p.look.leftRotationRpm ?? .35) * power);
  c.drawImage(left, -left.width / 2, -left.height / 2); c.restore();
  c.save(); c.globalAlpha = p.look.leftReflection ?? .42;
  c.translate(leftWidth / 2 - Math.sin(m.phase) * power * h * .003, h / 2 + Math.cos(m.phase * .7) * power * h * .003);
  c.scale(1.045, 1.045); c.drawImage(reflection, -leftWidth / 2, -h / 2); c.restore();
  // Only the background receives this album-derived shade; content is drawn later.
  c.save(); c.globalAlpha = p.look.leftVeil * s.leftShade.alphaScale;
  c.fillStyle = s.leftShade.color; c.fillRect(0, 0, p.scene.canvas.width, h); c.restore();
}
function paintRightImage(c: CanvasRenderingContext2D, s: PreparedStudio, m: StudioMotion): void {
  const { width: w, height: h } = s.right, power = s.project.look.motion;
  const dx = power * h * (Math.sin(m.phase) * .040 + Math.sin(m.phase * .63) * .012);
  const dy = power * h * Math.sin(m.phase * .79) * .030;
  c.save(); c.translate(s.rightX + w / 2 + dx, h / 2 + dy);
  // Constant overscan: changing it with displacement was the unwanted zoom pulse.
  // No beat impulses, rotation or per-frame expansion, just a slow continuous path.
  const scale = 1.015 + power * h * .108 / Math.min(w, h);
  c.scale(scale, scale); c.drawImage(s.right, -w / 2, -h / 2); c.restore();
}
function paintText(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, width: number, font: string, weight = "400", color = "#ffffff", outline = true): void {
  if (!text) return;
  c.save(); c.textBaseline = "alphabetic"; c.font = `${weight} ${size}px ${font}`;
  const measure = c.measureText(text).width;
  const fitted = measure > width ? Math.max(4, size * width / measure) : size;
  c.font = `${weight} ${fitted}px ${font}`;
  if (outline) { c.strokeStyle = "rgba(9,24,30,.72)"; c.lineWidth = Math.max(.5, fitted * .035); c.lineJoin = "round"; c.strokeText(text, x, y); }
  c.fillStyle = color; c.fillText(text, x, y); c.restore();
}
function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, font: string, accent: string): void {
  c.save(); c.shadowColor = "transparent"; c.shadowBlur = 0;
  const textX = x, baseline = y, size = h * .038;
  // Small labels need near-white luminance; retain only a hint of album color.
  const channels = [1, 3, 5].map(at => Math.round(parseInt(accent.slice(at, at + 2), 16) * .14 + 255 * .86));
  const tint = `rgb(${channels.join(",")})`;
  /* Temporarily hide the half-diamond label outline for visual comparison.
  c.font = `600 ${size}px ${font}`;
  const measuredWidth = c.measureText(text).width;
  const fitted = measuredWidth > h * .6 ? Math.max(4, size * h * .6 / measuredWidth) : size;
  c.font = `600 ${fitted}px ${font}`;
  const metrics = c.measureText(text);
  // Anchor the lower-left tip to the body text below; keep the label close
  // to the angled edge. The right/top-right stay deliberately open.
  const left = x, slant = h * .006;
  const top = baseline - (metrics.actualBoundingBoxAscent || fitted * .8) - h * .010;
  const bottom = baseline + (metrics.actualBoundingBoxDescent || fitted * .2) + h * .008;
  const right = textX + metrics.width + h * .006;
  const upperEnd = textX + Math.min(metrics.width * .18, h * .050);
  c.strokeStyle = tint; c.lineWidth = Math.max(1.25, h * .004); c.lineJoin = "miter"; c.lineCap = "butt";
  c.beginPath(); c.moveTo(upperEnd, top);
  c.lineTo(left + slant, top);
  c.lineTo(left, bottom);
  c.lineTo(right, bottom);
  c.stroke();
  // Extend both open ends into slender points, joined at the stroke's full
  // width rather than adding an arrowhead or a blunt rectangular cap.
  const halfStroke = c.lineWidth / 2;
  c.fillStyle = tint;
  c.beginPath();
  c.moveTo(upperEnd, top - halfStroke);
  c.lineTo(upperEnd + h * .035, top);
  c.lineTo(upperEnd, top + halfStroke);
  c.closePath();
  c.moveTo(right, bottom - halfStroke);
  c.lineTo(right + h * .045, bottom);
  c.lineTo(right, bottom + halfStroke);
  c.closePath(); c.fill();
  */
  c.shadowColor = "rgba(9,24,30,.3)"; c.shadowBlur = h * .002;
  paintText(c, text, textX, baseline, size, h * .6, font, "600", tint, false); c.restore();
}
function prepareDiscLayers(p: VisualizerProject, image: VisualizerImage, cover: HTMLCanvasElement, size: number): DiscLayers {
  const d = p.scene.disc, { width: w, height: h } = p.scene.canvas, cx = d.x * w, cy = d.y * h;
  // Integer world-space origins preserve the original static raster alignment.
  // Padding includes the sleeve's offset and the full soft-shadow footprint.
  const pad = Math.ceil(Math.max(h * .014, size * .065) * 4 + h * .005 + size * .043);
  const x = Math.floor(cx - size * (d.mode === "cover" ? .86 : .51) - pad), y = Math.floor(cy - size * .51 - pad);
  const width = Math.ceil(cx + size * .51 + pad) - x, height = Math.ceil(cy + size * .51 + pad) - y;
  const layer = (front: boolean) => cachedLayer(image, ["disc-static", front, w, h, d, size], () => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const c = canvas.getContext("2d")!; c.translate(cx - x, cy - y);
    if (front) paintDiscFront(c, p, cover, size); else paintDiscBack(c, h, size);
    return canvas;
  });
  return { back: layer(false), front: layer(true), x, y };
}
function paintDiscBack(c: CanvasRenderingContext2D, h: number, size: number): void {
  c.shadowColor = "rgba(15,35,38,.5)"; c.shadowBlur = h * .014; c.shadowOffsetY = h * .005;
  const rim = c.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2);
  rim.addColorStop(0, "#faffeb"); rim.addColorStop(.35, "#788f8d"); rim.addColorStop(.66, "#eef5df"); rim.addColorStop(1, "#5c7375");
  c.fillStyle = rim; c.beginPath(); c.arc(0, 0, size * .51, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0; c.shadowOffsetY = 0;
}
function paintDiscFront(c: CanvasRenderingContext2D, p: VisualizerProject, cover: HTMLCanvasElement, size: number): void {
  c.strokeStyle = "rgba(235,247,230,.4)"; c.lineWidth = size * .003;
  for (const r of [.44, .46, .48]) { c.beginPath(); c.arc(0, 0, size * r, 0, Math.PI * 2); c.stroke(); }
  c.fillStyle = "rgba(239,247,234,.9)"; c.beginPath(); c.arc(0, 0, size * .08, 0, Math.PI * 2); c.fill();
  c.fillStyle = "rgba(44,62,61,.65)"; c.beginPath(); c.arc(0, 0, size * .025, 0, Math.PI * 2); c.fill();
  if (p.scene.disc.mode === "cover") {
    // Equal-height sleeve/disc; only the rightmost 36% of the disc is exposed.
    const x = -size * .86, y = -size / 2;
    c.shadowColor = "rgba(10,24,27,.65)"; c.shadowBlur = size * .065; c.shadowOffsetX = size * .018; c.shadowOffsetY = size * .025;
    c.drawImage(cover, x, y); c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
    const lip = c.createLinearGradient(0, y + size * .84, 0, y + size);
    lip.addColorStop(0, "rgba(209,226,216,.08)"); lip.addColorStop(.12, "rgba(86,117,110,.38)"); lip.addColorStop(1, "rgba(33,62,58,.60)");
    c.fillStyle = lip; c.fillRect(x, y + size * .84, size, size * .16);
    c.strokeStyle = "rgba(242,255,241,.45)"; c.lineWidth = Math.max(.5, size * .004); c.strokeRect(x, y, size, size);
  }
}
function paintDisc(c: CanvasRenderingContext2D, s: PreparedStudio, t: number): void {
  const layers = s.discLayers; if (!layers) return;
  const p = s.project, d = p.scene.disc, { width: w, height: h } = p.scene.canvas, size = s.disc.width;
  c.drawImage(layers.back, layers.x, layers.y);
  c.save(); c.translate(d.x * w, d.y * h); c.rotate(t * Math.PI * 2 * d.rpm / 60 * d.direction);
  c.drawImage(s.disc, -size / 2, -size / 2); c.restore();
  c.drawImage(layers.front, layers.x, layers.y);
}
function spectrumValue(f: VisualizerFeatureFrame, at: number, gain: number): number {
  const n = clamp(at, 0, 1) * (f.bands.length - 1), i = Math.floor(n), k = n - i;
  const level = clamp((f.bands[i] || 0) * (1 - k) + (f.bands[Math.min(i + 1, f.bands.length - 1)] || 0) * k);
  // Analysis bands are log magnitudes (-60..0 dB), not linear bar heights.
  // Recover contrast before visual gain so a dense master is not a uniform comb.
  return clamp(Math.expm1(level * 5.5) / Math.expm1(5.5) * gain);
}
function paintArcRail(c: CanvasRenderingContext2D, p: VisualizerProject): void {
  const { height: h } = p.scene.canvas, shift = 0;
  c.save();
  c.shadowColor = "rgba(14,39,42,.45)"; c.shadowBlur = h * .011;
  arcPath(c, p, shift, undefined, -h * .007); c.strokeStyle = "rgba(240,250,234,.9)"; c.lineWidth = h * .006; c.stroke(); c.shadowBlur = 0;
  arcPath(c, p, shift, undefined, -h * .017); c.strokeStyle = "rgba(246,255,248,.8)"; c.lineWidth = h * .0024; c.setLineDash([h * .01, h * .005]); c.stroke(); c.setLineDash([]);
  arcPath(c, p, shift, undefined, h * .004); c.strokeStyle = p.look.accent; c.lineWidth = h * .0025; c.stroke();
  const dots = 56;
  for (let i = 0; i <= dots; i++) {
    const [x, y] = arcPoint(p, i / dots, shift, -h * .007);
    c.fillStyle = p.look.accent;
    c.beginPath(); c.arc(x, y, h * .0038, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
function paintArc(c: CanvasRenderingContext2D, s: PreparedStudio, f: VisualizerFeatureFrame): void {
  const p = s.project, { width: w, height: h } = p.scene.canvas;
  c.drawImage(s.rail, s.railX, 0); c.save();
  if (p.look.mainSpectrum) {
    const count = s.arcBars.length, gain = p.look.spectrumGain * s.spectrumScale;
    c.lineCap = "butt";
    for (let i = 0; i < count; i++) {
      const bar = s.arcBars[i];
      s.arcLengths[i] = h * .004 + spectrumValue(f, bar.frequency, gain) * bar.envelope * w * p.scene.spectrum.length * 1.2;
    }
    // Low/mid bands occupy the middle of the arc, with treble toward both ends.
    // Gentle edge attenuation balances the composition without inventing beats.
    for (const cyan of [false, true]) {
      c.beginPath();
      for (let i = 0; i < count; i++) {
        const [x, y, nx, ny] = s.arcBars[i].point, length = s.arcLengths[i];
        if (!cyan) { c.moveTo(x - nx * h * .026, y - ny * h * .026); c.lineTo(x - nx * (h * .026 + length * .34), y - ny * (h * .026 + length * .34)); }
        c.moveTo(x + nx * h * .012, y + ny * h * .012);
        c.lineTo(x + nx * (length * (cyan ? .68 : 1) + h * .012), y + ny * (length * (cyan ? .68 : 1) + h * .012));
      }
      c.strokeStyle = cyan ? p.look.accent : "rgba(255,255,255,.97)";
      c.shadowColor = "rgba(6,26,40,.5)"; c.shadowBlur = cyan ? 0 : h * .004;
      c.lineWidth = Math.max(1, s.arcBarWidth * (cyan ? .34 : .70)); c.stroke();
    }
  }
  c.restore();
}
function paintSmallSpectrum(c: CanvasRenderingContext2D, s: PreparedStudio, f: VisualizerFeatureFrame, t: number): void {
  const p = s.project, mode = p.look.smallSpectrum; if (mode === "off") return;
  const gain = p.look.spectrumGain * s.spectrumScale;
  const lyricLayout = p.lyrics.mode !== "off" && s.lyricFlow.length > 0;
  const { width: w, height: h } = p.scene.canvas, x = w * .066 * s.contentScale, width = w * .376 * s.contentScale, base = h * (lyricLayout ? .935 : .925), amp = h * (lyricLayout ? .105 : .145), count = Math.max(20, Math.round(48 * Math.min(1, s.contentScale)));
  const values = Array.from({ length: count }, (_, i) => spectrumValue(f, i / (count - 1), gain));
  c.save(); c.lineJoin = "round"; c.lineCap = "round";
  // A thin, unfilled history with a diffused echo, never a filled volume meter.
  if (p.look.energyLine) {
    const points = 96, center = h * (lyricLayout ? .894 : .858), traceHeight = h * (lyricLayout ? .06 : .087), window = 2.4 / (p.look.traceSpeed ?? 7);
    c.beginPath();
    for (let i = 0; i <= points; i++) {
      const time = t - window + i / points * window;
      const at = clamp(time * s.timeline.fps, 0, s.energyTrace.length - 1), index = Math.floor(at), k = at - index;
      const a = s.energyTrace[index], b = s.energyTrace[Math.min(index + 1, s.energyTrace.length - 1)];
      const value = time < 0 ? 0 : a + (b - a) * k;
      const y = center - value * traceHeight, px = x + i / points * width;
      if (i === 0) c.moveTo(px, y); else c.lineTo(px, y);
    }
    c.strokeStyle = "rgba(9,24,30,.78)"; c.lineWidth = Math.max(2.4, h * .007); c.stroke();
    c.strokeStyle = "#f9fcff"; c.lineWidth = Math.max(1.3, h * .004); c.stroke();
  }
  if (mode !== "line") {
    c.beginPath();
    for (let i = 0; i < count; i++) {
      const height = Math.max(h * .002, values[i] * amp);
      c.rect(x + i * width / count, base - height, width / count * .68, height);
    }
    // One shadow rasterization for the entire spectrum, not one blur per bar.
    c.fillStyle = "rgba(255,255,255,.97)"; c.shadowColor = "rgba(15,31,38,.65)"; c.shadowBlur = h * .002; c.shadowOffsetY = h * .002; c.fill();
    c.shadowBlur = 0; c.shadowOffsetY = 0;
  }
  if (mode !== "bars") {
    const smooth = values.map((_, i) => {
      let sum = 0;
      for (let n = -2; n <= 2; n++) sum += values[clamp(i + n, 0, count - 1)] * (3 - Math.abs(n));
      return base - amp * sum / 9 * .72 - h * .001;
    });
    c.beginPath(); c.moveTo(x, smooth[0]);
    for (let i = 1; i < count; i++) {
      const px = x + (i - 1) / (count - 1) * width, next = x + i / (count - 1) * width;
      c.quadraticCurveTo(px, smooth[i - 1], (px + next) / 2, (smooth[i - 1] + smooth[i]) / 2);
    }
    c.lineTo(x + width, smooth[count - 1]);
    c.strokeStyle = p.look.accent; c.lineWidth = h * .003; c.stroke();
  }
  c.restore();
}
function paintLights(c: CanvasRenderingContext2D, s: PreparedStudio, t: number, m: StudioMotion, shift: number): void {
  const p = s.project, { width: w, height: h } = p.scene.canvas;
  c.save();
  c.save(); arcPath(c, p, shift, "right"); c.clip(); c.globalCompositeOperation = "screen";
  const anchors = [[.65, .20], [.80, .31], [.86, .49], [.63, .84]];
  for (const [i, [ax, ay]] of anchors.entries()) {
    const drift = t * .25 + i * 2.3;
    const x = w * (ax + Math.sin(drift) * .018), y = h * (ay + Math.cos(drift * .73) * .035);
    const breathe = ((1 + Math.sin(t * (.68 + i * .07) + i * 2.1)) / 2) ** 2;
    if ((p.look.mist ?? .38) > 0) {
      c.save(); c.translate(x + Math.sin(drift * .81) * h * .035, y); c.rotate(Math.sin(drift) * .35);
      c.globalAlpha = (p.look.mist ?? .38) * (.10 + breathe * .30 + m.drift * .08);
      const width = h * (.46 + i % 2 * .1), height = h * (.24 + m.drift * .035);
      c.drawImage(s.mist, -width / 2, -height / 2, width, height); c.restore();
    }
    if (p.look.glow > 0) {
      const radius = h * (.065 + i % 2 * .015) * (.8 + breathe * .35);
      c.globalAlpha = p.look.glow * (.08 + breathe * .58 + m.drift * .15);
      c.drawImage(s.light, x - radius, y - radius, radius * 2, radius * 2);
    }
  }
  c.restore();
  const random = (seed: number) => { const v = Math.sin(seed * 127.1 + 31.7) * 43758.5453; return v - Math.floor(v); };
  for (let i = 0; i < Math.round(p.look.particles * 55); i++) {
    const x = ((random(i + 1) + t * .002 * (i % 2 ? 1 : -1)) % 1 + 1) % 1 * w;
    const y = ((random(i + 99) - t * .004) % 1 + 1) % 1 * h;
    const size = h * (.0013 + random(i + 44) * .004) * (1 + m.pulse * .3);
    c.globalAlpha = (.1 + .3 * Math.sin(t * 1.1 + i) ** 2) * p.look.particles;
    c.fillStyle = i % 3 ? "#f7ffff" : p.look.accent; c.beginPath(); c.moveTo(x, y - size); c.quadraticCurveTo(x, y, x + size, y); c.quadraticCurveTo(x, y, x, y + size); c.quadraticCurveTo(x, y, x - size, y); c.quadraticCurveTo(x, y, x, y - size); c.fill();
  }
  c.restore();
}
function prepareLyricViewport(p: VisualizerProject, contentScale: number, flow: RollingLyric[]): LyricViewport {
  const { width: w, height: h } = p.scene.canvas;
  // Keep the resting layout unchanged; extend only the exit area above it so
  // the old cue can pass through a soft mask instead of hitting a hard crop.
  const originalOnly = flow.every(cue => cue.lines.length === 1);
  const restingTop = h * (p.text.subtitle ? .555 : .505), exitBand = h * .035;
  const top = restingTop - exitBand;
  const canvas = document.createElement("canvas"); canvas.width = Math.ceil(w * .47 * contentScale); canvas.height = Math.ceil(h * .82 - top);
  const context = canvas.getContext("2d")!, padding = h * .009, gap = h * (originalOnly ? .024 : .014);
  const leadY = exitBand + padding;
  const extraLines = flow.reduce((max, cue) => Math.max(max, cue.lines.length - 1), 0);
  const slots = Math.min(2, flow.length);
  const scaleBudget = LYRIC_ACTIVE_SCALE + (slots > 1 ? LYRIC_PREVIEW_SCALE : 0);
  const cardHeight = Math.floor((Math.ceil(h * .82 - restingTop) - padding * 2 - gap * (slots - 1)) / scaleBudget);
  const rowBudget = 1.3 + extraLines * .84 * 1.30;
  // Reserve complete original/translation blocks for both current and next cues.
  // A long wrapped block fits once and keeps that layout when promoted.
  const size = Math.min(h * .060 * p.lyrics.size * p.text.scale * Math.min(1, contentScale), cardHeight / rowBudget);
  const mask = context.createLinearGradient(0, 0, 0, canvas.height);
  // Fully opaque at the lead slot; feather the entire upper exit band, while
  // retaining only a narrow lower edge so the preview stays readable.
  mask.addColorStop(0, "rgba(0,0,0,0)"); mask.addColorStop(leadY / canvas.height, "#000");
  mask.addColorStop(1 - padding / canvas.height, "#000"); mask.addColorStop(1, "rgba(0,0,0,0)");
  return { canvas, context, mask, top, padding, leadY, gap, size, cardHeight };
}
const lyricWords = new Intl.Segmenter("en", { granularity: "word" });
const lyricGraphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
function lyricWrapPoints(text: string) {
  const normalized = text.normalize("NFC");
  const graphemes = [...lyricGraphemes.segment(normalized)];
  const chars = graphemes.map(part => part.segment);
  const wordEnds = new Set([...lyricWords.segment(normalized)].map(part => part.index + part.segment.length));
  const breaks = new Set<number>();
  for (let i = 1; i < chars.length; i++) {
    if (!wordEnds.has(graphemes[i].index)) continue;
    // Keep closing punctuation with the preceding word and opening brackets
    // with the following word. Segmenter also keeps contractions intact.
    if (/^[、。，．！？：；,.!?;:%…）】》」』〕〉\)\]\}’”]/u.test(chars[i])) continue;
    if (/[（【《「『〔〈\(\[\{‘“]$/u.test(chars[i - 1])) continue;
    breaks.add(i);
  }
  return { chars, breaks };
}
function lyricCard(s: PreparedStudio, index: number): LyricCard | null {
  const line = s.lyricFlow[index], viewport = s.lyricViewport; if (!line?.lines.length || !viewport) return null;
  const cached = s.lyricCards.get(index); if (cached) return cached;
  const p = s.project, { width: w, height: h } = p.scene.canvas;
  const card = document.createElement("canvas"); card.width = Math.ceil(w * .47 * s.contentScale / LYRIC_ACTIVE_SCALE);
  const c = card.getContext("2d")!, font = STUDIO_FONTS[p.text.font];
  // Wrap at the enlarged active width so promotion never clips the right edge.
  const width = w * .455 * s.contentScale / LYRIC_ACTIVE_SCALE, texts = line.lines.map(lyricWrapPoints);
  const available = viewport.cardHeight;
  const layout = (size: number) => {
    const rows: { text: string; size: number; y: number; translated: boolean }[] = [];
    let y = size, fitsWidth = true;
    for (const [i, { chars, breaks }] of texts.entries()) {
      const fontSize = size * (i ? .84 : 1);
      if (i) y += fontSize * 1.30;
      c.font = `${i ? 600 : 700} ${fontSize}px ${font}`;
      let rowIndex = 0;
      for (let offset = 0; offset < chars.length;) {
        while (offset < chars.length && /^\s+$/u.test(chars[offset])) offset++;
        if (offset === chars.length) break;
        if (rowIndex++) y += fontSize * 1.18;
        let lo = 0, hi = chars.length - offset;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (c.measureText(chars.slice(offset, offset + mid).join("")).width <= width) lo = mid; else hi = mid - 1;
        }
        if (!lo) fitsWidth = false;
        let end = offset + Math.max(1, lo);
        if (end < chars.length) {
          // Prefer the last complete word that fits. Split at a grapheme only
          // when the first word itself is wider than the entire line.
          for (let boundary = end; boundary > offset; boundary--) {
            if (breaks.has(boundary)) { end = boundary; break; }
          }
        }
        rows.push({ text: chars.slice(offset, end).join("").trimEnd(), size: fontSize, y, translated: i > 0 });
        offset = end;
      }
    }
    return { size, rows, fitsWidth, height: Math.ceil(Math.max(size * 1.3, y + size * .28)) };
  };
  // Word-aware wrapping is shared by originals and translations. Only an
  // overflowing block shrinks; preview and export reuse the same card layout.
  let fitted = layout(viewport.size);
  if (fitted.height > available || !fitted.fitsWidth) {
    let lo = 0, hi = viewport.size;
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = layout((lo + hi) / 2);
      if (candidate.height <= available && candidate.fitsWidth) { lo = candidate.size; fitted = candidate; } else hi = candidate.size;
    }
  }
  const { rows } = fitted;
  card.height = fitted.height;
  c.shadowColor = "rgba(0,0,0,.85)"; c.shadowBlur = h * .002;
  for (const row of rows) {
    c.font = `${row.translated ? 600 : 700} ${row.size}px ${font}`;
    c.strokeStyle = "rgba(0,0,0,.72)"; c.lineWidth = Math.max(.65, row.size * .035); c.lineJoin = "round";
    c.strokeText(row.text, h * .003, row.y);
    c.fillStyle = "#ffffff";
    c.fillText(row.text, h * .003, row.y);
  }
  const result = { canvas: card };
  s.lyricCards.set(index, result);
  if (s.lyricCards.size > 8) s.lyricCards.delete(s.lyricCards.keys().next().value!);
  return result;
}
function paintRollingLyrics(c: CanvasRenderingContext2D, s: PreparedStudio, time: number): void {
  const viewport = s.lyricViewport; if (!viewport) return;
  const { width: w } = s.project.scene.canvas, flow = s.lyricFlow;
  const index = Math.max(0, lyricIndex(flow, time)), cue = flow[index];
  const current = lyricCard(s, index), previous = lyricCard(s, index - 1), next = lyricCard(s, index + 1);
  if (!current) return;
  const smooth = (value: number) => { const k = clamp(value); return k * k * k * (k * (k * 6 - 15) + 10); };
  const interval = flow[index + 1] ? flow[index + 1].time - cue.time : Infinity;
  const duration = Math.min(.32, Math.max(.001, interval * .45), index > 0 ? Math.max(.001, (cue.time - flow[index - 1].time) * .45) : .32);
  const progress = index > 0 ? clamp((time - cue.time) / duration) : 1;
  // One uninterrupted roll: incoming and outgoing cues share the same travel
  // and scale progress. The old cue is fully transparent when the new one lands.
  const enter = 1 - (1 - progress) ** 3, leave = 1 - enter;
  const outgoingScale = LYRIC_ACTIVE_SCALE + (LYRIC_PREVIEW_SCALE - LYRIC_ACTIVE_SCALE) * enter;
  const previewAlpha = .78;
  const currentScale = LYRIC_PREVIEW_SCALE + (LYRIC_ACTIVE_SCALE - LYRIC_PREVIEW_SCALE) * enter;
  const lastFade = next ? 0 : smooth((time - Math.max(cue.start, Math.min(cue.end, studioDuration(s.timeline) - .65))) / .65);
  const layer = viewport.context, x = Math.round(w * .004 * s.contentScale), y = viewport.leadY;
  const oldStep = (previous?.canvas.height ?? current.canvas.height) * LYRIC_ACTIVE_SCALE + viewport.gap;
  const step = current.canvas.height * currentScale + viewport.gap;
  layer.clearRect(0, 0, viewport.canvas.width, viewport.canvas.height);
  const draw = (item: LyricCard, top: number, alpha: number, scale = 1) => {
    if (alpha <= 0) return;
    // Original, wrapped rows and translation move as one complete block.
    // Only the viewport boundary feathers; no per-line crop or delayed detail.
    layer.save();
    layer.translate(x, top); layer.scale(scale, scale);
    layer.globalAlpha = alpha;
    layer.drawImage(item.canvas, 0, 0);
    layer.restore();
  };
  // Both cues rise together; the outgoing block shrinks through the upper mask.
  const travel = oldStep * enter;
  if (previous && leave > 0) draw(previous, y - travel, leave, outgoingScale);
  const currentY = y + oldStep - travel;
  const currentAlpha = time >= cue.start ? 1 : previewAlpha;
  const visibleScale = currentScale + (LYRIC_PREVIEW_SCALE - currentScale) * lastFade;
  const visibleY = currentY - (current.canvas.height * LYRIC_ACTIVE_SCALE + viewport.gap) * lastFade;
  draw(current, visibleY, currentAlpha * (1 - lastFade), visibleScale);
  // Scale from the shared left origin so both cues stay left-aligned.
  if (next) draw(next, currentY + step, previewAlpha * enter, LYRIC_PREVIEW_SCALE);
  layer.globalAlpha = 1; layer.globalCompositeOperation = "destination-in"; layer.fillStyle = viewport.mask;
  layer.fillRect(0, 0, viewport.canvas.width, viewport.canvas.height); layer.globalCompositeOperation = "source-over";
  c.drawImage(viewport.canvas, w * .04 * s.contentScale, viewport.top);
}
function paintLyrics(c: CanvasRenderingContext2D, s: PreparedStudio, t: number): void {
  // Legacy subtitle/ring projects also use the single left-side layout.
  if (s.project.lyrics.mode !== "off") paintRollingLyrics(c, s, t + s.project.lyrics.offset);
}

function paintInformation(c: CanvasRenderingContext2D, p: VisualizerProject, lyricLayout: boolean, contentScale: number): void {
  const { width: w, height: h } = p.scene.canvas;
  c.save(); c.shadowColor = `${p.look.accent}a6`; c.shadowBlur = h * .012;
  const textX = w * .044 * contentScale, max = w * .435 * contentScale, font = STUDIO_FONTS[p.text.font], scale = p.text.scale * Math.min(1, contentScale), labelSize = h * scale;
  // Keep labels just above their body line as the overall text scale changes.
  const above = (baseline: number, size: number) => h * (baseline - (size * .85 + .013) * scale);
  if (p.text.showAlbum && (p.text.album || p.text.title).trim()) {
    label(c, "Artwork/Album", w * .035 * contentScale, above(.108, .035), labelSize, font, p.look.accent);
    paintText(c, p.text.album || p.text.title, w * .035 * contentScale, h * .108, h * .035 * scale, max, font);
  }
  paintText(c, p.text.collaboration, w * .186 * contentScale, h * .285, h * .080 * scale, w * .285 * contentScale, STUDIO_FONTS.serif, "400");
  if (!lyricLayout && p.text.title.trim()) label(c, "Track Name", textX, above(.485, .082), labelSize, font, p.look.accent);
  paintText(c, p.text.title, textX, h * (lyricLayout ? .435 : .485), h * (lyricLayout ? .078 : .082) * scale, max, font, "700");
  paintText(c, p.text.subtitle, textX, h * (lyricLayout ? .495 : .532), h * .026 * scale, max, font);
  if (lyricLayout) {
    paintText(c, p.text.credit, w * .186 * contentScale, h * .35, h * .022 * scale, w * .285 * contentScale, font);
  } else {
    if (p.text.artist.trim()) label(c, "Artist Name", textX, above(.67, .083), labelSize, font, p.look.accent);
    paintText(c, p.text.artist, textX, h * .67, h * .083 * scale, max, font, "600");
    paintText(c, p.text.credit, textX, h * .721, h * .025 * scale, max, font);
  }
  c.restore();
}

function paintClocks(c: CanvasRenderingContext2D, s: PreparedStudio, t: number): void {
  const { width: w, height: h } = s.project.scene.canvas;
  const left = studioClock(t), right = studioClock(studioDuration(s.timeline) - t), key = `${left}|${right}`;
  let layer = s.clockLayer;
  if (!layer) {
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = Math.ceil(h * .12);
    layer = s.clockLayer = { canvas, context: canvas.getContext("2d")!, key: "", top: Math.floor(h * .9) };
  }
  if (layer.key !== key) {
    const lc = layer.context; lc.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    lc.shadowColor = s.project.look.accent; lc.shadowBlur = h * .008;
    const y = h * .968 - layer.top, width = w * .04 * s.contentScale;
    paintText(lc, left, w * .023 * s.contentScale, y, h * .026, width, STUDIO_FONTS.sans);
    paintText(lc, right, w * .454 * s.contentScale, y, h * .026, width, STUDIO_FONTS.sans);
    layer.key = key;
  }
  c.drawImage(layer.canvas, 0, layer.top);
}

/** Single visual source of truth for editor, deterministic seeks and offline RGBA export. */
export function drawStudioFrame(c: CanvasRenderingContext2D, s: PreparedStudio, seconds: number): void {
  const p = s.project, { width: w, height: h } = p.scene.canvas;
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, studioDuration(s.timeline));
  const m = sampleStudioMotion(s.motion, t, s.timeline.fps), f = sampleStudioFeatures(s.timeline, t);
  const shift = 0;
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.shadowBlur = 0;
  c.fillStyle = "#ecf1eb"; c.fillRect(0, 0, w, h);
  c.save(); arcPath(c, p, shift, "left"); c.clip(); paintLeftLayers(c, s, t, m); c.restore();
  c.save(); arcPath(c, p, shift, "right"); c.clip(); paintRightImage(c, s, m); c.restore();
  paintLights(c, s, t, m, shift); paintArc(c, s, f);
  if (s.watermark) c.drawImage(s.watermark, w * .984 - s.watermark.width, h * .984 - s.watermark.height);
  // Move the content as one block, independently of backgrounds and the arc.
  // Normalized offsets keep preview, seeks and full-resolution export identical.
  const layout = p.leftContent ?? { x: 0, y: 0, scale: 1 }, anchorX = w * .25 * s.contentScale, anchorY = h * .5;
  c.save(); c.translate(anchorX + layout.x * w, anchorY + layout.y * h);
  c.scale(layout.scale, layout.scale); c.translate(-anchorX, -anchorY);
  paintDisc(c, s, t);
  if (p.text.visible) c.drawImage(s.information, 0, 0);
  paintSmallSpectrum(c, s, f, t);
  if (p.text.progress) {
    const x = w * .066 * s.contentScale, width = w * .376 * s.contentScale, y = h * .960, duration = studioDuration(s.timeline), ratio = clamp(t / Math.max(.001, duration));
    c.save(); c.lineWidth = Math.max(1, h * .0018); c.strokeStyle = "rgba(247,255,255,.65)"; c.beginPath(); c.moveTo(x, y); c.lineTo(x + width, y); c.stroke();
    c.fillStyle = "#ffffff"; c.shadowColor = p.look.accent; c.shadowBlur = h * .008; c.beginPath(); c.arc(x + width * ratio, y, h * .006, 0, Math.PI * 2); c.fill();
    c.restore(); paintClocks(c, s, t);
  }
  paintLyrics(c, s, t); c.restore(); c.restore();
}

export function studioCanvas(s: PreparedStudio, willReadFrequently = true): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = s.project.scene.canvas.width; canvas.height = s.project.scene.canvas.height;
  // The exporter measures both hints, then keeps one context for the whole job.
  // This is a browser hint, not a guarantee of a CPU/GPU implementation.
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently });
  if (!context) throw new Error("Canvas 2D 不可用");
  return [canvas, context];
}
