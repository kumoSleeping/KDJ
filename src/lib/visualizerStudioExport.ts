import { studioDuration, validateVisualizerProject, type VisualizerDraft, type VisualizerProject } from "./visualizerStudio";
import { loadStudioImages, prepareStudio, type PreparedStudio } from "./visualizerStudioRenderer";
import { getBridge } from "./bridge";
import { studioChunkFrames, studioVideoBitrate, studioWorkerCount } from "./visualizerStudioFrames";
import { visualizerApi, type VisualizerJobStatus } from "./api";
import { NO_BACKGROUND_DRAWING, NO_VIDEO_ENCODER } from "./visualizerExportSupport";
import type { StudioFrameTiming, StudioWorkerCommand, StudioWorkerReply, StudioWorkerRequest, StudioWorkerResult } from "./visualizerStudioExport.worker";
import { captureDiagnostic } from "./diagnostics";

const terminal = (status: VisualizerJobStatus) => ["done", "failed", "canceled"].includes(status.phase);
/** The encoder moved past this frame, a retry replaced its pass, or the job already
 * ended. The next snapshot says which; none of these is a renderer failure. */
const superseded = (error: unknown) => /过期或重复的视频帧|导出任务已结束/.test(error instanceof Error ? error.message : String(error));

/** Renders, encodes and uploads the video: its unit is a GOP of `chunkFrames` frames,
 * drawn and encoded by one worker. `slots` uploads may be in flight at once. */
interface FrameProducer {
  slots: number;
  chunkFrames: number;
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
    // The window's own encoder is the only one: an export that loses it midway (a driver
    // reset, a session taken away) fails and can be started again.
    const { width, height } = draft.project.scene.canvas, { fps, quality } = draft.project.output;
    producer = await createStudioWorkerPool(draft.project, prepared, images, signal);
    signal.throwIfAborted();
    job = await visualizerApi.start({ track_id: draft.project.track.id, signature: analysis.signature,
      duration: studioDuration(analysis.timeline), width, height, fps, video_bitrate: studioVideoBitrate(width, height, fps, quality),
      output_path: outputPath, audio_48k: draft.project.output.audio48k !== false, chunk_frames: producer.chunkFrames });
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
      // A GOP takes a renderer seconds, and nothing else tells the server the editor is alive.
      if (!polling) {
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

const WORKER_SETUP_MS = 30_000;
/** Opening a hardware session and encoding four frames; a driver that hangs must not hold the export. */
const ENCODER_SETUP_MS = 15_000;

class StudioWorker {
  private calls = new Map<number, { resolve: (result: StudioWorkerResult) => void; reject: (error: Error) => void }>();
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
      if (reply.ok) call.resolve(reply); else call.reject(new Error(reply.message));
    };
    this.worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message || "可视化导出线程异常退出")); };
    this.worker.onmessageerror = () => this.fail(new Error("可视化导出线程消息无法解析"));
  }
  call(command: StudioWorkerCommand, transfer: Transferable[] = []): Promise<StudioWorkerResult> {
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

/** The renderers that opened an encoder writing the same parameter sets as the first one that
 * did. Drivers cap concurrent sessions, so some renderers may get none. */
async function openStudioEncoders(workers: StudioWorker[]): Promise<{ encoders: StudioWorker[]; reason: string }> {
  let timer = 0;
  const late = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("硬件编码器启动超时")), ENCODER_SETUP_MS); });
  const probes = await Promise.allSettled(workers.map(worker => Promise.race([worker.call({ type: "encoder" }), late])));
  window.clearTimeout(timer);
  const encoders: StudioWorker[] = [];
  let parameters: string | undefined, reason = "";
  probes.forEach((probe, k) => {
    if (probe.status === "rejected") { reason ||= probe.reason instanceof Error ? probe.reason.message : String(probe.reason); return; }
    parameters ??= probe.value.parameters;
    if (probe.value.parameters === parameters) encoders.push(workers[k]); else reason ||= "各编码会话的参数集不一致";
  });
  return { encoders, reason };
}

/** Parallel workers that draw off the editor thread and encode what they draw. Never change
 * producers during encoding. */
async function createStudioWorkerPool(project: VisualizerProject, prepared: PreparedStudio, images: HTMLImageElement[], signal: AbortSignal): Promise<FrameProducer> {
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") throw new Error(NO_BACKGROUND_DRAWING);
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
    // The renderers are up: from here only the encoder probe is bounded, by its own limit.
    window.clearTimeout(timer);
    // Every renderer that got an encoder session is the pool: phones and some drivers cap them.
    const { encoders, reason } = await openStudioEncoders(workers);
    if (!encoders.length) throw new Error(reason || NO_VIDEO_ENCODER);
    signal.throwIfAborted();
    const calibrationMs = performance.now() - started;
    let frames = 0;
    const timings = new Map<StudioWorker, StudioFrameTiming>();
    const log = (encoder: string, active: number) => {
      const summary = { encoder, workers: active, frames, elapsedMs: Math.round(performance.now() - started), calibrationMs: Math.round(calibrationMs),
        willReadFrequently: hint, calibrationFramesPerSecond: Object.fromEntries([...rates].map(([key, rate]) => [String(key), rate * 1000])),
        ...(timings.size ? { perFrameMs: perFrame([...timings.values()]) } : {}) };
      console.info("[visualizer export]", summary);
      // Where a phone spends its time is only known on the phone: the report carries it.
      if (timings.size) captureDiagnostic("visualizer-export", "timing", JSON.stringify(summary), `width=${width} height=${height} fps=${fps}`, "info");
    };
    const idle = (pool: StudioWorker[]) => pool.reduce((a, b) => b.pending < a.pending ? b : a);
    for (const worker of workers) if (!encoders.includes(worker)) worker.terminate();
    const chunkFrames = studioChunkFrames(fps);
    return {
      // One per renderer: a GOP occupies its encoder from the first frame to the flush.
      slots: encoders.length, chunkFrames,
      upload: async (job, token, index) => {
        const worker = idle(encoders), { status, timing } = await worker.call({ type: "encode", job, token, index });
        if (timing) timings.set(worker, timing);
        frames += Math.min(chunkFrames, count - index * chunkFrames);
        return status!;
      },
      release() {
        for (const worker of encoders) worker.terminate();
        log("webview", encoders.length);
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

/** Each step's milliseconds per frame within one renderer, averaged over the renderers. */
function perFrame(timings: StudioFrameTiming[]): Record<string, number> {
  const frames = timings.reduce((sum, t) => sum + t.frames, 0) || 1;
  const step = (key: keyof StudioFrameTiming) => +(timings.reduce((sum, t) => sum + t[key], 0) / frames).toFixed(2);
  return { draw: step("drawMs"), read: step("readMs"), convert: step("convertMs"), encode: step("encodeMs"), send: step("sendMs") };
}
