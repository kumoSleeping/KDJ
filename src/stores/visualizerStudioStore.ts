import { create } from "zustand";
import { isEditorWindow } from "../lib/windowRole";
import { showKvj } from "../lib/kvjWindow";
import { useSidePanels } from "../lib/sidePanels";
import type { TrackSummary } from "../types";
import { useAppStore } from "./appStore";

/** The visualizer configuration's id among the drawer's apps (see drawerApps). */
export const VISUALIZER_DOCK_APP = "visualizer";

interface State {
  track: TrackSummary | null;
  inlineSettings: boolean;
  settingsTarget: HTMLElement | null;
  setSettingsTarget: (target: HTMLElement | null) => void;
  openInlineSettings: (track: TrackSummary) => void;
  beforeClose: (() => Promise<boolean>) | null;
  setBeforeClose: (handler: (() => Promise<boolean>) | null) => void;
  open: (track: TrackSummary) => void;
  follow: (track: TrackSummary) => void;
  /** What the app's own close control does: let the editor save first, then leave. */
  requestClose: () => void;
  close: () => void;
}
/**
 * The configuration is an app of the main window's right column. `track` set means it is open;
 * asking for it again brings it to the front. The export queue owns frozen snapshots.
 */
export const useVisualizerStudioStore = create<State>((set, get) => ({
  track: null, inlineSettings: false, settingsTarget: null, beforeClose: null,
  setSettingsTarget: settingsTarget => set({ settingsTarget }),
  // The floating picture keeps the picture; only its controls come up in the column.
  openInlineSettings: track => {
    set({ track: { ...track }, inlineSettings: true });
    useAppStore.setState({ showComposition: false });
    useSidePanels.getState().raise(VISUALIZER_DOCK_APP);
  },
  setBeforeClose: beforeClose => set({ beforeClose }),
  open: track => {
    // A tool window has no right column: the main window hosts the configuration.
    if (isEditorWindow) { showKvj({ tab: "visualizer", track }); return; }
    set({ track: { ...track }, inlineSettings: false });
    useAppStore.setState({ showComposition: false });
    useSidePanels.getState().raise(VISUALIZER_DOCK_APP);
  },
  follow: track => {
    if (track.id <= 0 || get().track?.id === track.id) return;
    // The player already owns this switch; never reload or pause its new source.
    set({ track: { ...track } });
  },
  requestClose: () => {
    const { track, beforeClose, close } = get();
    if (!track) return;
    if (beforeClose) void beforeClose(); else close();
  },
  close: () => set({ track: null, inlineSettings: false }),
}));
