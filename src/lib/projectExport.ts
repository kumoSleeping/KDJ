/**
 * A `.kdjv` project written out as an MP4 (docs/kdjv.md): the server mixes its sound and opens an
 * export job (POST /api/kdjv/export); this window draws every frame the way the live picture
 * does, encodes it with the WebView's own H.264 encoder and uploads it to that job — the
 * visualizer's job transport (pumpFrames), so the server puts it into an MP4 with the sound and
 * checks it. KDJ has no FFmpeg. The export lasts as long as the window that draws it: one
 * interrupted is started again from the queue.
 */
import { api, visualizerApi, type VisualizerJobStatus } from "./api";
import { getBridge } from "./bridge";
import { captureDiagnostic } from "./diagnostics";
import type { ExportOptions } from "./lanes";
import { ENCODER_SETUP_MS, pumpFrames, RENDERER_STALL_MS, STEPS, StudioWorker, WORKER_SETUP_MS, type FrameProducer } from "./visualizerStudioExport";
import { studioChunkFrames, studioVideoBitrate, type StudioQuality } from "./visualizerStudioFrames";
import { NO_BACKGROUND_DRAWING, NO_VIDEO_ENCODER } from "./visualizerExportSupport";
import type { ProjectExportGeometry, ProjectWorkerCommand } from "./projectExport.worker";
import type { KdjvLive } from "../types";

/** What the server answers for a picture export. */
export interface ProjectExportJob {
  job: VisualizerJobStatus;
  export: { width: number; height: number; fps: number; from: number; to: number; frames: number; chunk_frames: number };
  live: KdjvLive;
  output: string;
}

/** The encoder's bit rate for a project's CRF (16 high, 20 standard, 26 compact). */
export function projectQuality(crf: number | undefined): StudioQuality {
  if (crf === undefined) return "standard";
  return crf <= 17 ? "high" : crf >= 24 ? "low" : "standard";
}

/** Sends a renderer one command and waits for its answer (the visualizer's worker protocol). */
const call = (worker: StudioWorker, command: ProjectWorkerCommand) =>
  worker.call(command as unknown as Parameters<StudioWorker["call"]>[0]);

/** The renderer of one export: one worker drawing and encoding its GOPs in order. */
async function createProducerFor(trackId: number, started: ProjectExportJob, geometry: ProjectExportGeometry, signal: AbortSignal): Promise<FrameProducer> {
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") throw new Error(NO_BACKGROUND_DRAWING);
  // Vite emits the worker chunk.
  const worker = new StudioWorker(new Worker(new URL("./projectExport.worker.ts", import.meta.url), { type: "module" }), "工程导出");
  const abort = () => worker.fail(new DOMException("工程导出已取消", "AbortError"));
  const timer = window.setTimeout(() => worker.fail(new Error("工程导出线程启动超时")), WORKER_SETUP_MS);
  signal.addEventListener("abort", abort);
  try {
    const { baseUrl, authToken } = getBridge();
    const videoUrls: Record<number, string> = {};
    started.live.sources.forEach((source, n) => { if (source.kind === "video") videoUrls[n] = api.kdjvSourceUrl(trackId, n); });
    await call(worker, { type: "init", live: started.live, trackId, geometry, videoUrls, baseUrl, authToken });
    window.clearTimeout(timer);
    let probeTimer = 0;
    const late = new Promise<never>((_, reject) => { probeTimer = window.setTimeout(() => reject(new Error("硬件编码器启动超时")), ENCODER_SETUP_MS); });
    try {
      await Promise.race([call(worker, { type: "encoder" }), late]);
    } catch (error) {
      throw error instanceof Error && error.message ? error : new Error(NO_VIDEO_ENCODER);
    } finally { window.clearTimeout(probeTimer); }
    signal.throwIfAborted();
    const startedAt = performance.now();
    let frames = 0;
    return {
      slots: 1, chunkFrames: geometry.chunkFrames,
      upload: async (job, token, index) => {
        const { status } = await call(worker, { type: "encode", job, token, index });
        frames += Math.min(geometry.chunkFrames, geometry.frames - index * geometry.chunkFrames);
        return status!;
      },
      drawn: () => worker.drawn,
      stuck() {
        const now = performance.now();
        if (!(worker.pending > 0 && now - worker.moved > RENDERER_STALL_MS)) return undefined;
        return new Error(`工程导出在${worker.work}已 ${Math.round((now - worker.moved) / 1000)} 秒没有进展，停在${worker.step ? STEPS[worker.step] : "等待线程回应"}（已画 ${worker.drawn} 帧）`);
      },
      release() {
        worker.terminate();
        const summary = { frames, elapsedMs: Math.round(performance.now() - startedAt) };
        console.info("[kdjv export]", summary);
        captureDiagnostic("kdjv-export", "timing", JSON.stringify(summary), `width=${geometry.width} height=${geometry.height} fps=${geometry.fps}`, "info");
      },
    };
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** The sound alone, as a WAV beside the project. */
export async function exportProjectSound(trackId: number, options: ExportOptions): Promise<string> {
  const answer = await api.exportKdjv({ track_id: trackId, options: { ...options, audio_only: true } }) as { path: string };
  return answer.path;
}

/**
 * Exports the project's picture and sound; answers the job's last word (done, failed — with
 * `code: "kdjv_project_changed"` when the project was written meanwhile — or canceled).
 * `onStatus` hears it as it goes.
 */
export async function runProjectExport(trackId: number, options: ExportOptions | undefined, signal: AbortSignal,
  onStatus: (status: VisualizerJobStatus) => void): Promise<VisualizerJobStatus> {
  let started: ProjectExportJob | null = null;
  let producer: FrameProducer | undefined;
  const leave = () => { if (started) void visualizerApi.cancel(started.job.id, true).catch(() => undefined); };
  window.addEventListener("pagehide", leave);
  try {
    signal.throwIfAborted();
    // A GOP is a second: the server takes this for the project's own rate too (rounded).
    const fps = Math.round(options?.fps ?? 30);
    const body: Parameters<typeof api.exportKdjv>[0] = { track_id: trackId, options: options ?? {}, chunk_frames: studioChunkFrames(fps) };
    if (options?.width && options.height && options.fps) {
      body.video_bitrate = studioVideoBitrate(options.width, options.height, Math.round(options.fps), projectQuality(options.quality));
    }
    started = await api.exportKdjv(body) as ProjectExportJob;
    onStatus(started.job);
    signal.throwIfAborted();
    const e = started.export;
    producer = await createProducerFor(trackId, started, {
      width: e.width, height: e.height, fps: e.fps, from: e.from, frames: e.frames, chunkFrames: e.chunk_frames,
      bitrate: studioVideoBitrate(e.width, e.height, e.fps, projectQuality(options?.quality)),
    }, signal);
    return await pumpFrames(started.job, producer, signal, onStatus);
  } catch (error) {
    if (started) {
      // Respect the backend commit point: a completed file cannot be canceled.
      const final = await visualizerApi.cancel(started.job.id).catch(() => null);
      if (final && (final.phase === "done" || signal.aborted)) return final;
    }
    throw error;
  } finally {
    producer?.release();
    window.removeEventListener("pagehide", leave);
  }
}
