import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const DOWNLOADS_KEY = "kd-side-downloads-open";

/** The right column holds only what was asked for: the task list and the lyrics. */
export const useSidePanels = create<{
  downloads: boolean;
  lyrics: boolean;
  setDownloads(open: boolean): void;
  setLyrics(open: boolean): void;
}>((set) => ({
  downloads: readLocalStorage(DOWNLOADS_KEY) === "true",
  lyrics: false,
  setDownloads(downloads) {
    writeLocalStorageNow(DOWNLOADS_KEY, String(downloads));
    set({ downloads });
  },
  setLyrics: lyrics => set({ lyrics }),
}));
