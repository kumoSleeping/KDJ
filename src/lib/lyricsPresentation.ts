import { create } from "zustand";

export type LyricsExtent = "standard" | "long" | "fullscreen";
/** A display preference only; library and project documents are never rewritten. */
export const useLyricsPresentation = create<{
  extent: LyricsExtent;
  color: boolean;
  setExtent(extent: LyricsExtent): void;
  toggleColor(): void;
}>(set => ({
  extent: "standard", color: false,
  setExtent: extent => set({ extent }),
  toggleColor: () => set(state => ({ color: !state.color })),
}));
