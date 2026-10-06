import type { ClipPicture, CompositionProject, WorkshopClip, WorkshopSource } from "../types/workshop";
import { clamp, cloneProject, isImageSource, isVisualSource } from "./workshop";

export const pictureResizeEdges = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type PictureResizeEdge = typeof pictureResizeEdges[number];
/** Match export: preserve the original frame, or refit the retained source area. */
export function pictureBox(p: CompositionProject, c: WorkshopClip, s: WorkshopSource) {
  const crop = c.picture.crop ?? [0,0,0,0];
  const left = Math.floor(s.width * crop[0]), top = Math.floor(s.height * crop[1]);
  const sw = Math.max(1, Math.floor(s.width * (1 - crop[0] - crop[2])));
  const sh = Math.max(1, Math.floor(s.height * (1 - crop[1] - crop[3])));
  const image = isImageSource(s);
  const autoFit = Boolean(c.picture.crop_auto_fit);
  const keepPosition = !autoFit && c.picture.crop_keep_position !== false;
  const frameWidth = keepPosition ? s.width : sw, frameHeight = keepPosition ? s.height : sh;
  const fit = autoFit ? Math.max : Math.min;
  const w = fit(p.canvas.width, p.canvas.height * frameWidth / frameHeight) * c.picture.scale;
  // Cover rounds outward to avoid a one-pixel gap; match export dimensions.
  const round = autoFit ? Math.ceil : Math.round;
  const unit = image ? 1 : 2;
  const fittedWidth = Math.max(1, round(w / unit)) * unit;
  const h = fittedWidth * frameHeight / frameWidth;
  const width = fittedWidth / p.canvas.width;
  const height = Math.max(1, round(h / unit)) * unit / p.canvas.height;
  const rotation = image ? c.picture.rotation ?? 0 : 0;
  const angle = rotation * Math.PI / 180;
  // Rust overlays the rotated image's integer bounding box. CSS rotates the
  // original box around its center, so translate that same bounded center back.
  const rotatedWidth = image ? Math.max(1, Math.ceil(
    width * p.canvas.width * Math.abs(Math.cos(angle)) + height * p.canvas.height * Math.abs(Math.sin(angle)) - 1e-9,
  )) / p.canvas.width : width;
  const rotatedHeight = image ? Math.max(1, Math.ceil(
    width * p.canvas.width * Math.abs(Math.sin(angle)) + height * p.canvas.height * Math.abs(Math.cos(angle)) - 1e-9,
  )) / p.canvas.height : height;
  // Cover needs negative offsets for the oversized axis, rather than pinning
  // its top/left edge to zero. Preserve legacy placement when not opted in.
  const place = (center: number, size: number) => autoFit
    ? Math.max(Math.min(0, 1-size), Math.min(Math.max(0, 1-size), center-size/2))
    : Math.max(0, Math.min(1-size, center-size/2));
  return {width, height,
    x: place(c.picture.x, rotatedWidth) + (rotatedWidth-width)/2,
    y: place(c.picture.y, rotatedHeight) + (rotatedHeight-height)/2,
    left, top, sw, sh, rotation, keepPosition,
    mediaWidth: s.width / frameWidth, mediaHeight: s.height / frameHeight,
    mediaX: keepPosition ? 0 : -left / frameWidth, mediaY: keepPosition ? 0 : -top / frameHeight,
    clipPath: `inset(${top / s.height * 100}% ${(s.width - left - sw) / s.width * 100}% ${(s.height - top - sh) / s.height * 100}% ${left / s.width * 100}%)`};
}
/** One-shot footage layout. Preserve crops, appearance, timing and import defaults. */
export function layoutProjectPictures(p: CompositionProject, mode: "contain" | "cover"): CompositionProject {
  const next = cloneProject(p), sources = new Map(next.sources.map(s => [s.id, s]));
  for (const layer of next.layers) for (const c of layer.clips) {
    const source = sources.get(c.source_id);
    // Text overlays are not footage: fitting them would turn captions into full-frame images.
    if (!source || !isVisualSource(source) || c.picture.subtitle) continue;
    Object.assign(c.picture, { x: .5, y: .5, scale: 1, crop_keep_position: false, crop_auto_fit: mode === "cover" });
    const b = pictureBox(next, c, source);
    if (b.rotation) {
      const angle = b.rotation * Math.PI / 180, cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
      const w = b.width * next.canvas.width, h = b.height * next.canvas.height;
      // Contain the rotated bounds; cover the inverse-rotated canvas corners.
      c.picture.scale = clamp(mode === "contain"
        ? Math.min(next.canvas.width / (w * cos + h * sin), next.canvas.height / (w * sin + h * cos))
        : Math.max((next.canvas.width * cos + next.canvas.height * sin) / w, (next.canvas.width * sin + next.canvas.height * cos) / h), .1, 2);
    }
  }
  return next;
}

/** Uniform scaling in canvas pixels, anchored at the opposite edge/corner. */
export function resizePictureLayout(p: CompositionProject, c: WorkshopClip, s: WorkshopSource,
  edge: PictureResizeEdge, dx: number, dy: number, fromCenter = false): Pick<ClipPicture, "x" | "y" | "scale"> {
  const b = pictureBox(p, c, s), angle = b.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos;
  const ex = edge.includes("e") ? 1 : edge.includes("w") ? -1 : 0;
  const ey = edge.includes("s") ? 1 : edge.includes("n") ? -1 : 0;
  const vx = ex * b.width * p.canvas.width, vy = ey * b.height * p.canvas.height;
  const factor = 1 + (fromCenter ? 2 : 1) * (localX * vx + localY * vy) / Math.max(1, vx * vx + vy * vy);
  const scale = clamp(c.picture.scale * factor, .1, 2), ratio = scale / c.picture.scale;
  const shiftX = fromCenter ? 0 : vx * (ratio - 1) / 2;
  const shiftY = fromCenter ? 0 : vy * (ratio - 1) / 2;
  return { scale,
    x: clamp(b.x + b.width / 2 + (shiftX * cos - shiftY * sin) / p.canvas.width, 0, 1),
    y: clamp(b.y + b.height / 2 + (shiftX * sin + shiftY * cos) / p.canvas.height, 0, 1),
  };
}

export function gifFrame(ends: number[] | undefined, ms: number): {index: number; ms: number} {
  if (!ends?.length) return {index:0, ms:0};
  const time = Math.max(0, ms) % ends[ends.length - 1];
  let lo = 0, hi = ends.length - 1;
  while (lo < hi) { const mid = (lo+hi) >>> 1; if (ends[mid] <= time) lo = mid+1; else hi = mid; }
  return {index: lo, ms: lo ? ends[lo-1] : 0};
}
