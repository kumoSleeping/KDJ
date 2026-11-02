// One export renderer. Frames are a pure function of their index, so several of these draw
// different GOPs of the same frozen project, encode them with the WebView's own H.264 encoder
// and upload them straight to the local server: pixels never cross back through the editor's
// thread.
import type { VisualizerFeatureTimeline } from "../types/audioVisualizer";
import type { VisualizerJobStatus } from "./api";
import { studioDuration, type VisualizerProject } from "./visualizerStudio";
import { drawStudioFrame, prepareStudio, studioCanvas, type PreparedStudio } from "./visualizerStudioRenderer";
import { h264ParameterSets, rgbaToYuv420, studioAvcCodec, studioChunkFrames, studioVideoBitrate } from "./visualizerStudioFrames";

export type StudioWorkerCommand =
  /** The timeline arrives as JSON text: one string copy per worker instead of
   * serializing every feature object on the editor thread. */
  | { type: "init"; project: VisualizerProject; images: ImageBitmap[]; timeline: string; baseUrl: string; authToken: string }
  | { type: "context"; willReadFrequently: boolean }
  | { type: "time"; indices: number[] }
  /** Opens this renderer's encoder and proves it on a short GOP. */
  | { type: "encoder" }
  /** Draws, encodes and uploads GOP `index`. */
  | { type: "encode"; job: string; token: number; index: number };
export interface StudioWorkerRequest { id: number; command: StudioWorkerCommand }
export interface StudioWorkerResult { status?: VisualizerJobStatus; parameters?: string; timing?: StudioFrameTiming }
/** Milliseconds this renderer spent in each step of the frames it encoded. `encodeMs` is the
 * time spent waiting for the encoder (its queue, and the flush that closes each GOP). */
export interface StudioFrameTiming { frames: number; drawMs: number; readMs: number; convertMs: number; encodeMs: number; sendMs: number }
export type StudioWorkerReply = { id: number } & ({ ok: true } & StudioWorkerResult | { ok: false; message: string });
/** Where a renderer is in its GOP. */
export type StudioWorkerStep = "draw" | "queue" | "flush" | "send";
/** Sent beside the replies, as a renderer moves: frames drawn since it started, and the step it
 * is in now. A renderer that stops moving is seen, and where it stopped. */
export interface StudioWorkerProgress { progress: { drawn: number; step: StudioWorkerStep } }
/** Something the report should carry: an encoder session that stopped and was replaced. */
export interface StudioWorkerNote { note: string }

let prepared: PreparedStudio | undefined;
let surface: ReturnType<typeof studioCanvas> | undefined;
let server = { baseUrl: "", authToken: "" };
const timing: StudioFrameTiming = { frames: 0, drawMs: 0, readMs: 0, convertMs: 0, encodeMs: 0, sendMs: 0 };
let drawn = 0;
const step = (now: StudioWorkerStep) => postMessage({ progress: { drawn, step: now } } satisfies StudioWorkerProgress);

function draw(index: number): void {
  if (!prepared || !surface) throw new Error("导出线程尚未准备画面");
  const before = performance.now();
  drawStudioFrame(surface[1], prepared, index / prepared.project.output.fps);
  timing.drawMs += performance.now() - before;
}

function pixels(index: number): ImageData {
  draw(index);
  const [canvas, context] = surface!, before = performance.now();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  timing.readMs += performance.now() - before;
  return image;
}

function i420(index: number): Uint8Array<ArrayBuffer> {
  const image = pixels(index), before = performance.now();
  const yuv = rgbaToYuv420(image.data, image.width, image.height);
  timing.convertMs += performance.now() - before;
  return yuv;
}

interface Gop { parts: Uint8Array<ArrayBuffer>[]; last: number; failure?: string }
/** `moved`: when the encoder last took a frame or gave one back. */
interface StudioEncoder { encoder: VideoEncoder; gop: Gop; moved: number }
let video: StudioEncoder | undefined;
let config: VideoEncoderConfig | undefined;
/** A session that has taken frames and neither takes another nor gives one back for this long
 * has stopped. Seen on an M3 Pro (report c7190206): after its four-frame probe went through, a
 * session took seven frames of the first second and then nothing for 96 seconds, with no error.
 * Some encoders hold frames until more arrive or a flush; when the WebView will not hand them
 * more first, only a flush gets them out, and the flush queues behind the frames it holds. */
const ENCODER_STALL_MS = 5_000;
/** Frames encoded between flushes: unbounded until a session stops, then the probe's four
 * (which that session did encode), then one. */
const FLUSH_EVERY = [Infinity, 4, 1];
let flushes = 0;
class EncoderStall extends Error {}
let encoding: Promise<unknown> = Promise.resolve();
/** One GOP at a time: two interleaved on one encoder would share its reference frames. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = encoding.then(task, task);
  encoding = run.catch(() => undefined);
  return run;
}
const frameCount = (s: PreparedStudio) => Math.ceil(studioDuration(s.timeline) * s.project.output.fps);

/** One encoder session for the whole export: the first the WebView has, hardware before
 * software and High profile before Main and Baseline (some phones and emulators have only a
 * software one, or no High profile). There is no other encoder to fall back on. */
async function openEncoder(): Promise<void> {
  if (!prepared) throw new Error("导出线程尚未准备画面");
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") throw new Error("这个 WebView 没有 WebCodecs");
  const { width, height } = prepared.project.scene.canvas, fps = prepared.project.output.fps;
  const base = { width, height, framerate: fps, bitrate: studioVideoBitrate(width, height, fps, prepared.project.output.quality),
    bitrateMode: "variable", latencyMode: "quality", avc: { format: "annexb" } } as const;
  const candidates: VideoEncoderConfig[] = (["prefer-hardware", "no-preference"] as const)
    .flatMap(hardwareAcceleration => (["high", "main", "baseline"] as const)
      .map(profile => ({ ...base, codec: studioAvcCodec(width, height, fps, profile), hardwareAcceleration })));
  for (const candidate of candidates) if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; }
  if (!config) throw new Error(`这台设备不能编码 ${width} × ${height} 的 H.264 视频，换一个较小的分辨率`);
  startEncoder(config);
}

/** A session on `chosen`: a replacement takes the configuration the first one was proved with,
 * so it writes the same parameter sets. */
function startEncoder(chosen: VideoEncoderConfig): void {
  const state: StudioEncoder = {
    gop: { parts: [], last: -1 }, moved: performance.now(),
    encoder: new VideoEncoder({
      output(chunk) {
        const gop = state.gop;
        state.moved = performance.now();
        // Chunks leave in decode order. A timestamp stepping back means reordered
        // frames, which a stream copy of the bare bitstream cannot time.
        if (chunk.timestamp <= gop.last) gop.failure ??= "硬件编码器重排了画面顺序";
        if (!gop.parts.length && chunk.type !== "key") gop.failure ??= "硬件编码器没有以关键帧开始";
        gop.last = chunk.timestamp;
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes); gop.parts.push(bytes);
      },
      error(error) { state.gop.failure ??= error.message || "硬件编码器异常退出"; },
    }),
  };
  state.encoder.configure(chosen);
  video = state;
}

/** `dequeue` is not in every WebView; the timer bounds the wait either way. */
const settle = (encoder: VideoEncoder) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); encoder.removeEventListener("dequeue", done); resolve(); };
  const timer = setTimeout(done, 4);
  encoder.addEventListener("dequeue", done);
});

/** A flush that does not come back within the stall limit (plus a little per frame it holds). */
async function flush(state: StudioEncoder, held: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flushing = state.encoder.flush();
  flushing.catch(() => undefined);
  try {
    await Promise.race([flushing, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EncoderStall(`编码器收尾 ${held} 帧没有返回`)), ENCODER_STALL_MS + held * 100);
    })]);
  } finally { clearTimeout(timer); }
  state.moved = performance.now();
}

/** Frames `first .. first + count` as one closed GOP. A session that stops is closed and the GOP
 * is encoded again on a new one, flushing more often; the third stop fails the export. */
async function encodeGop(first: number, count: number): Promise<Uint8Array<ArrayBuffer>[]> {
  for (;;) {
    try { return await encodeGopOnce(first, count); } catch (error) {
      if (!(error instanceof EncoderStall) || !config) throw error;
      const fps = prepared!.project.output.fps, queued = video!.encoder.encodeQueueSize, second = Math.floor(first / fps) + 1;
      if (flushes + 1 >= FLUSH_EVERY.length) throw new Error(`编码器在第 ${second} 秒停住，换了 ${flushes} 次新会话、每帧收尾也一样：${error.message}（排队 ${queued} 帧）`);
      try { video!.encoder.close(); } catch { /* already closed */ }
      flushes++;
      postMessage({ note: `编码会话在第 ${second} 秒停住（${error.message}，排队 ${queued} 帧），已换新会话重编这一秒，此后每 ${FLUSH_EVERY[flushes]} 帧收尾一次` } satisfies StudioWorkerNote);
      startEncoder(config);
    }
  }
}

async function encodeGopOnce(first: number, count: number): Promise<Uint8Array<ArrayBuffer>[]> {
  if (!prepared || !video) throw new Error("导出线程尚未准备编码器");
  const state = video, { encoder } = state, gop: Gop = state.gop = { parts: [], last: -1 }, every = FLUSH_EVERY[flushes];
  const { width, height } = prepared.project.scene.canvas, fps = prepared.project.output.fps;
  state.moved = performance.now();
  for (let n = 0; n < count; n++) {
    step("draw");
    const index = first + n, timestamp = Math.round(index * 1e6 / fps), duration = Math.round(1e6 / fps);
    // Not `new VideoFrame(canvas)`: Android's WebView turns an RGB frame into BT.601 YUV and
    // writes no colour description, so players read it as BT.709 and shift reds and greens.
    const frame = new VideoFrame(i420(index), {
      format: "I420", codedWidth: width, codedHeight: height, timestamp, duration,
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });
    const before = performance.now();
    try { encoder.encode(frame, { keyFrame: n === 0 }); } finally { frame.close(); }
    drawn++;
    // Bound the frames waiting for the encoder: each holds a full I420 copy.
    if (encoder.encodeQueueSize > 2) step("queue");
    for (let size = encoder.encodeQueueSize; size > 2 && !gop.failure; size = encoder.encodeQueueSize) {
      await settle(encoder);
      if (encoder.encodeQueueSize < size) state.moved = performance.now();
      else if (performance.now() - state.moved > ENCODER_STALL_MS) throw new EncoderStall(`收了 ${n + 1} 帧后 ${ENCODER_STALL_MS / 1000} 秒既不收新帧也不出画面`);
    }
    if ((n + 1) % every === 0 && n + 1 < count && !gop.failure) { step("flush"); await flush(state, every); }
    timing.encodeMs += performance.now() - before;
    timing.frames++;
    if (gop.failure) throw new Error(gop.failure);
  }
  step("flush");
  const flushing = performance.now();
  await flush(state, count);
  timing.encodeMs += performance.now() - flushing;
  if (gop.failure) throw new Error(gop.failure);
  if (gop.parts.length !== count) throw new Error(`硬件编码器输出了 ${gop.parts.length} 帧，应为 ${count} 帧`);
  return gop.parts;
}

async function send(job: string, token: number, index: number, body: Blob): Promise<VisualizerJobStatus> {
  step("send");
  const before = performance.now();
  try { return await post(job, token, index, body); } finally { timing.sendMs += performance.now() - before; }
}

async function post(job: string, token: number, index: number, body: Blob): Promise<VisualizerJobStatus> {
  const response = await fetch(`${server.baseUrl}/api/visualizer/jobs/${encodeURIComponent(job)}/frames`, {
    method: "POST", body,
    headers: { Authorization: `Bearer ${server.authToken}`, "Content-Type": "application/octet-stream", "X-KDJ-Activity-Recorded": "1", "X-KDJ-Video-Frame": `${token}:${index}` },
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const detail = data && typeof data === "object" && "detail" in data ? String(data.detail) : "";
    throw new Error(detail || response.statusText || `HTTP ${response.status}`);
  }
  return data as VisualizerJobStatus;
}

async function handle(command: StudioWorkerCommand): Promise<StudioWorkerResult | undefined> {
  switch (command.type) {
    case "init": {
      server = { baseUrl: command.baseUrl, authToken: command.authToken };
      prepared = prepareStudio(command.project, command.images, JSON.parse(command.timeline) as VisualizerFeatureTimeline);
      // Prepared layers own their own copies; release the decoded sources now.
      for (const image of command.images) image.close();
      return;
    }
    case "context":
      if (!prepared) throw new Error("导出线程尚未准备画面");
      if (surface) surface[0].width = surface[0].height = 1;
      surface = studioCanvas(prepared, command.willReadFrequently);
      return;
    case "time":
      for (const index of command.indices) pixels(index);
      return;
    case "encoder": {
      await openEncoder();
      const parts = await exclusive(() => encodeGop(0, Math.min(4, frameCount(prepared!))));
      const parameters = h264ParameterSets(new Uint8Array(await new Blob(parts).arrayBuffer()));
      if (!parameters) throw new Error("硬件编码器没有输出 Annex B 关键帧");
      // The probe's frames are not the export's.
      Object.assign(timing, { frames: 0, drawMs: 0, readMs: 0, convertMs: 0, encodeMs: 0, sendMs: 0 });
      return { parameters };
    }
    case "encode": {
      const per = studioChunkFrames(prepared!.project.output.fps), first = command.index * per;
      const parts = await exclusive(() => encodeGop(first, Math.min(per, frameCount(prepared!) - first)));
      return { status: await send(command.job, command.token, command.index, new Blob(parts)), timing: { ...timing } };
    }
  }
}

addEventListener("message", (event: MessageEvent<StudioWorkerRequest>) => {
  const { id, command } = event.data;
  handle(command).then(
    result => postMessage({ id, ok: true, ...result } satisfies StudioWorkerReply),
    error => postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies StudioWorkerReply),
  );
});
