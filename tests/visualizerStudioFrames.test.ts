import { test } from "node:test";
import assert from "node:assert/strict";
import { rgbaToYuv420, studioWorkerCount, yuv420Bytes } from "../src/lib/visualizerStudioFrames";

function solid(width: number, height: number, [r, g, b]: number[]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return rgba;
}
// Expected values: FFmpeg 7.1 `scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p`.
for (const [name, rgb, yuv] of [
  ["black", [0, 0, 0], [16, 128, 128]], ["white", [255, 255, 255], [235, 128, 128]], ["gray", [128, 128, 128], [126, 128, 128]],
  ["red", [255, 0, 0], [63, 102, 240]], ["green", [0, 255, 0], [173, 42, 26]], ["blue", [0, 0, 255], [32, 240, 118]],
] as const) {
  test(`I420 matches FFmpeg's BT.709 limited-range conversion: ${name}`, () => {
    const out = rgbaToYuv420(solid(4, 2, [...rgb]), 4, 2);
    assert.equal(out.length, yuv420Bytes(4, 2));
    assert.deepEqual([...out], [...Array(8).fill(yuv[0]), ...Array(2).fill(yuv[1]), ...Array(2).fill(yuv[2])]);
  });
}
test("I420 keeps full-resolution luma and averages each 2×2 chroma block", () => {
  // Left block black, right block white: chroma stays neutral, luma keeps the edge.
  const rgba = solid(4, 2, [0, 0, 0]);
  for (const x of [2, 3]) for (const y of [0, 1]) rgba.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 3);
  assert.deepEqual([...rgbaToYuv420(rgba, 4, 2)], [16, 16, 235, 235, 16, 16, 235, 235, 128, 128, 128, 128]);
});
test("export workers are bounded by cores and by memory", () => {
  assert.equal(studioWorkerCount(1920, 1080, 1600 * 1600, 18_000 * 68, 8), 6);
  assert.equal(studioWorkerCount(1920, 1080, 0, 0, 64), 8);
  assert.equal(studioWorkerCount(1920, 1080, 0, 0, 2), 1, "a dual-core machine still gets one off-thread renderer");
  // 1440p, two 16 MP images and a 30-minute 60 fps timeline: memory, not cores, limits.
  const workers = studioWorkerCount(2560, 1440, 32_000_000, 108_000 * 68, 16);
  assert.equal(workers, 2);
  assert.ok(workers * (2560 * 1440 * 4 * 10 + 32_000_000 * 4 + 108_000 * 68 * 16) <= 768 * 1024 * 1024);
});
