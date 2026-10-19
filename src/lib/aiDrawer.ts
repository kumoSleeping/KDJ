/**
 * The AI's app in the list's drawer (docs/ai-dock.md, "AI 抽屉"): 任务 — the request under way or
 * the last one, step by step — and 历史 — the earlier sessions, read back and continued. Opened
 * from the drawer's head or from the Agent Mode name in the search row.
 */
import { create } from "zustand";
import { useSidePanels } from "./sidePanels";

export type AiDrawerPage = "tasks" | "history";

export const aiDrawerPages: { id: AiDrawerPage; label: string }[] = [
  { id: "tasks", label: "任务" },
  { id: "history", label: "历史" },
];

/** The id of the app among the drawer's (drawerApps.tsx). */
export const AI_DRAWER_APP = "ai";

export const useAiDrawer = create<{
  open: boolean;
  page: AiDrawerPage;
  show(page?: AiDrawerPage): void;
  setPage(page: AiDrawerPage): void;
  close(): void;
}>((set, get) => ({
  open: false,
  page: "tasks",
  show(page) {
    set({ open: true, page: page ?? get().page });
    useSidePanels.getState().raise(AI_DRAWER_APP);
  },
  setPage(page) {
    set({ page });
  },
  close() {
    set({ open: false });
  },
}));
