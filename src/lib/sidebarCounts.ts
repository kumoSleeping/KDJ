import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const HIDDEN_KEY = "kd-sidebar-counts-hidden";

/**
 * Whether the rows of the sidebar end in their counts: one choice for the whole sidebar (all
 * tracks, every source and its playlists, every folder at any depth), made with the eye on a
 * top-level row. A view preference only; the counts are shown until the listener turns them off.
 */
export const useSidebarCounts = create<{ shown: boolean; setShown(shown: boolean): void }>((set, get) => ({
  shown: readLocalStorage(HIDDEN_KEY) !== "true",
  setShown(shown) {
    if (get().shown === shown) return;
    writeLocalStorageNow(HIDDEN_KEY, String(!shown));
    set({ shown });
  },
}));
