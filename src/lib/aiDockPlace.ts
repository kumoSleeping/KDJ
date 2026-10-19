import { create } from "zustand";

/**
 * Where the AI dock and the playing song's bubble stand at the bottom right (docs/ai-dock.md).
 *
 * The dock's place is read by the bottom stack of task bubbles: the playing song's bubble (the
 * stack's base) keeps the corner, and the dock stands on top of it; every other bubble moves to
 * the dock's left when the window is wide enough for both. `under` goes the other way: how far
 * the base bubble reaches up from the floor, its gap included, which the dock stands on.
 */
export interface AiDockPlace {
  width: number;
  height: number;
  /** The other bubbles stand to the dock's left; false: they keep their place in the stack. */
  beside: boolean;
}

export const useAiDockPlace = create<{ place: AiDockPlace | null; under: number }>(() => ({ place: null, under: 0 }));

export function setAiDockPlace(place: AiDockPlace | null): void {
  const before = useAiDockPlace.getState().place;
  if (before === place) return;
  if (before && place && before.width === place.width && before.height === place.height && before.beside === place.beside) return;
  useAiDockPlace.setState({ place });
}

export function setAiDockUnder(under: number): void {
  if (useAiDockPlace.getState().under !== under) useAiDockPlace.setState({ under });
}
