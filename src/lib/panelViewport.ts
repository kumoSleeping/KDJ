import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const PORTRAIT_SONG_PANEL_KEY = "kd-portrait-song-panel";
const songPanels = new Set(["lyrics", "control", "waveform", "visualizer", "information", "metadata"]
  .map(id => `kd-activity-panels:${id}`));
const savedSongPanel = readLocalStorage(PORTRAIT_SONG_PANEL_KEY);
const defaultSongPanel = savedSongPanel && songPanels.has(savedSongPanel)
  ? savedSongPanel : "kd-activity-panels:lyrics";
const withSongPanel = (ids: string[], id: string) => [...ids.filter(value => !songPanels.has(value)), id];
export function responsivePanelSelection(ids: string[], id: string, narrow: boolean): string[] {
  return narrow && songPanels.has(id) ? withSongPanel(ids, id) : [...ids, id];
}

/** Responsive presentation only. Never write enabled flags, placements or window-size overrides. */
export const usePanelViewport = create<{
  narrow: boolean;
  compact: boolean;
  activeIds: string[];
  portraitSongPanel: string;
  expandedPanelId: string | null;
  setExpandedPanel(id: string | null): void;
  revealSongPanel(): void;
  toggleSongPanel(): void;
  activeIdsByOrientation: { landscape: string[]; portrait: string[] };
  setMode(narrow: boolean, compact: boolean): void;
  togglePanel(id: string): void;
  closePanel(id?: string): void;
}>((set) => ({
  narrow: false, compact: false, activeIds: [],
  portraitSongPanel: defaultSongPanel,
  expandedPanelId: null,
  setExpandedPanel: expandedPanelId => set({ expandedPanelId }),
  // A temporary now-playing surface must never change the dock's visible cards.
  revealSongPanel: () => set(state => !state.narrow ? state : {
    expandedPanelId: "kd-activity-panels:lyrics",
  }),
  toggleSongPanel: () => set(state => !state.narrow ? state : {
    expandedPanelId: state.expandedPanelId === "kd-activity-panels:lyrics"
      ? null : "kd-activity-panels:lyrics",
  }),
  activeIdsByOrientation: { landscape: [], portrait: [] },
  setMode: (narrow, compact) => set(state => {
    if (state.narrow === narrow) {
      return state.compact === compact ? state : { compact };
    }
    // Snapshot the departing orientation; compact-mode changes are not a reset.
    const activeIdsByOrientation = {
      ...state.activeIdsByOrientation,
      [state.narrow ? "portrait" : "landscape"]: state.activeIds,
    };
    return {
      narrow, compact, activeIdsByOrientation,
      activeIds: activeIdsByOrientation[narrow ? "portrait" : "landscape"],
    };
  }),
  togglePanel: id => set(state => {
    if (state.activeIds.includes(id)) return { activeIds: state.activeIds.filter(value => value !== id) };
    if (state.narrow && songPanels.has(id)) {
      writeLocalStorageNow(PORTRAIT_SONG_PANEL_KEY, id);
      return { portraitSongPanel: id, activeIds: withSongPanel(state.activeIds, id) };
    }
    return { activeIds: [...state.activeIds, id] };
  }),
  closePanel: id => set(state => !state.activeIds.length ? state
    : { activeIds: id ? state.activeIds.filter(value => value !== id) : [] }),
}));
