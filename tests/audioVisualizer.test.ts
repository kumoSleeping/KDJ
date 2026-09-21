import test from "node:test";
import assert from "node:assert/strict";
import { createAudioVisualizerScene, validateVisualizerScene, visualizerArcX, visualizerArcNormal, visualizerSpectrumRect, visualizerDiscAngle, visualizerCropExtent, visualizerFrameIndex } from "../src/lib/audioVisualizerScene";
import type { VisualizerFeatureTimeline } from "../src/types/audioVisualizer";
import { rasterizeVisualizerSpectrum } from "../src/lib/audioVisualizerRaster";

test("transparent spectrum pixels match the Rust golden and replay deterministically", () => {
  const scene = createAudioVisualizerScene("/cover.png"), rect = visualizerSpectrumRect(scene);
  const pixels = new Uint8ClampedArray(rect[2] * rect[3] * 4);
  const frame = { bands: Array(48).fill(1), bass: 1, rms: 1, onset: 1 };
  rasterizeVisualizerSpectrum(scene, frame, pixels);
  let hash = 2166136261;
  for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
  assert.equal(hash >>> 0, 3595654391);
  const first = pixels.slice();
  rasterizeVisualizerSpectrum(scene, { ...frame, bands: Array(48).fill(0) }, pixels);
  rasterizeVisualizerSpectrum(scene, frame, pixels);
  assert.deepEqual(pixels, first);
  assert.throws(() => rasterizeVisualizerSpectrum(scene, frame, new Uint8ClampedArray(1)));
});

test("scene defaults match the Rust scene contract", () => {
  const scene = createAudioVisualizerScene("/cover.png");
  validateVisualizerScene(scene);
  assert.deepEqual(scene.canvas, { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(visualizerSpectrumRect(scene), [735, 0, 565, 1080]);
  assert.ok(Math.abs(visualizerArcX(scene, 540) - 883.2) < 1e-8);
  assert.deepEqual(visualizerArcNormal(scene, 540), [1, -0]);
  assert.ok(Math.abs(visualizerDiscAngle(scene, 5) - Math.PI) < 1e-8);
  assert.deepEqual(visualizerCropExtent(1920, 1080, 0), [1920, 1080]);
});

test("invalid scene parameters are rejected before drawing", () => {
  assert.throws(() => validateVisualizerScene(createAudioVisualizerScene()));
  for (const change of [
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.images.push("second", "third"); },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.left.zoom = NaN; },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.right.image = 1; },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.canvas.width = 1919; },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.disc.rpm = Infinity; },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.spectrum.bands = 15; },
    (s: ReturnType<typeof createAudioVisualizerScene>) => { s.spectrum.color[0] = -1; },
  ]) {
    const scene = createAudioVisualizerScene("/cover.png"); change(scene);
    assert.throws(() => validateVisualizerScene(scene));
  }
});

test("left/right transforms and separate projects do not alias", () => {
  const a = createAudioVisualizerScene("/first.png"), b = createAudioVisualizerScene("/second.png");
  a.left.focus_x = 0.1; a.spectrum.color[0] = 0;
  assert.equal(a.right.focus_x, 0.5);
  assert.equal(b.left.focus_x, 0.5);
  assert.equal(b.spectrum.color[0], 129);
});

test("seeking uses deterministic audio frame indices rather than wall time", () => {
  const timeline: VisualizerFeatureTimeline = { version: 1, sample_rate: 22050, sample_count: 44100, fps: 30, frames: Array.from({ length: 60 }, () => ({ bands: [0], bass: 0, rms: 0, onset: 0 })) };
  for (const [time, expected] of [[0, 0], [1 / 30, 1], [1, 30], [1.99, 59], [12, 59], [-3, 0], [NaN, 0]]) {
    assert.equal(visualizerFrameIndex(timeline, time), expected);
  }
  assert.equal(visualizerFrameIndex({ ...timeline, frames: [] }, 0), -1);
  assert.equal(visualizerFrameIndex(timeline, 1), 30);
});
