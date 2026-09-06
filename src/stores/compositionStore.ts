import { create } from "zustand";
import { api } from "../lib/api";
import { COMPOSITION_DEFAULTS } from "../lib/composition";
import type { WsEvent } from "../types";
import type { CompositionLane, CompositionOptions, CompositionPatch, CompositionSnapshot, CompositionTask } from "../types/composition";

interface CompositionStore extends CompositionSnapshot {
  error: string; acting: boolean;
  accept(snapshot: CompositionSnapshot): void;
  refresh(): Promise<void>;
  perform(action: () => Promise<CompositionSnapshot>): Promise<void>;
  enqueue(ids: number[]): Promise<void>;
  reorder(lane: CompositionLane, ids: string[]): Promise<void>;
  stack(source: string, target: string): Promise<void>;
  patch(task: CompositionTask, patch: Omit<CompositionPatch, "generation">): Promise<void>;
  reanalyze(task: CompositionTask): Promise<void>;
  setDefaults(options: CompositionOptions): Promise<void>;
  start(ids?: string[]): Promise<void>;
  cancel(ids?: string[]): Promise<void>;
  remove(id?: string, lane?: CompositionLane): Promise<void>;
  handleEvent(event: WsEvent): void;
  clearError(): void;
}
let refreshing: Promise<void> | null = null;
let actionTail: Promise<void> = Promise.resolve();
let pendingActions = 0;
const retiredSessions = new Set<string>();
export const useCompositionStore = create<CompositionStore>()((set, get) => ({
  session_id: "", revision: -1, tasks: [], defaults: COMPOSITION_DEFAULTS, error: "", acting: false,
  accept(snapshot) {
    const current = get();
    if (snapshot.session_id !== current.session_id) {
      if (retiredSessions.has(snapshot.session_id)) return;
      if (current.session_id) retiredSessions.add(current.session_id);
      set(snapshot);
    } else if (snapshot.revision >= current.revision) set(snapshot);
  },
  refresh() {
    if (refreshing) return refreshing;
    refreshing = api.compositions().then((snapshot) => get().accept(snapshot)).catch((error: unknown) => {
      set({ error: (error as Error).message });
    }).finally(() => { refreshing = null; });
    return refreshing;
  },
  perform(action) {
    pendingActions += 1;
    set({ acting: true, error: "" });
    const run = actionTail.then(async () => {
      try { get().accept(await action()); }
      catch (error) { set({ error: (error as Error).message }); await get().refresh(); }
      finally { pendingActions -= 1; set({ acting: pendingActions > 0 }); }
    });
    actionTail = run;
    return run;
  },
  enqueue: (ids) => get().perform(() => api.enqueueCompositions(ids)),
  reorder: (lane, ids) => get().perform(() => api.reorderCompositions(lane, ids)),
  stack: (source, target) => get().perform(() => api.stackCompositionVideo(source, target)),
  patch: (task, patch) => get().perform(() => api.patchComposition(task.id, { generation: task.generation, ...patch })),
  reanalyze: (task) => get().perform(() => api.reanalyzeComposition(task.id, task.generation)),
  setDefaults: (options) => get().perform(() => api.compositionDefaults(options)),
  start: (ids) => get().perform(() => api.startCompositions(ids)),
  cancel: (ids) => get().perform(() => api.cancelCompositions(ids)),
  remove: (id, lane) => get().perform(() => api.removeComposition(id, lane)),
  handleEvent(event) {
    if (event.type === "composition.updated" || event.type === "composition.list") get().accept(event.payload);
    if (event.type === "connection.open") void get().refresh();
    if (event.type === "composition.completed") api.invalidateTrackDetail(event.payload.track_id);
  },
  clearError: () => set({ error: "" }),
}));
