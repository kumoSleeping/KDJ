/**
 * Places that take library rows dragged by the pointer. The track table follows the pointer by
 * hand (TrackTable.tsx `beginTrackPointerDrag`), so no `dragover` or `drop` ever reaches a
 * place: it asks this registry instead, at every move and at the release. A place registers its
 * element once (`usePointerTrackDrop`); the innermost registered element under the pointer is
 * the one that is told.
 */
import { useEffect, useRef, type RefObject } from "react";

export interface PointerTrackDrop {
  /** The rows are over the place at (x, y). What it returns names the drop on the drag's card. */
  over(ids: readonly number[], x: number, y: number): string | null;
  /** The rows left the place, or the drag ended elsewhere. */
  leave(): void;
  drop(ids: readonly number[], x: number, y: number): void;
}

const places = new Map<Element, PointerTrackDrop>();

/** The place under a point, if any. */
export function pointerTrackDropAt(x: number, y: number): PointerTrackDrop | null {
  if (typeof document === "undefined" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let node: Element | null = document.elementFromPoint(x, y); node; node = node.parentElement) {
    const place = places.get(node);
    if (place) return place;
  }
  return null;
}

/** Registers `element` while it is mounted; the latest `place` given is the one that is told. */
export function usePointerTrackDrop(element: RefObject<Element | null>, place: PointerTrackDrop | null): void {
  const latest = useRef(place);
  latest.current = place;
  const on = place !== null;
  useEffect(() => {
    const node = element.current;
    if (!node || !on) return;
    places.set(node, {
      over: (ids, x, y) => latest.current?.over(ids, x, y) ?? null,
      leave: () => latest.current?.leave(),
      drop: (ids, x, y) => latest.current?.drop(ids, x, y),
    });
    return () => { places.delete(node); };
  }, [element, on]);
}
