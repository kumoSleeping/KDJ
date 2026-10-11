/**
 * The row list (RowList.css): a virtualized stack of independently placed rows, on
 * @tanstack/react-virtual. Both lists of the workspace build on this — the local track list
 * (library/TrackTable.tsx) and the search results (download/ResultTable.tsx).
 *
 * The WebView scrolls on its own thread and tells the page afterwards; the virtualizer renders
 * the rows for the offset it is told in that same frame (flushSync), and keeps about a screen
 * and a half of rows ready on either side so a scroll, back or on, finds its rows built. Nothing
 * else happens in a scroll frame: no row is measured, no layout is read, no attribute is put
 * on an ancestor. A fast fling can still outrun the frames that build rows; the rows that are
 * built after the viewport reached their places then arrive one after another
 * (listArrival.ts, "chase") instead of popping in by the frame.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";

/** Rows kept rendered beyond either edge of the viewport, at least; the lists ask for about a screen and a half. */
export const ROW_LIST_OVERSCAN = 12;
/** Screens of rows kept rendered beyond either edge of the viewport: a scroll back finds its rows built. */
export const ROW_LIST_OVERSCAN_SCREENS = 1.5;
export function rowListOverscan(screenRows: number): number {
  return Math.max(ROW_LIST_OVERSCAN, Math.ceil(ROW_LIST_OVERSCAN_SCREENS * screenRows));
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

export interface RowListOptions {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Rows in the list. */
  count: number;
  /** The height of a row (the measured one in a list whose rows are measured). */
  rowHeight: number;
  /** A block's estimated height, when blocks hold more than one row; `rowHeight` otherwise. */
  estimateSize?(index: number): number;
  /** The height of the head that stands above the rows in the same scroll container. */
  headHeight: number;
  getKey(index: number): string | number;
  /** Rows are as tall as their contents and measured when they are mounted. */
  measured?: boolean;
  /** Rows (blocks) kept rendered beyond either edge; `rowListOverscan` of the screen by default. */
  overscan?: number;
}

/** The virtualizer of a row list. `rowHeight` is the estimate; call `measure()` when it changes. */
export function useRowList({ scrollerRef, count, rowHeight, estimateSize, headHeight, getKey, measured = false, overscan = ROW_LIST_OVERSCAN }: RowListOptions) {
  return useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: estimateSize ?? (() => rowHeight),
    overscan,
    getItemKey: getKey,
    scrollMargin: headHeight,
    scrollToFn: rowListScrollTo,
    // A measured list reads a row's height once, when it mounts; a fixed one never.
    measureElement: measured ? undefined : () => rowHeight,
  });
}

/**
 * How the scroll container is moving, as seen from the frames that reach the page.
 * `fast` is a fling: covers are not asked for while it lasts. `direction` is the sign of the
 * last travel. `moving` is true from the first scroll frame until the scroll has rested.
 */
export interface ScrollPace {
  speed: number;
  fast: boolean;
}
/** One wheel notch is a burst of a single frame; the speed is averaged over about this long. */
const SPEED_SMOOTHING_MS = 100;
/** px/ms. Above the first a scroll is fast; it stays fast until it falls below the second. */
const FAST_ENTER_SPEED = 3;
const FAST_EXIT_SPEED = 2;
/** This long without a scroll frame and the scroll has rested. */
export const SCROLL_REST_MS = 140;

export function scrollPace(previous: ScrollPace, travel: number, elapsedMs: number): ScrollPace {
  const elapsed = Math.max(1, elapsedMs);
  const keep = Math.exp(-elapsed / SPEED_SMOOTHING_MS);
  const speed = previous.speed * keep + (travel / elapsed) * (1 - keep);
  return { speed, fast: Math.abs(speed) > (previous.fast ? FAST_EXIT_SPEED : FAST_ENTER_SPEED) };
}
export const REST_PACE: ScrollPace = { speed: 0, fast: false };

export interface ScrollMotion {
  /** A fling is under way: re-rendered when it starts and when it ends. */
  fling: boolean;
  /** Read in effects: the sign of the last travel, and whether a scroll is under way. */
  motion: RefObject<{ direction: -1 | 1; moving: boolean }>;
}

/** Follows the scroll container's vertical offset; `onRest` is called when a scroll has rested. */
export function useScrollMotion(scrollerRef: RefObject<HTMLElement | null>, onRest: () => void): ScrollMotion {
  const [fling, setFling] = useState(false);
  const motion = useRef<{ direction: -1 | 1; moving: boolean }>({ direction: 1, moving: false });
  const restRef = useRef(onRest);
  restRef.current = onRest;
  const flingRef = useRef(false);
  const setFlingOnce = useCallback((next: boolean) => {
    if (flingRef.current === next) return;
    flingRef.current = next;
    setFling(next);
  }, []);
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    let pace = REST_PACE;
    let sampledAt = 0;
    let top = node.scrollTop;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const now = performance.now();
      const next = node.scrollTop;
      const travel = next - top;
      if (travel === 0) return;
      top = next;
      pace = scrollPace(pace, travel, sampledAt ? now - sampledAt : 16);
      sampledAt = now;
      motion.current = { direction: travel < 0 ? -1 : 1, moving: true };
      setFlingOnce(pace.fast);
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        pace = REST_PACE;
        sampledAt = 0;
        motion.current = { ...motion.current, moving: false };
        setFlingOnce(false);
        restRef.current();
      }, SCROLL_REST_MS);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (idle !== null) clearTimeout(idle);
    };
  }, [scrollerRef, setFlingOnce]);
  return { fling, motion };
}
