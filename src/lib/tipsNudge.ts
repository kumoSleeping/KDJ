import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

/** The version the tips entry last greeted on; a different one is a build it has not met. */
const KEY = "kd-tips-greeted-build";

/**
 * Whether the tips key (the bulb) flashes. It does, a few times, the first time a build is opened
 * (first run or after an update), and not again: the build is written down at once, so a restart
 * does not repeat it. Opening the tips ends it early. A view preference only.
 */
export const useTipsNudge = create<{ fresh: boolean; dismiss(): void }>(set => ({
  fresh: false,
  dismiss: () => set({ fresh: false }),
}));

let asked = false;
/** Called once by the key itself: compares this build with the one it last greeted on. */
export function greetTipsOnNewBuild(): void {
  if (asked) return;
  asked = true;
  void (async () => {
    let version = "dev";
    try {
      if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        version = await (await import("@tauri-apps/api/app")).getVersion();
      }
    } catch { /* an unknown build greets once, like any other */ }
    if (readLocalStorage(KEY) === version) return;
    writeLocalStorageNow(KEY, version);
    useTipsNudge.setState({ fresh: true });
  })();
}
