import { create } from "zustand";
import { readLocalStorage, writeLocalStorageSoon } from "./storageWrite";
import { visualizerExportAvailable } from "./platformFeatures";

/** The sections of the visualizer configuration, in title order. */
export const studioTabs = [{ id: "scene", label: "画面" }, { id: "pictures", label: "图片" }, { id: "text", label: "文字" }, { id: "output", label: "导出" }] as const;
export type StudioTab = typeof studioTabs[number]["id"];
/** Without an exporter there are no export settings. */
export const shownStudioTabs = () => visualizerExportAvailable() ? studioTabs : studioTabs.filter(tab => tab.id !== "output");

const STUDIO_TAB_KEY = "kd-visualizer-studio-tab";
function savedStudioTab(): StudioTab {
  const saved = readLocalStorage(STUDIO_TAB_KEY);
  return shownStudioTabs().find(tab => tab.id === saved)?.id ?? "scene";
}

/** The section in view. A view preference only; it is never part of a visualizer project. */
export const useStudioTab = create<{ tab: StudioTab; setTab(tab: StudioTab): void }>(set => ({
  tab: savedStudioTab(),
  setTab: tab => { set({ tab }); writeLocalStorageSoon(STUDIO_TAB_KEY, tab); },
}));
