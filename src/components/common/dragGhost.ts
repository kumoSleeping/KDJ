/**
 * The card that follows the pointer while something is dragged: a cover (or a glyph), the title
 * on one line and a count when several items go together. Every drag of songs, results and
 * folders uses it, whether the pointer is followed by hand (`pointerDragGhost`) or the system
 * carries a picture (`setDragGhost`). Its styles are in DragGhost.css.
 *
 * The card outlives the drag in two cases. Dropped on the downloads, the same card hops into
 * the list (`droppedDragCard`, flown by lib/downloadToss.ts). Let go on a place that does not
 * take it, the card shakes its head and fades (`refuseDragGhost`, decided by lib/dragRefusal.ts).
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

/** What a card shows, with its cover already found: enough to draw the same card again. */
interface CardFace {
  title: string;
  count: number;
  glyph: DragGhostGlyph;
  image: HTMLImageElement | null;
}

function faceOf(content: DragGhostContent): CardFace {
  return {
    title: content.title,
    count: Math.max(1, Math.floor(content.count ?? 1)),
    glyph: content.glyph ?? "song",
    image: loadedCover(content.coverFrom),
  };
}

/** Builds the card. The caller places it and takes it away. */
export function buildDragGhost(content: DragGhostContent): HTMLDivElement {
  return drawCard(faceOf(content));
}

function drawCard(face: CardFace): HTMLDivElement {
  const { count } = face;
  const card = document.createElement("div");
  card.className = "kd-drag-ghost-card";
  if (count > 1) card.dataset.many = "true";
  const cover = document.createElement("span");
  cover.className = "kd-drag-ghost-cover";
  const tile = coverTile(face.image, 36);
  if (tile) cover.append(tile);
  else {
    cover.dataset.glyph = face.glyph;
    cover.append(ghostGlyph(GLYPHS[face.glyph], 18));
  }
  const copy = document.createElement("span");
  copy.className = "kd-drag-ghost-copy";
  const title = document.createElement("span");
  title.className = "kd-drag-ghost-title";
  title.textContent = face.title;
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

/* ------------------------------------------------------------------------------------------ */
/* The card after the drag                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A point on screen, or an offset between two. */
export interface GhostPoint { x: number; y: number }

/**
 * The card of the drag that is going on or has just ended, and where the centre of its cover
 * sits as seen from the pointer (the system's picture hangs differently from the card that
 * follows the pointer by hand).
 */
let lastCard: { face: CardFace; cover: GhostPoint } | null = null;
/** The card that follows the pointer by hand, while there is one. */
let liveGhost: HTMLElement | null = null;
/** Set by `refuseDragGhost` for the card that is taken away in the same turn. */
let refusal = false;

/** The refusal: two beats of the small clock for the shake, then the short fade. */
const REFUSE_SHAKE_MS = 320;
const REFUSE_FADE_MS = 110;

/** From the corner of a card to the centre of its cover (its padding plus half the cover). */
function coverCentre(card: Element): GhostPoint {
  const pad = parseFloat(getComputedStyle(card).paddingLeft) || 6;
  return { x: pad + 18, y: pad + 18 };
}

export interface DroppedCard {
  /** A fresh copy of the card, not placed anywhere. */
  card: HTMLDivElement;
  /** From the point where the drag was let go to the centre of the card's cover. */
  cover: GhostPoint;
}

/**
 * The card of the drag that has just been dropped, drawn again so that it can go on from where
 * the user saw it. Each drag gives its card once; null when the drag showed none.
 */
export function droppedDragCard(): DroppedCard | null {
  const last = lastCard;
  lastCard = null;
  return last ? { card: drawCard(last.face), cover: last.cover } : null;
}

/**
 * Lets go of the last card `ms` after its drag ended, unless another drag has begun: a drop that
 * arrives late (WebKit may send it well after `dragend`) can still use it until then.
 */
export function forgetDragCard(ms: number): void {
  const mine = lastCard;
  if (mine) window.setTimeout(() => { if (lastCard === mine) lastCard = null; }, ms);
}

/** Shakes a placed card's head and takes it away. */
function shakeAway(host: HTMLElement): void {
  host.dataset.refused = "true";
  host.querySelector<HTMLElement>(".kd-drag-ghost-hint")?.setAttribute("hidden", "");
  window.setTimeout(() => host.remove(), REFUSE_SHAKE_MS + REFUSE_FADE_MS + 40);
}

/**
 * The drag was let go at `point`, on a place that does not take what was dragged: the card
 * says no — it shakes its head two or three times where it is and fades. A card that follows
 * the pointer by hand does it itself when its owner takes it away in this same turn; for a
 * system drag, whose picture the system has already taken back, a copy does it at the point.
 * Under reduced motion the card only fades (DragGhost.css).
 */
export function refuseDragGhost(point: GhostPoint): void {
  if (liveGhost) {
    refusal = true;
    // The owner removes its card while it handles the same release; if it does not, forget it.
    window.setTimeout(() => { refusal = false; }, 0);
    return;
  }
  const dropped = droppedDragCard();
  if (!dropped) return;
  const host = document.createElement("div");
  host.className = "kd-drag-ghost";
  host.append(dropped.card);
  document.body.append(host);
  const centre = coverCentre(dropped.card);
  host.style.transform = `translate3d(${point.x + dropped.cover.x - centre.x}px, ${point.y + dropped.cover.y - centre.y}px, 0)`;
  shakeAway(host);
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
  const face = faceOf(content);
  const card = drawCard(face);
  const hint = card.querySelector<HTMLElement>(".kd-drag-ghost-hint");
  host.append(card);
  document.body.append(host);
  const move = (x: number, y: number) => { host.style.transform = `translate3d(${x + 10}px, ${y + 12}px, 0)`; };
  move(clientX, clientY);
  const centre = coverCentre(card);
  lastCard = { face, cover: { x: 10 + centre.x, y: 12 + centre.y } };
  liveGhost = host;
  return {
    move,
    hint(text) {
      if (!hint || (hint.hidden ? null : hint.textContent) === text) return;
      hint.hidden = !text;
      hint.textContent = text ?? "";
    },
    remove() {
      if (liveGhost === host) liveGhost = null;
      // Whoever handles this release (a drop into the downloads) takes the card in the same turn.
      forgetDragCard(0);
      if (refusal && host.isConnected) {
        refusal = false;
        shakeAway(host);
      } else {
        host.remove();
      }
    },
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
  const face = faceOf(content);
  const card = drawCard(face);
  stage.append(card);
  document.body.append(stage);
  try {
    // Forces layout: the picture is taken from what is laid out now.
    void stage.offsetWidth;
    dataTransfer.setDragImage(stage, 30, 32);
    // The pointer holds the picture at (30, 32) of the stage; the card starts at its padding.
    const style = getComputedStyle(stage);
    const centre = coverCentre(card);
    lastCard = { face, cover: { x: (parseFloat(style.paddingLeft) || 16) + centre.x - 30, y: (parseFloat(style.paddingTop) || 16) + centre.y - 32 } };
  } catch {
    // The browser's own picture is used instead.
  }
  const remove = () => stage.remove();
  requestAnimationFrame(remove);
  // A window in the background runs no frames.
  window.setTimeout(remove, 250);
}
