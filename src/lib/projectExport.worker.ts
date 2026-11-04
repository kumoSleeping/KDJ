// The renderer of a `.kdjv` project's export (projectExport.ts). It draws each frame of the
// project the way its live picture does (KdjvCodecPicture: kdjvLive.ts's boxes, opacity and
// source times, the last track first), with every video decoded frame by frame in order by the
// WebView's own decoder (mediabunny over the server's Range route), and the stills and GIF frames
// the server decodes. Frames are encoded and uploaded like the visualizer's (studioEncoder.ts).
import { Input, MATROSKA, MP4, QTFF, UrlSource, VideoSampleSink, WEBM, type VideoSample } from "mediabunny";
import type { VisualizerJobStatus } from "./api";
import { clipAlpha, clipBox, sourceTime, type LiveClip } from "./kdjvLive";
import { createGopEncoder, postGop, type GopEncoder, type StudioFrameTiming, type StudioWorkerStep } from "./studioEncoder";
import { h264ParameterSets, rgbaToYuv420 } from "./visualizerStudioFrames";
import type { StudioWorkerNote, StudioWorkerProgress, StudioWorkerReply, StudioWorkerResult } from "./visualizerStudioExport.worker";
import type { KdjvLive } from "../types";

/** What the export draws: the project's frame `f` is its time `from + f / fps`. */
export interface ProjectExportGeometry {
  width: number;
  height: number;
  fps: number;
  from: number;
  frames: number;
  chunkFrames: number;
  bitrate: number;
}

export type ProjectWorkerCommand =
  | { type: "init"; live: KdjvLive; trackId: number; geometry: ProjectExportGeometry; videoUrls: Record<number, string>; baseUrl: string; authToken: string }
  /** Opens the encoder and proves it on a short GOP. */
  | { type: "encoder" }
  /** Draws, encodes and uploads GOP `index`. */
  | { type: "encode"; job: string; token: number; index: number };
export interface ProjectWorkerRequest { id: number; command: ProjectWorkerCommand }

/** A source position this far before the frame shown is a jump back: the decode starts again. */
const BACK_SEC = 1e-4;
/** A source position this far past the frame shown is cheaper to seek to than to decode up to. */
const SEEK_AHEAD_SEC = 3;

/** One video clip's frames in source order, from a decode started where it was first asked. */
class ClipFrames {
  private readonly input: Input;
  private readonly sink: Promise<VideoSampleSink>;
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private current: VideoSample | null = null;
  private next: VideoSample | null = null;
  private ended = false;

  constructor(url: string) {
    this.input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new UrlSource(url) });
    this.sink = this.input.getPrimaryVideoTrack().then(async track => {
      if (!track) throw new Error("素材里没有视频画面，或者是读不了的容器");
      if (!(await track.canDecode())) throw new Error(`系统解码器不支持 ${track.codec ?? "这种编码"}`);
      return new VideoSampleSink(track);
    });
  }

  /** The frame shown at source second `t`: the last one starting at or before it. */
  async at(t: number): Promise<VideoSample | null> {
    const shown = this.current?.timestamp ?? -Infinity;
    if (!this.iterator || t < shown - BACK_SEC || (this.current && t > shown + SEEK_AHEAD_SEC)) await this.restart(t);
    while (!this.ended) {
      if (!this.next) {
        const step = await this.iterator!.next();
        if (step.done) { this.ended = true; break; }
        this.next = step.value;
      }
      if (this.next.timestamp > t + BACK_SEC && this.current) break;
      this.current?.close();
      this.current = this.next;
      this.next = null;
    }
    return this.current;
  }

  private async restart(t: number): Promise<void> {
    this.release();
    this.ended = false;
    this.iterator = (await this.sink).samples(Math.max(0, t));
  }

  private release(): void {
    void this.iterator?.return();
    this.iterator = null;
    this.current?.close();
    this.next?.close();
    this.current = this.next = null;
  }

  dispose(): void {
    this.release();
    this.input.dispose();
  }
}

let live: KdjvLive | undefined;
let geometry: ProjectExportGeometry | undefined;
let trackId = 0;
let videoUrls: Record<number, string> = {};
let server = { baseUrl: "", authToken: "" };
let surface: [OffscreenCanvas, OffscreenCanvasRenderingContext2D] | undefined;
let encoder: GopEncoder | undefined;
/** Video clips being decoded, by clip number. */
const readers = new Map<number, ClipFrames>();
/** Still pictures and GIF frames, by source and frame. */
const stills = new Map<string, Promise<ImageBitmap>>();
const timing: StudioFrameTiming = { frames: 0, drawMs: 0, readMs: 0, convertMs: 0, encodeMs: 0, sendMs: 0 };
let drawn = 0;
const step = (now: StudioWorkerStep) => postMessage({ progress: { drawn, step: now } } satisfies StudioWorkerProgress);

/** Frame `index` of an image or GIF source at source second `t` (a GIF loops, as `<img>` does). */
function stillFrame(n: number, t: number): Promise<ImageBitmap> {
  const ends = live!.sources[n]?.frame_ends ?? [];
  const total = Math.max(ends[ends.length - 1] ?? 0, 1e-3);
  const time = Math.max(0, t) % total;
  // The first frame ending after `time`, as the server's `frame_index` picks it.
  const after = ends.findIndex(end => end > time);
  const index = after < 0 ? Math.max(0, ends.length - 1) : after;
  const key = `${n}:${index}`;
  let bitmap = stills.get(key);
  if (!bitmap) {
    bitmap = fetch(`${server.baseUrl}/api/kdjv/image/${trackId}/${n}?index=${index}&width=0`, { headers: { Authorization: `Bearer ${server.authToken}` } })
      .then(async response => {
        if (!response.ok) throw new Error(`读不到工程的图片素材 ${n + 1}：HTTP ${response.status}`);
        return createImageBitmap(await response.blob());
      });
    stills.set(key, bitmap);
    // A long GIF keeps only its recent frames.
    if (stills.size > 64) {
      const [oldest] = stills.keys();
      void stills.get(oldest)?.then(b => b.close(), () => undefined);
      stills.delete(oldest);
    }
  }
  return bitmap;
}

/** A picture of `fw` × `fh` drawn into the clip's box less its crop, as KdjvCodecPicture draws. */
function place(ctx: OffscreenCanvasRenderingContext2D, c: LiveClip, fw: number, fh: number, draw: (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => void) {
  const { width, height } = ctx.canvas;
  const at = clipBox(live!, c);
  const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
  const keepX = Math.max(0.01, 1 - l - r), keepY = Math.max(0.01, 1 - t - b);
  draw(fw * l, fh * t, fw * keepX, fh * keepY,
    (at.left + l * at.width) / 100 * width, (at.top + t * at.height) / 100 * height,
    at.width * keepX / 100 * width, at.height * keepY / 100 * height);
}

/** Draws the project at second `t`: black, then each clip on screen, bottom first. */
async function compose(t: number): Promise<void> {
  const project = live!, [, ctx] = surface!;
  const shown: number[] = [];
  project.clips.forEach((c, n) => {
    const local = t - c.at;
    if (local >= 0 && local < c.length && clipAlpha(c, local) > 0) shown.push(n);
  });
  // A clip off screen lets its decoder go; one coming back later (a retried GOP) starts again.
  for (const [n, reader] of readers) if (!shown.includes(n)) { reader.dispose(); readers.delete(n); }
  // Drawn bottom first: the last track, and within a track the earlier clip under the later.
  shown.sort((a, b) => (project.clips[b].track - project.clips[a].track) || (a - b));
  // Every frame is asked for before any is drawn: the decoders work at once.
  const pictures = await Promise.all(shown.map(async n => {
    const c = project.clips[n], source = project.sources[c.source], at = sourceTime(c, t - c.at);
    if (source?.kind === "video") {
      let reader = readers.get(n);
      if (!reader) {
        const url = videoUrls[c.source];
        if (!url) throw new Error(`工程素材 ${c.source + 1} 没有地址`);
        reader = new ClipFrames(url);
        readers.set(n, reader);
      }
      return { n, video: await reader.at(at) };
    }
    if (source?.kind === "image" || source?.kind === "gif") return { n, still: await stillFrame(c.source, at) };
    return { n };
  }));
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const picture of pictures) {
    const c = project.clips[picture.n];
    ctx.globalAlpha = clipAlpha(c, t - c.at);
    if (picture.video) {
      const frame = picture.video;
      place(ctx, c, frame.displayWidth, frame.displayHeight, (...box) => frame.draw(ctx, ...box));
    } else if (picture.still) {
      const image = picture.still;
      place(ctx, c, image.width, image.height, (...box) => ctx.drawImage(image, ...box));
    }
  }
  ctx.globalAlpha = 1;
}

async function i420(index: number): Promise<Uint8Array<ArrayBuffer>> {
  const g = geometry!, [canvas, ctx] = surface!;
  let before = performance.now();
  await compose(g.from + index / g.fps);
  timing.drawMs += performance.now() - before;
  before = performance.now();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  timing.readMs += performance.now() - before;
  before = performance.now();
  const yuv = rgbaToYuv420(image.data, image.width, image.height);
  timing.convertMs += performance.now() - before;
  return yuv;
}

async function handle(command: ProjectWorkerCommand): Promise<StudioWorkerResult | undefined> {
  switch (command.type) {
    case "init": {
      ({ live, geometry, trackId, videoUrls } = command);
      server = { baseUrl: command.baseUrl, authToken: command.authToken };
      const canvas = new OffscreenCanvas(geometry.width, geometry.height);
      const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      if (!ctx) throw new Error("导出线程无法建立画布");
      ctx.imageSmoothingQuality = "high";
      surface = [canvas, ctx];
      return;
    }
    case "encoder": {
      const g = geometry;
      if (!g || !surface) throw new Error("导出线程尚未准备画面");
      encoder = createGopEncoder({
        width: g.width, height: g.height, fps: g.fps, bitrate: g.bitrate, timing,
        frame: i420, step, encoded: () => { drawn++; },
        note: note => postMessage({ note } satisfies StudioWorkerNote),
      });
      await encoder.open();
      const parts = await encoder.encodeGop(0, Math.min(4, g.frames));
      const parameters = h264ParameterSets(new Uint8Array(await new Blob(parts).arrayBuffer()));
      if (!parameters) throw new Error("硬件编码器没有输出 Annex B 关键帧");
      // The probe's frames are not the export's.
      Object.assign(timing, { frames: 0, drawMs: 0, readMs: 0, convertMs: 0, encodeMs: 0, sendMs: 0 });
      return { parameters };
    }
    case "encode": {
      const g = geometry;
      if (!g || !encoder) throw new Error("导出线程尚未准备编码器");
      const first = command.index * g.chunkFrames;
      const parts = await encoder.encodeGop(first, Math.min(g.chunkFrames, g.frames - first));
      step("send");
      const before = performance.now();
      try {
        const status = await postGop<VisualizerJobStatus>(server, command.job, command.token, command.index, new Blob(parts));
        return { status, timing: { ...timing } };
      } finally { timing.sendMs += performance.now() - before; }
    }
  }
}

addEventListener("message", (event: MessageEvent<ProjectWorkerRequest>) => {
  const { id, command } = event.data;
  handle(command).then(
    result => postMessage({ id, ok: true, ...result } satisfies StudioWorkerReply),
    error => postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies StudioWorkerReply),
  );
});
