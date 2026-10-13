import { create } from "zustand";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";

/** Bump the suffix when the tips gain something worth greeting again. */
const KEY = "kd-tips-greeted-v1";

/**
 * Whether the tips entry still greets (the little mouse hops under the bulb): until the tips have
 * been opened once on this build's first run. A view preference; losing it only greets again.
 */
export const useTipsNudge = create<{ fresh: boolean; dismiss(): void }>(set => ({
  fresh: readLocalStorage(KEY) !== "1",
  dismiss: () => { set({ fresh: false }); writeLocalStorageSoon(KEY, "1"); },
}));
