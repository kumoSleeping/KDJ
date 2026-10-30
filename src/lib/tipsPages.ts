import { create } from "zustand";
import { getBridge } from "./bridge";

/** The tips drawer's pages, in title order: one kind of lesson each. */
export type TipsPage = "search" | "sidebar" | "download" | "viz" | "player" | "library";
export const tipsPages: readonly { id: TipsPage; label: string; title?: string }[] = [
  { id: "search", label: "搜索", title: "聚合搜索" },
  { id: "sidebar", label: "侧栏", title: "侧边栏" },
  { id: "download", label: "下载" },
  { id: "viz", label: "可视化" },
  { id: "player", label: "播放器", title: "播放器与小窗" },
  { id: "library", label: "曲库", title: "本地曲库" },
];

/** The pages this window offers: the visualizer only on a desktop. */
export function shownTipsPages(): readonly { id: TipsPage; label: string; title?: string }[] {
  let desktop = false;
  try {
    desktop = ["darwin", "win32", "linux"].includes(getBridge().platform);
  } catch { /* no bridge yet */ }
  return desktop ? tipsPages : tipsPages.filter(page => page.id !== "viz");
}

/** The page the tips drawer shows. A view state: it starts over with the app. */
export const useTipsPage = create<{ page: TipsPage; setPage(page: TipsPage): void }>(set => ({
  page: "search",
  setPage: page => set({ page }),
}));
