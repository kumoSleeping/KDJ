import type { AudioVisualizerScene, VisualizerFeatureFrame } from "../types/audioVisualizer";
import { visualizerSpectrumRect } from "./audioVisualizerScene";
import { rasterizeVisualizerSpectrum } from "./audioVisualizerRaster";

interface Surface { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; pixels: ImageData }
const surfaces = new WeakMap<CanvasRenderingContext2D, Surface>();

/** One reusable stripe per preview; no full-frame pixel transfers or frame queue. */
export function drawVisualizerSpectrum(context: CanvasRenderingContext2D, scene: AudioVisualizerScene, frame: VisualizerFeatureFrame): void {
  const [x, y, width, height] = visualizerSpectrumRect(scene);
  let surface = surfaces.get(context);
  if (!surface || surface.canvas.width !== width || surface.canvas.height !== height) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const target = canvas.getContext("2d");
    if (!target) throw new Error("Canvas 2D 不可用");
    surface = { canvas, context: target, pixels: target.createImageData(width, height) };
    surfaces.set(context, surface);
  }
  rasterizeVisualizerSpectrum(scene, frame, surface.pixels.data);
  surface.context.putImageData(surface.pixels, 0, 0);
  context.drawImage(surface.canvas, x, y);
}
