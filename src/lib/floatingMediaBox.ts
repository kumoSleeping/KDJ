/**
 * The floating media window: one remembered box shared by the video window and the visualizer
 * of the playing song. Pure geometry only; storage and DOM live in their own modules.
 *
 * Sharing rule. What is remembered is the rectangle the user last left on screen. Another
 * picture opens with that rectangle's WIDTH; its height follows its own aspect ratio. On each
 * axis the new rectangle keeps the edge of the remembered one that lies nearer to its side of
 * the viewport (ties keep left and top), then is clamped into the viewport. Opening never
 * changes what is remembered, so alternating between pictures cannot drift.
 */

export const FLOAT_MEDIA_STORAGE_KEY = "kdj.floatingMediaBoxV1";
export const FLOAT_MEDIA_MIN_WIDTH = 240;
export const FLOAT_MEDIA_MARGIN = 8;
export const FLOAT_MEDIA_DEFAULT_WIDTH = 352;

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatViewport {
  width: number;
  height: number;
}

/** What the window currently shows. */
export interface FloatContent {
  /** Picture width / height. */
  ratio: number;
  /** Fixed rows outside the picture (the title strip of an embedded platform player). */
  extraHeight?: number;
  minWidth?: number;
}

export type FloatResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const FLOAT_RESIZE_EDGES: readonly FloatResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function pictureRatio(content: FloatContent): number {
  return Number.isFinite(content.ratio) && content.ratio > 0 ? content.ratio : 16 / 9;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function floatWidthLimits(
  viewport: FloatViewport,
  content: FloatContent,
): { minimum: number; maximum: number } {
  const availableWidth = Math.max(1, viewport.width - FLOAT_MEDIA_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - FLOAT_MEDIA_MARGIN * 2 - (content.extraHeight ?? 0));
  const maximum = Math.min(availableWidth, availableHeight * pictureRatio(content));
  return { minimum: Math.min(Math.max(FLOAT_MEDIA_MIN_WIDTH, content.minWidth ?? 0), maximum), maximum };
}

function sized(width: number, viewport: FloatViewport, content: FloatContent): { w: number; h: number } {
  const { minimum, maximum } = floatWidthLimits(viewport, content);
  const w = clamp(width, minimum, maximum);
  return { w, h: w / pictureRatio(content) + (content.extraHeight ?? 0) };
}

function placed(x: number, y: number, w: number, h: number, viewport: FloatViewport): FloatRect {
  return {
    x: clamp(x, FLOAT_MEDIA_MARGIN, Math.max(FLOAT_MEDIA_MARGIN, viewport.width - w - FLOAT_MEDIA_MARGIN)),
    y: clamp(y, FLOAT_MEDIA_MARGIN, Math.max(FLOAT_MEDIA_MARGIN, viewport.height - h - FLOAT_MEDIA_MARGIN)),
    w,
    h,
  };
}

/** A rectangle the hand is moving: its own top-left corner is kept. */
export function fitFloatRect(rect: FloatRect, viewport: FloatViewport, content: FloatContent): FloatRect {
  const { w, h } = sized(rect.w, viewport, content);
  return placed(rect.x, rect.y, w, h, viewport);
}

/** Where a picture opens, given the remembered rectangle. See the sharing rule above. */
export function resolveFloatRect(remembered: FloatRect, viewport: FloatViewport, content: FloatContent): FloatRect {
  const { w, h } = sized(remembered.w, viewport, content);
  const keepRight = viewport.width - (remembered.x + remembered.w) < remembered.x;
  const keepBottom = viewport.height - (remembered.y + remembered.h) < remembered.y;
  return placed(
    keepRight ? remembered.x + remembered.w - w : remembered.x,
    keepBottom ? remembered.y + remembered.h - h : remembered.y,
    w,
    h,
    viewport,
  );
}

/** Nothing remembered yet: the corner above the right end of the player bar. */
export function defaultFloatRect(viewport: FloatViewport, playerBar = 60): FloatRect {
  const margin = 16;
  const w = FLOAT_MEDIA_DEFAULT_WIDTH;
  const h = (w * 9) / 16;
  return {
    x: Math.max(margin, viewport.width - w - margin),
    y: Math.max(margin, viewport.height - playerBar - margin - h - 8),
    w,
    h,
  };
}

/** Width follows the larger of the two pointer movements; the edge opposite the handle stays. */
export function resizeFloatRect(
  start: FloatRect,
  edge: FloatResizeEdge,
  dx: number,
  dy: number,
  viewport: FloatViewport,
  content: FloatContent,
): FloatRect {
  const horizontal = edge.includes("e") ? dx : edge.includes("w") ? -dx : 0;
  const vertical = (edge.includes("s") ? dy : edge.includes("n") ? -dy : 0) * pictureRatio(content);
  const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  const { w, h } = sized(start.w + delta, viewport, content);
  return placed(
    start.x + (edge.includes("w") ? start.w - w : 0),
    start.y + (edge.includes("n") ? start.h - h : 0),
    w,
    h,
    viewport,
  );
}

export interface StoredFloatRect {
  rect: FloatRect;
  /** Keys this build does not know; written back untouched. */
  extra: Record<string, unknown>;
}

export function parseStoredFloatRect(raw: string | null): StoredFloatRect | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { x, y, w, h, ...extra } = value as Record<string, unknown>;
    if (![x, y, w, h].every(part => typeof part === "number" && Number.isFinite(part))) return null;
    if ((w as number) <= 0 || (h as number) <= 0) return null;
    return { rect: { x: x as number, y: y as number, w: w as number, h: h as number }, extra };
  } catch {
    return null;
  }
}

export function serializeFloatRect(rect: FloatRect, extra: Record<string, unknown> = {}): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  return JSON.stringify({ ...extra, v: 1, x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) });
}

// ---------------------------------------------------------------------------------- motion

export type FloatEdge = "top" | "right" | "bottom" | "left";

/** Equal gaps (a window parked in a corner has two) go to the sides first, then the bottom. */
const EDGE_TIE_ORDER: readonly FloatEdge[] = ["right", "left", "bottom", "top"];
const EDGE_VECTOR: Record<FloatEdge, FloatOffset> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export interface FloatOffset {
  x: number;
  y: number;
}

/** Clearance past the viewport edge, so the window's shadow leaves with it. */
export const FLOAT_MOTION_PAD = 32;

export function floatEdgeGap(rect: FloatRect, viewport: FloatViewport, edge: FloatEdge): number {
  if (edge === "top") return rect.y;
  if (edge === "left") return rect.x;
  if (edge === "right") return viewport.width - (rect.x + rect.w);
  return viewport.height - (rect.y + rect.h);
}

/** The viewport edge the window is nearest to. Gaps are compared in whole pixels. */
export function nearestFloatEdge(rect: FloatRect, viewport: FloatViewport): FloatEdge {
  return EDGE_TIE_ORDER.reduce((nearest, edge) =>
    Math.round(floatEdgeGap(rect, viewport, edge)) < Math.round(floatEdgeGap(rect, viewport, nearest)) ? edge : nearest);
}

export interface FloatSlide {
  edge: FloatEdge;
  /** Translation that puts the window just outside that edge. */
  offset: FloatOffset;
}

/**
 * The way in and out: straight across the nearest edge of the place the window rests in.
 * `rect` is where it is now, which differs from `home` only when it was caught on the way.
 */
export function planFloatSlide(rect: FloatRect, viewport: FloatViewport, home: FloatRect = rect): FloatSlide {
  const edge = nearestFloatEdge(home, viewport);
  const extent = edge === "top" || edge === "bottom" ? rect.h : rect.w;
  const travel = Math.max(0, floatEdgeGap(rect, viewport, edge) + extent + FLOAT_MOTION_PAD);
  // `+ 0` keeps a zero component from becoming -0 in a keyframe.
  return { edge, offset: { x: EDGE_VECTOR[edge].x * travel + 0, y: EDGE_VECTOR[edge].y * travel + 0 } };
}
