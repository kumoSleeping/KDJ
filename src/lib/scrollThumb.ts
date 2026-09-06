/** Geometry independent of DOM; the hit target can be wider than the painted thumb. */
export function scrollThumb(viewport: number, content: number, startInset: number, endInset: number) {
  const extent = Math.max(0, content - viewport);
  const rail = Math.max(0, viewport - startInset - endInset);
  const length = Math.min(rail, Math.max(44, rail * viewport / Math.max(1, content)));
  return { extent, length, travel: Math.max(0, rail - length), inset: startInset };
}
export function thumbPosition(offset: number, extent: number, travel: number): number {
  return extent > 0 ? Math.min(1, Math.max(0, offset / extent)) * travel : 0;
}
export function scrollFromThumb(position: number, extent: number, travel: number): number {
  return travel > 0 ? Math.min(1, Math.max(0, position / travel)) * extent : 0;
}
