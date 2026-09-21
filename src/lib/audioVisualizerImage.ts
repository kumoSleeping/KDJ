import type { VisualizerImageTransform } from "../types/audioVisualizer";
import { visualizerCropExtent } from "./audioVisualizerScene";

export type VisualizerImage = HTMLImageElement | ImageBitmap | HTMLCanvasElement;
export function visualizerSurface(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D 不可用");
  return [canvas, context];
}

/** Static work only: crop, mirror and rotate when an asset or its settings change. */
export function fitVisualizerImage(image: VisualizerImage, transform: VisualizerImageTransform, width: number, height: number): HTMLCanvasElement {
  const iw = "naturalWidth" in image ? image.naturalWidth : image.width;
  const ih = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!iw || !ih || iw * ih > 32_000_000) throw new Error("图片未加载或尺寸过大");
  const [cw, ch] = visualizerCropExtent(width, height, transform.rotation_deg), aspect = cw / ch;
  const sw = Math.max(1, Math.floor(Math.min(iw, ih * aspect) / transform.zoom));
  const sh = Math.max(1, Math.floor(Math.min(ih, iw / aspect) / transform.zoom));
  let sx = Math.floor((iw - sw) * transform.focus_x), sy = Math.floor((ih - sh) * transform.focus_y);
  const [crop, context] = visualizerSurface(cw, ch);
  if (transform.mirror_x) sx = iw - sx - sw;
  if (transform.mirror_y) sy = ih - sy - sh;
  context.translate(transform.mirror_x ? cw : 0, transform.mirror_y ? ch : 0);
  context.scale(transform.mirror_x ? -1 : 1, transform.mirror_y ? -1 : 1);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, cw, ch);
  let rotated = crop;
  if (transform.rotation_deg !== 0) {
    const angle = transform.rotation_deg * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    const [target, rc] = visualizerSurface(Math.ceil(cw * cos + ch * sin), Math.ceil(cw * sin + ch * cos));
    rc.translate(target.width / 2, target.height / 2); rc.rotate(angle);
    rc.drawImage(crop, -cw / 2, -ch / 2); rotated = target;
  }
  const [result, output] = visualizerSurface(width, height);
  output.drawImage(rotated, Math.floor((rotated.width - width) / 2), Math.floor((rotated.height - height) / 2), width, height, 0, 0, width, height);
  if (transform.blur > 0) {
    const padding = Math.ceil(transform.blur * 4);
    const [padded, pc] = visualizerSurface(width + padding * 2, height + padding * 2);
    const axis = (length: number) => [[0, 1, 0, padding], [0, length, padding, length], [length - 1, 1, length + padding, padding]];
    // Extend border pixels before blur instead of adding transparent margins.
    for (const [x, w, dx, dw] of axis(width)) for (const [y, h, dy, dh] of axis(height)) pc.drawImage(result, x, y, w, h, dx, dy, dw, dh);
    output.clearRect(0, 0, width, height); output.filter = `blur(${transform.blur}px)`;
    output.drawImage(padded, -padding, -padding); output.filter = "none";
  }
  return result;
}
