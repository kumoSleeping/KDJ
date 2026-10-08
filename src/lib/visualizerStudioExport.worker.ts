// One export renderer. Frames are a pure function of their index, so several of these
// draw different frames of the same frozen project and upload them straight to the
// local server: pixels never cross back through the editor's thread.
import type { VisualizerFeatureTimeline } from "../types/audioVisualizer";
import type { VisualizerJobStatus } from "./api";
import type { VisualizerProject } from "./visualizerStudio";
import { drawStudioFrame, prepareStudio, studioCanvas, type PreparedStudio } from "./visualizerStudioRenderer";
import { rgbaToYuv420 } from "./visualizerStudioFrames";

export type StudioWorkerCommand =
  /** The timeline arrives as JSON text: one string copy per worker instead of
   * serializing every feature object on the editor thread. */
  | { type: "init"; project: VisualizerProject; images: ImageBitmap[]; timeline: string; baseUrl: string; authToken: string }
  | { type: "context"; willReadFrequently: boolean }
  | { type: "time"; indices: number[] }
  | { type: "upload"; job: string; token: number; index: number };
export interface StudioWorkerRequest { id: number; command: StudioWorkerCommand }
export type StudioWorkerReply = { id: number } & ({ ok: true; status?: VisualizerJobStatus } | { ok: false; message: string });

let prepared: PreparedStudio | undefined;
let surface: ReturnType<typeof studioCanvas> | undefined;
let server = { baseUrl: "", authToken: "" };

function pixels(index: number): ImageData {
  if (!prepared || !surface) throw new Error("导出线程尚未准备画面");
  const [canvas, context] = surface;
  drawStudioFrame(context, prepared, index / prepared.project.output.fps);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Same request as `visualizerApi.frame`. Drawing happens before the first await, so
 * the next queued frame renders while this upload is still in flight. */
async function upload(job: string, token: number, index: number): Promise<VisualizerJobStatus> {
  const image = pixels(index);
  // A Blob body: Chromium uploads an ArrayBuffer body from a worker at only ~7 MB/s.
  const body = new Blob([rgbaToYuv420(image.data, image.width, image.height)]);
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

async function handle(command: StudioWorkerCommand): Promise<VisualizerJobStatus | undefined> {
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
    case "upload":
      return upload(command.job, command.token, command.index);
  }
}

addEventListener("message", (event: MessageEvent<StudioWorkerRequest>) => {
  const { id, command } = event.data;
  handle(command).then(
    status => postMessage({ id, ok: true, status } satisfies StudioWorkerReply),
    error => postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies StudioWorkerReply),
  );
});
