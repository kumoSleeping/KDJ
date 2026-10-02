import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";
import { usePlaybackPrefs } from "./playbackPrefs";
import { useDetailVisualizerPrefs } from "./detailVisualizerPrefs";
import { usePanelViewport } from "./panelViewport";

const OPEN_KEY = "kd-track-preview-open";

export type TopPanelId = "control" | "waveform" | "search";
const ENABLED_KEY = "kd-top-panels-enabled";
function readEnabled(): Record<TopPanelId, boolean> {
  try {
    const value = JSON.parse(readLocalStorage(ENABLED_KEY) ?? "{}");
    return { control: value?.control !== false, waveform: value?.waveform !== false, search: value?.search !== false };
  } catch { return { control: true, waveform: true, search: true }; }
}

export const usePlaybackPanelPrefs = create<{
  open: boolean;
  enabled: Record<TopPanelId, boolean>;
  setEnabled(id: TopPanelId, enabled: boolean): void;
  setOpen(open: boolean): void;
}>((set) => ({
  enabled: readEnabled(),
  setEnabled(id, enabled) {
    set(state => {
      const next = { ...state.enabled, [id]: enabled };
      writeLocalStorageNow(ENABLED_KEY, JSON.stringify(next));
      return { enabled: next };
    });
  },
  open: readLocalStorage(OPEN_KEY) !== "false",
  setOpen(open) {
    writeLocalStorageNow(OPEN_KEY, String(open));
    set({ open });
  },
}));

/** Compact previews can temporarily open a disabled card without changing its saved switch. */
export function useEffectiveTopPanels() {
  const enabled = usePlaybackPanelPrefs(state => state.enabled);
  const activeIds = usePanelViewport(state => state.activeIds);
  const compact = usePanelViewport(state => state.compact);
  return { ...enabled,
    control: enabled.control || (compact && activeIds.includes("kd-activity-panels:control")),
    waveform: enabled.waveform || (compact && activeIds.includes("kd-activity-panels:waveform")),
    search: enabled.search || (compact && activeIds.includes("kd-activity-panels:search")),
  };
}

export type PlaybackPanelId = "control" | "visualizer" | "waveform";

export function usePlaybackPanelVisibility(): Record<PlaybackPanelId, boolean> {
  const control = usePlaybackPrefs(state => state.detailControlVisible);
  const waveform = usePlaybackPrefs(state => state.detailWaveformVisible);
  const visualizer = useDetailVisualizerPrefs(state => state.visible);
  return { control, waveform, visualizer };
}

export function setPlaybackPanelVisible(id: string, visible: boolean) {
  if (id === "control") usePlaybackPrefs.getState().setDetailControlVisible(visible);
  if (id === "waveform") usePlaybackPrefs.getState().setDetailWaveformVisible(visible);
  if (id === "visualizer") useDetailVisualizerPrefs.getState().setVisible(visible);
}
