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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualizerOptions } from "@tanstack/react-virtual";

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
}

/**
 * The virtualizer of a row list, and whether a short list has been built whole. `rowHeight` is
 * the estimate; call `measure()` when it changes.
 */
export function useRowList({ scrollerRef, count, rowHeight, estimateSize, headHeight, screenRows, getKey, measured = false, resetKey }: RowListOptions) {
  const whole = count <= ROW_LIST_WHOLE;
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
  }, []);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: estimateSize ?? (() => rowHeight),
    overscan: rowListOverscan(screenRows),
    rangeExtractor,
    getItemKey: getKey,
    scrollMargin: headHeight,
    scrollToFn: rowListScrollTo,
    observeElementOffset: observeRowListOffset,
    // Nothing is flushed in a scroll frame: a render the window needs is an ordinary one.
    useFlushSync: false,
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
