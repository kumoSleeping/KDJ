import type { TrackSummary } from "../types";
import { isKvjWindow, isVisualizerWindow, isPreferencesWindow } from "../lib/windowRole";

export type KvjTab = "workshop" | "live-vj" | "visualizer" | "preferences";
export interface KvjOpenRequest { tab?: KvjTab; track?: TrackSummary; ids?: number[]; target?: string; section?: "updates"; }
let navigation = Promise.resolve();
export function acceptKvjRequest(request: KvjOpenRequest): Promise<void> {
  const run = navigation.then(async () => {
    if (isPreferencesWindow) {
      if (request.section === "updates") {
        const { useUpdateStore } = await import("./updateStore");
        useUpdateStore.setState(state => ({ focusEpoch: state.focusEpoch + 1 }));
      }
    } else if (isVisualizerWindow) {
      if (!request.track) throw new Error("请选择一首歌曲");
      const { useVisualizerStudioStore } = await import("./visualizerStudioStore");
      const editor = useVisualizerStudioStore.getState();
      if (editor.track?.id !== request.track.id) {
        if (editor.beforeClose && !await editor.beforeClose()) return;
        editor.open(request.track);
      }
    } else if (isKvjWindow && request.ids?.length) {
      const { enqueueLocalComposition } = await import("../lib/compositionActions");
      await enqueueLocalComposition(request.ids, request.target);
    }
  });
  navigation = run.catch(() => undefined);
  return run;
}
