import { create } from "zustand";
import type { TrackSummary } from "../types";
import { useVisualizerStudioStore } from "./visualizerStudioStore";
import { useWorkshopStore } from "./workshopStore";

export type KvjTab = "workshop" | "live-vj" | "visualizer";
export interface KvjOpenRequest { tab?: KvjTab; track?: TrackSummary; ids?: number[]; target?: string; }
export const useKvjStore = create<{ tab: KvjTab }>(() => ({ tab: "workshop" }));
let navigation = Promise.resolve();
export function acceptKvjRequest(request: KvjOpenRequest): Promise<void> {
  const run = navigation.then(async () => {
    const editor = useVisualizerStudioStore.getState();
    if (request.track && editor.track?.id !== request.track.id && editor.beforeClose) {
      if (!await editor.beforeClose()) return;
    }
    await useWorkshopStore.getState().flush();
    if (request.tab) useKvjStore.setState({ tab: request.tab });
    if (request.track) useVisualizerStudioStore.getState().open(request.track);
    if (request.ids?.length) {
      const { enqueueLocalComposition } = await import("../lib/compositionActions");
      await enqueueLocalComposition(request.ids, request.target);
    }
  });
  navigation = run.catch(() => undefined);
  return run;
}
