import type { TrackSummary } from "../types";
import { isPreferencesWindow } from "../lib/windowRole";

export type KvjTab = "visualizer" | "preferences";
export interface KvjOpenRequest { tab?: KvjTab; track?: TrackSummary; section?: "updates"; }
let navigation = Promise.resolve();
export function acceptKvjRequest(request: KvjOpenRequest): Promise<void> {
  const run = navigation.then(async () => {
    if (isPreferencesWindow) {
      if (request.section === "updates") {
        const { useUpdateStore } = await import("./updateStore");
        useUpdateStore.setState(state => ({ focusEpoch: state.focusEpoch + 1 }));
      }
    }
  });
  navigation = run.catch(() => undefined);
  return run;
}
