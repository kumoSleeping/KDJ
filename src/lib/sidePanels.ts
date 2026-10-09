import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const DOWNLOADS_KEY = "kd-side-downloads-open";
const LYRICS_KEY = "kd-side-lyrics-open";

/**
 * The task list and the lyrics, two of the right column's apps. `raised` names an app asked for
 * again while it was already open, so the drawer shows it again (see useDrawerOrder).
 */
export const useSidePanels = create<{
  downloads: boolean;
  lyrics: boolean;
  raised: { id: string | null; token: number };
  setDownloads(open: boolean): void;
  setLyrics(open: boolean): void;
  raise(id: string): void;
}>((set, get) => ({
  raised: { id: null, token: 0 },
  raise: id => set({ raised: { id, token: get().raised.token + 1 } }),
  downloads: readLocalStorage(DOWNLOADS_KEY) === "true",
  // Once opened the lyrics stay until they are closed by hand, across songs and restarts.
  lyrics: readLocalStorage(LYRICS_KEY) === "true",
  setDownloads(downloads) {
    writeLocalStorageNow(DOWNLOADS_KEY, String(downloads));
    set({ downloads });
    if (downloads) get().raise("downloads");
  },
  setLyrics(lyrics) {
    writeLocalStorageNow(LYRICS_KEY, String(lyrics));
    set({ lyrics });
    if (lyrics) get().raise("lyrics");
  },
}));
