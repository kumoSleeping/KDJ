/**
 * The row list (RowList.css): a virtualized stack of independently placed rows, on
 * @tanstack/react-virtual. Both lists of the workspace build on this — the local track list
 * (library/TrackTable.tsx) and the search results (download/ResultTable.tsx).
 *
 * The WebView scrolls on its own thread, showing tiles the page's main thread painted ahead of
 * time. Every change to the scrolled content invalidates tiles, and every millisecond the main
 * thread spends while the scroll runs is a millisecond it does not paint the tiles the scroll is
 * heading for: a page that renders on every scroll frame shows blank where it has not painted.
 * So the rows are not re-rendered by the frame. A list of a few hundred rows is rendered whole
 * and the DOM does not change while it scrolls at all. A long list keeps three screens of rows
 * beyond either edge of the viewport and moves that window only once a whole screen has been
 * travelled, without flushSync, so the rows that come and go do so two screens from view.
 *
 * That is how a list is left to the WebView. In WebKit a list may scroll itself instead (`own`),
 * and then it is the other way round, for two things that are WebKit's own:
 * - It paints an overflow container about one tile beyond its viewport, so a fling it performs on
 *   its own thread runs past what is painted whatever the page does.
 * - Every box that clips its overflow (each cell with its ellipsis) is a layer, and every scroll
 *   and every tile it paints walks all the layers in the container (RenderBox::requiresLayer,
 *   RenderLayer::recursiveUpdateLayerPositionsAfterScroll): two thousand rows built whole are
 *   twenty thousand layers, and the frames of a scroll take tens of milliseconds each with
 *   React doing nothing.
 * So such a list takes the wheel and moves itself (`ownWheel`), keeps only the rows around the
 * viewport, and renders the rows a scroll reaches in the event that reports it. Its container is
 * `overflow: hidden` (`data-own-scroll`, RowList.css): WebKit gives only an `auto` or `scroll`
 * container a node on its scrolling thread (`RenderBox::scrollsOverflowY`,
 * `RenderLayerScrollableArea::canUseCompositedScrolling`), and a written offset is handed to that
 * thread at once (`AsyncScrollingCoordinator::requestScrollToPosition`), which moves the tiles
 * before the page has painted the ones it is heading for. A hidden container is scrolled by the
 * main thread: the scroll, the rows and the tiles they need are committed together, when the
 * page is late the list stands still for that frame, and it is never blank. The wheel, the scroll
 * handles and the page keys (`ownKeys`) are then the page's to do.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualizerOptions } from "@tanstack/react-virtual";
import { buildsAhead, scrollTopTo, wheelPixels } from "../../lib/wheelScroll";

/**
 * Lists up to this many rows (blocks) are rendered whole: the window around the viewport comes
 * first, then the rest a chunk at a time between frames, until nothing is left to build and the
 * DOM never changes while the list scrolls.
 */
export const ROW_LIST_WHOLE = 3000;
const GROW_CHUNK = 250;
const GROW_PAUSE_MS = 16;
/** Screens of rows kept rendered beyond either edge of the viewport of a long list. */
export const ROW_LIST_OVERSCAN_SCREENS = 3;
/** The window of a long list moves once the scroll has travelled this much of the viewport. */
export const ROW_LIST_STEP_SCREENS = 1;
/** This long without a scroll frame and the scroll has rested. */
export const SCROLL_REST_MS = 150;
/** Rows kept beyond either edge of the viewport of a list that scrolls itself, at the least. */
const OWN_OVERSCAN_ROWS = 8;
/** A wheel event this long after the last one starts another gesture. */
const WHEEL_GESTURE_MS = 120;
/** The travel after which a wheel gesture is taken to run along one axis. */
const WHEEL_AXIS_PX = 4;
/** A wheel that reports lines is taken to mean this many pixels a line, as over the scroll handles (scrollPills.ts). */
const WHEEL_LINE_PX = 16;
/**
 * The keys that scroll a container by a page or to an end, which a hidden container no longer
 * answers itself. Not Space: it is the player's (usePlayerShortcuts) and never scrolled a list
 * here; both listen on the window, so which of them got it would depend on which mounted first.
 */
const PAGE_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

/** How many rows (blocks) to keep beyond either edge of the viewport. */
export function rowListOverscan(screenRows: number): number {
  return Math.ceil(ROW_LIST_OVERSCAN_SCREENS * Math.max(1, screenRows));
}

type RowVirtualizerOptions = VirtualizerOptions<HTMLElement, HTMLElement>;

/**
 * The virtualizer puts the list where it is asked to by writing the offset: no smooth scrolling
 * from the page (the WebView animates a wheel or a fling itself), and the same in a document
 * without `scrollTo` (the tests).
 */
const rowListScrollTo: RowVirtualizerOptions["scrollToFn"] = (offset, _options, instance) => {
  const element = instance.scrollElement;
  if (element) element.scrollTop = offset;
};

/**
 * The virtualizer hears of the scroll offset once a screen of travel, and when the scroll has
 * rested — not on every frame. Between those the rows kept beyond the viewport carry the scroll.
 */
const observeRowListOffset: RowVirtualizerOptions["observeElementOffset"] = (instance, cb) => {
  const element = instance.scrollElement;
  if (!element) return;
  let reported = element.scrollTop;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    idle = null;
    reported = element.scrollTop;
    cb(reported, false);
  };
  const onScroll = () => {
    const offset = element.scrollTop;
    const step = Math.max(1, (instance.scrollRect?.height ?? 0) * ROW_LIST_STEP_SCREENS);
    if (Math.abs(offset - reported) >= step) {
      reported = offset;
      cb(offset, true);
    }
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(settle, SCROLL_REST_MS);
  };
  cb(reported, false);
  element.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    element.removeEventListener("scroll", onScroll);
    if (idle !== null) clearTimeout(idle);
  };
};

/**
 * A list that scrolls itself: the virtualizer hears of every scroll in the event that reports it,
 * and (useFlushSync) the rows for it are rendered there, before the frame is painted. A scroll
 * the page writes itself is heard of before it is written (`scrollTopTo`).
 */
const observeOwnOffset: RowVirtualizerOptions["observeElementOffset"] = (instance, cb) => {
  const element = instance.scrollElement;
  if (!element) return;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const onScroll = () => {
    cb(element.scrollTop, true);
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; cb(element.scrollTop, false); }, SCROLL_REST_MS);
  };
  cb(element.scrollTop, false);
  element.addEventListener("scroll", onScroll, { passive: true });
  // A scroll the page is about to write (the wheel, the scroll handle) has its rows built first;
  // the scroll event that follows reports the same offset and renders nothing.
  const release = buildsAhead(element, (top) => cb(top, true));
  return () => {
    release();
    element.removeEventListener("scroll", onScroll);
    if (idle !== null) clearTimeout(idle);
  };
};

/**
 * WebKit (the macOS and Linux WebView, Safari): the engine in which a list scrolls itself (see
 * the head of this file). Chromium rasters far ahead of the viewport and a touch screen sends no
 * wheel, so the list is left to the WebView there.
 */
export function listScrollsItself(agent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /AppleWebKit\//.test(agent) && !/Chrom(e|ium)\/|Edg\/|Android/.test(agent);
}

/** Whether something between the wheel's target and the list scrolls on its own along that axis. */
function scrollsWithin(target: EventTarget | null, list: HTMLElement, vertical: boolean): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== list; node = node.parentElement) {
    const room = vertical ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
    if (room <= 1) continue;
    const style = getComputedStyle(node);
    const overflow = vertical ? style.overflowY : style.overflowX;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

/**
 * The list takes the wheel and moves itself. A gesture (a swipe with its momentum, a turn of a
 * wheel) runs along the axis it started on, as the WebView's own scrolling does, so a vertical
 * fling does not shake a list that is wider than its pane. A pinch and a wheel over something
 * that scrolls inside the list are left alone. Returns what takes the listener off.
 */
export function ownWheel(list: HTMLElement): () => void {
  let last = -Infinity;
  let axis: "x" | "y" | null = null;
  let travelX = 0;
  let travelY = 0;
  let inner: boolean | null = null;
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey) return;
    // When the system produced it, not when the page got to it: a late page does not split a gesture.
    if (event.timeStamp - last > WHEEL_GESTURE_MS) { axis = null; travelX = 0; travelY = 0; inner = null; }
    last = event.timeStamp;
    const page = event.deltaMode === 2;
    const delta = wheelPixels(event, WHEEL_LINE_PX, page ? list.clientWidth : 0, page ? list.clientHeight : 0);
    if (axis === null) {
      travelX += Math.abs(delta.x);
      travelY += Math.abs(delta.y);
      if (travelX + travelY >= WHEEL_AXIS_PX) axis = travelY >= travelX ? "y" : "x";
    }
    const vertical = axis === null ? Math.abs(delta.y) >= Math.abs(delta.x) : axis === "y";
    inner ??= scrollsWithin(event.target, list, vertical);
    if (inner) return;
    event.preventDefault();
    if (vertical) { if (delta.y) scrollTopTo(list, list.scrollTop + delta.y); }
    else if (delta.x) list.scrollLeft += delta.x;
  };
  list.addEventListener("wheel", onWheel, { passive: false });
  return () => list.removeEventListener("wheel", onWheel);
}

/**
 * The page keys of a list that scrolls itself: Page Up / Down, Home and End move it as the
 * engine would move an `auto` container, for the element that has the focus or, with none, for
 * the list the pointer last pressed in (as WebKit chooses the container of a key scroll).
 * A field keeps its keys.
 */
export function ownKeys(list: HTMLElement): () => void {
  let pressedWithin = false;
  const onPointerDown = (event: PointerEvent) => { pressedWithin = event.target instanceof Node && list.contains(event.target); };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !PAGE_KEYS.has(event.key)) return;
    const active = document.activeElement;
    const focused = active && active !== document.body ? active : null;
    if (focused ? !list.contains(focused) : !pressedWithin) return;
    if (focused instanceof HTMLElement && (focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return;
    // The engine's page step: the viewport less a line of context.
    const page = Math.max(list.clientHeight * 0.875, list.clientHeight - 40);
    const top = event.key === "Home" ? 0 : event.key === "End" ? list.scrollHeight
      : list.scrollTop + (event.key === "PageUp" ? -page : page);
    event.preventDefault();
    scrollTopTo(list, top);
  };
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("keydown", onKey);
  };
}

export interface RowListOptions {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Rows (blocks) in the list. */
  count: number;
  /** The height of a row (the measured one in a list whose rows are measured). */
  rowHeight: number;
  /** A block's estimated height, when blocks hold more than one row; `rowHeight` otherwise. */
  estimateSize?(index: number): number;
  /** The height of the head that stands above the rows in the same scroll container. */
  headHeight: number;
  /** Rows a screen holds: the window beyond the viewport is sized by it. */
  screenRows: number;
  getKey(index: number): string | number;
  /** Rows are as tall as their contents and measured when they are mounted. */
  measured?: boolean;
  /** Another list: a short one starts being built whole again. */
  resetKey?: unknown;
  /** Keep even a short task list windowed: page switches must not copy thousands of rows. */
  windowed?: boolean;
  /** In-memory scroll geometry retained when a page is unmounted. */
  initialOffset?: number;
  initialMeasurementsCache?: RowVirtualizerOptions["initialMeasurementsCache"];
  /**
   * The list scrolls itself (see the head of this file): it takes the wheel, is never built whole,
   * keeps half a screen of rows beyond either edge and renders in the scroll event.
   */
  own?: boolean;
}

/**
 * The virtualizer of a row list, and whether a short list has been built whole. `rowHeight` is
 * the estimate; call `measure()` when it changes.
 */
export function useRowList({ scrollerRef, count, rowHeight, estimateSize, headHeight, screenRows, getKey, measured = false, resetKey, own = false, windowed = false, initialOffset, initialMeasurementsCache }: RowListOptions) {
  const whole = !own && !windowed && count <= ROW_LIST_WHOLE;
  // Rows of a short list built beyond the window so far: [0, grown).
  const [grown, setGrown] = useState(0);
  const grownRef = useRef(0);
  grownRef.current = whole ? grown : 0;
  useEffect(() => { setGrown(0); }, [resetKey]);
  useEffect(() => {
    if (!whole || grown >= count) return;
    const timer = setTimeout(() => setGrown((built) => Math.min(count, built + GROW_CHUNK)), GROW_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [whole, grown, count]);
  const rangeExtractor = useCallback((range: Range) => {
    const window = defaultRangeExtractor(range);
    // A short list grows outward from the window, a chunk a tick, until it is whole: one run
    // of rows, never a gap (the body's padding stands in for what is not built).
    const grown = grownRef.current;
    if (grown === 0 || window.length === 0) return window;
    const first = Math.max(0, window[0] - grown);
    const last = Math.min(range.count - 1, window[window.length - 1] + grown);
    const indices: number[] = [];
    for (let index = first; index <= last; index += 1) indices.push(index);
    return indices;
    // The virtualizer keeps the indexes it extracted until the range or this function changes:
    // the function is another one for every chunk, or the chunk is not built before the next scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whole, grown]);
  useEffect(() => {
    const list = scrollerRef.current;
    if (!own || !list) return;
    // `overflow: hidden` (RowList.css): the container has no scrolling-thread node, see the head of this file.
    list.dataset.ownScroll = "";
    const wheel = ownWheel(list), keys = ownKeys(list);
    return () => { wheel(); keys(); delete list.dataset.ownScroll; };
  }, [own, scrollerRef]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: estimateSize ?? (() => rowHeight),
    overscan: own ? Math.max(OWN_OVERSCAN_ROWS, Math.ceil(screenRows / 2)) : rowListOverscan(screenRows),
    rangeExtractor,
    getItemKey: getKey,
    initialOffset,
    initialMeasurementsCache,
    scrollMargin: headHeight,
    scrollToFn: rowListScrollTo,
    observeElementOffset: own ? observeOwnOffset : observeRowListOffset,
    // Left to the WebView, nothing is flushed in a scroll frame: a render the window needs is an
    // ordinary one. A list that scrolls itself renders the rows of a scroll before it is painted.
    useFlushSync: own,
    // A measured list reads a block's height once, when it mounts; a fixed one never.
    measureElement: measured ? undefined : () => rowHeight,
  });
  return { virtualizer, whole, mounted: whole && grown >= count };
}

/**
 * The room the rows that are not built would take, above and below the built ones: the body's
 * padding, so the built rows lie at their places in the normal flow. `headHeight` is the
 * virtualizer's scrollMargin, which its offsets include.
 */
export function rowListPadding(items: readonly { start: number; end: number }[], totalSize: number, headHeight: number) {
  if (items.length === 0) return { paddingTop: 0, paddingBottom: Math.max(0, totalSize) };
  const first = items[0];
  const last = items[items.length - 1];
  return {
    paddingTop: Math.max(0, first.start - headHeight),
    paddingBottom: Math.max(0, totalSize - (last.end - headHeight)),
  };
}

/**
 * The scroll as the page sees it, read in effects: the offset of the last scroll frame, the
 * sign of its travel, and whether a scroll is under way (from the first frame until it rests).
 * Reading the offset in the scroll event costs nothing; reading it in an effect would force a
 * layout.
 */
export interface ScrollMotion {
  offset: number;
  direction: -1 | 1;
  moving: boolean;
}

/**
 * Follows the scroll container; `onRest` is called when a scroll has rested, `onScroll` on every
 * scroll frame after the motion is updated (for a list waiting to present itself at an offset:
 * the virtualizer renders nothing for a small scroll, so the list asks for a render itself).
 */
export function useScrollMotion(scrollerRef: RefObject<HTMLElement | null>, onRest: () => void, onScroll?: () => void): RefObject<ScrollMotion> {
  const motion = useRef<ScrollMotion>({ offset: 0, direction: 1, moving: false });
  const restRef = useRef(onRest);
  restRef.current = onRest;
  const scrollRef = useRef(onScroll);
  scrollRef.current = onScroll;
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    motion.current = { ...motion.current, offset: node.scrollTop };
    let idle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const next = node.scrollTop;
      const travel = next - motion.current.offset;
      if (travel === 0) return;
      motion.current = { offset: next, direction: travel < 0 ? -1 : 1, moving: true };
      scrollRef.current?.();
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        motion.current = { ...motion.current, moving: false };
        restRef.current();
      }, SCROLL_REST_MS);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (idle !== null) clearTimeout(idle);
    };
  }, [scrollerRef]);
  return motion;
}
