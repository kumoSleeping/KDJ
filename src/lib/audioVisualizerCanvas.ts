import type { AudioVisualizerScene, VisualizerFeatureTimeline } from "../types/audioVisualizer";
import { defaultVisualizerTransform, validateVisualizerScene, visualizerArcX, visualizerDiscAngle, visualizerFrameIndex } from "./audioVisualizerScene";
import { fitVisualizerImage, type VisualizerImage } from "./audioVisualizerImage";
import { drawVisualizerSpectrum } from "./audioVisualizerSpectrum";

export interface PreparedVisualizerScene {
  readonly scene: AudioVisualizerScene;
  readonly left: HTMLCanvasElement;
  readonly right: HTMLCanvasElement;
  readonly disc: HTMLCanvasElement;
  readonly cover: HTMLCanvasElement;
}

/** Rebuild on configuration changes, not on playback ticks. */
export function prepareVisualizerScene(input: AudioVisualizerScene, images: VisualizerImage[]): PreparedVisualizerScene {
  validateVisualizerScene(input);
  if (images.length !== input.images.length) throw new Error("图片素材与场景不匹配");
  const scene: AudioVisualizerScene = structuredClone(input);
  const { width, height } = scene.canvas;
  const left = fitVisualizerImage(images[scene.left.image], scene.left, width, height);
  const right = fitVisualizerImage(images[scene.right.image], scene.right, width, height);
  const context = right.getContext("2d")!;
  context.globalCompositeOperation = "destination-in";
  context.beginPath(); context.moveTo(visualizerArcX(scene, 0), 0);
  context.lineTo(width, 0); context.lineTo(width, height); context.lineTo(visualizerArcX(scene, height), height);
  context.quadraticCurveTo(width * (scene.arc.position - 2 * scene.arc.bend), height / 2, visualizerArcX(scene, 0), 0);
  context.closePath(); context.fill(); context.globalCompositeOperation = "source-over";
  const size = Math.max(2, Math.round(Math.min(width, height) * scene.disc.size / 2) * 2);
  const disc = fitVisualizerImage(images[scene.disc.image], defaultVisualizerTransform(), size, size);
  const dc = disc.getContext("2d")!;
  dc.globalCompositeOperation = "destination-in";
  dc.beginPath(); dc.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); dc.fill();
  dc.globalCompositeOperation = "source-over";
  const square = Math.round(size * 0.76);
  const cover = fitVisualizerImage(images[scene.disc.image], defaultVisualizerTransform(), square, square);
  return { scene, left, right, disc, cover };
}

/** Time comes from the pinned song. Wall time and the global song store are never read. */
export function drawVisualizerFrame(context: CanvasRenderingContext2D, prepared: PreparedVisualizerScene, timeline: VisualizerFeatureTimeline, seconds: number): void {
  const { scene } = prepared, { width, height, fps } = scene.canvas;
  const index = visualizerFrameIndex(timeline, seconds), frame = timeline.frames[index];
  if (!frame || timeline.fps !== fps || frame.bands.length !== scene.spectrum.bands) throw new Error("可视化时间序列与场景不匹配");
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1; context.globalCompositeOperation = "source-over";
  context.fillStyle = "black"; context.fillRect(0, 0, width, height);
  context.drawImage(prepared.left, 0, 0); context.drawImage(prepared.right, 0, 0);
  if (scene.disc.mode !== "hidden") {
    const size = prepared.disc.width;
    const x = Math.floor(scene.disc.x * width - size / 2), y = Math.floor(scene.disc.y * height - size / 2);
    context.save(); context.translate(x + size / 2, y + size / 2);
    context.rotate(visualizerDiscAngle(scene, index / fps)); context.drawImage(prepared.disc, -size / 2, -size / 2); context.restore();
    if (scene.disc.mode === "cover") context.drawImage(prepared.cover, Math.floor(scene.disc.x * width - size * 0.78), Math.floor(scene.disc.y * height - prepared.cover.height / 2));
  }
  drawVisualizerSpectrum(context, scene, frame);
  context.restore();
}
