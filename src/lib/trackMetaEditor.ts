import { create } from "zustand";

/** What the editor was asked for from: a panel it should stand beside, or the pointer. */
export type TrackMetaEditorAnchor =
  | { rect: { left: number; top: number; right: number; bottom: number } }
  | { x: number; y: number };

interface TrackMetaEditorState {
  /** The library track being edited; one editor at a time. */
  trackId: number | null;
  anchor: TrackMetaEditorAnchor | null;
  /** Counts requests to edit, so an editor already showing the track returns to its form. */
  request: number;
  /** An unsaved draft holds the editor on its track until it is saved or cancelled. */
  dirty: boolean;
  /** Counts requests the draft refused; the editor says why nothing happened. */
  refused: number;
  /** Where the window was last dragged to. A session memory, not a preference. */
  position: { left: number; top: number } | null;
  open(trackId: number, anchor?: TrackMetaEditorAnchor): boolean;
  close(): boolean;
  /** The entry that opened the editor for a track also closes it. */
  toggle(trackId: number, anchor?: TrackMetaEditorAnchor): boolean;
  setDirty(dirty: boolean): void;
  setPosition(position: { left: number; top: number }): void;
}

export const useTrackMetaEditor = create<TrackMetaEditorState>((set, get) => ({
  trackId: null,
  anchor: null,
  request: 0,
  dirty: false,
  refused: 0,
  position: null,
  open(trackId, anchor) {
    // Online tracks have no library record to write to.
    if (!Number.isFinite(trackId) || trackId <= 0) return false;
    const current = get();
    if (current.trackId !== null && current.trackId !== trackId && current.dirty) {
      set({ refused: current.refused + 1 });
      return false;
    }
    set({
      trackId,
      // An editor that is already up stays where it is.
      anchor: current.trackId === null ? anchor ?? null : current.anchor,
      request: current.request + 1,
    });
    return true;
  },
  close() {
    const current = get();
    if (current.trackId === null) return true;
    if (current.dirty) {
      set({ refused: current.refused + 1 });
      return false;
    }
    set({ trackId: null, anchor: null });
    return true;
  },
  toggle(trackId, anchor) {
    return get().trackId === trackId ? get().close() : get().open(trackId, anchor);
  },
  setDirty: dirty => { if (get().dirty !== dirty) set({ dirty }); },
  setPosition: position => set({ position }),
}));

/** The panel an entry sits in, so the editor opens beside the whole panel instead of over it. */
export function trackMetaEditorAnchor(element: Element): TrackMetaEditorAnchor {
  const box = (element.closest('[role="dialog"]') ?? element).getBoundingClientRect();
  return { rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } };
}

const GAP = 8;
const EDGE = 8;

/**
 * Where a window of `size` first appears. `floor` is the top of the player bar: the editor
 * stands above it. Beside a panel it takes the roomier side and shares the panel's bottom
 * edge; from a row menu it opens just off the pointer, below the row when there is room.
 */
export function placeTrackMetaEditor(
  anchor: TrackMetaEditorAnchor | null,
  size: { width: number; height: number },
  viewport: { width: number; floor: number },
): { left: number; top: number } {
  const maxLeft = Math.max(EDGE, viewport.width - size.width - EDGE);
  const maxTop = Math.max(EDGE, viewport.floor - size.height - EDGE);
  const clampLeft = (left: number) => Math.max(EDGE, Math.min(left, maxLeft));
  const clampTop = (top: number) => Math.max(EDGE, Math.min(top, maxTop));
  if (!anchor) return { left: maxLeft, top: maxTop };
  if ("rect" in anchor) {
    const { rect } = anchor;
    const roomLeft = rect.left - EDGE;
    const roomRight = viewport.width - rect.right - EDGE;
    const needed = size.width + GAP;
    const onLeft = rect.left - GAP - size.width;
    const onRight = rect.right + GAP;
    const top = clampTop(rect.bottom - size.height);
    if (roomLeft >= roomRight && roomLeft >= needed) return { left: onLeft, top };
    if (roomRight >= needed) return { left: onRight, top };
    // No side has room: stand above the panel if that fits, else overlap as little as possible.
    const above = rect.top - GAP - size.height;
    if (above >= EDGE) return { left: clampLeft(rect.left), top: above };
    return { left: clampLeft(roomLeft >= roomRight ? onLeft : onRight), top };
  }
  const right = anchor.x + GAP;
  const left = right + size.width <= viewport.width - EDGE ? right : clampLeft(anchor.x - GAP - size.width);
  const below = anchor.y + GAP;
  const top = below + size.height <= viewport.floor - EDGE ? below
    : anchor.y - GAP - size.height >= EDGE ? anchor.y - GAP - size.height : clampTop(below);
  return { left, top };
}
