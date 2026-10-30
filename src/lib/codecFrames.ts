/**
 * Still pictures of a video, decoded with the system's decoder through WebCodecs (mediabunny
 * reads the file by Range, the same as codecClip.ts): what `kdj peek` returns and a library
 * video's cover. KDJ has no FFmpeg; a file this WebView cannot read or decode is refused with
 * the reason, and its caller says so.
 */
import { CanvasSink, Input, MATROSKA, MP4, QTFF, UrlSource, WEBM } from "mediabunny";

export interface VideoFrames {
  /** Seconds, from the container. */
  duration: number;
  /** The frame shown at `at` seconds as a JPEG, or null when there is none there. */
  jpeg(at: number): Promise<Blob | null>;
  /** The frame at `at` drawn into a canvas the caller owns, for a contact sheet. */
  canvas(at: number): Promise<HTMLCanvasElement | OffscreenCanvas | null>;
  dispose(): void;
}

export function codecFramesAvailable(): boolean {
  return typeof VideoDecoder !== "undefined";
}

export async function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas, quality = 0.85): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("无法编码 JPEG"))), "image/jpeg", quality));
}

/** Opens `url` for frames `width` pixels wide (the height follows the picture). */
export async function openVideoFrames(url: string, width: number): Promise<VideoFrames> {
  if (!codecFramesAvailable()) throw new Error("这台设备的 WebView 不支持 WebCodecs 视频解码");
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new UrlSource(url) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("文件里没有视频画面，或者是读不了的容器");
    if (!(await track.canDecode())) throw new Error(`系统解码器不支持 ${track.codec ?? "这种编码"}`);
    const duration = await input.computeDuration();
    const sink = new CanvasSink(track, { width: Math.max(16, Math.round(width / 2) * 2), poolSize: 1 });
    const frame = async (at: number) => (await sink.getCanvas(Math.max(0, Math.min(at, duration - 0.05))))?.canvas ?? null;
    return {
      duration,
      async jpeg(at) {
        const canvas = await frame(at);
        return canvas ? toJpeg(canvas) : null;
      },
      async canvas(at) {
        const canvas = await frame(at);
        if (!canvas) return null;
        // The sink reuses its one canvas: the caller gets its own copy.
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext("2d")?.drawImage(canvas as CanvasImageSource, 0, 0);
        return copy;
      },
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

/** Mostly black: the mean luma of a small sample under 16 of 255. */
export function mostlyBlack(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 18;
  const ctx = probe.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(canvas as CanvasImageSource, 0, 0, probe.width, probe.height);
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return sum / (data.length / 4) < 16;
}
