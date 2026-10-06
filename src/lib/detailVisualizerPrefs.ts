import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-detail-visualizer-visible";
const VISUALIZATION_KEY = "kd-detail-show-visualization";

interface DetailVisualizerPrefs {
  visible: boolean;
  setVisible(value: boolean): void;
  showVisualization: boolean;
  setShowVisualization(value: boolean): void;
}

export const useDetailVisualizerPrefs = create<DetailVisualizerPrefs>((set) => ({
  visible: readLocalStorage(STORAGE_KEY) === "true",
  showVisualization: readLocalStorage(VISUALIZATION_KEY) === "true",
  setShowVisualization(showVisualization) {
    writeLocalStorageNow(VISUALIZATION_KEY, String(showVisualization));
    set({ showVisualization });
  },
  setVisible(visible) {
    writeLocalStorageNow(STORAGE_KEY, String(visible));
    set({ visible });
  },
}));
