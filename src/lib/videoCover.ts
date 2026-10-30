/**
 * A library video with no picture of its own gets a frame as its cover: decoded here with the
 * system decoder (codecFrames.ts) and kept by the server (`/library/video-cover`). One video at
 * a time, each asked once per run; one that cannot be decoded keeps the video mark.
 */
import { api, framesApi } from "./api";
import { codecFramesAvailable, mostlyBlack, openVideoFrames, toJpeg } from "./codecFrames";

const COVER_WIDTH = 480;
/** Where to look, as parts of the length: the first frame that is not black is the cover. */
const POSITIONS = [0.1, 0.35, 0.6];

const asked = new Map<number, Promise<boolean>>();
let queue: Promise<unknown> = Promise.resolve();

async function make(trackId: number): Promise<boolean> {
  const frames = await openVideoFrames(api.videoUrl(trackId), COVER_WIDTH);
  try {
    let chosen: HTMLCanvasElement | OffscreenCanvas | null = null;
    for (const part of POSITIONS) {
      const canvas = await frames.canvas(frames.duration * part);
      if (!canvas) continue;
      chosen ??= canvas;
      if (!mostlyBlack(canvas)) { chosen = canvas; break; }
    }
    if (!chosen) return false;
    await framesApi.saveVideoCover(trackId, await toJpeg(chosen));
    return true;
  } finally {
    frames.dispose();
  }
}

/** Whether a cover was made for the video: the caller then loads its cover again. */
export function requestVideoCover(trackId: number): Promise<boolean> {
  if (!codecFramesAvailable()) return Promise.resolve(false);
  const known = asked.get(trackId);
  if (known) return known;
  const run = queue.then(() => make(trackId)).catch(() => false);
  queue = run;
  asked.set(trackId, run);
  return run;
}
