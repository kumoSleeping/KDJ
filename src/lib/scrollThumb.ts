/**
 * The handle is a position mark, not a second column: it shrinks with the content as usual but
 * never grows past this, so a list a little longer than its window does not get a bar most of
 * the window long.
 */
export const SCROLL_THUMB_MAX = 72;

/** Geometry independent of DOM; the hit target can be wider than the painted thumb. */
export function scrollThumb(viewport: number, content: number, startInset: number, endInset: number, minLength = 44) {
  const extent = Math.max(0, content - viewport);
  const rail = Math.max(0, viewport - startInset - endInset);
  const length = Math.min(rail, SCROLL_THUMB_MAX, Math.max(minLength, rail * viewport / Math.max(1, content)));
  return { extent, length, travel: Math.max(0, rail - length), inset: startInset };
}
export function thumbPosition(offset: number, extent: number, travel: number): number {
  return extent > 0 ? Math.min(1, Math.max(0, offset / extent)) * travel : 0;
}
export function scrollFromThumb(position: number, extent: number, travel: number): number {
  return travel > 0 ? Math.min(1, Math.max(0, position / travel)) * extent : 0;
}
