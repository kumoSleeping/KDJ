import { studioDuration, validateVisualizerProject, type VisualizerDraft, type VisualizerProject } from "./visualizerStudio";
import { drawStudioFrame, loadStudioImages, prepareStudio, studioCanvas, type PreparedStudio } from "./visualizerStudioRenderer";
import { getBridge } from "./bridge";
import { studioWorkerCount } from "./visualizerStudioFrames";
import { visualizerApi, type VisualizerJobStatus } from "./api";
import type { StudioWorkerCommand, StudioWorkerReply, StudioWorkerRequest } from "./visualizerStudioExport.worker";

const terminal = (status: VisualizerJobStatus) => ["done", "failed", "canceled"].includes(status.phase);
/** The encoder moved past this frame, a retry replaced its pass, or the job already
 * ended. The next snapshot says which; none of these is a renderer failure. */
const superseded = (error: unknown) => /过期或重复的视频帧|导出任务已结束/.test(error instanceof Error ? error.message : String(error));

/** Renders and uploads frames. `slots` uploads may be in flight at once. */
interface FrameProducer {
  slots: number;
  format: "rgba" | "yuv420p";
  upload(job: string, token: number, index: number): Promise<VisualizerJobStatus>;
  release(): void;
}

/** Queue-owned lifetime: switching songs or unmounting the editor cannot stop
 * frame production. Only explicit cancellation or leaving the app does. */
export async function runStudioExport(draft: VisualizerDraft, outputPath: string, signal: AbortSignal,
  onStatus: (status: VisualizerJobStatus) => void): Promise<VisualizerJobStatus> {
  let job: VisualizerJobStatus | null = null;
  let producer: FrameProducer | undefined;
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
    producer = await createStudioFrameProducer(draft.project, prepared, images, signal);
    signal.throwIfAborted();
    job = await visualizerApi.start({ track_id: draft.project.track.id, signature: analysis.signature,
      duration: studioDuration(analysis.timeline), width: draft.project.scene.canvas.width,
      height: draft.project.scene.canvas.height, fps: draft.project.output.fps,
      acceleration: draft.project.output.acceleration, output_path: outputPath, pixel_format: producer.format });
    return await pumpFrames(job, producer, signal, onStatus);
  } catch (error) {
    if (job) {
      // Respect the backend commit point: a completed file cannot be canceled.
      const final = await visualizerApi.cancel(job.id);
      if (final.phase === "done" || signal.aborted) return final;
    }
    throw error;
  } finally {
    producer?.release();
    window.removeEventListener("pagehide", leave);
  }
}

/** Keep every free slot busy with the lowest frame of the encoder's window that is
 * not uploaded yet. Upload responses carry the window; poll only when none can. */
async function pumpFrames(first: VisualizerJobStatus, producer: FrameProducer, signal: AbortSignal,
  onStatus: (status: VisualizerJobStatus) => void): Promise<VisualizerJobStatus> {
  let latest = first, attempt = -1, active = 0, polling = false, failure: unknown, lastUi = -Infinity;
  const sent = new Set<number>();
  let wake: (() => void) | undefined;
  const changed = () => { const resolve = wake; wake = undefined; resolve?.(); };
  // Responses arrive out of order across connections; only a newer version wins.
  const accept = (status: VisualizerJobStatus) => { if (!terminal(latest) && status.version > latest.version) latest = status; };
  signal.addEventListener("abort", changed);
  try {
    while (true) {
      signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      const now = performance.now();
      if (now - lastUi >= 200 || terminal(latest)) { onStatus(latest); lastUi = now; }
      if (terminal(latest)) return latest;
      const demand = latest.demand;
      if (demand) {
        // An encoder retry replays the sequence: every frame must be uploaded again.
        if (demand.attempt !== attempt) { attempt = demand.attempt; sent.clear(); }
        for (const index of sent) if (index < demand.index) sent.delete(index);
        for (let index = demand.index; index < demand.end && active < producer.slots; index++) {
          if (sent.has(index)) continue;
          sent.add(index); active++;
          producer.upload(first.id, demand.token, index)
            .then(accept, error => { if (!superseded(error)) failure ??= error; })
            .finally(() => { active--; changed(); });
        }
      }
      if (!active && !polling) {
        polling = true;
        visualizerApi.poll(first.id, demand?.token ?? 0, signal)
          .then(accept, error => { failure ??= error; })
          .finally(() => { polling = false; changed(); });
      }
      await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    signal.removeEventListener("abort", changed);
  }
}

/** Parallel workers when the WebView can draw off the editor thread; otherwise the
 * measured single-canvas path. Never change producers during encoding. */
async function createStudioFrameProducer(project: VisualizerProject, prepared: PreparedStudio, images: HTMLImageElement[], signal: AbortSignal): Promise<FrameProducer> {
  if (typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined") {
    try {
      return await createStudioWorkerPool(project, prepared, images, signal);
    } catch (error) {
      signal.throwIfAborted();
      console.warn("[visualizer export] worker renderers unavailable, drawing on the editor thread", error);
    }
  }
  const frames = await createStudioExportFrames(prepared, signal);
  return {
    // Two slots: the next frame draws while the previous upload is in flight.
    slots: 2, format: "rgba",
    upload: async (job, token, index) => visualizerApi.frame(job, token, index, frames.read(index), signal),
    release: frames.release,
  };
}

const WORKER_SETUP_MS = 30_000;

class StudioWorker {
  private calls = new Map<number, { resolve: (status: VisualizerJobStatus | undefined) => void; reject: (error: Error) => void }>();
  private next = 0;
  private dead: Error | undefined;
  // Vite emits the worker chunk; tool bundles that leave this URL unresolved fail to
  // start it and fall back to the editor-thread producer.
  readonly worker = new Worker(new URL("./visualizerStudioExport.worker.ts", import.meta.url), { type: "module" });
  pending = 0;
  constructor() {
    this.worker.onmessage = (event: MessageEvent<StudioWorkerReply>) => {
      const reply = event.data, call = this.calls.get(reply.id);
      if (!call) return;
      this.calls.delete(reply.id); this.pending--;
      if (reply.ok) call.resolve(reply.status); else call.reject(new Error(reply.message));
    };
    this.worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message || "可视化导出线程异常退出")); };
    this.worker.onmessageerror = () => this.fail(new Error("可视化导出线程消息无法解析"));
  }
  call(command: StudioWorkerCommand, transfer: Transferable[] = []): Promise<VisualizerJobStatus | undefined> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject }); this.pending++;
      this.worker.postMessage({ id, command } satisfies StudioWorkerRequest, transfer);
    });
  }
  fail(error: Error) {
    this.dead ??= error;
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear(); this.pending = 0;
  }
  terminate() { this.worker.terminate(); this.fail(new DOMException("可视化导出已结束", "AbortError")); }
}

async function createStudioWorkerPool(project: VisualizerProject, prepared: PreparedStudio, images: HTMLImageElement[], signal: AbortSignal): Promise<FrameProducer> {
  const started = performance.now(), { width, height } = prepared.project.scene.canvas, fps = prepared.project.output.fps;
  const timeline = prepared.timeline, count = Math.ceil(studioDuration(timeline) * fps);
  const imagePixels = images.reduce((sum, image) => sum + image.naturalWidth * image.naturalHeight, 0);
  const size = studioWorkerCount(width, height, imagePixels, timeline.frames.length * ((timeline.frames[0]?.bands.length ?? 0) + 4), navigator.hardwareConcurrency || 4);
  const workers = Array.from({ length: size }, () => new StudioWorker());
  const abort = () => { for (const worker of workers) worker.fail(new DOMException("可视化导出已取消", "AbortError")); };
  // A worker that never loads (or never answers) must not hold the export forever.
  const timer = window.setTimeout(() => { for (const worker of workers) worker.fail(new Error("可视化导出线程启动超时")); }, WORKER_SETUP_MS);
  signal.addEventListener("abort", abort);
  try {
    const { baseUrl, authToken } = getBridge(), text = JSON.stringify(timeline);
    // The draft project, not the prepared copy: preparation resolves the accent and
    // the disc position, and must start from the same inputs in every worker.
    await Promise.all(workers.map(async worker => {
      const bitmaps = await Promise.all(images.map(image => createImageBitmap(image)));
      await worker.call({ type: "init", project, images: bitmaps, timeline: text, baseUrl, authToken }, bitmaps);
    }));
    // Measure the whole pool, both context hints: a hint that wins on one canvas can
    // serialize in a shared GPU process once every worker draws at the same time.
    const rates = new Map<boolean, number>();
    for (const hint of [true, false]) {
      await Promise.all(workers.map(worker => worker.call({ type: "context", willReadFrequently: hint })));
      await Promise.all(workers.map((worker, k) => worker.call({ type: "time", indices: [k % count] })));
      const before = performance.now();
      await Promise.all(workers.map((worker, k) => worker.call({ type: "time", indices: [0, 1, 2].map(n => (k + n * size) % count) })));
      rates.set(hint, size * 3 / (performance.now() - before));
    }
    // Keep the CPU-backed readback default unless the other hint is clearly faster.
    const hint = !(rates.get(false)! > rates.get(true)! * 1.15);
    if (hint) await Promise.all(workers.map(worker => worker.call({ type: "context", willReadFrequently: true })));
    signal.throwIfAborted();
    const calibrationMs = performance.now() - started;
    let frames = 0;
    return {
      // Two per worker: one frame draws while the previous one uploads.
      slots: size * 2, format: "yuv420p",
      upload: async (job, token, index) => {
        const worker = workers.reduce((a, b) => b.pending < a.pending ? b : a);
        const status = await worker.call({ type: "upload", job, token, index });
        frames++;
        return status!;
      },
      release() {
        for (const worker of workers) worker.terminate();
        console.info("[visualizer export]", { workers: size, frames, elapsedMs: performance.now() - started, calibrationMs,
          willReadFrequently: hint, calibrationFramesPerSecond: Object.fromEntries([...rates].map(([key, rate]) => [String(key), rate * 1000])) });
      },
    };
  } catch (error) {
    for (const worker of workers) worker.terminate();
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
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
  let frames = 0, drawMs = 0, readMs = 0, released = false;
  const calibrationMs = performance.now() - started;
  return {
    read(index: number): ArrayBuffer {
      signal.throwIfAborted();
      if (released || !Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("无效的视频帧请求");
      const before = performance.now();
      drawStudioFrame(context, prepared, index / fps);
      const drawn = performance.now(), pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      drawMs += drawn - before; readMs += performance.now() - drawn; frames++;
      return pixels.data.buffer as ArrayBuffer;
    },
    release() {
      if (released) return;
      released = true; canvas.width = canvas.height = 1;
      console.info("[visualizer export]", {
        frames, drawMs, readMs, elapsedMs: performance.now() - started, calibrationMs,
        willReadFrequently: selected.hint,
        calibration: candidates.map(({ hint, samples }) => ({ willReadFrequently: hint, drawAndReadMs: samples })),
      });
    },
  };
}
