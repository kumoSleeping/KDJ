import { studioDuration, validateVisualizerProject, type VisualizerDraft } from "./visualizerStudio";
import { drawStudioFrame, loadStudioImages, prepareStudio, studioCanvas, type PreparedStudio } from "./visualizerStudioRenderer";
import { visualizerApi, type VisualizerJobStatus } from "./api";

/** Queue-owned lifetime: switching songs or unmounting the editor cannot stop
 * frame production. Only explicit cancellation or leaving the app does. */
export async function runStudioExport(draft: VisualizerDraft, outputPath: string, signal: AbortSignal,
  onStatus: (status: VisualizerJobStatus) => void): Promise<VisualizerJobStatus> {
  let job: VisualizerJobStatus | null = null;
  let frames: Awaited<ReturnType<typeof createStudioExportFrames>> | undefined;
  const leave = () => { if (job) void visualizerApi.cancel(job.id, true).catch(() => undefined); };
  window.addEventListener("pagehide", leave);
  try {
    signal.throwIfAborted();
    validateVisualizerProject(draft.project);
    const [analysis, images] = await Promise.all([
      visualizerApi.analyze(draft.project.track.id, draft.project.scene.spectrum, signal),
      loadStudioImages(draft.images),
      document.fonts.ready,
    ]);
    signal.throwIfAborted();
    const prepared = prepareStudio(draft.project, images, analysis.timeline);
    frames = await createStudioExportFrames(prepared, signal);
    signal.throwIfAborted();
    job = await visualizerApi.start({ track_id: draft.project.track.id, signature: analysis.signature,
      duration: studioDuration(analysis.timeline), width: draft.project.scene.canvas.width,
      height: draft.project.scene.canvas.height, fps: draft.project.output.fps,
      acceleration: draft.project.output.acceleration, output_path: outputPath });
    let last = 0, lastUi = -Infinity;
    while (true) {
      signal.throwIfAborted();
      const now = performance.now();
      if (now - lastUi >= 200 || ["done", "failed", "canceled"].includes(job.phase)) { onStatus(job); lastUi = now; }
      if (["done", "failed", "canceled"].includes(job.phase)) return job;
      const demand = job.demand;
      if (demand && demand.token !== last) {
        // Each upload awaits real network I/O and yields to the event loop.
        // An extra per-frame timer adds latency and is throttled when hidden.
        const pixels = frames.read(demand.index);
        const upload = visualizerApi.frame(job.id, demand.token, demand.index, pixels, signal);
        try {
          frames.prefetch(demand.index + 1);
          job = await upload;
          last = demand.token;
          continue;
        } catch (error) {
          await upload.catch(() => undefined);
          // An encoder retry may replace an in-flight frame demand.
          if (!(error instanceof Error ? error.message : String(error)).includes("过期或重复的视频帧")) throw error;
        }
        last = demand.token;
      }
      job = await visualizerApi.poll(job.id, last, signal);
    }
  } catch (error) {
    if (job) {
      // Respect the backend commit point: a completed file cannot be canceled.
      const final = await visualizerApi.cancel(job.id);
      if (final.phase === "done" || signal.aborted) return final;
    }
    throw error;
  } finally {
    frames?.release();
    window.removeEventListener("pagehide", leave);
  }
}

/** Measure the complete draw + readback path in the actual WebView. WebKit and
 * WebView2 need not make the same choice; the hint is not a GPU capability flag.
 * Never change contexts during encoding, including a hardware-encoder retry. */
export async function createStudioExportFrames(prepared: PreparedStudio, signal: AbortSignal) {
  const started = performance.now();
  const candidates = [true, false].map(hint => ({ hint, pair: studioCanvas(prepared, hint), samples: [] as number[] }));
  let selected: typeof candidates[number];
  try {
    // Alternate ordering to reduce warm-cache bias. First two reads warm each
    // context before timing four consecutive frames of this exact composition.
    for (let pass = 0; pass < 6; pass++) {
      for (const index of pass % 2 ? [1, 0] : [0, 1]) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        signal.throwIfAborted();
        const candidate = candidates[index], [canvas, context] = candidate.pair, before = performance.now();
        drawStudioFrame(context, prepared, pass / prepared.project.output.fps);
        context.getImageData(0, 0, canvas.width, canvas.height);
        if (pass >= 2) candidate.samples.push(performance.now() - before);
      }
    }
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[1] + sorted[2]) / 2; };
    // Retain the stable readback default when the difference is only noise.
    selected = median(candidates[1].samples) < median(candidates[0].samples) * .85 ? candidates[1] : candidates[0];
  } catch (error) {
    for (const candidate of candidates) candidate.pair[0].width = candidate.pair[0].height = 1;
    throw error;
  }
  for (const candidate of candidates) if (candidate !== selected) candidate.pair[0].width = candidate.pair[0].height = 1;
  const [canvas, context] = selected.pair, fps = prepared.project.output.fps;
  const count = Math.ceil(studioDuration(prepared.timeline) * fps);
  let ahead: { index: number; pixels: ArrayBuffer } | null = null;
  let frames = 0, drawMs = 0, readMs = 0, released = false;
  const calibrationMs = performance.now() - started;
  function read(index: number): ArrayBuffer {
    signal.throwIfAborted();
    if (released || !Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("无效的视频帧请求");
    const cached = ahead; ahead = null;
    if (cached?.index === index) return cached.pixels;
    const before = performance.now();
    drawStudioFrame(context, prepared, index / fps);
    const drawn = performance.now(), pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    drawMs += drawn - before; readMs += performance.now() - drawn; frames++;
    return pixels.data.buffer as ArrayBuffer;
  }
  return {
    read,
    /** One speculative frame only. It is a pure function of its index, so a
     * retry/seek can either reuse it or discard it without stateful drift. */
    prefetch(index: number) {
      if (!signal.aborted && index < count) ahead = { index, pixels: read(index) };
    },
    release() {
      if (released) return;
      released = true; ahead = null; canvas.width = canvas.height = 1;
      console.info("[visualizer export]", {
        frames, drawMs, readMs, elapsedMs: performance.now() - started, calibrationMs,
        willReadFrequently: selected.hint,
        calibration: candidates.map(({ hint, samples }) => ({ willReadFrequently: hint, drawAndReadMs: samples })),
      });
    },
  };
}
