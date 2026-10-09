import { scrollFromThumb, scrollThumb, thumbPosition } from "./scrollThumb";
import { wheelPixels } from "./wheelScroll";

/**
 * One pair of floating scroll handles for every scroll container that has none of its own.
 *
 * Native scrollbars are hidden app-wide (design.css): they take a gutter out of narrow panels
 * and cannot be drawn alike in WebKit and Chromium. Instead of wrapping each list in a component,
 * this follows the container the user is scrolling, or whose edge the pointer is at, and lays the
 * handles over that edge. They live in the top layer, so no panel's overflow or stacking context
 * clips them, and they are shown only for scrolling the user does: a list that scrolls itself
 * (lyrics following the song) does not flash a handle.
 *
 * The track table keeps its own handles (OverlayScrollbars); both are drawn by `.kd-scroll-handle`.
 */

type Axis = "vertical" | "horizontal";
const AXES: readonly Axis[] = ["vertical", "horizontal"];
/** The hit strip of `.kd-scroll-handle`; the painted pill is narrower. */
const HIT = 14;
/** Smallest handle. The table's is larger because it is the only way through a long library. */
const MIN_LENGTH = 28;
/** The pointer this close to a container's edge brings its handle out. */
const EDGE_REACH = 18;
/** A handle stays this long after the last scroll. */
const LINGER_MS = 1100;
/** A scroll counts as the user's when it follows their input this closely. */
const INPUT_WINDOW_MS = 350;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "]);

type Metric = ReturnType<typeof scrollThumb>;

/**
 * Squash a handle against the end of its rail when a scroll arrives there. Returns the function
 * to call with each new offset; the first call only records where the handle starts.
 */
export function edgeBump(handle: HTMLElement): (offset: number, extent: number) => void {
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (offset, extent) => {
    const edge = extent <= 0 ? "" : offset <= 0.5 ? "start" : offset >= extent - 0.5 ? "end" : "";
    const arrived = last !== null && edge !== "" && edge !== last;
    last = edge;
    if (!arrived) return;
    if (timer !== null) clearTimeout(timer);
    handle.removeAttribute("data-bump");
    // Reading layout between the two writes restarts the animation for a second arrival.
    void handle.offsetWidth;
    handle.setAttribute("data-bump", edge);
    timer = setTimeout(() => { timer = null; handle.removeAttribute("data-bump"); }, 360);
  };
}

/** Which axes of `node` the user can scroll and a handle is worth showing for. */
function scrollableAxes(node: HTMLElement): Record<Axis, boolean> | null {
  if (node.dataset.kdScrollbar === "none") return null;
  // The track table draws its own.
  if (node.parentElement?.classList.contains("kd-overlay-scroll-host")) return null;
  const style = getComputedStyle(node);
  const scrolls = (value: string) => value === "auto" || value === "scroll";
  const vertical = scrolls(style.overflowY) && node.clientHeight >= 64 && node.scrollHeight > node.clientHeight + 1;
  // Chip rows and tab strips scroll sideways without a bar; only real panes get one.
  const horizontal = scrolls(style.overflowX) && node.clientHeight >= 120 && node.clientWidth >= 120
    && node.scrollWidth > node.clientWidth + 1;
  return vertical || horizontal ? { vertical, horizontal } : null;
}

function scrollableAncestor(start: EventTarget | null): HTMLElement | null {
  for (let node = start instanceof Element ? start : null; node && node !== document.documentElement; node = node.parentElement) {
    if (node instanceof HTMLElement && node !== document.body && scrollableAxes(node)) return node;
  }
  return null;
}

/** Installs the handles for this document. Returns the function that removes them. */
export function installScrollPills(): () => void {
  const layer = document.createElement("div");
  layer.className = "kd-overlay-scrollbars kd-scroll-float";
  layer.setAttribute("aria-hidden", "true");
  // The top layer, where supported: above dialogs and menus opened before a scroll in them.
  layer.setAttribute("popover", "manual");
  const handles = {} as Record<Axis, HTMLDivElement>;
  const bumps = {} as Record<Axis, (offset: number, extent: number) => void>;
  for (const axis of AXES) {
    const handle = document.createElement("div");
    handle.className = "kd-scroll-handle";
    handle.dataset.axis = axis;
    handle.style.display = "none";
    layer.append(handle);
    handles[axis] = handle;
    bumps[axis] = edgeBump(handle);
  }
  document.body.append(layer);
  const raise = () => {
    if (typeof layer.showPopover !== "function") return;
    try {
      if (layer.matches(":popover-open")) layer.hidePopover();
      layer.showPopover();
    } catch { /* Not connected yet, or the document is going away. */ }
  };
  raise();

  let active: HTMLElement | null = null;
  let metrics: Record<Axis, Metric | null> = { vertical: null, horizontal: null };
  let frame = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let dragging: Axis | null = null;
  let near = false;
  let over = false;
  let input: { target: EventTarget | null; at: number } = { target: null, at: -Infinity };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;

  const paint = () => {
    frame = 0;
    const node = active;
    if (!node) return;
    if (!node.isConnected) { dismiss(); return; }
    const rect = node.getBoundingClientRect();
    const left = rect.left + node.clientLeft;
    const top = rect.top + node.clientTop;
    for (const axis of AXES) {
      const handle = handles[axis];
      const metric = metrics[axis];
      if (!metric || metric.travel <= 0) { handle.style.display = "none"; continue; }
      const offset = axis === "vertical" ? node.scrollTop : node.scrollLeft;
      const along = metric.inset + thumbPosition(offset, metric.extent, metric.travel);
      const x = axis === "vertical" ? left + node.clientWidth - HIT : left + along;
      const y = axis === "vertical" ? top + along : top + node.clientHeight - HIT;
      handle.style.display = "";
      handle.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      handle.style[axis === "vertical" ? "height" : "width"] = `${metric.length}px`;
      bumps[axis](offset, metric.extent);
    }
  };
  const schedulePaint = () => { if (!frame) frame = requestAnimationFrame(paint); };
  function measure(): void {
    const node = active;
    if (!node) return;
    const axes = node.isConnected ? scrollableAxes(node) : null;
    if (!axes) { dismiss(); return; }
    metrics = {
      vertical: axes.vertical ? scrollThumb(node.clientHeight, node.scrollHeight, 3, axes.horizontal ? HIT : 3, MIN_LENGTH) : null,
      horizontal: axes.horizontal ? scrollThumb(node.clientWidth, node.scrollWidth, 3, axes.vertical ? HIT : 3, MIN_LENGTH) : null,
    };
    paint();
  }
  /** Something else is drawn over the edge the handle would sit on. */
  const covered = (node: HTMLElement) => {
    if (typeof document.elementFromPoint !== "function") return false;
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.right - node.clientLeft - HIT - 4, rect.top + rect.height / 2);
    return hit !== null && !node.contains(hit) && !layer.contains(hit);
  };
  const linger = () => {
    layer.dataset.visible = "true";
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (dragging || near || over) linger();
      else dismiss();
    }, LINGER_MS);
  };
  function dismiss(): void {
    delete layer.dataset.visible;
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    observer?.disconnect();
    active = null;
    near = false;
  }
  const activate = (node: HTMLElement) => {
    if (node !== active) {
      if (!scrollableAxes(node) || covered(node)) return;
      observer?.disconnect();
      active = node;
      observer?.observe(node);
      if (node.firstElementChild) observer?.observe(node.firstElementChild);
      for (const axis of AXES) bumps[axis] = edgeBump(handles[axis]);
      // A dialog or menu opened after the layer would otherwise cover it.
      if (node.closest("dialog, [popover]")) raise();
      measure();
      if (active !== node) return;
    }
    linger();
  };

  const noteInput = (event: Event) => {
    if (event.type === "keydown" && !SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
    input = { target: event.type === "keydown" ? document.activeElement : event.target, at: performance.now() };
  };
  const onScroll = (event: Event) => {
    const node = event.target;
    if (!(node instanceof HTMLElement)) return;
    if (node === active) {
      schedulePaint();
      if (dragging || performance.now() - input.at < INPUT_WINDOW_MS) linger();
      return;
    }
    // Only scrolling the user is doing, in the container they are doing it in.
    if (performance.now() - input.at >= INPUT_WINDOW_MS) return;
    if (!(input.target instanceof Node) || !(node.contains(input.target) || layer.contains(input.target))) return;
    activate(node);
  };

  let pointer: { x: number; y: number; target: EventTarget | null; resolved: EventTarget | null; hovered: HTMLElement | null } =
    { x: 0, y: 0, target: null, resolved: null, hovered: null };
  let pointerFrame = 0;
  const trackPointer = () => {
    pointerFrame = 0;
    if (dragging) return;
    over = pointer.target instanceof Node && layer.contains(pointer.target);
    if (over) { linger(); return; }
    if (pointer.target !== pointer.resolved) {
      pointer.resolved = pointer.target;
      pointer.hovered = scrollableAncestor(pointer.target);
    }
    near = false;
    const node = pointer.hovered;
    if (!node || !node.isConnected) return;
    const axes = node === active ? { vertical: !!metrics.vertical, horizontal: !!metrics.horizontal } : scrollableAxes(node);
    if (!axes) return;
    const rect = node.getBoundingClientRect();
    const right = rect.left + node.clientLeft + node.clientWidth;
    const bottom = rect.top + node.clientTop + node.clientHeight;
    const inside = pointer.x <= right && pointer.y <= bottom && pointer.x >= rect.left && pointer.y >= rect.top;
    near = inside && ((axes.vertical && pointer.x >= right - EDGE_REACH) || (axes.horizontal && pointer.y >= bottom - EDGE_REACH));
    if (near) activate(node);
  };
  const onPointerMove = (event: PointerEvent) => {
    // A press is a drag of something else (rows, a selection); touch has no hover.
    if (event.pointerType === "touch" || (event.buttons !== 0 && !dragging)) return;
    pointer = { ...pointer, x: event.clientX, y: event.clientY, target: event.target };
    if (!pointerFrame) pointerFrame = requestAnimationFrame(trackPointer);
  };

  const beginDrag = (axis: Axis, event: PointerEvent) => {
    const node = active;
    const metric = metrics[axis];
    if (event.button !== 0 || !node || !metric) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = handles[axis];
    const pointerId = event.pointerId;
    const coordinate = (at: PointerEvent) => axis === "vertical" ? at.clientY : at.clientX;
    const start = coordinate(event);
    const initial = thumbPosition(axis === "vertical" ? node.scrollTop : node.scrollLeft, metric.extent, metric.travel);
    dragging = axis;
    layer.dataset.dragging = axis;
    linger();
    try { handle.setPointerCapture(pointerId); } catch { /* The window listeners below still follow the pointer. */ }
    const move = (at: PointerEvent) => {
      if (at.pointerId !== pointerId) return;
      at.preventDefault();
      const value = scrollFromThumb(initial + coordinate(at) - start, metric.extent, metric.travel);
      if (axis === "vertical") node.scrollTop = value;
      else node.scrollLeft = value;
      paint();
    };
    const end = (at: Event) => {
      if (at instanceof PointerEvent && at.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Already released. */ }
      dragging = null;
      delete layer.dataset.dragging;
      linger();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
  };
  const onLayerWheel = (event: WheelEvent) => {
    const node = active;
    if (!node) return;
    const delta = wheelPixels(event, 16, node.clientWidth, node.clientHeight);
    node.scrollLeft += delta.x;
    node.scrollTop += delta.y;
    input = { target: node, at: performance.now() };
    event.preventDefault();
  };
  const onResize = () => { if (active) measure(); };
  // No more pointer events will say that it left the handle.
  const onPointerGone = () => { over = false; near = false; };
  const starts = AXES.map(axis => {
    const start = (event: PointerEvent) => beginDrag(axis, event);
    handles[axis].addEventListener("pointerdown", start);
    return () => handles[axis].removeEventListener("pointerdown", start);
  });

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("wheel", noteInput, { capture: true, passive: true });
  document.addEventListener("touchmove", noteInput, { capture: true, passive: true });
  document.addEventListener("keydown", noteInput, { capture: true });
  document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  layer.addEventListener("wheel", onLayerWheel, { passive: false });
  document.documentElement.addEventListener("pointerleave", onPointerGone);
  window.addEventListener("blur", onPointerGone);
  window.addEventListener("resize", onResize);
  return () => {
    document.documentElement.removeEventListener("pointerleave", onPointerGone);
    window.removeEventListener("blur", onPointerGone);
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("wheel", noteInput, { capture: true });
    document.removeEventListener("touchmove", noteInput, { capture: true });
    document.removeEventListener("keydown", noteInput, { capture: true });
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    window.removeEventListener("resize", onResize);
    for (const stop of starts) stop();
    if (frame) cancelAnimationFrame(frame);
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    dismiss();
    layer.remove();
  };
}
