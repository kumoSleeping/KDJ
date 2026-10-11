export interface WheelSample {
  deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean;
}

/** Wheel delta in pixels. Shift turns a vertical-only wheel into a horizontal one. */
export function wheelPixels(sample: WheelSample, lineHeight: number, pageWidth: number, pageHeight: number): { x: number; y: number } {
  const unitX = sample.deltaMode === 1 ? lineHeight : sample.deltaMode === 2 ? pageWidth : 1;
  const unitY = sample.deltaMode === 1 ? lineHeight : sample.deltaMode === 2 ? pageHeight : 1;
  const x = sample.deltaX * unitX;
  const y = sample.deltaY * unitY;
  return sample.shiftKey && !x ? { x: y, y: 0 } : { x, y };
}

/**
 * Scrollers that build what a scroll will show before the scroll is made (the row lists that
 * scroll themselves, common/rowList.ts). WebKit hands a scroll the page writes to its scrolling
 * thread at once, and the scroll event that would have the rows built comes a rendering update
 * later: the place is on show for a frame with nothing in it.
 */
const builders = new WeakMap<Element, (top: number) => void>();

/** `build` is called with the offset a scroll is about to be written to. Returns what ends that. */
export function buildsAhead(node: Element, build: (top: number) => void): () => void {
  builders.set(node, build);
  return () => { if (builders.get(node) === build) builders.delete(node); };
}

/**
 * Writes a scroller's vertical offset from an event handler, after what it shows there has been
 * built. Not for an effect or a render: the build is a synchronous render of its own.
 */
export function scrollTopTo(node: HTMLElement, top: number): void {
  const build = builders.get(node);
  if (build) {
    const to = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
    // A write that moves nothing sends no scroll event either: nothing would end the scroll it started.
    if (to !== node.scrollTop) build(to);
  }
  node.scrollTop = top;
}
