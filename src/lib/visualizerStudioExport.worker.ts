// One export renderer. Frames are a pure function of their index, so several of these draw
// different GOPs of the same frozen project, encode them with the WebView's own H.264 encoder
// and upload them straight to the local server: pixels never cross back through the editor's
// thread.
import type { VisualizerFeatureTimeline } from "../types/audioVisualizer";
import type { VisualizerJobStatus } from "./api";
import { studioDuration, type VisualizerProject } from "./visualizerStudio";
import { drawStudioFrame, prepareStudio, studioCanvas, type PreparedStudio } from "./visualizerStudioRenderer";
import { h264ParameterSets, rgbaToYuv420, studioChunkFrames, studioVideoBitrate } from "./visualizerStudioFrames";
import { createGopEncoder, postGop, type GopEncoder, type StudioFrameTiming, type StudioWorkerStep } from "./studioEncoder";

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
export type StudioWorkerReply = { id: number } & ({ ok: true } & StudioWorkerResult | { ok: false; message: string });
export type { StudioFrameTiming, StudioWorkerStep };
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

let encoder: GopEncoder | undefined;
const frameCount = (s: PreparedStudio) => Math.ceil(studioDuration(s.timeline) * s.project.output.fps);

/** One encoder session for the whole export (studioEncoder.ts). */
async function openEncoder(): Promise<void> {
  if (!prepared) throw new Error("导出线程尚未准备画面");
  const { width, height } = prepared.project.scene.canvas, fps = prepared.project.output.fps;
  encoder = createGopEncoder({
    width, height, fps, bitrate: studioVideoBitrate(width, height, fps, prepared.project.output.quality), timing,
    frame: i420, step, encoded: () => { drawn++; },
    note: note => postMessage({ note } satisfies StudioWorkerNote),
  });
  await encoder.open();
}

async function encodeGop(first: number, count: number): Promise<Uint8Array<ArrayBuffer>[]> {
  if (!prepared || !encoder) throw new Error("导出线程尚未准备编码器");
  return encoder.encodeGop(first, count);
}

async function send(job: string, token: number, index: number, body: Blob): Promise<VisualizerJobStatus> {
  step("send");
  const before = performance.now();
  try { return await postGop<VisualizerJobStatus>(server, job, token, index, body); } finally { timing.sendMs += performance.now() - before; }
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
      const parts = await encodeGop(0, Math.min(4, frameCount(prepared!)));
      const parameters = h264ParameterSets(new Uint8Array(await new Blob(parts).arrayBuffer()));
      if (!parameters) throw new Error("硬件编码器没有输出 Annex B 关键帧");
      // The probe's frames are not the export's.
      Object.assign(timing, { frames: 0, drawMs: 0, readMs: 0, convertMs: 0, encodeMs: 0, sendMs: 0 });
      return { parameters };
    }
    case "encode": {
      const per = studioChunkFrames(prepared!.project.output.fps), first = command.index * per;
      const parts = await encodeGop(first, Math.min(per, frameCount(prepared!) - first));
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
