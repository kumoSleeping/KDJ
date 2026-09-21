import type { AudioVisualizerScene, VisualizerFeatureFrame } from "../types/audioVisualizer";
import { visualizerArcNormal, visualizerArcX, visualizerSpectrumRect } from "./audioVisualizerScene";

/** Straight-alpha raster shared algorithmically with audio_visualizer/raster.rs. */
function line(pixels: Uint8ClampedArray, width: number, height: number, ax: number, ay: number, bx: number, by: number, thickness: number, color: readonly number[]): void {
  const radius = thickness / 2;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
  const x1 = Math.min(width, Math.max(0, Math.ceil(Math.max(ax, bx) + radius + 1)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
  const y1 = Math.min(height, Math.max(0, Math.ceil(Math.max(ay, by) + radius + 1)));
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const t = Math.max(0, Math.min(1, length > 0 ? ((px - ax) * dx + (py - ay) * dy) / length : 0));
    const distance = Math.sqrt((px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2);
    const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance)) * color[3] / 255;
    if (alpha === 0) continue;
    const offset = (y * width + x) * 4, old = pixels[offset + 3] / 255;
    const combined = alpha + old * (1 - alpha);
    for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round((color[c] * alpha + pixels[offset + c] * old * (1 - alpha)) / combined);
    pixels[offset + 3] = Math.round(combined * 255);
  }
}

export function rasterizeVisualizerSpectrum(scene: AudioVisualizerScene, frame: VisualizerFeatureFrame, pixels: Uint8ClampedArray): void {
  const [origin, , width, height] = visualizerSpectrumRect(scene);
  if (pixels.length !== width * height * 4 || frame.bands.length !== scene.spectrum.bands) throw new Error("透明频谱缓冲区与场景不匹配");
  pixels.fill(0);
  const scale = height / 1080, color = [...scene.spectrum.color];
  color[3] = Math.min(color[3], 100);
  for (let y = 0; y < height; y += 3) {
    const end = Math.min(y + 3, height);
    line(pixels, width, height, visualizerArcX(scene, y) - origin, y, visualizerArcX(scene, end) - origin, end, Math.max(scale, 0.75), color);
  }
  color[3] = scene.spectrum.color[3];
  for (let i = 0; i < frame.bands.length; i++) {
    const y = (i + 0.5) * height / frame.bands.length, x = visualizerArcX(scene, y) - origin;
    const [nx, ny] = visualizerArcNormal(scene, y);
    const value = Number.isFinite(frame.bands[i]) ? frame.bands[i] : 0;
    const length = Math.max(0, Math.min(1, value)) * scene.spectrum.length * scene.canvas.width;
    line(pixels, width, height, x - nx * length, y - ny * length, x + nx * length, y + ny * length, Math.max(1.8 * scale, 1), color);
  }
}
