import { mediaProductionAvailable } from "../lib/platformFeatures";
import { create } from "zustand";
import { isEditorWindow } from "../lib/windowRole";
import { showKvj } from "../lib/kvjWindow";
import { useSidePanels } from "../lib/sidePanels";
import type { TrackSummary } from "../types";

/** The visualizer configuration's id among the drawer's apps (see drawerApps). */
export const VISUALIZER_DOCK_APP = "visualizer";

interface State {
  track: TrackSummary | null;
  inlineSettings: boolean;
  /**
   * The song whose window was asked for by hand (the row's menu) with its controls: should the
   * song turn out to bring no window (no cover, no saved picture), the whole editor opens for
   * it instead of the controls leaving, since a picture can only be given to it there.
   */
  editorIfNoWindow: number | null;
  settingsTarget: HTMLElement | null;
  setSettingsTarget: (target: HTMLElement | null) => void;
  openInlineSettings: (track: TrackSummary, options?: { editorIfNoWindow?: boolean }) => void;
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
  track: null, inlineSettings: false, editorIfNoWindow: null, settingsTarget: null, beforeClose: null,
  setSettingsTarget: settingsTarget => set({ settingsTarget }),
  // The floating picture keeps the picture; only its controls come up in the column.
  openInlineSettings: (track, options) => {
    if (!mediaProductionAvailable()) return;
    set({ track: { ...track }, inlineSettings: true, editorIfNoWindow: options?.editorIfNoWindow ? track.id : null });
    useSidePanels.getState().raise(VISUALIZER_DOCK_APP);
  },
  setBeforeClose: beforeClose => set({ beforeClose }),
  open: track => {
    if (!mediaProductionAvailable()) return;
    // A tool window has no right column: the main window hosts the configuration.
    if (isEditorWindow) { showKvj({ tab: "visualizer", track }); return; }
    set({ track: { ...track }, inlineSettings: false, editorIfNoWindow: null });
    useSidePanels.getState().raise(VISUALIZER_DOCK_APP);
  },
  follow: track => {
    if (track.id <= 0 || get().track?.id === track.id) return;
    // The player already owns this switch; never reload or pause its new source.
    // The song asked for by hand keeps its promise of an editor through the switch to it.
    set(state => ({ track: { ...track }, editorIfNoWindow: state.editorIfNoWindow === track.id ? track.id : null }));
  },
  requestClose: () => {
    const { track, beforeClose, close } = get();
    if (!track) return;
    if (beforeClose) void beforeClose(); else close();
  },
  close: () => set({ track: null, inlineSettings: false, editorIfNoWindow: null }),
}));
