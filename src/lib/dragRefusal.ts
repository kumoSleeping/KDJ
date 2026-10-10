/**
 * The "no" of a drop that is not taken. When something dragged inside the app — library tracks,
 * search results, a sidebar folder — is let go on a place that takes other things but not this
 * one (a library track on the downloads or the exports, a search result on the sampler or the
 * trash, anything on an online source's row), its card shakes its head and fades
 * (`refuseDragGhost` in components/common/dragGhost.ts). There is no message and no colour.
 *
 * It never speaks for a drop that was taken, nor for a drag that simply ends over nothing in
 * particular: only the places listed in REFUSAL_ZONES are worth an answer, and never the one the
 * drag started in.
 *
 * Who takes what is not listed here a second time:
 * - System (HTML5) drags: a target accepts by cancelling `dragover`. The last `dragover` of the
 *   drag is kept, and whether it was cancelled is read when the drag ends.
 * - Drags that follow the pointer by hand (lib/searchDrag.ts, the track table): `pointerAccepts`
 *   asks the same hit tests their own release handlers use.
 *
 * Installed once, when the module is first imported.
 */

import { forgetDragCard, isElement, refuseDragGhost } from "../components/common/dragGhost";
import { folderDropElementAt, searchDropPathAt, searchQueueDropElementAt } from "./folderDrop";
import {
  TRACK_COVER_DROP_TARGET_ATTR, TRACK_DECK_DROP_TARGET_ATTR, TRACK_SAMPLER_DROP_TARGET_ATTR, trackDeckDropSideAt,
} from "./trackDrag";

/** Places that take some drag of the app, so that letting another kind go there is a mistake worth answering. */
export const REFUSAL_ZONES = [
  // The downloads and the exports: the drawer app, its entry, the task pages.
  '.kd-drawer[data-app="downloads"]', '[data-drawer-entry="downloads"]', "[data-kd-search-queue-drop]", ".kd-task-page",
  // The sidebar's rows (not its add row, a row being named or a status line) and the rail's items.
  ".kd-folder-pane .kd-folder:not(.kd-folder-add, .kd-folder-new, .kd-stream-status)", ".kd-narrow-folder-rail button",
  // The decks, the sampler, the trash and the cover box.
  `[${TRACK_DECK_DROP_TARGET_ATTR}]`, `[${TRACK_SAMPLER_DROP_TARGET_ATTR}]`, "[data-kd-track-trash-target]", `[${TRACK_COVER_DROP_TARGET_ATTR}]`,
].join(", ");

/** A `dragover` older than this says nothing about where the drag was let go. */
const OVER_FRESH_MS = 1500;
/** A late `drop` may still want the card this long after `dragend` (see trackDrag.ts). */
const LATE_DROP_MS = 2000;

/** The zone at a point that is worth an answer, unless the drag came out of it. */
function refusalZoneAt(x: number, y: number, source: Element | null): Element | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const zone = document.elementFromPoint(x, y)?.closest(REFUSAL_ZONES) ?? null;
  return zone && !(source && zone.contains(source)) ? zone : null;
}

/** Whether a drag that follows the pointer by hand is taken at a point (as its own release handler decides). */
export function pointerAccepts(kind: "track" | "search", x: number, y: number): boolean {
  // Both load a deck.
  if (trackDeckDropSideAt(x, y) !== null) return true;
  if (kind === "search") return !!searchQueueDropElementAt(x, y) || !!searchDropPathAt(x, y);
  if (folderDropElementAt(x, y)) return true;
  const hit = document.elementFromPoint(x, y);
  return !!hit?.closest(`[${TRACK_SAMPLER_DROP_TARGET_ATTR}], [data-kd-track-trash-target], [${TRACK_COVER_DROP_TARGET_ATTR}]`);
}

let installed = false;

export function installDragRefusal(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // ---- system drags ----
  let source: Element | null = null;
  let active = false;
  let dropped = false;
  let lastOver: { event: DragEvent; at: number } | null = null;
  window.addEventListener("dragstart", event => {
    source = isElement(event.target) ? event.target : null;
    active = true;
    dropped = false;
    lastOver = null;
  }, true);
  // Kept as the event itself: whether a target cancelled it is only known after it was dispatched.
  window.addEventListener("dragover", event => {
    if (active) lastOver = { event, at: performance.now() };
  }, true);
  // A drop is only delivered to a target that accepted.
  window.addEventListener("drop", () => { dropped = true; }, true);
  window.addEventListener("dragend", () => {
    const over = lastOver;
    const from = source;
    const taken = dropped;
    active = false;
    source = null;
    lastOver = null;
    forgetDragCard(LATE_DROP_MS);
    if (taken || !over || performance.now() - over.at > OVER_FRESH_MS || over.event.defaultPrevented) return;
    const { clientX: x, clientY: y } = over.event;
    if (refusalZoneAt(x, y, from)) refuseDragGhost({ x, y });
  }, true);

  // ---- drags that follow the pointer by hand ----
  // Registered before any drag begins, so this runs ahead of the drag's own release handler,
  // which takes its card away in the same turn.
  let pointerSource: Element | null = null;
  window.addEventListener("pointerdown", event => {
    pointerSource = isElement(event.target) ? event.target : null;
  }, { capture: true, passive: true });
  window.addEventListener("pointerup", event => {
    const flags = document.body.dataset;
    const kind = flags.kdSearchPointerDragging ? "search" : flags.kdTrackPointerDragging ? "track" : null;
    if (!kind) return;
    const { clientX: x, clientY: y } = event;
    if (refusalZoneAt(x, y, pointerSource) && !pointerAccepts(kind, x, y)) refuseDragGhost({ x, y });
  }, { capture: true, passive: true });
}

installDragRefusal();
