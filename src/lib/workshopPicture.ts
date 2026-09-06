import type { CompositionProject, WorkshopClip, WorkshopSource } from "../types/workshop";
import { isImageSource } from "./workshop";
/** Integer source crop and fitted geometry, shared with Rust's image export. */
export function pictureBox(p: CompositionProject, c: WorkshopClip, s: WorkshopSource) {
  const crop = c.picture.crop ?? [0,0,0,0];
  const left = Math.floor(s.width * crop[0]), top = Math.floor(s.height * crop[1]);
  const sw = Math.max(1, Math.floor(s.width * (1 - crop[0] - crop[2])));
  const sh = Math.max(1, Math.floor(s.height * (1 - crop[1] - crop[3])));
  const image = isImageSource(s);
  const w = Math.min(p.canvas.width, p.canvas.height * sw / sh) * c.picture.scale;
  const width = (image ? Math.max(1, Math.round(w)) : w) / p.canvas.width;
  const height = (image ? Math.max(1, Math.round(width * p.canvas.width * sh / sw)) : width * p.canvas.width * sh / sw) / p.canvas.height;
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
  return {width, height,
    x: Math.max(0, Math.min(1-rotatedWidth, c.picture.x-rotatedWidth/2)) + (rotatedWidth-width)/2,
    y: Math.max(0, Math.min(1-rotatedHeight, c.picture.y-rotatedHeight/2)) + (rotatedHeight-height)/2,
    left, top, sw, sh, rotation};
}
export function gifFrame(ends: number[] | undefined, ms: number): {index: number; ms: number} {
  if (!ends?.length) return {index:0, ms:0};
  const time = Math.max(0, ms) % ends[ends.length - 1];
  let lo = 0, hi = ends.length - 1;
  while (lo < hi) { const mid = (lo+hi) >>> 1; if (ends[mid] <= time) lo = mid+1; else hi = mid; }
  return {index: lo, ms: lo ? ends[lo-1] : 0};
}
