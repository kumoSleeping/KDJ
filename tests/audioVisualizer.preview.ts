import { prepareVisualizerScene, drawVisualizerFrame } from "../src/lib/audioVisualizerCanvas";
import type { AudioVisualizerScene, VisualizerFeatureTimeline } from "../src/types/audioVisualizer";

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.src = url; await image.decode(); return image;
}
async function check() {
  const request = await fetch("/request.json").then((r) => r.json()) as { scene: AudioVisualizerScene };
  const timeline = await fetch("/features.json").then((r) => r.json()) as VisualizerFeatureTimeline;
  const images = await Promise.all(request.scene.images.map((_, i) => loadImage(`/image-${i}`)));
  const prepared = prepareVisualizerScene(request.scene, images);
  const expected = document.createElement("canvas"), decoded = document.createElement("canvas");
  const { width, height, fps } = request.scene.canvas;
  expected.width = decoded.width = width; expected.height = decoded.height = height;
  const context = expected.getContext("2d", { willReadFrequently: true })!;
  const output = decoded.getContext("2d", { willReadFrequently: true })!;
  const video = document.createElement("video"); video.muted = true; video.preload = "auto";
  const ready = new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("MP4 decode failed")), { once: true });
  });
  video.src = "/render.mp4"; document.body.append(video); video.style.display = "none";
  await ready;
  const checks: { frame: number; meanAbsoluteError: number; over32Fraction: number }[] = [];
  for (const frame of [0, Math.floor(timeline.frames.length / 2), timeline.frames.length - 1]) {
    const seeked = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
    video.currentTime = (frame + 0.5) / fps;
    await seeked;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    drawVisualizerFrame(context, prepared, timeline, frame / fps);
    output.drawImage(video, 0, 0, width, height);
    const reference = context.getImageData(0, 0, width, height).data;
    const actual = output.getImageData(0, 0, width, height).data;
    let sum = 0, over32 = 0;
    for (let pixel = 0; pixel < reference.length; pixel += 4) {
      let max = 0;
      for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(reference[pixel + channel] - actual[pixel + channel]);
        sum += difference; max = Math.max(max, difference);
      }
      if (max > 32) over32++;
    }
    checks.push({ frame, meanAbsoluteError: sum / (width * height * 3), over32Fraction: over32 / (width * height) });
  }
  drawVisualizerFrame(context, prepared, timeline, 0);
  const first = context.getImageData(0, 0, width, height).data;
  drawVisualizerFrame(context, prepared, timeline, 3);
  drawVisualizerFrame(context, prepared, timeline, 0);
  const replay = context.getImageData(0, 0, width, height).data;
  let seekDifferenceCount = 0, seekMaxDifference = 0, seekSum = 0;
  const seekDifferences: { x: number; y: number; channel: number; before: number; after: number }[] = [];
  for (let i = 0; i < first.length; i++) {
    const difference = Math.abs(first[i] - replay[i]);
    if (difference) {
      seekDifferenceCount++;
      if (seekDifferences.length < 24) seekDifferences.push({ x: Math.floor(i / 4) % width, y: Math.floor(i / 4 / width), channel: i % 4, before: first[i], after: replay[i] });
    }
    seekSum += difference; seekMaxDifference = Math.max(seekMaxDifference, difference);
  }
  const deterministicSeek = seekDifferenceCount === 0;
  const result = { ok: deterministicSeek && checks.every((c) => c.meanAbsoluteError < 5 && c.over32Fraction < 0.03), deterministicSeek, seekDifferenceCount, seekMaxDifference, seekDifferences, seekMeanDifference: seekSum / first.length, width, height, checks };
  video.remove();
  return result;
}
Object.assign(globalThis, { visualizerAcceptance: check().catch((error) => ({ ok: false, error: String(error) })) });
