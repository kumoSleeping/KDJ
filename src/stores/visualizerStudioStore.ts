import { create } from "zustand";
import type { TrackSummary } from "../types";
import { getPlayingTrack } from "../lib/playingTrack";
import { useAppStore } from "./appStore";
interface State {
  track: TrackSummary | null;
  fromPlayback: boolean;
  inlineSettings: boolean;
  previewRequest: number;
  settingsTarget: HTMLElement | null;
  setSettingsTarget: (target: HTMLElement | null) => void;
  openInlineSettings: (track: TrackSummary) => void;
  beforeClose: (() => Promise<boolean>) | null;
  setBeforeClose: (handler: (() => Promise<boolean>) | null) => void;
  open: (track: TrackSummary) => void;
  follow: (track: TrackSummary) => void;
  close: () => void;
}
/** The editor follows local playback; the export queue owns frozen snapshots. */
export const useVisualizerStudioStore = create<State>((set, get) => ({
  track: null, fromPlayback: false, inlineSettings: false, previewRequest: 0, settingsTarget: null, beforeClose: null,
  setSettingsTarget: settingsTarget => set({ settingsTarget }),
  openInlineSettings: track => {
    set({ track: { ...track }, fromPlayback: true, inlineSettings: true });
    useAppStore.setState({ showComposition: false });
  },
  setBeforeClose: beforeClose => set({ beforeClose }),
  open: track => {
    // Explicit editing must expose a preview even when the playback sidebar is hidden.
    set({ track: { ...track }, fromPlayback: getPlayingTrack()?.id === track.id,
      inlineSettings: false, previewRequest: get().previewRequest + 1 });
    useAppStore.setState({ showComposition: false });
  },
  follow: track => {
    if (track.id <= 0 || get().track?.id === track.id) return;
    // The player already owns this switch; never reload or pause its new source.
    set({ track: { ...track }, fromPlayback: true });
  },
  close: () => set({ track: null, fromPlayback: false, inlineSettings: false }),
}));
