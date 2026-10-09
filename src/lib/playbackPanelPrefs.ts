import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

export type TopPanelId = "waveform" | "search";
const ENABLED_KEY = "kd-top-panels-enabled";
function readStored(): Record<string, unknown> {
  try {
    const value = JSON.parse(readLocalStorage(ENABLED_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Which of the fixed panels above the list are shown. */
export const useTopPanels = create<{
  enabled: Record<TopPanelId, boolean>;
  setEnabled(id: TopPanelId, enabled: boolean): void;
}>((set) => {
  const stored = readStored();
  return {
    enabled: { waveform: stored.waveform !== false, search: stored.search !== false },
    setEnabled(id, enabled) {
      set(state => {
        const next = { ...state.enabled, [id]: enabled };
        // Keep switches written by other builds alongside the two this one owns.
        writeLocalStorageNow(ENABLED_KEY, JSON.stringify({ ...readStored(), ...next }));
        return { enabled: next };
      });
    },
  };
});
