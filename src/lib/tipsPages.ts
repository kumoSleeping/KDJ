import { create } from "zustand";

/** The tips drawer's pages, in title order: one kind of lesson each. */
export type TipsPage = "search" | "download" | "viz" | "player" | "all";
export const tipsPages: readonly { id: TipsPage; label: string; title?: string }[] = [
  { id: "search", label: "搜索", title: "聚合搜索" },
  { id: "download", label: "下载" },
  { id: "viz", label: "可视化" },
  { id: "player", label: "播放器", title: "播放器与小窗" },
  { id: "all", label: "更多", title: "全部使用提示" },
];

/** The page the tips drawer shows. A view state: it starts over with the app. */
export const useTipsPage = create<{ page: TipsPage; setPage(page: TipsPage): void }>(set => ({
  page: "search",
  setPage: page => set({ page }),
}));
