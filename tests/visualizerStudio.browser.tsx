import React from "react";
import "../src/design.css";
import { createRoot } from "react-dom/client";
import VisualizerStudioPanel from "../src/components/composition/VisualizerStudioPanel";
import { useVisualizerStudioStore } from "../src/stores/visualizerStudioStore";
import { visualizerApi } from "../src/lib/api";
import { createVisualizerProject, saveVisualizerDraft, syncVisualizerImages, studioDuration } from "../src/lib/visualizerStudio";
import { loadStudioImages, prepareStudio, drawStudioFrame, studioCanvas } from "../src/lib/visualizerStudioRenderer";
import type { KdjBridge } from "../src/types";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition: unknown, detail: string) => { if (!condition) throw new Error(detail); };
const globals = globalThis as typeof globalThis & { studioAcceptance: Promise<unknown>; studioVisualReady?: boolean; studioFrame?: string; studioChecks?: unknown };

globals.studioAcceptance = (async () => {
  const fixture = await fetch("/bridge.json").then(r => r.json());
  fixture.baseUrl = location.origin;
  Object.defineProperty(window, "kdj", { value: { ...fixture, revealPath: async () => undefined, pickFolder: async () => fixture.directory } as KdjBridge, configurable: true });
  const track = { ...fixture.track, title: "ARC LIGHT", artist: "KDJ Visualizer", album: "REFERENCE EDITION" };
  const blob = await fetch("/cover.png").then(r => r.blob());
  const p = createVisualizerProject(track); syncVisualizerImages(p, 1);
  p.output.directory = fixture.directory; p.output.filename = "studio-software.mp4"; p.output.acceleration = "software";
  p.text.collaboration = "KDJ × MUSIC"; p.text.subtitle = "Audio-reactive visual study"; p.text.credit = "Independent motion / transparent spectrum";
  p.lyrics.lrc = "[00:00.00]弧光与节奏\n[00:02.00]保留画面的原色\n[00:04.00]每一层独立呼吸\n[00:06.00]KDJ 可视化初版";
  p.lyrics.translation = "[00:00.00]Arc light and rhythm\n[00:02.00]Keep the original colors\n[00:04.00]Independent layers in motion\n[00:06.00]KDJ visualizer preview";
  p.lyrics.mode = "subtitle";
  await saveVisualizerDraft({ project: p, images: [blob] });
  const analysis = await visualizerApi.analyze(track.id, p.scene.spectrum);
  const images = await loadStudioImages([blob]);
  const prepared = prepareStudio(p, images, analysis.timeline);
  const coverContext = prepared.cover.getContext("2d")!;
  for (const [x, y] of [[0, 0], [prepared.cover.width - 1, 0], [0, prepared.cover.height - 1], [prepared.cover.width - 1, prepared.cover.height - 1]]) {
    assert(coverContext.getImageData(x, y, 1, 1).data[3] === 255, "Square cover must fully mask the rotating disc, including portrait-image corners");
  }
  const [surface, c] = studioCanvas(prepared);
  drawStudioFrame(c, prepared, 1.2); const first = c.getImageData(0, 0, surface.width, surface.height).data.slice();
  drawStudioFrame(c, prepared, 6.4); drawStudioFrame(c, prepared, 0); drawStudioFrame(c, prepared, 1.2);
  const second = c.getImageData(0, 0, surface.width, surface.height).data;
  let changed = 0, maxSeekDelta = 0;
  for (let i = 0; i < first.length; i++) { const delta = Math.abs(first[i] - second[i]); if (delta) changed++; maxSeekDelta = Math.max(maxSeekDelta, delta); }
  // Allow fewer than 0.01% changed channels for Canvas raster variation.
  // Motion-array identity is tested separately; retain maximum pixel delta in
  // the report instead of claiming bit-identical browser rasterization.
  assert(changed <= 500, `Seek re-render changed ${changed} bytes, max channel delta ${maxSeekDelta}`);
  globals.studioFrame = surface.toDataURL("image/png");

  const two = structuredClone(p); syncVisualizerImages(two, 2); two.scene.right.image = 1; two.scene.right.rotation_deg = 25;
  const solid = document.createElement("canvas"); solid.width = 800; solid.height = 600; const sc = solid.getContext("2d")!; sc.fillStyle = "#eddbab"; sc.fillRect(0, 0, 800, 600);
  const double = prepareStudio(two, [images[0], solid], analysis.timeline); drawStudioFrame(c, double, 1.2);
  assert(c.getImageData(Math.round(surface.width * .9), 30, 1, 1).data[3] === 255, "Two-image/rotation edge leaked transparent pixels");

  const transparent = structuredClone(p); transparent.look.motion = 0; transparent.look.glow = 0; transparent.look.particles = 0; transparent.look.energyLine = false; transparent.text.visible = false; transparent.text.progress = false;
  const silence = { ...analysis.timeline, frames: analysis.timeline.frames.map(f => ({ ...f, bands: f.bands.map(() => 0), bass: 0, rms: 0, onset: 0 })) };
  const silent = prepareStudio(transparent, [solid], silence); drawStudioFrame(c, silent, 1);
  const point = c.getImageData(Math.round(surface.width * .2), Math.round(surface.height * .84), 1, 1).data;
  assert(point[0] > 100 && point[1] > 100 && point[2] > 80, "Small-spectrum area was filled black");

  useVisualizerStudioStore.getState().open(track);
  const host = document.createElement("div"); host.className = "kd-stage"; host.style.height = "100vh"; document.body.append(host);
  createRoot(host).render(<VisualizerStudioPanel />);
  let ready = false;
  for (let n = 0; n < 250; n++) {
    const button = document.querySelector<HTMLButtonElement>(".kd-viz-export");
    if (document.querySelector(".kd-viz-preview canvas") && button && !button.disabled) { ready = true; break; }
    await delay(80);
  }
  assert(ready, `Panel did not initialize: ${document.querySelector(".kd-viz-notice")?.textContent}`);
  assert(document.querySelectorAll(".kd-viz-group").length === 8, "Missing panel configuration groups");
  assert(document.querySelector(".kd-viz-song")?.textContent?.includes("ARC LIGHT"), "Pinned song not displayed");
  globals.studioVisualReady = true; await delay(1000);

  const started = performance.now();
  document.querySelector<HTMLButtonElement>(".kd-viz-export")!.click();
  let done = false;
  for (let n = 0; n < 1800; n++) {
    const jobText = document.querySelector(".kd-viz-job")?.textContent || "";
    if (jobText.includes("在文件夹中显示")) { done = true; break; }
    const error = document.querySelector(".kd-viz-notice")?.textContent || "";
    if (error.includes("导出失败") || error.includes("缺少") || error.includes("未提交")) throw new Error(error);
    await delay(100);
  }
  assert(done, `UI export did not finish: ${document.querySelector(".kd-viz-job")?.textContent}`);
  const softwareMs = performance.now() - started;

  const request = { track_id: track.id, signature: analysis.signature, duration: studioDuration(analysis.timeline), output_path: `${fixture.directory}/studio-software.mp4`, width: p.scene.canvas.width, height: p.scene.canvas.height, fps: 30, acceleration: "software" };
  let protectedExisting = false;
  try { await visualizerApi.start(request); } catch (e) { protectedExisting = /已存在|未覆盖/.test(String(e)); }
  assert(protectedExisting, "Existing output was not rejected");
  let protectedSource = false;
  try { await visualizerApi.start({ ...request, output_path: `${fixture.directory}/changed.mp4`, signature: "wrong-source-version" }); } catch (e) { protectedSource = /变化/.test(String(e)); }
  assert(protectedSource, "Mismatched source was not rejected");
  const unauthorized = await fetch(`${fixture.baseUrl}/api/visualizer/jobs/any?kdj_media_token=${fixture.mediaToken}`);
  assert(unauthorized.status === 401, "Media capability incorrectly authorized control API");

  let cancelJob = await visualizerApi.start({ ...request, output_path: `${fixture.directory}/canceled.mp4` });
  for (let n = 0; n < 20 && !cancelJob.demand; n++) cancelJob = await visualizerApi.poll(cancelJob.id, 0);
  cancelJob = await visualizerApi.cancel(cancelJob.id); assert(cancelJob.phase === "canceled", "Cancel did not end frame request");
  await delay(500);

  // Same renderer at 60 fps with automatic hardware acceleration.
  const fast = structuredClone(p); fast.scene.canvas = { width: 1280, height: 720, fps: 30 }; fast.output.fps = 60;
  const fastPrepared = prepareStudio(fast, images, analysis.timeline), [fastSurface, fc] = studioCanvas(fastPrepared);
  let hardware = await visualizerApi.start({ ...request, output_path: `${fixture.directory}/studio-auto-60.mp4`, width: 1280, height: 720, fps: 60, acceleration: "auto" });
  const hardwareStart = performance.now(); let last = 0, maxToken = 0; const encoderStatuses = new Set<string>();
  while (!['done', 'failed', 'canceled'].includes(hardware.phase)) {
    encoderStatuses.add(hardware.status);
    if (hardware.demand && hardware.demand.token !== last) {
      const { token, index } = hardware.demand; drawStudioFrame(fc, fastPrepared, index / 60);
      await visualizerApi.frame(hardware.id, token, index, fc.getImageData(0, 0, fastSurface.width, fastSurface.height).data.buffer as ArrayBuffer);
      last = token; maxToken = Math.max(maxToken, token);
    }
    hardware = await visualizerApi.poll(hardware.id, last);
  }
  assert(hardware.phase === "done", hardware.error || "Auto encoder failed");
  const hardwareMs = performance.now() - hardwareStart;

  const video = document.createElement("video"); video.muted = true; video.preload = "auto"; video.src = "/studio-software.mp4";
  await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Cannot decode exported MP4")); });
  const decoded = document.createElement("canvas"); decoded.width = p.scene.canvas.width; decoded.height = p.scene.canvas.height; const dc = decoded.getContext("2d", { willReadFrequently: true })!;
  const comparisons = [];
  for (const frame of [1, 90, 210]) {
    await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Video seek failed")); video.currentTime = (frame + .2) / 30; });
    dc.drawImage(video, 0, 0); drawStudioFrame(c, prepared, frame / 30);
    const a = dc.getImageData(0, 0, decoded.width, decoded.height).data, b = c.getImageData(0, 0, surface.width, surface.height).data;
    let sum = 0; for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    const mae = sum / (a.length / 4 * 3); comparisons.push({ frame, rgbMeanAbsoluteError: mae }); assert(mae < 16, `Export differs from preview: MAE ${mae}`);
  }
  globals.studioChecks = { seekChangedBytes: changed, maxSeekChannelDelta: maxSeekDelta, transparentSpectrumPixel: Array.from(point), protectedExisting, protectedSource, mediaCannotControl: unauthorized.status, cancellation: cancelJob.phase, softwareMs, hardwareMs, hardwareFramesRequested: maxToken, encoderStatuses: [...encoderStatuses], comparisons, duration: video.duration };
  return { ok: true, ...globals.studioChecks as object };
})().catch(error => ({ ok: false, error: String(error), stack: error?.stack, notice: document.querySelector(".kd-viz-notice")?.textContent, status: document.querySelector(".kd-viz-job")?.textContent }));
