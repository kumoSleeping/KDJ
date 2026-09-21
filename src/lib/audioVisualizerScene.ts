import type { AudioVisualizerScene, VisualizerFeatureTimeline, VisualizerImageTransform } from "../types/audioVisualizer";

export function defaultVisualizerTransform(): VisualizerImageTransform {
  return { image: 0, focus_x: 0.5, focus_y: 0.5, zoom: 1, rotation_deg: 0, mirror_x: false, mirror_y: false, blur: 0 };
}
export function createAudioVisualizerScene(image?: string): AudioVisualizerScene {
  return {
    version: 1, canvas: { width: 1920, height: 1080, fps: 30 }, images: image ? [image] : [],
    left: defaultVisualizerTransform(), right: defaultVisualizerTransform(),
    arc: { position: 0.60, bend: 0.14 },
    disc: { mode: "cover", image: 0, x: 0.27, y: 0.52, size: 0.60, rpm: 6, direction: 1 },
    spectrum: { bands: 48, length: 0.075, sensitivity: 1, smoothing: 0.72, color: [129, 209, 246, 220] },
  };
}
const between = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
export function validateVisualizerScene(scene: AudioVisualizerScene): void {
  const c = scene.canvas;
  if (scene.version !== 1 || !Number.isInteger(c.width) || !Number.isInteger(c.height) || c.width % 2 || c.height % 2 || !between(c.width, 320, 2560) || !between(c.height, 180, 1440) || c.fps !== 30) throw new Error("可视化画布参数无效");
  if (scene.images.length < 1 || scene.images.length > 2 || scene.images.some((s) => !s.trim())) throw new Error("需要一至两张图片");
  const imageIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < scene.images.length;
  for (const t of [scene.left, scene.right]) {
    if (!imageIndex(t.image) || !between(t.focus_x, 0, 1) || !between(t.focus_y, 0, 1) || !between(t.zoom, 1, 4) || !between(t.rotation_deg, -180, 180) || !between(t.blur, 0, 20)) throw new Error("图片变换参数无效");
  }
  if (!between(scene.arc.position, 0.25, 0.75) || !between(scene.arc.bend, -0.2, 0.2)) throw new Error("弧线参数无效");
  const d = scene.disc;
  if (!imageIndex(d.image) || !["hidden", "disc", "cover"].includes(d.mode) || !between(d.x, 0, 1) || !between(d.y, 0, 1) || !between(d.size, 0.1, 0.85) || !between(d.rpm, 0, 60) || ![-1, 1].includes(d.direction)) throw new Error("唱片参数无效");
  const s = scene.spectrum;
  if (!Number.isInteger(s.bands) || !between(s.bands, 16, 96) || !between(s.length, 0.005, 0.15) || !between(s.sensitivity, 0.1, 4) || !between(s.smoothing, 0, 0.98) || s.color.length !== 4 || s.color.some((v) => !Number.isInteger(v) || !between(v, 0, 255))) throw new Error("频谱参数无效");
}
export function visualizerArcX(scene: AudioVisualizerScene, y: number): number {
  const u = y / scene.canvas.height;
  return scene.canvas.width * (scene.arc.position + scene.arc.bend * (4 * (u - 0.5) ** 2 - 1));
}
export function visualizerArcNormal(scene: AudioVisualizerScene, y: number): [number, number] {
  const slope = scene.canvas.width / scene.canvas.height * scene.arc.bend * 8 * (y / scene.canvas.height - 0.5);
  const norm = Math.sqrt(1 + slope * slope);
  return [1 / norm, -slope / norm];
}
export function visualizerSpectrumRect(scene: AudioVisualizerScene): [number, number, number, number] {
  const w = scene.canvas.width, a = scene.arc.position * w, b = (scene.arc.position - scene.arc.bend) * w;
  const margin = scene.spectrum.length * w + 4;
  const x = Math.max(0, Math.floor(Math.min(a, b) - margin));
  const end = Math.min(w, Math.ceil(Math.max(a, b) + margin));
  return [x, 0, end - x, scene.canvas.height];
}
export function visualizerDiscAngle(scene: AudioVisualizerScene, seconds: number): number {
  return seconds * Math.PI * 2 * scene.disc.rpm / 60 * scene.disc.direction;
}
export function visualizerCropExtent(width: number, height: number, degrees: number): [number, number] {
  const angle = degrees * Math.PI / 180, sin = Math.abs(Math.sin(angle)), cos = Math.abs(Math.cos(angle));
  const even = (v: number) => Math.max(2, Math.ceil(v / 2) * 2);
  return [even(width * cos + height * sin), even(width * sin + height * cos)];
}
export function visualizerFrameIndex(timeline: VisualizerFeatureTimeline, seconds: number): number {
  if (!timeline.frames.length) return -1;
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return Math.min(timeline.frames.length - 1, Math.floor(time * timeline.fps + 1e-8));
}
