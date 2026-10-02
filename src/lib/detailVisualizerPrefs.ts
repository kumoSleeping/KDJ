import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-detail-visualizer-visible";

interface DetailVisualizerPrefs {
  visible: boolean;
  setVisible(value: boolean): void;
}

export const useDetailVisualizerPrefs = create<DetailVisualizerPrefs>((set) => ({
  visible: readLocalStorage(STORAGE_KEY) === "true",
  setVisible(visible) {
    writeLocalStorageNow(STORAGE_KEY, String(visible));
    set({ visible });
  },
}));
