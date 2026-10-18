import { create } from "zustand";

/**
 * Where the AI dock stands at the bottom right (docs/ai-dock.md), for the bottom stack of task
 * bubbles, which makes room for it: beside it, to its left, when the window is wide enough for
 * both; otherwise above it.
 */
export interface AiDockPlace {
  width: number;
  height: number;
  /** The bubbles stand to the dock's left; false: on top of it. */
  beside: boolean;
}

export const useAiDockPlace = create<{ place: AiDockPlace | null }>(() => ({ place: null }));

export function setAiDockPlace(place: AiDockPlace | null): void {
  const before = useAiDockPlace.getState().place;
  if (before === place) return;
  if (before && place && before.width === place.width && before.height === place.height && before.beside === place.beside) return;
  useAiDockPlace.setState({ place });
}
