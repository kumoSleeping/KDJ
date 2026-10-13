/**
 * The download parcel. When a download is started from something on screen, that block turns
 * into a small parcel, is thrown along a parabola and lands in the downloads drawer, which is
 * asked for first so that it is on its way while the parcel flies. A drop starts the same
 * flight as a short hop from where the item was let go — and there the card that was dragged
 * hops in as itself instead of turning into a parcel.
 *
 * A batch (several selected rows, a whole collection) gathers first: the covers of its rows that
 * are on screen travel to the source and stack there, the parcel comes up out of the stack with
 * the count on it, and only then it is thrown. Rows that are not on screen are the count alone;
 * nothing is built or loaded for them. One item, and a drop, are as described above.
 *
 * The download belongs to the landing. A caller starts the toss, waits for `ready` and only then
 * hands the download to the queue: `ready` resolves shortly before touchdown (tossPath.ts,
 * TOSS_HANDOVER_LEAD_MS), so the new row is in the list when the parcel arrives and not while it
 * is still in the air. A picture's export goes the same way into the exports queue (`to`). `ready`
 * always resolves, and once: at once when nothing flies (no source
 * on screen, reduced motion, a hidden window, too many parcels), early when the flight ends for
 * any other reason, when the window is hidden or about to go, and after a fixed limit at the
 * latest. While a parcel is in the air the drawer is held on the downloads (see drawerHold.ts),
 * which covers the handover. Styles are in components/download/DownloadToss.css.
 */

import { coverTile, droppedDragCard, ghostGlyph, isElement, loadedCover, type DroppedCard } from "../components/common/dragGhost";
import { useDownloadStore } from "../stores/downloadStore";
import { useTaskPanelStore, type TaskPanelView } from "../stores/taskPanelStore";
import { useVisualizerExportStore } from "../stores/visualizerExportStore";
import { useWorkshopStore } from "../stores/workshopStore";
import "./dragRefusal";
import { holdDrawer } from "./drawerHold";
import { useSidePanels } from "./sidePanels";
import {
  flushTossHandovers, SHEET_DOWN_MS, SHEET_SWAP_MS, TOSS_GATHER_MS, TOSS_LIFT_MS, TOSS_POP_MS, TOSS_FLIGHT_EASING, tossArc, tossFlightMs, tossGatherPick,
  tossGatherPlan, tossHandover, tossHandoverAt, tossRise,
  type TossHandover, type TossPoint,
} from "./tossPath";

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
   * The items of a batch, as `tossItemKey` names them. The rows on screen that carry one of
   * them (TOSS_ITEM_ATTR) gather into the parcel before it is thrown.
   */
  gather?: readonly string[];
  /**
   * False leaves the drawer as it is and aims at the 下载 entry instead (a download started from
   * inside another drawer app must not put that app away).
   */
  open?: boolean;
  /** Which queue the parcel is for: the downloads (the default) or the exports. */
  to?: TossTarget;
}

/** Where a parcel is going: the downloads queue, or the exports queue (a picture's export). */
export type TossTarget = "downloads" | "exports";
interface Target {
  view: TaskPanelView;
  /** The ids of the rows the queue has now: the parcel lands on one added since. */
  before(): Set<string>;
  /** Hears of the queue's rows changing. */
  subscribe(listener: () => void): () => void;
  /** The queue's list in the drawer, as shown. */
  list(drawer: Element): HTMLElement | null;
  /** The list builds only the rows around its viewport: a row that joins at the end is built once the list is scrolled there. */
  windowed: boolean;
}
const TARGETS: Record<TossTarget, Target> = {
  downloads: {
    view: "downloads",
    before: () => new Set(useDownloadStore.getState().tasks.keys()),
    subscribe: listener => useDownloadStore.subscribe(listener),
    list: drawer => Array.from(drawer.querySelectorAll<HTMLElement>(".kd-download-dropzone:not([data-history]) .kd-download-task-list"))
      .find(node => !node.closest(".kd-slide-ghost, [hidden]")) ?? null,
    windowed: false,
  },
  exports: {
    view: "exports",
    // The exports list has the workshop's projects and jobs beside the pictures: none of them is new.
    before: () => {
      const workshop = useWorkshopStore.getState();
      return new Set([...useVisualizerExportStore.getState().tasks.map(task => task.id), ...workshop.jobs.map(job => job.id), ...workshop.projects.map(project => project.id)]);
    },
    subscribe: listener => useVisualizerExportStore.subscribe(listener),
    list: drawer => Array.from(drawer.querySelectorAll<HTMLElement>(".kd-download-task-list"))
      .find(node => !node.closest(".kd-slide-ghost, [hidden], [data-drawer-pending]")) ?? null,
    windowed: true,
  },
};

export interface TossHandle {
  /**
   * Resolves when the download is to be handed to the queue: shortly before the parcel lands,
   * or at once when nothing flies. It always resolves, exactly once; await it and then enqueue.
   */
  readonly ready: Promise<void>;
  /** The enqueue failed: the parcel fades where it is and nothing is highlighted. */
  fail(): void;
}

/** Written on a row that stands for something downloadable: what a batch knows the row by. */
export const TOSS_ITEM_ATTR = "data-kd-toss-item";
/** The name of a source in a batch and on its row. */
export function tossItemKey(source: { platform: string; key: string }): string {
  return `${source.platform}:${source.key}`;
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

const NOOP: TossHandle = { ready: Promise.resolve(), fail() {} };

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
  const row = target.closest(".kd-list-row");
  if (row) {
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
    const row = isElement(event.target) ? event.target.closest(".kd-list-row") : null;
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
  // A hidden window runs its timers late or not at all, and a closing one never: downloads
  // that still wait for their parcels are handed over now.
  window.addEventListener("pagehide", flushTossHandovers);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushTossHandovers(); });
}
trackHand();

function isPoint(value: unknown): value is TossPoint {
  return typeof value === "object" && value !== null && !("width" in value) && "x" in value && "y" in value;
}

function resolveOrigin(request: TossRequest): Origin | null {
  const title = request.title?.trim() ?? "";
  const from = request.from;
  if (isElement(from)) {
    const row = from.closest(".kd-list-row");
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

/**
 * Where the parcel lands, as far as it can be told now: on the row of a task added since
 * `before` if there is one, else where the next row will go (after the last row, or at the top
 * of an empty list), else on the drawer's title row, else on the 下载 entry. The download is
 * handed over late in the flight, so "where the next row will go" is the usual answer at launch;
 * the flight asks again while it is under way (see `fly`) and corrects its end.
 */
function findLanding(open: boolean, before: ReadonlySet<string>, target: Target): Landing | null {
  const drawer = open ? shownDrawer() : null;
  if (drawer) {
    const left = sheetLeftMs(drawer);
    const list = target.list(drawer);
    if (list) {
      const box = settledRect(list);
      const row = newRows(before, list)[0];
      // The next row joins at the end: a windowed list is scrolled there so that it builds it.
      if (!row && target.windowed) list.scrollTop = list.scrollHeight;
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
function highlightAdded(before: ReadonlySet<string>, cancelled: () => boolean, target: Target): void {
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
    if (found || !target.windowed) return;
    // Not built yet: the new row is at the end of a windowed list, which builds it once it is there.
    const drawer = shownDrawer();
    const list = drawer ? target.list(drawer) : null;
    if (list) list.scrollTop = list.scrollHeight;
  };
  look();
  const stop = target.subscribe(() => { requestAnimationFrame(look); });
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

/** What flies: the element placed along the arc, the one corrected towards a moved target, and the one that turns and shrinks. */
interface Flyer {
  host: HTMLElement;
  aim: HTMLElement;
  body: HTMLElement;
  /** The block at the source that turns into the parcel; null for a hop. */
  chip: HTMLElement | null;
  /** The parcel, or the dragged card when that hops in as itself. */
  cargo: HTMLElement;
  card: boolean;
}

function flyer(chip: HTMLElement | null, cargo: HTMLElement, card: boolean): Flyer {
  const body = part("kd-toss-body", chip, cargo);
  const aim = part("kd-toss-aim", body);
  const host = document.createElement("div");
  host.className = "kd-toss";
  host.setAttribute("aria-hidden", "true");
  host.append(aim);
  return { host, aim, body, chip, cargo, card };
}

/* ------------------------------------------------------------------------------------------ */
/* A batch gathers                                                                              */
/* ------------------------------------------------------------------------------------------ */

const TILE_PX = 26;

interface GatherSource { at: TossPoint; cover: HTMLImageElement | null }

/** The part of the window in which rows of `row`'s list can be seen: its scroller, below the sticky head. */
function listBand(row: Element): Box {
  const scroller = row.closest(".kd-scroll");
  const bounds = scroller?.getBoundingClientRect() ?? box(0, 0, window.innerWidth, window.innerHeight);
  const head = row.closest("table")?.tHead?.offsetHeight ?? 0;
  const top = Math.max(0, bounds.top + head);
  const left = Math.max(0, bounds.left);
  return box(left, top, Math.min(window.innerWidth, bounds.right) - left, Math.min(window.innerHeight, bounds.bottom) - top);
}

/**
 * The rows of a batch that are on screen, as the place of each one's cover. Read once, before
 * anything moves; rows outside the list's visible part are left alone.
 */
function gatherSources(keys: readonly string[] | undefined): GatherSource[] {
  if (!keys || keys.length < 2) return [];
  const wanted = new Set(keys);
  const seen: { row: Element; at: TossPoint }[] = [];
  let band: Box | null = null;
  for (const row of document.querySelectorAll(`.kd-list-row[${TOSS_ITEM_ATTR}]`)) {
    if (!wanted.has(row.getAttribute(TOSS_ITEM_ATTR) ?? "")) continue;
    band ??= listBand(row);
    const rect = (row.querySelector(".kd-thumb") ?? row).getBoundingClientRect();
    const at = centre(rect);
    if (rect.width === 0 || at.y < band.top || at.y > band.bottom || at.x < band.left || at.x > band.right) continue;
    seen.push({ row, at });
  }
  // Only the covers that will travel are looked for and copied.
  return tossGatherPick(seen.length).map(index => ({ at: seen[index].at, cover: loadedCover(seen[index].row) }));
}

/**
 * The covers of a batch travel to `to` and stack there; the stack sinks into the parcel that
 * comes up over it. Pictures only: one inert layer, removed when the gesture is over.
 */
function gatherInto(to: TossPoint, sources: readonly GatherSource[]): void {
  const layer = document.createElement("div");
  layer.className = "kd-toss-gather";
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("inert", "");
  // The nearest cover leaves first, so the stack grows from the source outwards.
  const ordered = [...sources].sort((a, b) => Math.hypot(a.at.x - to.x, a.at.y - to.y) - Math.hypot(b.at.x - to.x, b.at.y - to.y));
  const sinkAt = TOSS_GATHER_MS - TOSS_POP_MS;
  const sunk: Promise<unknown>[] = [];
  tossGatherPlan(ordered.length).forEach((step, index) => {
    const { at, cover } = ordered[index];
    const face = part("kd-toss-tile-face", coverTile(cover, TILE_PX) ?? icon("", NOTE, 14));
    const tile = part("kd-toss-tile", face);
    tile.style.transform = place(at);
    layer.append(tile);
    const rest = { x: to.x + step.x, y: to.y + step.y };
    tile.animate([{ transform: place(at) }, { transform: place(rest) }],
      { duration: step.duration, delay: step.delay, easing: "cubic-bezier(0.5, 0, 0.2, 1)", fill: "both" });
    // It lifts off its row, tilts into its place in the fan, and sinks into the parcel at the end.
    const arrived = (step.delay + step.duration) / TOSS_GATHER_MS;
    const settled = `rotate(${step.turn}deg) scale(0.85)`;
    sunk.push(face.animate([
      { transform: "rotate(0deg) scale(1)", opacity: 1, offset: 0 },
      { transform: "rotate(0deg) scale(1.12)", opacity: 1, offset: Math.min(arrived * 0.4, 0.2) + step.delay / TOSS_GATHER_MS, easing: "ease-out" },
      { transform: settled, opacity: 1, offset: Math.min(arrived, sinkAt / TOSS_GATHER_MS) },
      { transform: settled, opacity: 1, offset: sinkAt / TOSS_GATHER_MS, easing: "ease-in" },
      { transform: `rotate(${step.turn}deg) scale(0.4)`, opacity: 0, offset: 1 },
    ], { duration: TOSS_GATHER_MS, easing: "linear", fill: "both" }).finished);
  });
  document.body.append(layer);
  // Gone when the last cover has sunk into the parcel — and in any case, like the parcel itself.
  const gone = () => layer.remove();
  Promise.all(sunk).then(gone, gone);
  window.setTimeout(gone, 2400);
}

function buildParcel(origin: Origin, request: TossRequest, count: number, gathering = false): Flyer {
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
  // A batch that gathers needs no block at the source: its covers are what turns into the parcel.
  if (origin.rect && !gathering) {
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
  return flyer(chip, parcel, false);
}

/** The card that was dragged, hung by the centre of its cover: that is the point that flies and lands. */
function buildCard(dropped: DroppedCard): Flyer {
  return flyer(null, part("kd-toss-card", dropped.card), true);
}

const place = (point: TossPoint) => `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;

let airborne = 0;

function fly(origin: Origin, request: TossRequest, count: number, before: ReadonlySet<string>, handover: TossHandover, release: () => void, target: Target): TossHandle {
  const open = request.open !== false;
  const hop = origin.rect === null;
  // A drop: the card the user was holding goes on from where it was let go.
  const dropped = hop ? droppedDragCard() : null;
  // Several items started from something on screen: their covers gather first. A drop already
  // holds its items in one card.
  const gathered = hop ? [] : gatherSources(count > 1 ? request.gather : undefined);
  const gathering = gathered.length > 0;
  const { host, aim, body, chip, cargo, card } = dropped ? buildCard(dropped) : buildParcel(origin, request, count, gathering);
  const start = dropped ? { x: origin.point.x + dropped.cover.x, y: origin.point.y + dropped.cover.y } : origin.point;
  let ended = false;
  let failed = false;
  let stopAiming = () => undefined as void;
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(guard);
    stopAiming();
    host.remove();
    airborne -= 1;
    // A flight that ends without having reached its handover (cancelled animations, nowhere to
    // land) still delivers the download.
    handover.deliver();
    release();
  };
  // Whatever happens to the animations (a tab in the background, a cancelled effect), the
  // parcel is taken away and the drawer let go.
  const guard = window.setTimeout(end, 2400);
  airborne += 1;
  host.style.transform = place(start);
  document.body.append(host);

  const liftMs = hop ? TOSS_POP_MS : gathering ? TOSS_GATHER_MS : TOSS_LIFT_MS;
  const lifted = { x: start.x, y: start.y - (hop ? 0 : 8) };
  if (gathering) gatherInto(start, gathered);
  host.animate([{ transform: place(start) }, { transform: place(lifted) }],
    { duration: liftMs, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "forwards" });
  // The block gathers itself and shrinks away; the parcel comes up in its place as it goes.
  chip?.animate([
    { transform: "scale(1)", opacity: 1 },
    { transform: "scale(1.04)", opacity: 1, offset: 0.3 },
    { transform: `scale(${chip.style.getPropertyValue("--kd-toss-shrink")})`, opacity: 0 },
  ], { duration: liftMs, easing: "cubic-bezier(0.5, 0, 0.6, 1)", fill: "forwards" });
  const pop = "cubic-bezier(0.2, 0.9, 0.3, 1.25)";
  const appear = cargo.animate(card ? [
    // Already in the hand, and seen: it only gathers itself for the hop.
    { transform: "scale(1)", opacity: 1 },
    { transform: "scale(0.96)", opacity: 1 },
  ] : hop ? [
    { transform: "scale(0.4)", opacity: 0, easing: pop },
    { transform: "scale(1)", opacity: 1 },
  ] : gathering ? [
    // Nothing to see until the covers have stacked; then it comes up out of the stack.
    { transform: "scale(0.4)", opacity: 0 },
    { transform: "scale(0.4)", opacity: 0, offset: 1 - TOSS_POP_MS / TOSS_GATHER_MS, easing: pop },
    { transform: "scale(1)", opacity: 1 },
  ] : [
    { transform: "scale(0.4)", opacity: 0 },
    { transform: "scale(0.45)", opacity: 0, offset: 0.4, easing: pop },
    { transform: "scale(1)", opacity: 1 },
  ], { duration: liftMs, fill: "both" });

  const fade = () => {
    if (ended) return;
    // Nothing will land: the download does not wait for the fade.
    handover.deliver();
    host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" }).finished.then(end, end);
  };

  const land = (at: TossPoint) => {
    if (ended) return;
    stopAiming();
    const ring = part("kd-toss-ring");
    ring.style.transform = place(at);
    const wave = part("kd-toss-ring-wave");
    ring.append(wave);
    document.body.append(ring);
    const gone = () => ring.remove();
    wave.animate([{ transform: "scale(0.35)", opacity: 0.55 }, { transform: "scale(1.5)", opacity: 0 }],
      { duration: RING_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }).finished.then(gone, gone);
    window.setTimeout(gone, RING_MS + 400);
    if (open) highlightAdded(before, () => failed, target);
    // The squash keeps the tilt and size it arrived with, so it does not snap upright first.
    const tilt = getComputedStyle(body).transform;
    const arrived = tilt && tilt !== "none" ? tilt : "scale(0.84)";
    body.animate(card ? [
      { transform: arrived, opacity: 1 },
      { transform: "translateY(3px) scale(0.5, 0.34)", opacity: 1, offset: 0.45 },
      { transform: "translateY(5px) scale(0.3, 0.16)", opacity: 0 },
    ] : [
      { transform: arrived, opacity: 1 },
      { transform: "translateY(4px) scale(1.14, 0.6)", opacity: 1, offset: 0.45 },
      { transform: "translateY(6px) scale(0.6, 0.3)", opacity: 0 },
    ], { duration: LAND_MS, easing: "cubic-bezier(0.3, 0, 0.5, 1)", fill: "forwards" }).finished.then(end, end);
  };

  const launch = () => {
    if (ended || failed) return;
    const landing = findLanding(open, before, target);
    if (!landing) { fade(); return; }
    // The drawer was asked for but its panel is not there yet: it has its whole way to come, and
    // when another app's panel is still out, that one leaves first.
    const swapping = document.querySelector(".kd-drawer") !== null;
    const sheetLeft = landing.sheetLeftMs || (open && !shownDrawer() ? SHEET_DOWN_MS + (swapping ? SHEET_SWAP_MS : 0) : 0);
    const distance = Math.hypot(landing.point.x - lifted.x, landing.point.y - lifted.y);
    const arc = tossArc(lifted, landing.point, tossRise(lifted, landing.point, hop));
    const duration = tossFlightMs(distance, sheetLeft, hop);
    const turn = landing.point.x >= lifted.x ? 1 : -1;
    body.animate(card ? [
      // The card keeps its own tilt; it leans a little into the hop and is smaller when it lands.
      { transform: "rotate(0deg) scale(1)" },
      { transform: `rotate(${5 * turn}deg) scale(0.62)` },
    ] : [
      { transform: `rotate(${-7 * turn}deg) scale(1)` },
      { transform: `rotate(${16 * turn}deg) scale(0.84)` },
    ], { duration, easing: card ? "cubic-bezier(0.5, 0, 0.8, 0.7)" : "cubic-bezier(0.3, 0, 0.7, 1)", fill: "forwards" });
    // Parameterize by distance, not ballistic time: the steep descending half must not
    // move faster than the shallow top. The timing curve then eases the whole flight down.
    const distances = [0];
    for (let i = 1; i < arc.length; i++) {
      distances.push(distances[i - 1] + Math.hypot(arc[i].x - arc[i - 1].x, arc[i].y - arc[i - 1].y));
    }
    const length = distances[distances.length - 1];
    const flight = host.animate(arc.map((step, i) => ({
      transform: place({ x: lifted.x + step.x, y: lifted.y + step.y }),
      offset: length > 0 ? distances[i] / length : i / (arc.length - 1),
    })), { duration, easing: TOSS_FLIGHT_EASING, fill: "forwards" });

    // The download goes to the queue when the parcel has nearly arrived.
    handover.within(tossHandoverAt(duration));

    // The arc ends where the target was at launch. The target may still move — the panel is
    // mounted during the flight, the list grows by the row of this very download — so the end
    // is corrected on the way: `aim` carries the difference, eased over what is left of the flight.
    let offset = { x: 0, y: 0 };
    let correction: Animation | null = null;
    const reaim = () => {
      // A newly inserted row can move the target a long way. Settle the aim before
      // the final third instead of racing to that row in the last few milliseconds.
      if (ended || Number(flight.currentTime ?? duration) >= duration * 0.65) return;
      const now = findLanding(open, before, target);
      if (!now) return;
      const next = { x: now.point.x - landing.point.x, y: now.point.y - landing.point.y };
      if (Math.hypot(next.x - offset.x, next.y - offset.y) < 2) return;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(aim).transform);
      const from = { x: matrix.e, y: matrix.f };
      const left = Math.max(1, duration - Number(flight.currentTime ?? duration));
      offset = next;
      correction?.cancel();
      correction = aim.animate([{ transform: place(from) }, { transform: place(next) }],
        { duration: left, easing: "cubic-bezier(0.3, 0, 0.4, 1)", fill: "forwards" });
    };
    let frame = 0;
    const onTasks = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; reaim(); });
    };
    const unsubscribe = target.subscribe(onTasks);
    const timers = [0.3, 0.55].map(share => window.setTimeout(reaim, duration * share));
    stopAiming = () => {
      stopAiming = () => undefined;
      unsubscribe();
      timers.forEach(timer => window.clearTimeout(timer));
      if (frame) cancelAnimationFrame(frame);
    };
    flight.finished.then(() => land({ x: landing.point.x + offset.x, y: landing.point.y + offset.y }), end);
  };
  appear.finished.then(launch, end);

  return {
    ready: handover.ready,
    fail() {
      if (failed) return;
      failed = true;
      fade();
    },
  };
}

/**
 * Throws a parcel into the downloads. Call it at the moment a download is started; it returns
 * at once. Hand the download to the queue when the returned `ready` has resolved.
 */
export function tossToDownloads(request: TossRequest = {}): TossHandle {
  if (typeof document === "undefined") return NOOP;
  const open = request.open !== false;
  const target = TARGETS[request.to ?? "downloads"];
  const before = target.before();
  if (open) {
    useTaskPanelStore.getState().setView(target.view);
    useSidePanels.getState().setDownloads(true);
  }
  const origin = resolveOrigin(request);
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // A source that is not on screen (a pane scrolled or switched away) has nothing to lift off.
  const onScreen = origin !== null && origin.point.x >= 0 && origin.point.x <= window.innerWidth
    && origin.point.y >= 0 && origin.point.y <= window.innerHeight;
  // In a hidden window no animation runs and no frame ends one: the download must not wait there.
  if (!origin || !onScreen || still || document.hidden || airborne >= MAX_PARCELS) {
    // Nothing flies: the download goes to the queue at once, the drawer opens and the new task
    // appears highlighted.
    let failed = false;
    if (open) highlightAdded(before, () => failed, target);
    return { ready: Promise.resolve(), fail() { failed = true; } };
  }
  return fly(origin, request, Math.max(1, Math.floor(request.count ?? 1)), before, tossHandover(), open ? holdDrawer(DOWNLOADS_APP) : () => undefined, target);
}
