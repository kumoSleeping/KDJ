import assert from "node:assert/strict";
import test from "node:test";
import { clipAlpha, clipBox, heldClips, preparedClips, sourceTime, type LiveClip } from "../src/lib/kdjvLive";
import type { KdjvLive } from "../src/types";

function clip(more: Partial<LiveClip>): LiveClip {
  return { source: 0, track: 0, at: 0, in: 0, out: 10, length: 10, x: 0.5, y: 0.5, scale: 1, opacity: 1,
    fill: false, fade_in: 0, fade_out: 0, ...more };
}

function project(clips: LiveClip[], source = { width: 1920, height: 1080 }): KdjvLive {
  return { duration: 60, width: 1920, height: 1080, sources: [{ kind: "video", fps: 30, ...source }], clips };
}

test("a decoder is held for the clips on screen and, while playing, the next two of each track", () => {
  const p = project([
    clip({ at: 0, length: 5 }),
    clip({ at: 5, length: 5 }),
    clip({ at: 6, length: 5 }),
    clip({ at: 7, length: 5 }),
    clip({ track: 1, at: 0, length: 30 }),
  ]);
  assert.deepEqual(preparedClips(p, 0.5, true), [0, 1, 4], "the next cut within the prewarm, nothing further");
  assert.deepEqual(preparedClips(p, 4.9, true), [0, 1, 2, 4], "two upcoming at most on a track");
  assert.deepEqual(preparedClips(p, 4, false), [0, 4], "a paused picture holds only what is shown");
  assert.deepEqual(preparedClips(p, 5.5, true), [0, 1, 2, 3, 4], "the clip just ended is kept past the cut");
  assert.deepEqual(preparedClips(p, 6.6, true), [1, 2, 3, 4], "and let go a moment later");
  assert.deepEqual(preparedClips(p, 5.5, false), [1, 4], "a paused picture keeps no ended clip");
});

test("a clip sits where the render puts it: fitted, filled, scaled and kept on the canvas", () => {
  const square = { width: 1080, height: 1080 };
  const fit = clipBox(project([], square), clip({}));
  assert.deepEqual(fit, { left: 21.875, top: 0, width: 56.25, height: 100 }, "a square is fitted to the height, centred");
  const fill = clipBox(project([], square), clip({ fill: true }));
  assert.equal(fill.width, 100);
  assert.ok(Math.abs(fill.top - -38.888888) < 1e-4, "a filled square overflows top and bottom evenly");
  const corner = clipBox(project([]), clip({ scale: 0.5, x: 0, y: 0 }));
  assert.deepEqual(corner, { left: 0, top: 0, width: 50, height: 50 }, "a small picture never leaves the canvas");
  // A quarter off either side of a square: the half left is fitted to the height and centred; the
  // element is the whole frame around it, clipped to it.
  const cropped = clipBox(project([], square), clip({ crop: [0.25, 0, 0.25, 0] }));
  assert.deepEqual(cropped, { ...fit, clip: "inset(0% 25% 0% 25%)" });
});

test("fades are smoothstep on the clip's own opacity, and a clip is invisible outside itself", () => {
  const c = clip({ opacity: 0.8, fade_in: 1, fade_out: 2 });
  assert.equal(clipAlpha(c, -0.1), 0);
  assert.equal(clipAlpha(c, 0.5), 0.8 * 0.5);
  assert.equal(clipAlpha(c, 5), 0.8);
  assert.equal(clipAlpha(c, 9), 0.8 * 0.5);
  assert.equal(clipAlpha(c, 10), 0);
});

test("a clip's source time runs at its speed from its in point", () => {
  const fast = clip({ in: 10, out: 20, length: 5 });
  assert.equal(sourceTime(fast, 2), 14, "twice as fast");
  assert.equal(sourceTime(fast, -1), 8, "before the cut it runs up to its in point");
  assert.equal(sourceTime(fast, 9), 20, "never past its out point");
});

test("a cut whose next clip is not showing yet holds the clip before it, not one that fades or is long gone", () => {
  const p = project([
    clip({ at: 0, length: 5 }),
    clip({ at: 5, length: 5 }),
    clip({ track: 1, at: 0, length: 5, fade_out: 1 }),
    clip({ track: 1, at: 5, length: 5 }),
  ]);
  assert.deepEqual(heldClips(p, 5.3, () => false), [0], "the clip before, on its own track; a fading one is not held");
  assert.deepEqual(heldClips(p, 5.3, n => n === 1), [], "nothing is held once the next clip shows");
  assert.deepEqual(heldClips(p, 9.5, () => false), [], "not past the hold");
});
