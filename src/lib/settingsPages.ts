import { create } from "zustand";

/** The settings drawer's pages, in title order. Each groups a few of the settings sections. */
export const settingsPages = [
  { id: "general", label: "通用" },
  { id: "playback", label: "播放" },
  { id: "sources", label: "下载" },
  { id: "system", label: "系统" },
] as const;
export type SettingsPage = typeof settingsPages[number]["id"];

/** The page the settings drawer shows. A view state: it starts over with the app. */
export const useSettingsPage = create<{ page: SettingsPage; setPage(page: SettingsPage): void }>(set => ({
  page: "general",
  setPage: page => set({ page }),
}));
