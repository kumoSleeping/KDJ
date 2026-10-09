export interface LibraryViewportInput {
  total: number; pending: number; top: number; height: number; rowHeight: number; headerHeight: number;
}
/** Screens of rows kept rendered beyond each edge of the viewport. */
const OVERSCAN_SCREENS = 2;
/** The rendered window moves in steps of this many rows, so most scroll frames reuse it as is. */
const WINDOW_STEP = 8;

/** The scroll offset the rendered window is computed from: it only changes once per step. */
export function libraryWindowTop(scrollTop: number, rowHeight: number): number {
  const step = Math.max(1, rowHeight) * WINDOW_STEP;
  return Math.floor(Math.max(0, scrollTop) / step) * step;
}

/**
 * How the scroll container is moving, as seen from the frames that reach the page.
 *
 * The WebView scrolls on its own thread and tells the page afterwards. Rows can be built for a
 * scroll at reading speed; a fast one runs past them, so while it lasts the table builds none and
 * shows painted stand-ins instead (see libraryStandIns).
 */
export interface LibraryScrollPace {
  /** Smoothed signed speed, px/ms. */
  speed: number;
  /** Speed over the last frame alone: a flick is at full speed before the smoothed one says so. */
  instant: number;
  fast: boolean;
}
export const LIBRARY_REST_PACE: LibraryScrollPace = { speed: 0, instant: 0, fast: false };
/** One wheel notch is a burst of a single frame; the speed is averaged over about this long. */
const SPEED_SMOOTHING_MS = 100;
/** px/ms. Above the first a scroll is fast; it stays fast until it falls below the second. */
const FAST_ENTER_SPEED = 3;
const FAST_EXIT_SPEED = 2;
/** Screens travelled between two frames (a dragged handle, or a stalled page) that are fast at once. */
const JUMP_SCREENS = 2;

export function libraryScrollPace(previous: LibraryScrollPace, travel: number, elapsedMs: number, viewHeight: number): LibraryScrollPace {
  const elapsed = Math.max(1, elapsedMs);
  const keep = Math.exp(-elapsed / SPEED_SMOOTHING_MS);
  const speed = previous.speed * keep + (travel / elapsed) * (1 - keep);
  const jump = Math.abs(travel) >= JUMP_SCREENS * Math.max(1, viewHeight);
  return { speed, instant: travel / elapsed, fast: jump || Math.abs(speed) > (previous.fast ? FAST_EXIT_SPEED : FAST_ENTER_SPEED) };
}

export function libraryViewport(input: LibraryViewportInput) {
  const rowHeight = Math.max(1, input.rowHeight);
  const height = Math.max(rowHeight, input.height - input.headerHeight);
  const count = Math.max(0, input.total + input.pending);
  const maxTop = Math.max(0, count * rowHeight - height);
  const top = Math.min(maxTop, Math.max(0, input.top));
  const screen = Math.max(1, Math.ceil(height / rowHeight));
  const visibleStart = Math.min(count, Math.floor(top / rowHeight));
  // `top` may trail the real offset by up to one step (see libraryWindowTop).
  const visibleEnd = Math.min(count, Math.ceil((top + height) / rowHeight) + WINDOW_STEP);
  const start = Math.max(0, visibleStart - OVERSCAN_SCREENS * screen);
  const end = Math.min(count, visibleEnd + OVERSCAN_SCREENS * screen);
  const trackIndex = (index: number) => Math.min(input.total, Math.max(0, index - input.pending));
  return { top, maxTop, count, start, end, visibleStart, visibleEnd,
    trackStart: trackIndex(Math.max(input.pending, start)), trackEnd: trackIndex(end),
    visibleTrackStart: trackIndex(visibleStart), visibleTrackEnd: trackIndex(visibleEnd),
    // Rows are demanded a screen before they are rendered; the rest of the library follows in
    // the background fill.
    fetchStart: trackIndex(Math.max(0, start - screen)),
    fetchEnd: trackIndex(Math.min(count, end + screen)),
  };
}

export function restoreLibraryAnchor(ids: readonly number[], anchorId: number | null, fallbackIndex: number,
  rowOffset: number, rowHeight: number, pending: number): number {
  const found = anchorId === null ? -1 : ids.indexOf(anchorId);
  const index = found >= 0 ? found : Math.min(Math.max(0, fallbackIndex), Math.max(0, ids.length - 1));
  return (pending + index) * rowHeight + Math.min(Math.max(0, rowOffset), rowHeight - 1);
}
