import { create } from "zustand";

/** The settings drawer's pages, in title order. Each groups a few of the settings sections. */
export const settingsPages = [
  { id: "general", label: "通用" },
  { id: "playback", label: "播放" },
  { id: "sources", label: "登录" },
  { id: "system", label: "系统" },
] as const;
export type SettingsPage = typeof settingsPages[number]["id"];

/** The page the settings drawer shows. A view state: it starts over with the app. */
export const useSettingsPage = create<{ page: SettingsPage; setPage(page: SettingsPage): void }>(set => ({
  page: "general",
  setPage: page => set({ page }),
}));

/** A section of a settings page that opening settings should bring into view. */
export type SettingsSection = "ffmpeg" | "report" | "ai";

/** Asks the settings drawer to land on a section: `focus` bumps the epoch the panel reacts to. */
export const useSettingsFocus = create<{ section: SettingsSection | null; epoch: number; focus(section: SettingsSection): void; clear(): void }>(set => ({
  section: null,
  epoch: 0,
  focus: section => set(state => ({ section, epoch: state.epoch + 1 })),
  clear: () => set({ section: null }),
}));

/**
 * Asks the 登录 page to open one account's ways to log in: the sidebar's 登录 of a source lands on
 * that source's own block, not at the top of the page. The row takes the request and clears it.
 */
export const useLoginRequest = create<{ platform: string | null; epoch: number; ask(platform: string): void; clear(): void }>(set => ({
  platform: null,
  epoch: 0,
  ask: platform => set(state => ({ platform, epoch: state.epoch + 1 })),
  clear: () => set({ platform: null }),
}));
