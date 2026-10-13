import { create } from "zustand";

/** The tips drawer's pages, in title order: one kind of lesson each. */
export type TipsPage = "search" | "download" | "viz" | "pip" | "player" | "all";
export const tipsPages: readonly { id: TipsPage; label: string; title?: string }[] = [
  { id: "search", label: "搜索", title: "聚合搜索" },
  { id: "download", label: "下载" },
  { id: "viz", label: "可视化" },
  { id: "pip", label: "小窗", title: "小窗播放器" },
  { id: "player", label: "播放器" },
  { id: "all", label: "全部", title: "全部使用提示" },
];

/** The page the tips drawer shows. A view state: it starts over with the app. */
export const useTipsPage = create<{ page: TipsPage; setPage(page: TipsPage): void }>(set => ({
  page: "search",
  setPage: page => set({ page }),
}));
