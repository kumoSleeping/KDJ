// Pure helpers for parallel studio export: no DOM, no worker globals.

const MAX_WORKERS = 8;
/** Upper bound for everything the export workers retain at once. */
const WORKER_MEMORY = 768 * 1024 * 1024;

/** Each worker holds its own layers (about five frames' worth), the frame being drawn
 * and one uploading frame with its body copy, its decoded images until prepared, and
 * its parsed feature timeline. Leave two cores for FFmpeg and the editor. */
export function studioWorkerCount(width: number, height: number, imagePixels: number, timelineValues: number, cores: number): number {
  const perWorker = width * height * 4 * 10 + imagePixels * 4 + timelineValues * 16;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 2, Math.floor(WORKER_MEMORY / perWorker)));
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
 * is the mean of its 2×2 block; the canvas has even dimensions. */
export function rgbaToYuv420(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(yuv420Bytes(width, height)), half = width >> 1, stride = width * 4;
  let u = width * height, v = u + (u >> 2);
  for (let y = 0; y < height; y += 2) {
    let top = y * stride, bottom = top + stride, upper = y * width, lower = upper + width;
    for (let x = 0; x < half; x++, top += 8, bottom += 8) {
      const r0 = rgba[top], g0 = rgba[top + 1], b0 = rgba[top + 2];
      const r1 = rgba[top + 4], g1 = rgba[top + 5], b1 = rgba[top + 6];
      const r2 = rgba[bottom], g2 = rgba[bottom + 1], b2 = rgba[bottom + 2];
      const r3 = rgba[bottom + 4], g3 = rgba[bottom + 5], b3 = rgba[bottom + 6];
      out[upper++] = (YR * r0 + YG * g0 + YB * b0 + 1081344) >> 16;
      out[upper++] = (YR * r1 + YG * g1 + YB * b1 + 1081344) >> 16;
      out[lower++] = (YR * r2 + YG * g2 + YB * b2 + 1081344) >> 16;
      out[lower++] = (YR * r3 + YG * g3 + YB * b3 + 1081344) >> 16;
      const r = r0 + r1 + r2 + r3, g = g0 + g1 + g2 + g3, b = b0 + b1 + b2 + b3;
      out[u++] = (UR * r + UG * g + UB * b + 33685504) >> 18;
      out[v++] = (VR * r + VG * g + VB * b + 33685504) >> 18;
    }
  }
  return out;
}
