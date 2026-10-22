/**
 * The arithmetic of a `.kdjv` project's live preview (KdjvLivePicture, docs/kdjv.md): which clips
 * hold a decoder, where each sits on the canvas and how opaque it is — the same as the render's
 * (render.rs `fitted_picture_size`, `picture_axis`, `envelope`), so the preview and the export agree.
 */
import type { KdjvLive } from "../types";

export type LiveClip = KdjvLive["clips"][number];

/**
 * An upcoming clip's decoder starts this long before its cut, so the cut shows a moving frame:
 * long enough for WebKit to seek it, hold its first frame and settle on the clock while unseen.
 */
export const PREWARM_SEC = 5;
/** A clip that has ended is held on its last frame at most this long while the next one settles. */
export const HOLD_SEC = 4;
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

/**
 * The clips kept on screen past their end at `t`: on a track whose clip of now is not showing yet
 * (its decoder still settling), the clip it follows, on its last frame, so the cut holds a picture
 * instead of going black or showing a frame that jumps. Not one that fades out (a crossfade's
 * other half is on another track), nor one that ended more than HOLD_SEC ago.
 */
export function heldClips(project: KdjvLive, t: number, showing: (n: number) => boolean): number[] {
  const out: number[] = [];
  project.clips.forEach((c, n) => {
    if (t < c.at || t >= c.at + c.length || showing(n)) return;
    let before = -1;
    project.clips.forEach((p, m) => {
      const end = p.at + p.length;
      if (m === n || p.track !== c.track || end > c.at + 0.05 || end < t - HOLD_SEC || p.fade_out > 0) return;
      if (before < 0 || end > project.clips[before].at + project.clips[before].length) before = m;
    });
    if (before >= 0 && !out.includes(before)) out.push(before);
  });
  return out.sort((a, b) => a - b);
}

/** The clip's box on the canvas, in percent: the render's fitted size and clamped position. */
export function clipBox(project: KdjvLive, c: LiveClip) {
  const s = project.sources[c.source];
  const W = project.width, H = project.height;
  // A crop: what is left is placed as the whole picture would be (render.rs, keep_position off);
  // the element stays the whole frame, larger than that box and clipped to it.
  const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
  const keepX = Math.max(0.01, 1 - l - r), keepY = Math.max(0.01, 1 - t - b);
  const fw = Math.max(1, s?.width || W) * keepX, fh = Math.max(1, s?.height || H) * keepY;
  const fit = c.fill ? Math.max(W, H * fw / fh) : Math.min(W, H * fw / fh);
  const w = fit * c.scale, h = w * fh / fw;
  const axis = (center: number, canvas: number, size: number) => {
    const at = canvas * center - size / 2;
    return c.fill
      ? Math.max(Math.min(0, canvas - size), Math.min(Math.max(0, canvas - size), at))
      : Math.max(0, Math.min(canvas - size, at));
  };
  const left = axis(c.x, W, w), top = axis(c.y, H, h);
  const full = { width: w / keepX, height: h / keepY };
  return {
    left: (left - l * full.width) / W * 100, top: (top - t * full.height) / H * 100,
    width: full.width / W * 100, height: full.height / H * 100,
    ...(l || t || r || b ? { clip: `inset(${t * 100}% ${r * 100}% ${b * 100}% ${l * 100}%)` } : {}),
  } as { left: number; top: number; width: number; height: number; clip?: string };
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
