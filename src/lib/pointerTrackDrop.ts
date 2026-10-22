/**
 * Places that take what is dragged by the pointer: library rows (the track table follows the
 * pointer by hand, TrackTable.tsx `beginTrackPointerDrag`) and search results (searchDrag.ts
 * `beginAudioPointerDrag` / `beginVideoPointerDrag`). No `dragover` or `drop` ever reaches a
 * place: the drag asks this registry instead, at every move and at the release. A place registers
 * its element once (`usePointerTrackDrop`, `usePointerSearchDrop`); the innermost registered
 * element under the pointer is the one that is told.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { ActiveSearchDrag } from "./searchDrag";

export interface PointerDrop<T> {
  /** What is dragged is over the place at (x, y). What it returns names the drop on the drag's card. */
  over(items: T, x: number, y: number): string | null;
  /** It left the place, or the drag ended elsewhere. */
  leave(): void;
  drop(items: T, x: number, y: number): void;
}
export type PointerTrackDrop = PointerDrop<readonly number[]>;
export type PointerSearchDrop = PointerDrop<ActiveSearchDrag>;

const trackPlaces = new Map<Element, PointerTrackDrop>();
const searchPlaces = new Map<Element, PointerSearchDrop>();

function placeAt<T>(places: Map<Element, PointerDrop<T>>, x: number, y: number): PointerDrop<T> | null {
  if (typeof document === "undefined" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let node: Element | null = document.elementFromPoint(x, y); node; node = node.parentElement) {
    const place = places.get(node);
    if (place) return place;
  }
  return null;
}

/** The place under a point that takes library rows, if any. */
export const pointerTrackDropAt = (x: number, y: number) => placeAt(trackPlaces, x, y);
/** The place under a point that takes search results, if any. */
export const pointerSearchDropAt = (x: number, y: number) => placeAt(searchPlaces, x, y);

function usePlace<T>(places: Map<Element, PointerDrop<T>>, element: RefObject<Element | null>, place: PointerDrop<T> | null): void {
  const latest = useRef(place);
  latest.current = place;
  const on = place !== null;
  useEffect(() => {
    const node = element.current;
    if (!node || !on) return;
    places.set(node, {
      over: (items, x, y) => latest.current?.over(items, x, y) ?? null,
      leave: () => latest.current?.leave(),
      drop: (items, x, y) => latest.current?.drop(items, x, y),
    });
    return () => { places.delete(node); };
  }, [places, element, on]);
}

/** Registers `element` for library rows while it is mounted; the latest `place` given is the one told. */
export function usePointerTrackDrop(element: RefObject<Element | null>, place: PointerTrackDrop | null): void {
  usePlace(trackPlaces, element, place);
}

/** Registers `element` for search results while it is mounted; the latest `place` given is the one told. */
export function usePointerSearchDrop(element: RefObject<Element | null>, place: PointerSearchDrop | null): void {
  usePlace(searchPlaces, element, place);
}
