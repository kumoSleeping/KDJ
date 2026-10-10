/**
 * What the track table shows where a fast scroll has outrun its rows: bars, painted on canvases
 * that scroll with the table.
 *
 * The WebView scrolls the table on its own thread; the page learns the offset afterwards and can
 * only then build the rows for it. A real row is a dozen cells of DOM and costs milliseconds, so
 * a fast scroll runs past any amount of rows built ahead and shows blank space, and building them
 * faster by scrolling from the page instead makes the scroll itself wait. So the table stops
 * building rows while it is scrolled fast, and builds them once, where the scroll slows down;
 * there the rows run after the scroll and catch up with it (components/library/listArrival.ts).
 * Until then the list is a blur, and that is what is painted: a quiet bar where each text would
 * be, never the text. Nothing can be read at these speeds, and a copy of the list would only have
 * to be swapped for the real one.
 *
 * A canvas is a layer of its own, already drawn when the scrolling thread reaches it. How far
 * ahead the bars must reach is a matter of speed: a flick through a library runs at tens of
 * thousands of pixels a second, and a frame of the page that takes a tenth of a second is a dozen
 * screens of travel. A tile is one `drawImage` of a pattern drawn once, at a quarter of the
 * resolution, so half a second of travel can be covered in a frame.
 *
 * Where each bar goes, how long it may be and in which colour is measured from a real row, so the
 * bars follow the theme, the column layout and the two-line layout without knowing them.
 */
import { MOTION_MICRO_OUT_MS, prefersReducedMotion } from "./motion";

/** Rows per canvas. Tiles sit at fixed rows, so a tile is painted once and reused while in range. */
export const STAND_IN_TILE_ROWS = 24;
/**
 * Screens [behind, ahead] of the viewport of a fast scroll that are covered whatever its speed.
 * Without a direction only the viewport itself is covered, which the table's own rows normally do:
 * a resting or slowly scrolled table holds no canvas at all.
 */
const BASE_SCREENS: readonly [number, number] = [1, 6];
/** Stand-ins reach this much travel ahead of the viewport, at the current speed. */
const LEAD_MS = 500;
/** And no further than this many tiles: each one is a layer. */
const MAX_LEAD_TILES = 64;
/** Canvas pixels per CSS pixel: a bar has no detail to keep. */
const BARS_SCALE = 0.25;
/** Tiles out of sight a frame may paint; the ones under the viewport are painted whatever their number. */
const BARS_PER_FRAME = 16;
/** Canvases keep their pixels this long after the last stand-in was shown: the next flick reuses them. */
const SPARE_PIXELS_MS = 4000;
/** The attribute of a canvas that is fading out under the rows that caught up (design.css). */
export const STAND_IN_LEAVING_ATTR = "data-leaving";

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

/** A text of a real row: the bar that stands for it starts where the text is anchored. */
interface TemplateCell {
  align: "left" | "center" | "right";
  x: number;
  y: number;
  /** The room a text has from its anchor. */
  width: number;
  /** Horizontal extent of the cell: columns scrolled out sideways are skipped. */
  from: number;
  to: number;
  /** Font size in pixels: the height of the bar. */
  size: number;
  color: string;
}
interface Template {
  /** Content offsets of the first row inside the scroll container. */
  bodyTop: number;
  left: number;
  cells: TemplateCell[];
  /** The cover box of a row, drawn empty. */
  thumb: { x: number; y: number; width: number; height: number; radius: number; color: string } | null;
}

export interface StandInFrame {
  /**
   * The row height the table lays its unbuilt rows out with. Stand-ins use the same one, so a
   * stand-in sits exactly where the table will put the real row.
   */
  rowHeight: number;
  count: number;
  first: number;
  windowStart: number;
  windowEnd: number;
  /** Direction of a fast scroll, 0 otherwise (see StandInPlanInput). */
  direction: -1 | 0 | 1;
  /** Speed of the scroll, px/ms: how far ahead to reach. */
  speed: number;
}

export interface StandInStats {
  /** Tiles painted and the time spent painting, since the last reading. */
  bars: number;
  ms: number;
  /** The longest a single frame spent painting. */
  worst: number;
}

export interface LibraryStandIns {
  /** Whether stand-ins can be painted at all: a real row has been measured and a canvas is available. */
  ready(): boolean;
  /**
   * Shows the stand-ins for the container's current offset. Returns the runs of rows that now have
   * something to show: the table's own rows and every painted stand-in, each as [start, end).
   */
  update(frame: StandInFrame): (readonly [number, number])[];
  /**
   * The scroll has slowed down and the table has built its rows here. The stand-ins near the
   * viewport fade out over the rows as those arrive, the others go at once; until the fade is over
   * an `update` without a direction leaves them alone, and one with a direction (the next fling)
   * ends it. Returns whether anything is fading.
   */
  settle(): boolean;
  /** The layout, columns or theme may have changed: measure a real row again. */
  invalidate(): void;
  /** What painting cost since the last call. */
  takeStats(): StandInStats;
  destroy(): void;
}

interface Tile {
  canvas: HTMLCanvasElement;
  index: number;
  /** Shows rows where they belong. An unpainted tile is hidden. */
  painted: boolean;
  /** Painted for the current measurements and sideways offset. A stale tile stays on show until its turn. */
  fresh: boolean;
  start: number;
  end: number;
  shown: string;
}

function lastText(node: Node): Text | null {
  for (let child = node.lastChild; child; child = child.previousSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.nodeValue?.trim()) return child as Text;
    } else {
      const found = lastText(child);
      if (found) return found;
    }
  }
  return null;
}

function opaque(color: string): boolean {
  return Boolean(color) && color !== "transparent" && !/,\s*0\)$/.test(color);
}

/** A number in [0, 1) that is the same for the same row and column: the bars of a pattern vary like text does. */
function scatter(row: number, column: number): number {
  return ((Math.imul(row + 1, 73856093) ^ Math.imul(column + 1, 19349663)) >>> 0) % 1000 / 1000;
}

export function createLibraryStandIns(scroller: HTMLElement, layer: HTMLElement): LibraryStandIns {
  const tiles = new Map<number, Tile>();
  const spare: HTMLCanvasElement[] = [];
  let template: Template | null = null;
  let stale = true;
  let painted = { left: -1, width: -1 };
  /** What the layer's box was last taken for: it is the table's box, and clips the canvases to it. */
  let boxed = { count: -1, rowHeight: -1, shape: null as Template | null };
  /** The bars of one tile, drawn once and copied onto every tile. */
  let pattern: { canvas: HTMLCanvasElement; shape: Template; left: number; width: number; rowHeight: number } | null = null;
  let trim: ReturnType<typeof setTimeout> | null = null;
  /** Running while the tiles left on show fade out (see settle). */
  let leaving: ReturnType<typeof setTimeout> | null = null;
  let lastFrame: StandInFrame | null = null;
  let frameRequest = 0;
  let canDraw: boolean | null = null;
  let stats: StandInStats = { bars: 0, ms: 0, worst: 0 };

  const measure = (): Template | null => {
    const body = scroller.querySelector<HTMLTableSectionElement>("table.kd-table > tbody");
    // An ordinary row: not the selected or playing one (their own colours), nor one with a media mark before its title.
    const rows = Array.from(body?.querySelectorAll<HTMLTableRowElement>("tr[data-kd-track-id]") ?? []).slice(0, 40);
    const row = rows.find((candidate) => candidate.getAttribute("aria-selected") !== "true" && !candidate.dataset.playing
      && !candidate.dataset.focus && !candidate.querySelector(".kd-video-mark")) ?? rows[0];
    const range = document.createRange();
    if (!body || !row || typeof range.getBoundingClientRect !== "function") return null;
    const rowBox = row.getBoundingClientRect();
    if (!(rowBox.height > 0)) return null;
    const box = scroller.getBoundingClientRect();
    const cells: TemplateCell[] = [];
    for (const cell of Array.from(row.cells)) {
      const text = cell.dataset.col ? lastText(cell) : null;
      const holder = text?.parentElement;
      if (!text || !holder) continue;
      range.selectNodeContents(text);
      const textBox = range.getBoundingClientRect();
      if (!(textBox.height > 0)) continue;
      const style = getComputedStyle(holder);
      const cellStyle = getComputedStyle(cell);
      const cellBox = cell.getBoundingClientRect();
      const from = cellBox.left + (parseFloat(cellStyle.paddingLeft) || 0) - rowBox.left;
      const to = cellBox.right - (parseFloat(cellStyle.paddingRight) || 0) - rowBox.left;
      // How the element that holds the text places it tells where a longer or shorter one would sit.
      const placing = style.display.includes("flex") ? style.justifyContent : style.textAlign;
      const align = placing === "center" ? "center" : /^(right|end|flex-end)$/.test(placing) ? "right" : "left";
      const left = textBox.left - rowBox.left;
      const right = textBox.right - rowBox.left;
      cells.push({ align, from, to, y: textBox.top + textBox.height / 2 - rowBox.top,
        x: align === "center" ? (left + right) / 2 : align === "right" ? right : left,
        width: align === "center" ? to - from : align === "right" ? right - from : to - left,
        size: parseFloat(style.fontSize) || 12,
        // A chip inside the cell is tinted for its own row (the key colour); the cell's colour suits every row.
        color: holder === cell || holder.parentElement === cell ? style.color : cellStyle.color });
    }
    if (!cells.length) return null;
    const thumbNode = row.querySelector<HTMLElement>(".kd-thumb");
    const thumbBox = thumbNode?.getBoundingClientRect();
    const thumbStyle = thumbNode ? getComputedStyle(thumbNode) : null;
    return { bodyTop: body.getBoundingClientRect().top - box.top + scroller.scrollTop - scroller.clientTop,
      left: rowBox.left - box.left + scroller.scrollLeft - scroller.clientLeft, cells,
      thumb: thumbBox && thumbStyle && thumbBox.width > 0 && opaque(thumbStyle.backgroundColor)
        ? { x: thumbBox.left - rowBox.left, y: thumbBox.top - rowBox.top, width: thumbBox.width, height: thumbBox.height,
            radius: parseFloat(thumbStyle.borderTopLeftRadius) || 0, color: thumbStyle.backgroundColor }
        : null };
  };

  const release = (tile: Tile) => {
    tile.canvas.style.display = "none";
    tile.canvas.removeAttribute(STAND_IN_LEAVING_ATTR);
    tile.shown = "none";
    spare.push(tile.canvas);
    tiles.delete(tile.index);
  };
  const obtain = (index: number): Tile => {
    const canvas = spare.pop() ?? layer.appendChild(document.createElement("canvas"));
    const tile: Tile = { canvas, index, painted: false, fresh: false, start: 0, end: 0, shown: "" };
    canvas.style.display = "none";
    canvas.style.clipPath = "";
    tiles.set(index, tile);
    return tile;
  };
  /** Nothing on show: give the pixels back, but not before a next flick could have used them. */
  const keepOrTrim = () => {
    if (tiles.size) {
      if (trim !== null) clearTimeout(trim);
      trim = null;
    } else if (trim === null && spare.some((canvas) => canvas.width > 0)) {
      trim = setTimeout(() => {
        trim = null;
        if (tiles.size) return;
        for (const canvas of spare) { canvas.width = 0; canvas.height = 0; }
      }, SPARE_PIXELS_MS);
    }
  };
  const endLeaving = () => {
    if (leaving === null) return;
    clearTimeout(leaving);
    leaving = null;
    for (const tile of [...tiles.values()]) release(tile);
    keepOrTrim();
  };

  /** The bars of a full tile for these measurements, drawn once. */
  const barsPattern = (rowHeight: number, shape: Template, left: number, width: number) => {
    if (pattern && pattern.shape === shape && pattern.left === left && pattern.width === width && pattern.rowHeight === rowHeight) return pattern.canvas;
    const canvas = pattern?.canvas ?? document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    canvas.width = Math.max(1, Math.round(width * BARS_SCALE));
    canvas.height = Math.max(1, Math.round(STAND_IN_TILE_ROWS * rowHeight * BARS_SCALE));
    context.setTransform(BARS_SCALE, 0, 0, BARS_SCALE, (shape.left - left) * BARS_SCALE, 0);
    context.globalAlpha = 0.2;
    shape.cells.forEach((cell, column) => {
      // Columns scrolled out sideways are not painted; a sideways scroll repaints.
      if (shape.left + cell.to < left || shape.left + cell.from > left + width) return;
      context.fillStyle = cell.color;
      const thickness = Math.max(4, cell.size * 0.6);
      for (let row = 0; row < STAND_IN_TILE_ROWS; row += 1) {
        // A short cell (a number, a key) is mostly full; a long one holds a text of any length.
        const share = cell.width < 90 ? 0.55 + 0.35 * scatter(row, column) : 0.25 + 0.55 * scatter(row, column);
        const length = Math.max(8, cell.width * share);
        const start = cell.align === "right" ? cell.x - length : cell.align === "center" ? cell.x - length / 2 : cell.x;
        context.fillRect(start, row * rowHeight + cell.y - thickness / 2, length, thickness);
      }
    });
    context.globalAlpha = 1;
    if (shape.thumb) {
      const { x, y, width: side, height, radius, color } = shape.thumb;
      context.fillStyle = color;
      context.beginPath();
      for (let row = 0; row < STAND_IN_TILE_ROWS; row += 1) {
        if (typeof context.roundRect === "function") context.roundRect(x, row * rowHeight + y, side, height, radius);
        else context.rect(x, row * rowHeight + y, side, height);
      }
      context.fill();
    }
    pattern = { canvas, shape, left, width, rowHeight };
    return canvas;
  };

  /** Sizes the tile's canvas, places it over its rows and copies the pattern onto it. */
  const paint = (tile: Tile, plan: StandInTile, rowHeight: number, shape: Template, left: number, width: number) => {
    const source = barsPattern(rowHeight, shape, left, width);
    const context = source ? tile.canvas.getContext("2d") : null;
    if (!source || !context) return;
    const base = tile.index * STAND_IN_TILE_ROWS;
    // The canvas runs from the tile's first row slot to its last painted row.
    const height = (plan.end - base) * rowHeight;
    const pixelWidth = Math.max(1, Math.round(width * BARS_SCALE));
    const pixelHeight = Math.max(1, Math.round(height * BARS_SCALE));
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (tile.canvas.width !== pixelWidth || tile.canvas.height !== pixelHeight) {
      tile.canvas.width = pixelWidth;
      tile.canvas.height = pixelHeight;
    } else {
      // Same pixels, wiped: sizing a canvas again would hand its layer a new, empty surface.
      context.clearRect(0, 0, pixelWidth, pixelHeight);
    }
    context.drawImage(source, 0, 0);
    tile.canvas.style.width = `${width}px`;
    tile.canvas.style.height = `${height}px`;
    tile.canvas.style.transform = `translate(${left}px, ${shape.bodyTop + base * rowHeight}px)`;
    tile.painted = true;
    tile.fresh = true;
    tile.start = plan.start;
    tile.end = plan.end;
    stats.bars += 1;
  };

  const ready = () => {
    if (canDraw === null) {
      // `localStorage["kd-library-standins"] = "off"` turns them off, to compare by hand (read once per table).
      try { canDraw = localStorage.getItem("kd-library-standins") !== "off" && Boolean(document.createElement("canvas").getContext("2d")); }
      catch { canDraw = false; }
    }
    if (!canDraw) return false;
    if (stale || !template) {
      const measured = measure();
      // Keep the previous measurements while no real row is mounted to measure again.
      if (measured) {
        stale = false;
        // Asked to measure again far more often than anything moved (any attribute written on the
        // document element asks): only a real difference repaints, and in place, never by hiding.
        if (!template || JSON.stringify(measured) !== JSON.stringify(template)) {
          template = measured;
          for (const tile of tiles.values()) tile.fresh = false;
        }
      }
    }
    return template !== null;
  };

  const update = (frame: StandInFrame): (readonly [number, number])[] => {
    const covered: (readonly [number, number])[] = [[frame.windowStart, frame.windowEnd]];
    if (leaving !== null) {
      // Fading out over rows the table has built: nothing to plan until a scroll outruns the rows again.
      if (!frame.direction) return covered;
      endLeaving();
    }
    lastFrame = frame;
    if (!ready() || !template) {
      for (const tile of [...tiles.values()]) release(tile);
      return covered;
    }
    const shape = template;
    const rowHeight = Math.max(1, frame.rowHeight);
    const left = scroller.scrollLeft;
    const width = scroller.clientWidth;
    if (frame.count !== boxed.count || rowHeight !== boxed.rowHeight || shape !== boxed.shape) {
      // A canvas reaching past the table, by a rounded pixel, would lengthen the scroll range while
      // it is shown: the layer is the table's own box and cuts off whatever goes beyond it.
      const table = scroller.querySelector<HTMLElement>("table.kd-table");
      if (table) {
        layer.style.width = `${table.offsetLeft + table.offsetWidth}px`;
        layer.style.height = `${table.offsetTop + table.offsetHeight}px`;
      }
      if (rowHeight !== boxed.rowHeight) for (const tile of tiles.values()) tile.painted = false;
      boxed = { count: frame.count, rowHeight, shape };
    }
    if (left !== painted.left || width !== painted.width) {
      for (const tile of tiles.values()) tile.fresh = false;
      painted = { left, width };
    }
    const speed = frame.direction ? Math.abs(frame.speed) : 0;
    // The header is stuck over the top of the container; the first row starts below it.
    const plan = standInPlan({ top: scroller.scrollTop, rowHeight, lead: speed * LEAD_MS,
      height: Math.max(rowHeight, scroller.clientHeight - Math.max(0, shape.bodyTop)),
      count: frame.count, first: frame.first, windowStart: frame.windowStart, windowEnd: frame.windowEnd, direction: frame.direction });
    const wanted = new Set(plan.map((tile) => tile.index));
    for (const tile of [...tiles.values()]) if (!wanted.has(tile.index)) release(tile);
    const began = plan.length ? performance.now() : 0;
    let budget = BARS_PER_FRAME;
    let waiting = false;
    for (const item of plan) {
      const tile = tiles.get(item.index) ?? obtain(item.index);
      // Other rows than it was painted for (the list grew or shrank, pending rows came or went).
      if (tile.start !== item.start || tile.end !== item.end) tile.painted = false;
      if (!tile.painted || !tile.fresh) {
        if (item.urgent || budget > 0) {
          budget -= 1;
          paint(tile, item, rowHeight, shape, left, width);
        } else {
          waiting = true;
        }
      }
      // An unpainted tile stays hidden: it is not where its rows are.
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
    if (waiting && !frameRequest) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        if (lastFrame) update(lastFrame);
      });
    }
    keepOrTrim();
    return covered;
  };

  const settle = () => {
    if (leaving !== null) return true;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    lastFrame = null;
    const shape = template;
    if (!shape || prefersReducedMotion()) {
      for (const tile of [...tiles.values()]) release(tile);
      keepOrTrim();
      return false;
    }
    // What the rest of the scroll can still bring into view while the fade lasts: a screen either side.
    const reach = scroller.clientHeight;
    const from = scroller.scrollTop - reach;
    const to = scroller.scrollTop + 2 * reach;
    for (const tile of [...tiles.values()]) {
      const top = shape.bodyTop + tile.index * STAND_IN_TILE_ROWS * boxed.rowHeight;
      if (tile.shown === "none" || top >= to || top + STAND_IN_TILE_ROWS * boxed.rowHeight <= from) release(tile);
      else tile.canvas.setAttribute(STAND_IN_LEAVING_ATTR, "");
    }
    keepOrTrim();
    if (!tiles.size) return false;
    leaving = setTimeout(endLeaving, MOTION_MICRO_OUT_MS);
    return true;
  };

  return {
    ready,
    update,
    settle,
    invalidate() { stale = true; },
    takeStats() {
      const taken = stats;
      stats = { bars: 0, ms: 0, worst: 0 };
      return taken;
    },
    destroy() {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      if (trim !== null) clearTimeout(trim);
      trim = null;
      if (leaving !== null) clearTimeout(leaving);
      leaving = null;
      lastFrame = null;
      pattern = null;
      tiles.clear();
      spare.length = 0;
      layer.replaceChildren();
    },
  };
}
