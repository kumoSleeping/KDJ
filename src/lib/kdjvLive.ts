/**
 * The arithmetic of a `.kdjv` project's live preview (KdjvLivePicture, docs/kdjv.md): which clips
 * hold a decoder, where each sits on the canvas and how opaque it is — the same as the render's
 * (render.rs `fitted_picture_size`, `picture_axis`, `envelope`), so the preview and the export agree.
 */
import type { KdjvLive } from "../types";

export type LiveClip = KdjvLive["clips"][number];

/** An upcoming clip's decoder starts this long before its cut, so the cut shows a moving frame. */
export const PREWARM_SEC = 2.5;
/** Upcoming clips prepared per track. */
const PREWARM_CLIPS = 2;

/** The clips to hold a decoder for at `t`: those on screen, and while playing the next few. */
export function preparedClips(project: KdjvLive, t: number, playing: boolean): number[] {
  const out: number[] = [];
  const upcoming = new Map<number, number[]>();
  project.clips.forEach((c, n) => {
    if (t >= c.at && t < c.at + c.length) out.push(n);
    else if (playing && c.at > t && c.at <= t + PREWARM_SEC) {
      const next = upcoming.get(c.track) ?? [];
      next.push(n);
      upcoming.set(c.track, next);
    }
  });
  for (const next of upcoming.values()) {
    out.push(...next.sort((a, b) => project.clips[a].at - project.clips[b].at).slice(0, PREWARM_CLIPS));
  }
  return out.sort((a, b) => a - b);
}

/** The clip's box on the canvas, in percent: the render's fitted size and clamped position. */
export function clipBox(project: KdjvLive, c: LiveClip) {
  const s = project.sources[c.source];
  const W = project.width, H = project.height;
  const fw = Math.max(1, s?.width || W), fh = Math.max(1, s?.height || H);
  const fit = c.fill ? Math.max(W, H * fw / fh) : Math.min(W, H * fw / fh);
  const w = fit * c.scale, h = w * fh / fw;
  const axis = (center: number, canvas: number, size: number) => {
    const at = canvas * center - size / 2;
    return c.fill
      ? Math.max(Math.min(0, canvas - size), Math.min(Math.max(0, canvas - size), at))
      : Math.max(0, Math.min(canvas - size, at));
  };
  return { left: axis(c.x, W, w) / W * 100, top: axis(c.y, H, h) / H * 100, width: w / W * 100, height: h / H * 100 };
}

/** Opacity at `local` seconds into the clip: its own, under smoothstep fades. */
export function clipAlpha(c: LiveClip, local: number): number {
  if (local < 0 || local >= c.length) return 0;
  const shape = (x: number) => { const v = Math.max(0, Math.min(1, x)); return v * v * (3 - 2 * v); };
  let alpha = c.opacity;
  if (c.fade_in > 0) alpha *= shape(local / c.fade_in);
  if (c.fade_out > 0) alpha *= shape((c.length - local) / c.fade_out);
  return alpha;
}

/** How fast the clip runs through its source. */
export function clipSpeed(c: LiveClip): number {
  return (c.out - c.in) / Math.max(1e-3, c.length);
}

/** The source second the clip shows at `local` seconds into it (before its cut while prewarming). */
export function sourceTime(c: LiveClip, local: number): number {
  return Math.min(c.out, c.in + local * clipSpeed(c));
}
