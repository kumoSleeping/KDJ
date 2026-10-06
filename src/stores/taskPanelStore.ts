import { create } from "zustand";

export type TaskPanelView = "downloads" | "history" | "exports" | "export-history";

/** All task pages share one dock identity and its expand/restore state. */
export const useTaskPanelStore = create<{
  view: TaskPanelView;
  setView(view: TaskPanelView): void;
}>((set) => ({
  view: "downloads",
  setView: view => set({ view }),
}));
