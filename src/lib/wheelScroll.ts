/**
 * Wheel and trackpad scrolling applied by the page instead of the WebView's scrolling thread.
 *
 * A WebView scrolls an overflow container on its own thread and tells the page afterwards. A
 * virtual list then renders the rows for an offset that is already on screen, and whatever it
 * has not rendered yet shows as blank; no amount of overscan covers a fast flick. Here the page
 * takes the wheel delta, moves the container itself and lets the caller render in the same
 * frame, so the offset and its rows are always painted together. The OS still supplies trackpad
 * momentum as wheel events.
 */
export interface WheelScrollState {
  /** Unrounded offsets; a WebView may round `scrollTop`, which would swallow sub-pixel deltas. */
  top: number;
  left: number;
}

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
 * Take over wheel scrolling of `node`. `afterScroll` runs in the animation frame that moved the
 * container, before it is painted; `lineHeight` converts line-mode wheels.
 */
export function attachWheelScroll(
  node: HTMLElement,
  lineHeight: () => number,
  afterScroll: () => void,
): () => void {
  const state: WheelScrollState = { top: node.scrollTop, left: node.scrollLeft };
  let pendingX = 0;
  let pendingY = 0;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const x = pendingX;
    const y = pendingY;
    pendingX = 0;
    pendingY = 0;
    // Something else moved the container (handle drag, keyboard, restore): continue from there.
    if (Math.abs(node.scrollTop - state.top) >= 1) state.top = node.scrollTop;
    if (Math.abs(node.scrollLeft - state.left) >= 1) state.left = node.scrollLeft;
    if (y) {
      state.top = Math.min(Math.max(0, node.scrollHeight - node.clientHeight), Math.max(0, state.top + y));
      node.scrollTop = state.top;
    }
    if (x) {
      state.left = Math.min(Math.max(0, node.scrollWidth - node.clientWidth), Math.max(0, state.left + x));
      node.scrollLeft = state.left;
    }
    afterScroll();
  };
  const onWheel = (event: WheelEvent) => {
    // Ctrl+wheel is pinch zoom; a locked container (track drag in progress) must not move.
    if (event.defaultPrevented || event.ctrlKey || node.style.overflow === "hidden") return;
    const delta = wheelPixels(event, lineHeight(), node.clientWidth, node.clientHeight);
    if (!delta.x && !delta.y) return;
    event.preventDefault();
    pendingX += delta.x;
    pendingY += delta.y;
    if (!frame) frame = requestAnimationFrame(apply);
  };
  node.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    node.removeEventListener("wheel", onWheel);
    if (frame) cancelAnimationFrame(frame);
  };
}
