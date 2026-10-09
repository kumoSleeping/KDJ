/**
 * The download parcel. When a download is started from something on screen, that block turns
 * into a small parcel, is thrown along a parabola and lands in the downloads drawer, which is
 * asked for first so that it is on its way down while the parcel flies. A drop starts the same
 * flight as a short hop from where the item was let go.
 *
 * The download itself never waits for any of this: callers enqueue as before and only tell the
 * toss that they did. While a parcel is in the air the drawer is held on the downloads (see
 * drawerHold.ts). Styles are in components/download/DownloadToss.css.
 */

import { coverTile, ghostGlyph, isElement, loadedCover } from "../components/common/dragGhost";
import { useDownloadStore } from "../stores/downloadStore";
import { useTaskPanelStore } from "../stores/taskPanelStore";
import { holdDrawer } from "./drawerHold";
import { useSidePanels } from "./sidePanels";
import { TOSS_LIFT_MS, TOSS_POP_MS, tossArc, tossFlightMs, tossRise, type TossPoint } from "./tossPath";

/** A rectangle on screen; a `DOMRect` is one. */
export interface TossBox { left: number; top: number; width: number; height: number }

export interface TossRequest {
  /**
   * Where the parcel starts: an element or its rectangle (the block that lifts off), or a point
   * (a drop: the parcel hops from there). Left out, it is where the user's hand last was — the
   * row or menu item that was clicked, or the point where a drag was let go.
   */
  from?: Element | TossBox | TossPoint | null;
  /** Written on the block that lifts off. */
  title?: string;
  /** A cover already on screen is preferred; this URL is only tried when none was found. */
  cover?: string;
  /** Several items go as one parcel with this count on it. */
  count?: number;
  /**
   * False leaves the drawer as it is and aims at the 下载 entry instead (a download started from
   * inside another drawer app must not put that app away).
   */
  open?: boolean;
}

export interface TossHandle {
  /** The enqueue failed: the parcel fades where it is and nothing is highlighted. */
  fail(): void;
}

/** The mark on a task row a parcel has just landed on, and on the list's head when no row came. */
export const TOSS_LANDED_ATTR = "data-kd-toss-landed";
export const TOSS_PULSE_ATTR = "data-kd-toss-pulse";

const DOWNLOADS_APP = "downloads";
const PARCEL_PX = 34;
/** Rapid adds may overlap, but only so many parcels fly at once; further ones only highlight. */
const MAX_PARCELS = 5;
const LAND_MS = 170;
const RING_MS = 380;
const HIGHLIGHT_MS = 1100;
/** A click this old no longer says where a download came from. */
const PRESS_FRESH_MS = 8000;
const DROP_FRESH_MS = 1500;

const ARROW = '<path d="M12 5.5v11"/><path d="m7 12 5 5 5-5"/>';
const HEART = '<path d="M7 5h4v2h2V5h4v2h2v6h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5V7h2z" fill="currentColor" stroke="none"/>';
const NOTE = '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>';

const NOOP: TossHandle = { fail() {} };

/* ------------------------------------------------------------------------------------------ */
/* Where the user's hand was                                                                    */
/* ------------------------------------------------------------------------------------------ */

interface Origin {
  /** The block that lifts off; null for a drop, which has only a point. */
  rect: Box | null;
  point: TossPoint;
  cover: HTMLImageElement | null;
  title: string;
}

interface Press extends Origin { at: number }

let lastPress: Press | null = null;
let lastDrag: (TossPoint & { at: number }) | null = null;
/** The row the last press or context menu was on: a menu item downloads that row. */
let menuRow: { cover: HTMLImageElement | null; title: string } | null = null;

interface Box extends TossBox { right: number; bottom: number }
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const centre = (rect: TossBox): TossPoint => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** The part of a table row that stands for the item: its cover and the start of its title. */
function rowBlock(row: Element): Box {
  const bounds = row.getBoundingClientRect();
  const thumb = row.querySelector(".kd-thumb")?.getBoundingClientRect();
  if (!thumb || thumb.width === 0) return box(bounds.left + 8, bounds.top, Math.min(220, bounds.width - 16), bounds.height);
  const text = row.querySelector(".kd-result-title-text, .kd-track-title, .kd-title-text")?.getBoundingClientRect();
  const left = thumb.left - 5;
  const right = Math.min(left + 240, Math.max(left + 110, (text && text.width > 0 ? text.right : thumb.right + 140) + 12));
  const height = Math.max(30, Math.min(bounds.height, thumb.height + 8));
  return box(left, thumb.top + thumb.height / 2 - height / 2, right - left, height);
}

function rowTitle(row: Element): string {
  return row.querySelector(".kd-result-title-text, .kd-track-title, .kd-title-text")?.textContent?.trim() ?? "";
}

function describePress(target: Element): Press {
  const at = performance.now();
  if (target.closest("[role='menu'], .kd-context-menu")) {
    const item = target.closest("button, [role^='menuitem']") ?? target;
    const rect = item.getBoundingClientRect();
    return { at, rect, point: centre(rect), cover: menuRow?.cover ?? null, title: menuRow?.title ?? "" };
  }
  const row = target.closest("tr");
  if (row?.closest("tbody")) {
    menuRow = { cover: loadedCover(row), title: rowTitle(row) };
    const rect = rowBlock(row);
    return { at, rect, point: centre(rect), ...menuRow };
  }
  const control = target.closest("button, [role='button'], a, label") ?? target;
  const rect = control.getBoundingClientRect();
  return { at, rect, point: centre(rect), cover: null, title: "" };
}

let tracking = false;
/** Remembers where the last press and the last drag point were. Cheap, passive, installed once. */
function trackHand(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  const press = (event: Event) => {
    if (isElement(event.target)) lastPress = describePress(event.target);
  };
  const dragged = (event: MouseEvent) => {
    lastDrag = { x: event.clientX, y: event.clientY, at: performance.now() };
  };
  const options = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", press, options);
  window.addEventListener("click", press, options);
  window.addEventListener("contextmenu", event => {
    const row = isElement(event.target) ? event.target.closest("tbody tr") : null;
    if (row) menuRow = { cover: loadedCover(row), title: rowTitle(row) };
  }, options);
  // A shortcut has no place on screen; a key that presses a button is followed by its click.
  window.addEventListener("keydown", () => { lastPress = null; }, options);
  window.addEventListener("dragover", dragged, options);
  window.addEventListener("drop", dragged, options);
  const pointerDragged = (event: PointerEvent) => {
    const flags = document.body.dataset;
    if (flags.kdSearchPointerDragging || flags.kdTrackPointerDragging) dragged(event);
  };
  window.addEventListener("pointermove", pointerDragged, options);
  window.addEventListener("pointerup", pointerDragged, options);
}
trackHand();

function isPoint(value: unknown): value is TossPoint {
  return typeof value === "object" && value !== null && !("width" in value) && "x" in value && "y" in value;
}

function resolveOrigin(request: TossRequest): Origin | null {
  const title = request.title?.trim() ?? "";
  const from = request.from;
  if (isElement(from)) {
    const row = from.closest("tbody tr");
    const rect = row ? rowBlock(row) : from.getBoundingClientRect();
    return { rect, point: centre(rect), cover: loadedCover(row ?? from), title: title || (row ? rowTitle(row) : "") };
  }
  if (isPoint(from)) return { rect: null, point: { x: from.x, y: from.y }, cover: null, title };
  if (from) return { rect: box(from.left, from.top, from.width, from.height), point: centre(from), cover: null, title };
  const now = performance.now();
  const press = lastPress && now - lastPress.at < PRESS_FRESH_MS ? lastPress : null;
  const drag = lastDrag && now - lastDrag.at < DROP_FRESH_MS ? lastDrag : null;
  if (drag && (!press || drag.at > press.at)) return { rect: null, point: { x: drag.x, y: drag.y }, cover: null, title };
  if (!press || !press.rect || press.rect.width === 0) return null;
  return { rect: press.rect, point: press.point, cover: press.cover, title: title || press.title };
}

/* ------------------------------------------------------------------------------------------ */
/* Where the parcel lands                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The rectangle an element will have once the motion it is caught in has ended. The drawer's
 * sheet and what is written on it arrive by translation only, so the translation of every
 * ancestor that is still animating is taken off.
 */
function settledRect(element: Element): Box {
  const rect = element.getBoundingClientRect();
  let dx = 0, dy = 0;
  for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
    if (!node.getAnimations().some(animation => animation.playState === "running")) continue;
    const transform = getComputedStyle(node).transform;
    if (!transform || transform === "none") continue;
    const matrix = new DOMMatrixReadOnly(transform);
    if (!matrix.is2D || Math.abs(matrix.a - 1) > 0.001 || Math.abs(matrix.d - 1) > 0.001 || matrix.b !== 0 || matrix.c !== 0) continue;
    dx += matrix.e;
    dy += matrix.f;
  }
  return box(rect.left - dx, rect.top - dy, rect.width, rect.height);
}

/** How long the sheet itself still moves. */
function sheetLeftMs(drawer: Element): number {
  let left = 0;
  for (const animation of drawer.getAnimations()) {
    if (animation.playState !== "running") continue;
    const end = Number(animation.effect?.getComputedTiming().endTime);
    if (Number.isFinite(end)) left = Math.max(left, end - Number(animation.currentTime ?? 0));
  }
  return left;
}

const shownDrawer = () => document.querySelector(`.kd-drawer[data-app="${DOWNLOADS_APP}"]:not([data-leaving])`);

/** The rows of tasks that did not exist when the toss began. */
function newRows(before: ReadonlySet<string>, within: ParentNode = document): HTMLElement[] {
  return Array.from(within.querySelectorAll<HTMLElement>(".kd-download-task[data-task-id]"))
    .filter(row => !before.has(row.dataset.taskId ?? "") && !row.closest(".kd-slide-ghost, [data-leaving]"));
}

/** Scrolls the list just far enough for a row to be in view. Never touches another scroller. */
function revealRow(list: HTMLElement, row: HTMLElement): void {
  const top = row.offsetTop - list.offsetTop;
  if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  else if (top < list.scrollTop) list.scrollTop = top;
}

interface Landing { point: TossPoint; sheetLeftMs: number }

function findLanding(open: boolean, before: ReadonlySet<string>): Landing | null {
  const drawer = open ? shownDrawer() : null;
  if (drawer) {
    const left = sheetLeftMs(drawer);
    const list = Array.from(drawer.querySelectorAll<HTMLElement>(".kd-download-dropzone:not([data-history]) .kd-download-task-list"))
      .find(node => !node.closest(".kd-slide-ghost, [hidden]"));
    if (list) {
      const box = settledRect(list);
      const row = newRows(before, list)[0];
      if (row) {
        revealRow(list, row);
        const at = settledRect(row.querySelector(".kd-download-task-cover") ?? row);
        return { point: { x: at.left + at.width / 2, y: Math.min(box.bottom - 16, Math.max(box.top + 16, at.top + at.height / 2)) }, sheetLeftMs: left };
      }
      // No row yet: where the next one goes, after the last row or at the top of an empty list.
      const rows = list.querySelectorAll<HTMLElement>(":scope > .kd-download-task");
      const last = rows.length ? settledRect(rows[rows.length - 1]) : null;
      const cover = rows.length ? settledRect(rows[rows.length - 1].querySelector(".kd-download-task-cover") ?? rows[rows.length - 1]) : null;
      return {
        point: {
          x: cover ? cover.left + cover.width / 2 : box.left + Math.min(58, box.width / 2),
          y: Math.min(box.bottom - 24, Math.max(box.top + 30, last ? last.bottom + 30 : box.top + 34)),
        },
        sheetLeftMs: left,
      };
    }
    const head = drawer.querySelector(".kd-title-tabs");
    if (head) {
      const box = settledRect(head);
      return { point: { x: box.left + Math.min(48, box.width / 2), y: box.top + box.height / 2 }, sheetLeftMs: left };
    }
  }
  const entry = document.querySelector(`[data-drawer-entry="${DOWNLOADS_APP}"]`) ?? document.querySelector('[data-kd-search-queue-drop="entry"]');
  const box = entry?.getBoundingClientRect();
  return box && box.width > 0 ? { point: centre(box), sheetLeftMs: 0 } : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Landing marks                                                                                */
/* ------------------------------------------------------------------------------------------ */

function mark(element: HTMLElement, attribute: string, ms: number, startedAt: number): void {
  if (element.hasAttribute(attribute)) return;
  // A row that replaces an earlier one (the server's task for a provisional one) joins the same
  // highlight part-way instead of starting it again.
  element.style.setProperty("--kd-toss-at", `${Math.round(startedAt - performance.now())}ms`);
  element.setAttribute(attribute, "");
  window.setTimeout(() => {
    element.removeAttribute(attribute);
    element.style.removeProperty("--kd-toss-at");
  }, Math.max(0, startedAt + ms - performance.now()));
}

/**
 * Highlights the rows of the tasks added since `before` as they appear. When none has come by
 * the time the highlight would be over, the head of the list answers instead.
 */
function highlightAdded(before: ReadonlySet<string>, cancelled: () => boolean): void {
  const startedAt = performance.now();
  let found = false;
  const look = () => {
    if (cancelled()) return;
    for (const row of newRows(before)) {
      if (!found) {
        const list = row.closest<HTMLElement>(".kd-download-task-list");
        if (list) revealRow(list, row);
      }
      found = true;
      mark(row, TOSS_LANDED_ATTR, HIGHLIGHT_MS, startedAt);
    }
  };
  look();
  const stop = useDownloadStore.subscribe(() => { requestAnimationFrame(look); });
  window.setTimeout(() => {
    stop();
    if (found || cancelled()) return;
    const head = shownDrawer()?.querySelector<HTMLElement>(".kd-download-summary");
    if (head) mark(head, TOSS_PULSE_ATTR, 620, performance.now());
  }, HIGHLIGHT_MS - 200);
}

/* ------------------------------------------------------------------------------------------ */
/* The parcel                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function part(className: string, ...children: (Node | null)[]): HTMLElement {
  const node = document.createElement("span");
  node.className = className;
  node.append(...children.filter((child): child is Node => child !== null));
  return node;
}

function icon(className: string, paths: string, size: number): SVGSVGElement {
  const svg = ghostGlyph(paths, size);
  svg.setAttribute("class", className);
  return svg;
}

/** A cover from a URL, shown only once it has loaded. */
function remoteCover(url: string | undefined, into: HTMLElement): void {
  if (!url?.trim()) return;
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.onload = () => into.replaceChildren(image);
  image.src = url;
}

function buildParcel(origin: Origin, request: TossRequest, count: number): { host: HTMLElement; body: HTMLElement; chip: HTMLElement | null; parcel: HTMLElement } {
  const label = count === 1 ? coverTile(origin.cover, 16) : null;
  const parcel = part("kd-toss-parcel",
    part("kd-toss-parcel-lid"),
    icon("kd-toss-arrow", ARROW, 20),
    icon("kd-toss-heart", HEART, 20),
    label && part("kd-toss-parcel-label", label),
    count > 1 ? part("kd-toss-count") : null);
  const badge = parcel.querySelector(".kd-toss-count");
  if (badge) badge.textContent = count > 99 ? "99+" : String(count);

  let chip: HTMLElement | null = null;
  if (origin.rect) {
    const tile = coverTile(origin.cover, 28);
    const cover = part("kd-toss-chip-cover", tile ?? icon("", NOTE, 15));
    if (!tile) remoteCover(request.cover, cover);
    const text = count > 1 ? `${count} 个任务` : origin.title;
    chip = part("kd-toss-chip", cover, text ? part("kd-toss-chip-title", document.createTextNode(text)) : null);
    // The block keeps the place and size of what was clicked; a bare icon button gets room for the title.
    const width = Math.min(240, Math.max(origin.rect.width, text ? 132 : 40));
    const height = Math.min(44, Math.max(30, origin.rect.height));
    Object.assign(chip.style, { width: `${width}px`, height: `${height}px`, left: `${-width / 2}px`, top: `${-height / 2}px` });
    chip.style.setProperty("--kd-toss-shrink", String(PARCEL_PX / width));
  }
  const body = part("kd-toss-body", chip, parcel);
  const host = document.createElement("div");
  host.className = "kd-toss";
  host.setAttribute("aria-hidden", "true");
  host.append(body);
  return { host, body, chip, parcel };
}

const place = (point: TossPoint) => `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;

let airborne = 0;

function fly(origin: Origin, request: TossRequest, count: number, before: ReadonlySet<string>, release: () => void): TossHandle {
  const open = request.open !== false;
  const hop = origin.rect === null;
  const { host, body, chip, parcel } = buildParcel(origin, request, count);
  let ended = false;
  let failed = false;
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(guard);
    host.remove();
    airborne -= 1;
    release();
  };
  // Whatever happens to the animations (a tab in the background, a cancelled effect), the
  // parcel is taken away and the drawer let go.
  const guard = window.setTimeout(end, 2400);
  airborne += 1;
  host.style.transform = place(origin.point);
  document.body.append(host);

  const liftMs = hop ? TOSS_POP_MS : TOSS_LIFT_MS;
  const lifted = { x: origin.point.x, y: origin.point.y - (hop ? 0 : 8) };
  host.animate([{ transform: place(origin.point) }, { transform: place(lifted) }],
    { duration: liftMs, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "forwards" });
  // The block gathers itself and shrinks away; the parcel comes up in its place as it goes.
  chip?.animate([
    { transform: "scale(1)", opacity: 1 },
    { transform: "scale(1.04)", opacity: 1, offset: 0.3 },
    { transform: `scale(${chip.style.getPropertyValue("--kd-toss-shrink")})`, opacity: 0 },
  ], { duration: liftMs, easing: "cubic-bezier(0.5, 0, 0.6, 1)", fill: "forwards" });
  const pop = "cubic-bezier(0.2, 0.9, 0.3, 1.25)";
  const appear = parcel.animate(hop ? [
    { transform: "scale(0.4)", opacity: 0, easing: pop },
    { transform: "scale(1)", opacity: 1 },
  ] : [
    { transform: "scale(0.4)", opacity: 0 },
    { transform: "scale(0.45)", opacity: 0, offset: 0.4, easing: pop },
    { transform: "scale(1)", opacity: 1 },
  ], { duration: liftMs, fill: "both" });

  const fade = () => {
    if (ended) return;
    host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" }).finished.then(end, end);
  };

  const land = (at: TossPoint) => {
    if (ended) return;
    const ring = part("kd-toss-ring");
    ring.style.transform = place(at);
    const wave = part("kd-toss-ring-wave");
    ring.append(wave);
    document.body.append(ring);
    const gone = () => ring.remove();
    wave.animate([{ transform: "scale(0.35)", opacity: 0.55 }, { transform: "scale(1.5)", opacity: 0 }],
      { duration: RING_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }).finished.then(gone, gone);
    window.setTimeout(gone, RING_MS + 400);
    if (open) highlightAdded(before, () => failed);
    // The squash keeps the tilt the parcel arrived with, so it does not snap upright first.
    const tilt = getComputedStyle(body).transform;
    const arrived = tilt && tilt !== "none" ? tilt : "scale(0.84)";
    body.animate([
      { transform: arrived, opacity: 1 },
      { transform: "translateY(4px) scale(1.14, 0.6)", opacity: 1, offset: 0.45 },
      { transform: "translateY(6px) scale(0.6, 0.3)", opacity: 0 },
    ], { duration: LAND_MS, easing: "cubic-bezier(0.3, 0, 0.5, 1)", fill: "forwards" }).finished.then(end, end);
  };

  const launch = () => {
    if (ended || failed) return;
    const landing = findLanding(open, before);
    if (!landing) { fade(); return; }
    const distance = Math.hypot(landing.point.x - lifted.x, landing.point.y - lifted.y);
    const arc = tossArc(lifted, landing.point, tossRise(lifted, landing.point, hop));
    const duration = tossFlightMs(distance, landing.sheetLeftMs, hop);
    const turn = landing.point.x >= lifted.x ? 1 : -1;
    body.animate([
      { transform: `rotate(${-7 * turn}deg) scale(1)` },
      { transform: `rotate(${16 * turn}deg) scale(0.84)` },
    ], { duration, easing: "cubic-bezier(0.3, 0, 0.7, 1)", fill: "forwards" });
    host.animate(arc.map(step => ({ transform: place({ x: lifted.x + step.x, y: lifted.y + step.y }) })),
      { duration, easing: "linear", fill: "forwards" }).finished.then(() => land(landing.point), end);
  };
  appear.finished.then(launch, end);

  return {
    fail() {
      if (failed) return;
      failed = true;
      fade();
    },
  };
}

/**
 * Throws a parcel into the downloads. Call it at the moment a download is started; it returns
 * at once and never delays the download.
 */
export function tossToDownloads(request: TossRequest = {}): TossHandle {
  if (typeof document === "undefined") return NOOP;
  const open = request.open !== false;
  const before = new Set(useDownloadStore.getState().tasks.keys());
  if (open) {
    useTaskPanelStore.getState().setView("downloads");
    useSidePanels.getState().setDownloads(true);
  }
  const origin = resolveOrigin(request);
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // A source that is not on screen (a pane scrolled or switched away) has nothing to lift off.
  const onScreen = origin !== null && origin.point.x >= 0 && origin.point.x <= window.innerWidth
    && origin.point.y >= 0 && origin.point.y <= window.innerHeight;
  if (!origin || !onScreen || still || airborne >= MAX_PARCELS) {
    // Nothing flies: the drawer opens and the new task appears highlighted.
    let failed = false;
    if (open) highlightAdded(before, () => failed);
    return { fail() { failed = true; } };
  }
  return fly(origin, request, Math.max(1, Math.floor(request.count ?? 1)), before, open ? holdDrawer(DOWNLOADS_APP) : () => undefined);
}
