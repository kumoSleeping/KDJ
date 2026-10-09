/**
 * The card that follows the pointer while something is dragged: a cover (or a glyph), the title
 * on one line and a count when several items go together. Every drag of songs, results and
 * folders uses it, whether the pointer is followed by hand (`pointerDragGhost`) or the system
 * carries a picture (`setDragGhost`). Its styles are in DragGhost.css.
 */

export type DragGhostGlyph = "song" | "video" | "folder";

export interface DragGhostContent {
  title: string;
  /** How many items are dragged; a badge is shown from two up. */
  count?: number;
  /**
   * Where a cover that is already on screen can be found: the row, a cell or the image itself.
   * Only a loaded image is used, so the card never waits for the network.
   */
  coverFrom?: Element | null;
  /** Drawn when there is no cover. */
  glyph?: DragGhostGlyph;
}

const GLYPHS: Record<DragGhostGlyph, string> = {
  song: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2.2 2.2h7.3A2.5 2.5 0 0 1 21 9.7v6.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
};

/** An inline icon in the stroke style of the rest of the app. */
export function ghostGlyph(paths: string, size: number): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

/**
 * Whether an event target or a caller's value is an element. Asked of the value itself: the
 * element classes are not globals everywhere this runs (the component tests' DOM).
 */
export function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && (value as Node).nodeType === 1
    && typeof (value as Element).closest === "function";
}

/** The loaded cover image inside `from`, or null while there is none to show. */
export function loadedCover(from: Element | null | undefined): HTMLImageElement | null {
  if (!from) return null;
  const images = from.tagName === "IMG" ? [from as HTMLImageElement] : Array.from(from.querySelectorAll<HTMLImageElement>(".kd-thumb img, img"));
  return images.find(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) ?? null;
}

/**
 * A square copy of a loaded image, cropped from its centre. A canvas has its pixels at once,
 * which a new `<img>` does not: the system takes the drag picture before that would decode.
 */
export function coverTile(image: HTMLImageElement | null, size: number): HTMLCanvasElement | null {
  if (!image) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = canvas.height = Math.round(size * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  try {
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return canvas;
}

/** Builds the card. The caller places it and takes it away. */
export function buildDragGhost(content: DragGhostContent): HTMLDivElement {
  const count = Math.max(1, Math.floor(content.count ?? 1));
  const card = document.createElement("div");
  card.className = "kd-drag-ghost-card";
  if (count > 1) card.dataset.many = "true";
  const cover = document.createElement("span");
  cover.className = "kd-drag-ghost-cover";
  const tile = coverTile(loadedCover(content.coverFrom), 36);
  if (tile) cover.append(tile);
  else {
    cover.dataset.glyph = content.glyph ?? "song";
    cover.append(ghostGlyph(GLYPHS[content.glyph ?? "song"], 18));
  }
  const copy = document.createElement("span");
  copy.className = "kd-drag-ghost-copy";
  const title = document.createElement("span");
  title.className = "kd-drag-ghost-title";
  title.textContent = content.title;
  const hint = document.createElement("span");
  hint.className = "kd-drag-ghost-hint";
  hint.hidden = true;
  copy.append(title, hint);
  card.append(cover, copy);
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "kd-drag-ghost-count";
    badge.textContent = count > 99 ? "99+" : String(count);
    card.append(badge);
  }
  return card;
}

export interface PointerDragGhost {
  /** Follows the pointer. */
  move(clientX: number, clientY: number): void;
  /** Names where the item would land right now ("下载队列", "Deck A"); null over nothing. */
  hint(text: string | null): void;
  remove(): void;
}

/** A card moved by the caller's own pointer tracking (drags that do not use HTML5 drag-and-drop). */
export function pointerDragGhost(content: DragGhostContent, clientX: number, clientY: number): PointerDragGhost {
  const host = document.createElement("div");
  host.className = "kd-drag-ghost";
  const card = buildDragGhost(content);
  const hint = card.querySelector<HTMLElement>(".kd-drag-ghost-hint");
  host.append(card);
  document.body.append(host);
  const move = (x: number, y: number) => { host.style.transform = `translate3d(${x + 10}px, ${y + 12}px, 0)`; };
  move(clientX, clientY);
  return {
    move,
    hint(text) {
      if (!hint || (hint.hidden ? null : hint.textContent) === text) return;
      hint.hidden = !text;
      hint.textContent = text ?? "";
    },
    remove: () => host.remove(),
  };
}

/**
 * Gives an HTML5 drag the same card as its picture. The system photographs the element when the
 * `dragstart` handlers have returned, and WebKit only photographs what is laid out inside the
 * window, so the card is put at the window's corner for that moment, with room around it for
 * the tilt and the shadow, and taken away in the next frame's callbacks — before that frame is
 * painted, so it is never seen on the page itself.
 */
export function setDragGhost(dataTransfer: DataTransfer | null, content: DragGhostContent): void {
  if (!dataTransfer || typeof dataTransfer.setDragImage !== "function") return;
  const stage = document.createElement("div");
  stage.className = "kd-drag-ghost kd-drag-ghost-stage";
  stage.append(buildDragGhost(content));
  document.body.append(stage);
  try {
    // Forces layout: the picture is taken from what is laid out now.
    void stage.offsetWidth;
    dataTransfer.setDragImage(stage, 30, 32);
  } catch {
    // The browser's own picture is used instead.
  }
  const remove = () => stage.remove();
  requestAnimationFrame(remove);
  // A window in the background runs no frames.
  window.setTimeout(remove, 250);
}
