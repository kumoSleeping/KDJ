/**
 * Fast scrolling keeps only the real row numbers. Narrow, device-resolution canvas tiles live
 * in the scrolling content, ahead of the compositor; no fake text, artwork or blurred pattern.
 * As soon as cheap DOM row shells reach a tile, their identical numbers replace it at once.
 * Content is admitted separately by libraryRowRecovery, never by wiping away this layer.
 */
export const STAND_IN_TILE_ROWS = 24;
const BASE_SCREENS: readonly [number, number] = [1, 6];
const LEAD_MS = 500;
const MAX_LEAD_TILES = 64;
const TILES_PER_FRAME = 8;
const SPARE_PIXELS_MS = 4000;

export interface StandInPlanInput {
  /** Offset of the viewport's first row pixel, in pixels from the first row. */
  top: number;
  /** Height of the rows' part of the viewport. */
  height: number;
  rowHeight: number;
  /** Rows in the table, and the first of them that is a track (pending downloads come before). */
  count: number;
  first: number;
  /** Rows the table itself has rendered: [start, end). */
  windowStart: number;
  windowEnd: number;
  /** Direction of a fast scroll; 0 for a table that builds its own rows as it goes. */
  direction: -1 | 0 | 1;
  /** Pixels ahead of the viewport to cover, when that is further than the screens always covered. */
  lead?: number;
}
export interface StandInTile {
  index: number;
  /** Rows painted on the tile: [start, end). */
  start: number;
  end: number;
  /** The part of them that is shown; the rest lies under real rows of the table. */
  shownStart: number;
  shownEnd: number;
  /** Under the viewport: painted in this frame whatever the budget. */
  urgent: boolean;
}

/** The tiles to show for a viewport, most needed first. */
export function standInPlan(input: StandInPlanInput): StandInTile[] {
  const rowHeight = Math.max(1, input.rowHeight);
  const count = Math.max(0, input.count);
  const first = Math.min(count, Math.max(0, input.first));
  const screen = Math.max(1, Math.ceil(input.height / rowHeight));
  const visibleStart = Math.min(count, Math.max(first, Math.floor(Math.max(0, input.top) / rowHeight)));
  const visibleEnd = Math.min(count, Math.max(visibleStart, Math.ceil((Math.max(0, input.top) + input.height) / rowHeight)));
  const [behind, ahead] = input.direction ? BASE_SCREENS : [0, 0];
  const baseFrom = Math.max(first, visibleStart - (input.direction < 0 ? ahead : behind) * screen);
  const baseTo = Math.min(count, visibleEnd + (input.direction < 0 ? behind : ahead) * screen);
  const lead = input.direction ? Math.min(MAX_LEAD_TILES * STAND_IN_TILE_ROWS, Math.ceil(Math.max(0, input.lead ?? 0) / rowHeight)) : 0;
  const from = input.direction < 0 ? Math.max(first, Math.min(baseFrom, visibleStart - lead)) : baseFrom;
  const to = input.direction > 0 ? Math.min(count, Math.max(baseTo, visibleEnd + lead)) : baseTo;
  const tiles: StandInTile[] = [];
  for (let index = Math.floor(from / STAND_IN_TILE_ROWS); index * STAND_IN_TILE_ROWS < to; index += 1) {
    const start = Math.max(first, index * STAND_IN_TILE_ROWS);
    const end = Math.min(count, (index + 1) * STAND_IN_TILE_ROWS);
    // The table's rows cover a run of rows; what is left of a tile is its top, its bottom or all of it.
    const coveredFrom = Math.max(start, input.windowStart);
    const coveredTo = Math.min(end, input.windowEnd);
    let shownStart = start;
    let shownEnd = end;
    if (coveredFrom < coveredTo) {
      if (coveredFrom <= start && coveredTo >= end) continue;
      if (coveredFrom <= start) shownStart = coveredTo;
      else if (coveredTo >= end) shownEnd = coveredFrom;
      // Rows on both sides of the window: keep the side the viewport is on or nearer to.
      else if (visibleStart >= coveredTo || visibleEnd - coveredTo > coveredFrom - visibleStart) shownStart = coveredTo;
      else shownEnd = coveredFrom;
    }
    if (shownStart >= shownEnd) continue;
    tiles.push({ index, start, end, shownStart, shownEnd, urgent: shownStart < visibleEnd && shownEnd > visibleStart });
  }
  const middle = (visibleStart + visibleEnd) / 2;
  const distance = (tile: StandInTile) => {
    const offset = (tile.start + tile.end) / 2 - middle;
    // Rows the scroll is heading for come before rows it has left.
    return input.direction && Math.sign(offset) !== input.direction ? Math.abs(offset) * 4 : Math.abs(offset);
  };
  return tiles.sort((a, b) => Number(b.urgent) - Number(a.urgent) || distance(a) - distance(b));
}

/** How many of the rows [start, end) lie outside every one of `covered`. */
export function standInGap(covered: readonly (readonly [number, number])[], start: number, end: number): number {
  let bare = 0;
  for (let row = start; row < end; row += 1) if (!covered.some(([from, to]) => row >= from && row < to)) bare += 1;
  return bare;
}

interface Template {
  bodyTop: number;
  left: number;
  width: number;
  rightPadding: number;
  font: string;
  color: string;
  scale: number;
}
export interface StandInFrame {
  rowHeight: number;
  count: number;
  first: number;
  windowStart: number;
  windowEnd: number;
  direction: -1 | 0 | 1;
  speed: number;
}
export interface StandInStats {
  tiles: number;
  ms: number;
  worst: number;
}
export interface LibraryStandIns {
  ready(): boolean;
  update(frame: StandInFrame): (readonly [number, number])[];
  invalidate(): void;
  takeStats(): StandInStats;
  destroy(): void;
}
interface Tile {
  canvas: HTMLCanvasElement;
  index: number;
  painted: boolean;
  fresh: boolean;
  start: number;
  end: number;
  first: number;
  shown: string;
}

export function createLibraryStandIns(scroller: HTMLElement, layer: HTMLElement): LibraryStandIns {
  const tiles = new Map<number, Tile>();
  const spare: HTMLCanvasElement[] = [];
  let template: Template | null = null;
  let stale = true;
  let boxed = { count: -1, rowHeight: -1, shape: null as Template | null };
  let trim: ReturnType<typeof setTimeout> | null = null;
  let lastFrame: StandInFrame | null = null;
  let frameRequest = 0;
  let canDraw: boolean | null = null;
  let stats: StandInStats = { tiles: 0, ms: 0, worst: 0 };

  const measure = (): Template | null => {
    const body = scroller.querySelector<HTMLElement>("table.kd-table > tbody");
    // A number shell is enough: cold summaries do not prevent fast scrolling.
    const cell = body?.querySelector<HTMLElement>('tr:not([data-pending]) td[data-col="index"]')
      ?? scroller.querySelector<HTMLElement>('thead [data-col="index"]');
    if (!body || !cell) return null;
    const cellBox = cell.getBoundingClientRect();
    if (!(cellBox.width > 0)) return null;
    const box = scroller.getBoundingClientRect();
    const style = getComputedStyle(cell);
    return {
      bodyTop: body.getBoundingClientRect().top - box.top + scroller.scrollTop - scroller.clientTop,
      left: cellBox.left - box.left + scroller.scrollLeft - scroller.clientLeft,
      width: cellBox.width,
      rightPadding: parseFloat(style.paddingRight) || 0,
      font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      color: style.color,
      scale: Math.max(1, window.devicePixelRatio || 1),
    };
  };
  const release = (tile: Tile) => {
    tile.canvas.style.display = "none";
    spare.push(tile.canvas);
    tiles.delete(tile.index);
  };
  const obtain = (index: number): Tile => {
    const canvas = spare.pop() ?? layer.appendChild(document.createElement("canvas"));
    canvas.style.display = "none";
    canvas.style.clipPath = "";
    const tile: Tile = { canvas, index, painted: false, fresh: false, start: 0, end: 0, first: -1, shown: "none" };
    tiles.set(index, tile);
    return tile;
  };
  const keepOrTrim = () => {
    if (tiles.size) {
      if (trim !== null) clearTimeout(trim);
      trim = null;
    } else if (trim === null && spare.some(canvas => canvas.width > 0)) {
      trim = setTimeout(() => {
        trim = null;
        if (!tiles.size) for (const canvas of spare) { canvas.width = 0; canvas.height = 0; }
      }, SPARE_PIXELS_MS);
    }
  };
  const ready = () => {
    if (canDraw === null) {
      // Retained as a manual comparison switch; normal rendering never depends on it.
      try { canDraw = localStorage.getItem("kd-library-standins") !== "off" && Boolean(document.createElement("canvas").getContext("2d")); }
      catch { canDraw = false; }
    }
    if (!canDraw) return false;
    if (stale || !template) {
      const measured = measure();
      if (measured) {
        stale = false;
        if (!template || JSON.stringify(measured) !== JSON.stringify(template)) {
          template = measured;
          for (const tile of tiles.values()) tile.fresh = false;
        }
      }
    }
    return template !== null;
  };
  const paint = (tile: Tile, plan: StandInTile, frame: StandInFrame, shape: Template) => {
    const context = tile.canvas.getContext("2d");
    if (!context) return;
    const base = tile.index * STAND_IN_TILE_ROWS;
    const height = (plan.end - base) * frame.rowHeight;
    const pixelWidth = Math.max(1, Math.ceil(shape.width * shape.scale));
    const pixelHeight = Math.max(1, Math.ceil(height * shape.scale));
    if (tile.canvas.width !== pixelWidth || tile.canvas.height !== pixelHeight) {
      tile.canvas.width = pixelWidth;
      tile.canvas.height = pixelHeight;
    } else {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
    }
    context.setTransform(shape.scale, 0, 0, shape.scale, 0, 0);
    context.font = shape.font;
    context.fillStyle = shape.color;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let row = plan.start; row < plan.end; row += 1) {
      context.fillText(String(row - frame.first + 1), shape.width - shape.rightPadding,
        (row - base + 0.5) * frame.rowHeight);
    }
    tile.canvas.style.width = `${shape.width}px`;
    tile.canvas.style.height = `${height}px`;
    tile.canvas.style.transform = `translate(${shape.left}px, ${shape.bodyTop + base * frame.rowHeight}px)`;
    tile.painted = true;
    tile.fresh = true;
    tile.start = plan.start;
    tile.end = plan.end;
    tile.first = frame.first;
    stats.tiles += 1;
  };
  const update = (frame: StandInFrame): (readonly [number, number])[] => {
    const covered: (readonly [number, number])[] = [[frame.windowStart, frame.windowEnd]];
    lastFrame = frame;
    if (!ready() || !template) {
      for (const tile of [...tiles.values()]) release(tile);
      keepOrTrim();
      return covered;
    }
    const shape = template;
    const rowHeight = Math.max(1, frame.rowHeight);
    if (frame.count !== boxed.count || rowHeight !== boxed.rowHeight || shape !== boxed.shape) {
      const table = scroller.querySelector<HTMLElement>("table.kd-table");
      if (table) {
        // Never let a rounded canvas enlarge the scroll range or disturb bottom-edge bounce.
        layer.style.width = `${table.offsetLeft + table.offsetWidth}px`;
        layer.style.height = `${table.offsetTop + table.offsetHeight}px`;
      }
      if (rowHeight !== boxed.rowHeight) for (const tile of tiles.values()) tile.painted = false;
      boxed = { count: frame.count, rowHeight, shape };
    }
    const plan = standInPlan({
      top: scroller.scrollTop, rowHeight, lead: frame.direction ? Math.abs(frame.speed) * LEAD_MS : 0,
      height: Math.max(rowHeight, scroller.clientHeight - Math.max(0, shape.bodyTop)),
      count: frame.count, first: frame.first, windowStart: frame.windowStart, windowEnd: frame.windowEnd, direction: frame.direction,
    });
    const wanted = new Set(plan.map(tile => tile.index));
    for (const tile of [...tiles.values()]) if (!wanted.has(tile.index)) release(tile);
    const began = plan.length ? performance.now() : 0;
    let budget = TILES_PER_FRAME;
    let waiting = false;
    for (const item of plan) {
      const tile = tiles.get(item.index) ?? obtain(item.index);
      if (tile.start !== item.start || tile.end !== item.end || tile.first !== frame.first) tile.painted = false;
      if (!tile.painted || !tile.fresh) {
        if (item.urgent || budget > 0) {
          budget -= 1;
          paint(tile, item, { ...frame, rowHeight }, shape);
        } else waiting = true;
      }
      const clipTop = (item.shownStart - item.index * STAND_IN_TILE_ROWS) * rowHeight;
      const clipBottom = (item.end - item.shownEnd) * rowHeight;
      const shown = !tile.painted ? "none" : clipTop || clipBottom ? `inset(${clipTop}px 0 ${clipBottom}px 0)` : "all";
      if (shown !== tile.shown) {
        tile.shown = shown;
        tile.canvas.style.display = shown === "none" ? "none" : "";
        tile.canvas.style.clipPath = shown === "none" || shown === "all" ? "" : shown;
      }
      if (tile.painted) covered.push([item.shownStart, item.shownEnd]);
    }
    if (plan.length) {
      const spent = performance.now() - began;
      stats.ms += spent;
      stats.worst = Math.max(stats.worst, spent);
    }
    if (waiting && !frameRequest) frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (lastFrame) update(lastFrame);
    });
    keepOrTrim();
    return covered;
  };
  return {
    ready, update,
    invalidate() { stale = true; },
    takeStats() {
      const taken = stats;
      stats = { tiles: 0, ms: 0, worst: 0 };
      return taken;
    },
    destroy() {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      if (trim !== null) clearTimeout(trim);
      frameRequest = 0;
      trim = null;
      lastFrame = null;
      tiles.clear();
      spare.length = 0;
      layer.replaceChildren();
    },
  };
}
