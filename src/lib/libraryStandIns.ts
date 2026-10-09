/**
 * Stand-in rows for the track table: the text of the rows around the viewport, painted on a few
 * canvases that scroll with the table.
 *
 * The WebView scrolls the table on its own thread; the page learns the offset afterwards and can
 * only then build the rows for it. A real row is a dozen cells of DOM and costs milliseconds, so
 * a fast scroll runs past any amount of rows built ahead and shows blank space, and building them
 * faster by scrolling from the page instead makes the scroll itself wait. A stand-in row is a few
 * `fillText` calls: a screen of them costs about as much as one real row, so several screens
 * ahead of a fast scroll are always painted. A canvas is a layer of its own, already drawn when
 * the scrolling thread reaches it. The table stops building rows while it is scrolled fast and
 * builds them once, where the scroll slows down; stand-ins are clipped to the rows that exist.
 *
 * Where each cell's text goes, and in which font and colour, is measured from a real row, so the
 * stand-ins follow the theme, the column layout and the two-line layout without knowing them.
 */

/** Rows per canvas. Tiles sit at fixed rows, so a tile is painted once and reused while in range. */
export const STAND_IN_TILE_ROWS = 24;
/**
 * Screens painted [behind, ahead] of the viewport of a fast scroll. Without a direction only the
 * viewport itself is covered, which the table's own rows normally do: a resting or slowly scrolled
 * table holds no canvas at all.
 */
const FLIGHT_SCREENS: readonly [number, number] = [1, 6];
/** Tiles outside the viewport painted per frame; the ones under the viewport are never deferred. */
const TILES_PER_FRAME = 2;
/** Canvas pixels per CSS pixel, at most. Stand-ins are seen in motion; sharper costs memory. */
const MAX_SCALE = 1.5;

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
  const [behind, ahead] = input.direction ? FLIGHT_SCREENS : [0, 0];
  const from = Math.max(first, visibleStart - (input.direction < 0 ? ahead : behind) * screen);
  const to = Math.min(count, visibleEnd + (input.direction < 0 ? behind : ahead) * screen);
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

/** `text` shortened to `width` with an ellipsis, the way a cell with `text-overflow: ellipsis` shows it. */
export function fitStandInText(measure: (text: string) => number, text: string, width: number): string {
  if (width <= 0) return "";
  if (measure(text) <= width) return text;
  let low = 0;
  let high = text.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, middle)}…`) <= width) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? `${text.slice(0, low).trimEnd()}…` : "";
}

interface TemplateCell {
  key: string;
  /** Where the text is anchored in the row, and the room it has from there. */
  align: "left" | "center" | "right";
  x: number;
  y: number;
  width: number;
  /** Horizontal extent of the cell, to skip columns scrolled out sideways. */
  from: number;
  to: number;
  font: string;
  color: string;
}
interface Template {
  rowHeight: number;
  /** Content offsets of the first row inside the scroll container. */
  bodyTop: number;
  left: number;
  cells: TemplateCell[];
  /** The cover box of a row, drawn empty: covers are not kept as pixels the canvas could use. */
  thumb: { x: number; y: number; width: number; height: number; radius: number; color: string } | null;
}

export interface StandInFrame {
  count: number;
  first: number;
  windowStart: number;
  windowEnd: number;
  /** Direction of a fast scroll, 0 otherwise (see StandInPlanInput). */
  direction: -1 | 0 | 1;
  /** Text of a cell; null for a cell that shows none, undefined while the row has not loaded. */
  text(row: number, column: string): string | null | undefined;
  /** What the texts depend on. A change in any item repaints every tile. */
  version: readonly unknown[];
}

export interface LibraryStandIns {
  /** Whether stand-ins can be painted at all: a real row has been measured and a canvas is available. */
  ready(): boolean;
  /**
   * Shows the stand-ins for the container's current offset. Returns the runs of rows that now have
   * something to show: the table's own rows and every painted stand-in, each as [start, end).
   */
  update(frame: StandInFrame): (readonly [number, number])[];
  /** The layout, columns or theme changed: measure a real row again and repaint. */
  invalidate(): void;
  destroy(): void;
}

interface Tile { canvas: HTMLCanvasElement; index: number; painted: boolean; start: number; end: number; shown: string }

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

export function createLibraryStandIns(scroller: HTMLElement, layer: HTMLElement): LibraryStandIns {
  const tiles = new Map<number, Tile>();
  const spare: HTMLCanvasElement[] = [];
  let template: Template | null = null;
  let stale = true;
  let version: readonly unknown[] = [];
  let painted = { left: -1, width: -1 };
  let lastFrame: StandInFrame | null = null;
  let frameRequest = 0;
  let canDraw: boolean | null = null;

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
        // A chip inside the cell is tinted for its own row (the key colour); the cell's colour suits every row.
        color: holder === cell || holder.parentElement === cell ? style.color : cellStyle.color });
    }
    if (!cells.length) return null;
    const thumbNode = row.querySelector<HTMLElement>(".kd-thumb");
    const thumbBox = thumbNode?.getBoundingClientRect();
    const thumbStyle = thumbNode ? getComputedStyle(thumbNode) : null;
    return { rowHeight: rowBox.height, bodyTop: body.getBoundingClientRect().top - box.top + scroller.scrollTop - scroller.clientTop,
      left: rowBox.left - box.left + scroller.scrollLeft - scroller.clientLeft, cells,
      thumb: thumbBox && thumbStyle && thumbBox.width > 0 && opaque(thumbStyle.backgroundColor)
        ? { x: thumbBox.left - rowBox.left, y: thumbBox.top - rowBox.top, width: thumbBox.width, height: thumbBox.height,
            radius: parseFloat(thumbStyle.borderTopLeftRadius) || 0, color: thumbStyle.backgroundColor }
        : null };
  };

  const release = (tile: Tile) => {
    tile.canvas.style.display = "none";
    tile.shown = "none";
    // Gives the pixels back; painting sizes the canvas again.
    tile.canvas.width = 0;
    tile.canvas.height = 0;
    spare.push(tile.canvas);
    tiles.delete(tile.index);
  };
  const obtain = (index: number): Tile => {
    const canvas = spare.pop() ?? layer.appendChild(document.createElement("canvas"));
    const tile: Tile = { canvas, index, painted: false, start: 0, end: 0, shown: "" };
    canvas.style.display = "none";
    canvas.style.clipPath = "";
    tiles.set(index, tile);
    return tile;
  };

  const paint = (tile: Tile, plan: StandInTile, frame: StandInFrame, shape: Template, left: number, width: number) => {
    const context = tile.canvas.getContext("2d");
    if (!context) return;
    const scale = Math.min(MAX_SCALE, window.devicePixelRatio || 1);
    const base = tile.index * STAND_IN_TILE_ROWS;
    // Not past the last row: a canvas reaching below the table would lengthen the scroll range.
    const height = (plan.end - base) * shape.rowHeight;
    tile.canvas.width = Math.max(1, Math.round(width * scale));
    tile.canvas.height = Math.max(1, Math.round(height * scale));
    tile.canvas.style.width = `${width}px`;
    tile.canvas.style.height = `${height}px`;
    tile.canvas.style.transform = `translate(${left}px, ${shape.bodyTop + base * shape.rowHeight}px)`;
    context.setTransform(scale, 0, 0, scale, (shape.left - left) * scale, 0);
    context.textBaseline = "middle";
    const loaded: boolean[] = [];
    const measureText = (text: string) => context.measureText(text).width;
    for (const cell of shape.cells) {
      // Columns scrolled out sideways are not painted; a sideways scroll repaints.
      if (shape.left + cell.to < left || shape.left + cell.from > left + width) continue;
      context.font = cell.font;
      context.fillStyle = cell.color;
      context.textAlign = cell.align;
      for (let row = plan.start; row < plan.end; row += 1) {
        const text = frame.text(row, cell.key);
        loaded[row - plan.start] = text !== undefined;
        if (text) context.fillText(fitStandInText(measureText, text, cell.width), cell.x, (row - base) * shape.rowHeight + cell.y);
      }
    }
    const title = shape.cells.find((cell) => cell.key === "title");
    if (shape.thumb || title) {
      context.fillStyle = shape.thumb?.color ?? title!.color;
      context.globalAlpha = shape.thumb ? 1 : 0.16;
      for (let row = plan.start; row < plan.end; row += 1) {
        const top = (row - base) * shape.rowHeight;
        context.beginPath();
        if (shape.thumb) {
          const { x, y, width: boxWidth, height: boxHeight, radius } = shape.thumb;
          if (typeof context.roundRect === "function") context.roundRect(x, top + y, boxWidth, boxHeight, radius);
          else context.rect(x, top + y, boxWidth, boxHeight);
        }
        // A row whose summary has not arrived: the bar its placeholder row shows.
        if (!loaded[row - plan.start] && title) context.rect(title.x, top + title.y - 4, Math.min(160, Math.max(0, title.width)), 8);
        context.fill();
      }
      context.globalAlpha = 1;
    }
    tile.painted = true;
    tile.start = plan.start;
    tile.end = plan.end;
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
      if (measured) { template = measured; stale = false; }
    }
    return template !== null;
  };

  const update = (frame: StandInFrame): (readonly [number, number])[] => {
    lastFrame = frame;
    const wasStale = stale;
    const covered: (readonly [number, number])[] = [[frame.windowStart, frame.windowEnd]];
    if (!ready() || !template) {
      for (const tile of [...tiles.values()]) release(tile);
      return covered;
    }
    const shape = template;
    const left = scroller.scrollLeft;
    const width = scroller.clientWidth;
    if ((wasStale && !stale) || left !== painted.left || width !== painted.width
      || frame.version.length !== version.length || frame.version.some((item, index) => item !== version[index])) {
      for (const tile of tiles.values()) tile.painted = false;
      version = frame.version;
      painted = { left, width };
    }
    // The header is stuck over the top of the container; the first row starts below it.
    const plan = standInPlan({ top: scroller.scrollTop, rowHeight: shape.rowHeight,
      height: Math.max(shape.rowHeight, scroller.clientHeight - Math.max(0, shape.bodyTop)),
      count: frame.count, first: frame.first, windowStart: frame.windowStart, windowEnd: frame.windowEnd, direction: frame.direction });
    const wanted = new Set(plan.map((tile) => tile.index));
    for (const tile of [...tiles.values()]) if (!wanted.has(tile.index)) release(tile);
    let budget = TILES_PER_FRAME;
    let waiting = false;
    for (const item of plan) {
      const tile = tiles.get(item.index) ?? obtain(item.index);
      if (!tile.painted || tile.start !== item.start || tile.end !== item.end) {
        tile.painted = false;
        if (item.urgent || budget > 0) {
          if (!item.urgent) budget -= 1;
          paint(tile, item, frame, shape, left, width);
        } else {
          waiting = true;
        }
      }
      // An unpainted tile stays hidden: what it showed belongs to another order or another column layout.
      const base = item.index * STAND_IN_TILE_ROWS;
      const clipTop = (item.shownStart - base) * shape.rowHeight;
      const clipBottom = (base + STAND_IN_TILE_ROWS - item.shownEnd) * shape.rowHeight;
      const shown = !tile.painted ? "none" : clipTop || clipBottom ? `inset(${clipTop}px 0 ${clipBottom}px 0)` : "all";
      if (shown !== tile.shown) {
        tile.shown = shown;
        tile.canvas.style.display = shown === "none" ? "none" : "";
        tile.canvas.style.clipPath = shown === "none" || shown === "all" ? "" : shown;
      }
      if (tile.painted) covered.push([item.shownStart, item.shownEnd]);
    }
    if (waiting && !frameRequest) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        if (lastFrame) update(lastFrame);
      });
    }
    return covered;
  };

  return {
    ready,
    update,
    invalidate() { stale = true; },
    destroy() {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      lastFrame = null;
      tiles.clear();
      spare.length = 0;
      layer.replaceChildren();
    },
  };
}
