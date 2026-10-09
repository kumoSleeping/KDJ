export interface LibraryViewportInput {
  total: number; pending: number; top: number; height: number; rowHeight: number; headerHeight: number;
  /** Direction of a fast scroll (see libraryScrollPace); 0 or omitted for a resting or slow table. */
  direction?: -1 | 0 | 1;
  /** The last frame travelled past everything that was rendered. */
  jump?: boolean;
  /** Pixels by which a jump aims past `top` (see LibraryScrollPace.lead). */
  lead?: number;
}
/** Screens of rows kept rendered beyond each edge of a resting or slowly moving viewport. */
const OVERSCAN_SCREENS = 2;
/** A fast scroll gives up a screen behind it for a third one ahead: the row count stays the same. */
const FAST_BEHIND_SCREENS = 1;
const FAST_AHEAD_SCREENS = 3;
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
 * The WebView scrolls on its own thread and tells the page afterwards, so the page is always
 * rendering rows for an offset that is already on screen. What it renders therefore follows the
 * pace: a fast scroll spends its rows ahead of the motion and mounts them without their costly
 * controls, and a frame that lands beyond everything rendered renders only what is under it.
 */
export interface LibraryScrollPace {
  /** Smoothed signed speed, px/ms. */
  speed: number;
  /** Direction of a fast scroll; 0 while resting or slow. */
  direction: -1 | 0 | 1;
  fast: boolean;
  jump: boolean;
  /**
   * Signed pixels between the offset the page was told and the one its rows will be shown at.
   * Non-zero only while the scrolling thread outruns the page jump after jump: rows rendered for
   * the reported offset would then never be seen, so they are rendered a frame of travel ahead.
   */
  lead: number;
}
export const LIBRARY_REST_PACE: LibraryScrollPace = { speed: 0, direction: 0, fast: false, jump: false, lead: 0 };
/** One wheel notch is a burst of a single frame; the speed is averaged over about this long. */
const SPEED_SMOOTHING_MS = 100;
/** px/ms. Above the first a scroll is fast; it stays fast until it falls below the second. */
const FAST_ENTER_SPEED = 3;
const FAST_EXIT_SPEED = 1.2;
/** Screens travelled between two frames (a dragged handle, or a stalled page) that count as a jump. */
const JUMP_SCREENS = 2;
const MAX_LEAD_SCREENS = 8;

/**
 * `threaded`: the scroll is being performed by the WebView's scrolling thread (wheel, trackpad,
 * touch), so the reported offset is already behind. A scroll the page performs itself (handle,
 * keyboard, locate) is exactly where it says.
 */
export function libraryScrollPace(previous: LibraryScrollPace, travel: number, elapsedMs: number, viewHeight: number,
  threaded = false): LibraryScrollPace {
  const elapsed = Math.max(1, elapsedMs);
  const keep = Math.exp(-elapsed / SPEED_SMOOTHING_MS);
  const speed = previous.speed * keep + (travel / elapsed) * (1 - keep);
  const jump = Math.abs(travel) >= JUMP_SCREENS * Math.max(1, viewHeight);
  const fast = jump || Math.abs(speed) > (previous.fast ? FAST_EXIT_SPEED : FAST_ENTER_SPEED);
  const direction = !fast ? 0 : travel > 0 ? 1 : travel < 0 ? -1 : previous.direction;
  // One jump may be a single stall of the page; a second one the same way means the page will be
  // as far behind again by the time this frame is shown.
  const limit = MAX_LEAD_SCREENS * Math.max(1, viewHeight);
  const lead = threaded && jump && previous.jump && direction === previous.direction
    ? Math.min(limit, Math.max(-limit, travel)) : 0;
  return { speed, direction, fast, jump, lead };
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
  const direction = input.direction ?? 0;
  let start: number;
  let end: number;
  if (input.jump && input.lead) {
    // The viewport will have moved on by `lead` when these rows are shown: render around there.
    const aim = Math.min(maxTop, Math.max(0, top + input.lead));
    const margin = Math.ceil(screen / 2);
    start = Math.floor(aim / rowHeight) - margin;
    end = Math.ceil((aim + height) / rowHeight) + WINDOW_STEP + margin;
  } else {
    // A jump landed past the rendered rows and the next frame may do the same: render what is
    // under it and one screen on, so the viewport is filled as soon as possible.
    const [behind, ahead] = input.jump ? [0, screen]
      : direction ? [FAST_BEHIND_SCREENS * screen, FAST_AHEAD_SCREENS * screen]
      : [OVERSCAN_SCREENS * screen, OVERSCAN_SCREENS * screen];
    start = visibleStart - (direction < 0 ? ahead : behind);
    end = visibleEnd + (direction < 0 ? behind : ahead);
  }
  start = Math.min(count, Math.max(0, start));
  end = Math.min(count, Math.max(start, end));
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
