import { create } from "zustand";
import type { TrackSummary } from "../types";
import { useAppStore } from "./appStore";
interface State {
  track: TrackSummary | null;
  fromPlayback: boolean;
  beforeClose: (() => Promise<boolean>) | null;
  setBeforeClose: (handler: (() => Promise<boolean>) | null) => void;
  open: (track: TrackSummary) => void;
  follow: (track: TrackSummary) => void;
  close: () => void;
}
/** The editor follows local playback; the export queue owns frozen snapshots. */
export const useVisualizerStudioStore = create<State>((set, get) => ({
  track: null, fromPlayback: false, beforeClose: null,
  setBeforeClose: beforeClose => set({ beforeClose }),
  open: track => {
    set({ track: { ...track }, fromPlayback: false });
    useAppStore.getState().openCompositionPanel();
  },
  follow: track => {
    if (track.id <= 0 || get().track?.id === track.id) return;
    // The player already owns this switch; never reload or pause its new source.
    set({ track: { ...track }, fromPlayback: true });
  },
  close: () => set({ track: null, fromPlayback: false }),
}));
