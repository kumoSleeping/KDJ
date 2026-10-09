/**
 * Floating surfaces that share one order of depth: the drawer's panel and the floating media
 * window. Whichever was opened or touched last is drawn over the others. The order is handed to
 * each surface as `--kd-surface-z`, which its stylesheet uses for its z-index, so a state with
 * a depth of its own (a fullscreen picture) still wins.
 */
const BASE = 80;
const surfaces: HTMLElement[] = [];

export function raiseSurface(node: HTMLElement | null): void {
  if (!node) return;
  if (surfaces.at(-1) === node && node.style.getPropertyValue("--kd-surface-z")) return;
  const kept = surfaces.filter(surface => surface !== node && surface.isConnected);
  surfaces.length = 0;
  surfaces.push(...kept, node);
  surfaces.forEach((surface, index) => surface.style.setProperty("--kd-surface-z", String(BASE + index)));
}
