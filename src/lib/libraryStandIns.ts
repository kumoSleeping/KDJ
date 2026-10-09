/**
 * Stand-in rows for the track table: the rows around the viewport, painted on canvases that scroll
 * with the table.
 *
 * The WebView scrolls the table on its own thread; the page learns the offset afterwards and can
 * only then build the rows for it. A real row is a dozen cells of DOM and costs milliseconds, so
 * a fast scroll runs past any amount of rows built ahead and shows blank space, and building them
 * faster by scrolling from the page instead makes the scroll itself wait. So the table stops
 * building rows while it is scrolled fast, and builds them once, where the scroll slows down;
 * until then it shows stand-ins. A canvas is a layer of its own, already drawn when the scrolling
 * thread reaches it.
 *
 * How far ahead the stand-ins must reach is a matter of speed. A flick through a library runs at
 * tens of thousands of pixels a second: a frame of the page that takes a tenth of a second is a
 * dozen screens of travel. Two kinds of stand-in cover that:
 * - text: the rows' own text, for the screens next to the viewport of a scroll slow enough to read
 *   anything. A tile of text is hundreds of `fillText` calls.
 * - bars: a grey bar where each text would be, at a quarter of the resolution, for everything
 *   further ahead and for the whole of a scroll too fast to read. A tile of bars is one
 *   `drawImage` of a pattern drawn once, so half a second of travel can be covered in a frame.
 *
 * Where each cell's text goes, and in which font and colour, is measured from a real row, so the
 * stand-ins follow the theme, the column layout and the two-line layout without knowing them.
 */

/** Rows per canvas. Tiles sit at fixed rows, so a tile is painted once and reused while in range. */
export const STAND_IN_TILE_ROWS = 24;
/**
 * Screens [behind, ahead] of the viewport of a fast scroll that are worth their text. Without a
 * direction only the viewport itself is covered, which the table's own rows normally do: a resting
 * or slowly scrolled table holds no canvas at all.
 */
const NEAR_SCREENS: readonly [number, number] = [1, 6];
/** Stand-ins reach this much travel ahead of the viewport, at the current speed. */
const LEAD_MS = 500;
/** And no further than this many tiles: each one is a layer. */
const MAX_LEAD_TILES = 64;
/** px/ms. Above the first nothing can be read and every new tile is bars; text returns below the second. */
const BARS_ENTER_SPEED = 14;
const BARS_EXIT_SPEED = 10;
/** Canvas pixels per CSS pixel: text at most this sharp (it is seen in motion), bars always this coarse. */
const TEXT_SCALE = 1.5;
const BARS_SCALE = 0.25;
/** Time a frame may spend on text for tiles outside the viewport, and bars tiles it may paint. */
const TEXT_BUDGET_MS = 5;
const BARS_PER_FRAME = 16;
/** Canvases keep their pixels this long after the last stand-in was shown: the next flick reuses them. */
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
  /** Pixels ahead of the viewport to cover, when that is further than the screens worth their text. */
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
  /** Within the screens worth their text. */
  near: boolean;
}

/** The tiles to show for a viewport, most needed first. */
export function standInPlan(input: StandInPlanInput): StandInTile[] {
  const rowHeight = Math.max(1, input.rowHeight);
  const count = Math.max(0, input.count);
  const first = Math.min(count, Math.max(0, input.first));
  const screen = Math.max(1, Math.ceil(input.height / rowHeight));
  const visibleStart = Math.min(count, Math.max(first, Math.floor(Math.max(0, input.top) / rowHeight)));
  const visibleEnd = Math.min(count, Math.max(visibleStart, Math.ceil((Math.max(0, input.top) + input.height) / rowHeight)));
  const [behind, ahead] = input.direction ? NEAR_SCREENS : [0, 0];
  const nearFrom = Math.max(first, visibleStart - (input.direction < 0 ? ahead : behind) * screen);
  const nearTo = Math.min(count, visibleEnd + (input.direction < 0 ? behind : ahead) * screen);
  const lead = input.direction ? Math.min(MAX_LEAD_TILES * STAND_IN_TILE_ROWS, Math.ceil(Math.max(0, input.lead ?? 0) / rowHeight)) : 0;
  const from = input.direction < 0 ? Math.max(first, Math.min(nearFrom, visibleStart - lead)) : nearFrom;
  const to = input.direction > 0 ? Math.min(count, Math.max(nearTo, visibleEnd + lead)) : nearTo;
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
    tiles.push({ index, start, end, shownStart, shownEnd, urgent: shownStart < visibleEnd && shownEnd > visibleStart,
      near: shownStart < nearTo && shownEnd > nearFrom });
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

interface TemplateCell {
  key: string;
  /** Where the text is anchored in the row, and the room it has from there. */
  align: "left" | "center" | "right";
  x: number;
  y: number;
  width: number;
  /** Horizontal extent of the cell: its text is cut there, and columns scrolled out sideways are skipped. */
  from: number;
  to: number;
  font: string;
  /** Font size in pixels: the height of the bar that stands for the text. */
  size: number;
  color: string;
}
interface Template {
  /** Content offsets of the first row inside the scroll container. */
  bodyTop: number;
  left: number;
  cells: TemplateCell[];
  /** The cover box of a row, drawn empty: covers are not kept as pixels the canvas could use. */
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
  /** Speed of the scroll, px/ms: how far ahead to reach, and whether text can be read at all. */
  speed: number;
  /** Text of a cell; null for a cell that shows none, undefined while the row has not loaded. */
  text(row: number, column: string): string | null | undefined;
  /**
   * What decides which row is where (the order, the rows before the tracks, the key notation). A
   * change in any item hides every tile until it is painted again: what it shows is wrong.
   */
  version: readonly unknown[];
  /**
   * What the texts are read from. A change repaints the text tiles in place: rows that arrive or
   * are edited replace their old text, and nothing is hidden meanwhile.
   */
  data: unknown;
}

export interface StandInStats {
  /** Tiles painted as text and as bars, and the time spent painting, since the last reading. */
  text: number;
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
  /** Painted from the current data and for the current sideways offset. A stale tile stays on show until its turn. */
  fresh: boolean;
  detail: "text" | "bars";
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
  let version: readonly unknown[] = [];
  let data: unknown;
  let painted = { left: -1, width: -1 };
  /** What the layer's box was last taken for: it is the table's box, and clips the canvases to it. */
  let boxed = { count: -1, rowHeight: -1, shape: null as Template | null };
  /** The bars of one tile, drawn once and copied onto every bars tile. */
  let pattern: { canvas: HTMLCanvasElement; shape: Template; left: number; width: number; rowHeight: number } | null = null;
  let bars = false;
  let trim: ReturnType<typeof setTimeout> | null = null;
  let lastFrame: StandInFrame | null = null;
  let frameRequest = 0;
  let canDraw: boolean | null = null;
  let stats: StandInStats = { text: 0, bars: 0, ms: 0, worst: 0 };

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
      const key = cell.dataset.col;
      const text = key ? lastText(cell) : null;
      const holder = text?.parentElement;
      if (!key || !text || !holder) continue;
      range.selectNodeContents(text);
      const textBox = range.getBoundingClientRect();
      if (!(textBox.height > 0)) continue;
      const style = getComputedStyle(holder);
      const cellStyle = getComputedStyle(cell);
      const cellBox = cell.getBoundingClientRect();
      const from = cellBox.left + (parseFloat(cellStyle.paddingLeft) || 0) - rowBox.left;
      const to = cellBox.right - (parseFloat(cellStyle.paddingRight) || 0) - rowBox.left;
      // How the element that holds the text places it tells where a longer or shorter one will sit.
      const placing = style.display.includes("flex") ? style.justifyContent : style.textAlign;
      const align = placing === "center" ? "center" : /^(right|end|flex-end)$/.test(placing) ? "right" : "left";
      const left = textBox.left - rowBox.left;
      const right = textBox.right - rowBox.left;
      cells.push({ key, align, from, to, y: textBox.top + textBox.height / 2 - rowBox.top,
        x: align === "center" ? (left + right) / 2 : align === "right" ? right : left,
        width: align === "center" ? to - from : align === "right" ? right - from : to - left,
        // Built from the longhands: the `font` shorthand reads as empty when it cannot express them all.
        font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
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
    tile.shown = "none";
    spare.push(tile.canvas);
    tiles.delete(tile.index);
  };
  const obtain = (index: number): Tile => {
    const canvas = spare.pop() ?? layer.appendChild(document.createElement("canvas"));
    const tile: Tile = { canvas, index, painted: false, fresh: false, detail: "bars", start: 0, end: 0, shown: "" };
    canvas.style.display = "none";
    canvas.style.clipPath = "";
    tiles.set(index, tile);
    return tile;
  };

  /** Sizes the tile's canvas for `scale`, wiped, and places it over its rows. */
  const prepare = (tile: Tile, plan: StandInTile, shape: Template, rowHeight: number, left: number, width: number, scale: number) => {
    const context = tile.canvas.getContext("2d");
    if (!context) return null;
    const base = tile.index * STAND_IN_TILE_ROWS;
    const height = (plan.end - base) * rowHeight;
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    if (tile.canvas.width !== pixelWidth || tile.canvas.height !== pixelHeight) {
      tile.canvas.width = pixelWidth;
      tile.canvas.height = pixelHeight;
    } else {
      // Same pixels, wiped: sizing a canvas again would hand its layer a new, empty surface.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
    }
    tile.canvas.style.width = `${width}px`;
    tile.canvas.style.height = `${height}px`;
    tile.canvas.style.transform = `translate(${left}px, ${shape.bodyTop + base * rowHeight}px)`;
    tile.painted = true;
    tile.fresh = true;
    tile.start = plan.start;
    tile.end = plan.end;
    return context;
  };

  const drawThumbs = (context: CanvasRenderingContext2D, shape: Template, rows: number, rowHeight: number) => {
    if (!shape.thumb) return;
    const { x, y, width, height, radius, color } = shape.thumb;
    context.fillStyle = color;
    context.beginPath();
    for (let row = 0; row < rows; row += 1) {
      if (typeof context.roundRect === "function") context.roundRect(x, row * rowHeight + y, width, height, radius);
      else context.rect(x, row * rowHeight + y, width, height);
    }
    context.fill();
  };

  const paintText = (tile: Tile, plan: StandInTile, frame: StandInFrame, shape: Template, left: number, width: number) => {
    const rowHeight = frame.rowHeight;
    const scale = Math.min(TEXT_SCALE, window.devicePixelRatio || 1);
    const context = prepare(tile, plan, shape, rowHeight, left, width, scale);
    if (!context) return;
    tile.detail = "text";
    const base = tile.index * STAND_IN_TILE_ROWS;
    const height = (plan.end - base) * rowHeight;
    context.setTransform(scale, 0, 0, scale, (shape.left - left) * scale, 0);
    context.textBaseline = "middle";
    const loaded: boolean[] = [];
    for (const cell of shape.cells) {
      // Columns scrolled out sideways are not painted; a sideways scroll repaints.
      if (shape.left + cell.to < left || shape.left + cell.from > left + width) continue;
      // A text longer than its cell is cut at the cell's edge, as the cell cuts it: one clip for
      // the column instead of measuring every text.
      context.save();
      context.beginPath();
      context.rect(cell.from, 0, cell.to - cell.from, height);
      context.clip();
      context.font = cell.font;
      context.fillStyle = cell.color;
      context.textAlign = cell.align;
      for (let row = plan.start; row < plan.end; row += 1) {
        const text = frame.text(row, cell.key);
        loaded[row - plan.start] = text !== undefined;
        if (text) context.fillText(text, cell.x, (row - base) * rowHeight + cell.y);
      }
      context.restore();
    }
    drawThumbs(context, shape, plan.end - base, rowHeight);
    // Rows whose summary has not arrived: the bar their placeholder row shows.
    const title = shape.cells.find((cell) => cell.key === "title");
    if (title && loaded.some((value) => !value)) {
      context.fillStyle = title.color;
      context.globalAlpha = 0.16;
      for (let row = plan.start; row < plan.end; row += 1) {
        if (!loaded[row - plan.start]) context.fillRect(title.x, (row - base) * rowHeight + title.y - 4, Math.min(160, Math.max(0, title.width)), 8);
      }
      context.globalAlpha = 1;
    }
    stats.text += 1;
  };

  /** The bars of a full tile for these measurements, drawn once. */
  const barsPattern = (frame: StandInFrame, shape: Template, left: number, width: number) => {
    const rowHeight = frame.rowHeight;
    if (pattern && pattern.shape === shape && pattern.left === left && pattern.width === width && pattern.rowHeight === rowHeight) return pattern.canvas;
    const canvas = pattern?.canvas ?? document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    canvas.width = Math.max(1, Math.round(width * BARS_SCALE));
    canvas.height = Math.max(1, Math.round(STAND_IN_TILE_ROWS * rowHeight * BARS_SCALE));
    context.setTransform(BARS_SCALE, 0, 0, BARS_SCALE, (shape.left - left) * BARS_SCALE, 0);
    // Columns that show text, asked of a row the table has rendered (and so most likely loaded).
    const probe = Math.max(frame.first, Math.min(frame.count - 1, frame.windowStart));
    context.globalAlpha = 0.2;
    shape.cells.forEach((cell, column) => {
      if (shape.left + cell.to < left || shape.left + cell.from > left + width) return;
      if (frame.text(probe, cell.key) === null) return;
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
    drawThumbs(context, shape, STAND_IN_TILE_ROWS, rowHeight);
    pattern = { canvas, shape, left, width, rowHeight };
    return canvas;
  };

  const paintBars = (tile: Tile, plan: StandInTile, frame: StandInFrame, shape: Template, left: number, width: number) => {
    const source = barsPattern(frame, shape, left, width);
    const context = source ? prepare(tile, plan, shape, frame.rowHeight, left, width, BARS_SCALE) : null;
    if (!source || !context) return;
    tile.detail = "bars";
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(source, 0, 0);
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
    lastFrame = frame;
    const covered: (readonly [number, number])[] = [[frame.windowStart, frame.windowEnd]];
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
    if (frame.version.length !== version.length || frame.version.some((item, index) => item !== version[index])) {
      for (const tile of tiles.values()) tile.painted = false;
      version = frame.version;
    }
    if (left !== painted.left || width !== painted.width) {
      for (const tile of tiles.values()) tile.fresh = false;
      painted = { left, width };
    }
    if (frame.data !== data) {
      // Bars say nothing about a row; only text has gone stale.
      for (const tile of tiles.values()) if (tile.detail === "text") tile.fresh = false;
      data = frame.data;
    }
    const speed = frame.direction ? Math.abs(frame.speed) : 0;
    bars = speed > (bars ? BARS_EXIT_SPEED : BARS_ENTER_SPEED);
    // The header is stuck over the top of the container; the first row starts below it.
    const plan = standInPlan({ top: scroller.scrollTop, rowHeight, lead: speed * LEAD_MS,
      height: Math.max(rowHeight, scroller.clientHeight - Math.max(0, shape.bodyTop)),
      count: frame.count, first: frame.first, windowStart: frame.windowStart, windowEnd: frame.windowEnd, direction: frame.direction });
    const wanted = new Set(plan.map((tile) => tile.index));
    for (const tile of [...tiles.values()]) if (!wanted.has(tile.index)) release(tile);
    const began = performance.now();
    let barsLeft = BARS_PER_FRAME;
    let texts = 0;
    let waiting = false;
    for (const item of plan) {
      const tile = tiles.get(item.index) ?? obtain(item.index);
      if (tile.start !== item.start || tile.end !== item.end) tile.painted = false;
      const want = !bars && item.near ? "text" : "bars";
      if (want === "text" && (!tile.painted || !tile.fresh || tile.detail === "bars")) {
        if (item.urgent || texts === 0 || performance.now() - began < TEXT_BUDGET_MS) {
          paintText(tile, item, frame, shape, left, width);
          texts += 1;
        } else {
          waiting = true;
          // Bars until its turn: a tile is never left blank for want of time.
          if (!tile.painted) paintBars(tile, item, frame, shape, left, width);
        }
      } else if (!tile.painted || (tile.detail === "bars" && !tile.fresh)) {
        if (item.urgent || barsLeft > 0) {
          barsLeft -= 1;
          paintBars(tile, item, frame, shape, left, width);
        } else {
          waiting = true;
        }
      }
      // An unpainted tile stays hidden: what it showed belongs to another order.
      // The canvas runs from the tile's first row slot to its last painted row.
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
    const spent = performance.now() - began;
    stats.ms += spent;
    stats.worst = Math.max(stats.worst, spent);
    if (waiting && !frameRequest) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        if (lastFrame) update(lastFrame);
      });
    }
    // Nothing on show: give the pixels back, but not before a next flick could have used them.
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
    return covered;
  };

  return {
    ready,
    update,
    invalidate() { stale = true; },
    takeStats() {
      const taken = stats;
      stats = { text: 0, bars: 0, ms: 0, worst: 0 };
      return taken;
    },
    destroy() {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      if (trim !== null) clearTimeout(trim);
      trim = null;
      lastFrame = null;
      pattern = null;
      tiles.clear();
      spare.length = 0;
      layer.replaceChildren();
    },
  };
}
