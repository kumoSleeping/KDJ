import { useEffect } from "react";
import { useLiveVjStore } from "../stores/liveVjStore";
import { liveVjSupported } from "./liveVj";

// The task card and full editor share one status loop, including while switching views.
let subscribers = 0;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
export function useLiveVjStatus() {
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !liveVjSupported()) return;
    subscribers += 1;
    if (subscribers === 1) {
      const owner = ++generation;
      const poll = async () => {
        await useLiveVjStore.getState().refresh();
        if (owner === generation && subscribers > 0) timer = setTimeout(poll, 500);
      };
      void poll();
    }
    return () => {
      subscribers -= 1;
      if (subscribers === 0) { generation += 1; clearTimeout(timer); }
    };
  }, []);
}
