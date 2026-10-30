// Pure helpers for parallel studio export: no DOM, no worker globals.

const MAX_WORKERS = 8;
/** Upper bound for everything the export workers retain at once. */
const WORKER_MEMORY = 768 * 1024 * 1024;

/** Each worker holds its own layers (about five frames' worth), the frame being drawn
 * and one uploading frame with its body copy, its decoded images until prepared, and
 * its parsed feature timeline. Leave two cores for the editor and the server's muxing. */
export function studioWorkerCount(width: number, height: number, imagePixels: number, timelineValues: number, cores: number): number {
  const perWorker = width * height * 4 * 10 + imagePixels * 4 + timelineValues * 16;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 2, Math.floor(WORKER_MEMORY / perWorker)));
}

/** Editor-encoded export: the video is cut into closed GOPs of one second. A renderer
 * draws and encodes a whole GOP, so GOPs finish in any order and are muxed in sequence. */
export const studioChunkFrames = (fps: number) => fps;

/** H.264 High at the lowest level that holds the canvas at this frame rate (Table A-1). */
export function studioAvcCodec(width: number, height: number, fps: number, profile: "high" | "main" | "baseline" = "high"): string {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16), rate = blocks * fps;
  const level = blocks <= 8192 && rate <= 245760 ? "28" : blocks <= 8704 && rate <= 522240 ? "2a" : rate <= 589824 ? "32" : "33";
  return `avc1.${{ high: "6400", main: "4d00", baseline: "4200" }[profile]}${level}`;
}

export type StudioQuality = "high" | "standard" | "low";
/** Video bits per second at 1080p30. A hardware encoder spends its target whatever the
 * picture shows, and this one is mostly still: 8 Mbps is what video sites ask of an upload. */
const QUALITY_BITRATE: Record<StudioQuality, number> = { high: 12_000_000, standard: 8_000_000, low: 5_000_000 };

/** What a hardware encoder is held to: proportional to pixels, half as much again at 60 fps. */
export function studioVideoBitrate(width: number, height: number, fps: number, quality: StudioQuality = "standard"): number {
  return Math.max(1_500_000, Math.min(80_000_000, Math.round(QUALITY_BITRATE[quality] * width * height / (1920 * 1080) * (fps > 30 ? 1.5 : 1))));
}

/** What a hardware-encoded export weighs, beside 256 kbps of AAC. Without a hardware
 * encoder x264 sizes the file by the picture instead, and it comes out smaller than this. */
export function studioExportBytes(width: number, height: number, fps: number, seconds: number, quality?: StudioQuality): number {
  return Math.round(seconds * (studioVideoBitrate(width, height, fps, quality) + 256_000) / 8);
}

/** SPS and PPS that open an Annex B GOP, as hex; null unless a key picture follows them.
 * GOPs of one video come from several encoder sessions and are stream-copied into one
 * track, which only holds when every session wrote the same parameter sets. */
export function h264ParameterSets(bytes: Uint8Array): string | null {
  const starts: number[] = [];
  for (let i = 2; i < bytes.length;) {
    if (bytes[i] === 0) i++;
    else if (bytes[i] === 1 && bytes[i - 1] === 0 && bytes[i - 2] === 0) { starts.push(i + 1); i += 3; }
    else i += 3;
  }
  if (!starts.length || starts[0] > 4) return null;
  const sets: string[] = [], kinds = new Set<number>();
  for (let n = 0; n < starts.length; n++) {
    const start = starts[n], kind = bytes[start] & 0x1f;
    if (kind === 1 || kind === 5) return kind === 5 && kinds.has(7) && kinds.has(8) ? sets.join(" ") : null;
    if (kind !== 7 && kind !== 8) continue;
    // A four-byte start code leaves its first zero at the end of this unit.
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : bytes.length;
    while (end > start && bytes[end - 1] === 0) end--;
    kinds.add(kind);
    sets.push(Array.from(bytes.subarray(start, end), byte => byte.toString(16).padStart(2, "0")).join(""));
  }
  return null;
}

/** Planar 4:2:0 frames are 37.5% of RGBA. Uploading raw RGBA saturates the WebView's
 * loopback transfer long before the renderers or the encoder: about 400 MB/s, i.e.
 * 48 frames/s at 1080p, in both WebKit and Chromium. */
export const yuv420Bytes = (width: number, height: number) => width * height * 3 / 2;

// BT.709 limited range in 16-bit fixed point, as FFmpeg's
// `scale=in_range=full:out_range=tv:out_color_matrix=bt709`: Y spans 16–235 and
// chroma 16–240. Chroma rows sum to zero, so neutral grays keep U = V = 128 exactly.
const YR = 11966, YG = 40254, YB = 4064;
const UR = -6596, UG = -22189, UB = 28785;
const VR = 28784, VG = -26145, VB = -2639;

/** Opaque RGBA (getImageData of an `alpha: false` canvas) to I420. Each chroma sample
 * is the mean of its 2×2 block; the canvas has even dimensions. A pixel is read as one
 * little-endian word (R in the low byte), a quarter of the loads of reading bytes. */
export function rgbaToYuv420(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(yuv420Bytes(width, height)), half = width >> 1;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  let u = width * height, v = u + (u >> 2);
  for (let y = 0; y < height; y += 2) {
    // A pixel's index is also its luma sample's.
    let top = y * width, bottom = top + width;
    for (let x = 0; x < half; x++, top += 2, bottom += 2) {
      const p0 = words[top], p1 = words[top + 1], p2 = words[bottom], p3 = words[bottom + 1];
      const r0 = p0 & 255, g0 = p0 >> 8 & 255, b0 = p0 >> 16 & 255;
      const r1 = p1 & 255, g1 = p1 >> 8 & 255, b1 = p1 >> 16 & 255;
      const r2 = p2 & 255, g2 = p2 >> 8 & 255, b2 = p2 >> 16 & 255;
      const r3 = p3 & 255, g3 = p3 >> 8 & 255, b3 = p3 >> 16 & 255;
      out[top] = (YR * r0 + YG * g0 + YB * b0 + 1081344) >> 16;
      out[top + 1] = (YR * r1 + YG * g1 + YB * b1 + 1081344) >> 16;
      out[bottom] = (YR * r2 + YG * g2 + YB * b2 + 1081344) >> 16;
      out[bottom + 1] = (YR * r3 + YG * g3 + YB * b3 + 1081344) >> 16;
      const r = r0 + r1 + r2 + r3, g = g0 + g1 + g2 + g3, b = b0 + b1 + b2 + b3;
      out[u++] = (UR * r + UG * g + UB * b + 33685504) >> 18;
      out[v++] = (VR * r + VG * g + VB * b + 33685504) >> 18;
    }
  }
  return out;
}
