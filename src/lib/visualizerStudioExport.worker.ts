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
export interface StudioWorkerResult { status?: VisualizerJobStatus; parameters?: string }
export type StudioWorkerReply = { id: number } & ({ ok: true } & StudioWorkerResult | { ok: false; message: string });

let prepared: PreparedStudio | undefined;
let surface: ReturnType<typeof studioCanvas> | undefined;
let server = { baseUrl: "", authToken: "" };

function pixels(index: number): ImageData {
  if (!prepared || !surface) throw new Error("导出线程尚未准备画面");
  const [canvas, context] = surface;
  drawStudioFrame(context, prepared, index / prepared.project.output.fps);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

interface Gop { parts: Uint8Array<ArrayBuffer>[]; last: number; failure?: string }
interface StudioEncoder { encoder: VideoEncoder; gop: Gop }
let video: StudioEncoder | undefined;
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
  let config: VideoEncoderConfig | undefined;
  for (const candidate of candidates) if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; }
  if (!config) throw new Error(`这台设备不能编码 ${width} × ${height} 的 H.264 视频，换一个较小的分辨率`);
  const state: StudioEncoder = {
    gop: { parts: [], last: -1 },
    encoder: new VideoEncoder({
      output(chunk) {
        const gop = state.gop;
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
  state.encoder.configure(config);
  video = state;
}

/** `dequeue` is not in every WebView; the timer bounds the wait either way. */
const settle = (encoder: VideoEncoder) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); encoder.removeEventListener("dequeue", done); resolve(); };
  const timer = setTimeout(done, 4);
  encoder.addEventListener("dequeue", done);
});

/** Frames `first .. first + count` as one closed GOP, from I420 frames in BT.709 limited range. */
async function encodeGop(first: number, count: number): Promise<Uint8Array<ArrayBuffer>[]> {
  if (!prepared || !video) throw new Error("导出线程尚未准备编码器");
  const { encoder } = video, gop: Gop = video.gop = { parts: [], last: -1 };
  const { width, height } = prepared.project.scene.canvas, fps = prepared.project.output.fps;
  for (let n = 0; n < count; n++) {
    const index = first + n, image = pixels(index);
    const frame = new VideoFrame(rgbaToYuv420(image.data, width, height), {
      format: "I420", codedWidth: width, codedHeight: height, timestamp: Math.round(index * 1e6 / fps), duration: Math.round(1e6 / fps),
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });
    try { encoder.encode(frame, { keyFrame: n === 0 }); } finally { frame.close(); }
    // Bound the frames waiting for the encoder: each holds a full I420 copy.
    while (encoder.encodeQueueSize > 2 && !gop.failure) await settle(encoder);
    if (gop.failure) throw new Error(gop.failure);
  }
  await encoder.flush();
  if (gop.failure) throw new Error(gop.failure);
  if (gop.parts.length !== count) throw new Error(`硬件编码器输出了 ${gop.parts.length} 帧，应为 ${count} 帧`);
  return gop.parts;
}

async function send(job: string, token: number, index: number, body: Blob): Promise<VisualizerJobStatus> {
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
      return { parameters };
    }
    case "encode": {
      const per = studioChunkFrames(prepared!.project.output.fps), first = command.index * per;
      const parts = await exclusive(() => encodeGop(first, Math.min(per, frameCount(prepared!) - first)));
      return { status: await send(command.job, command.token, command.index, new Blob(parts)) };
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
