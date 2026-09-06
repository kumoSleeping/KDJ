import { create } from "zustand";
import { SEARCH_PLATFORMS } from "../lib/searchPlatforms";
import { readLocalStorage, writeLocalStorageNow } from "../lib/storageWrite";
import type { Platform } from "../types";

const STORAGE_KEY = "kd-sidebar-hidden-platforms-v1";

function readHiddenPlatforms(): Platform[] {
  try {
    const value: unknown = JSON.parse(readLocalStorage(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return SEARCH_PLATFORMS.map((item) => item.id).filter((id) => value.includes(id));
  } catch {
    return [];
  }
}

interface SidebarVisibilityState {
  hiddenPlatforms: Platform[];
  hidePlatform(platform: Platform): void;
  restorePlatforms(platforms: Platform[]): void;
}

/** 仅控制侧栏入口；下载源开关、账号和已打开的歌单保持独立。 */
export const useSidebarVisibilityStore = create<SidebarVisibilityState>((set) => ({
  hiddenPlatforms: readHiddenPlatforms(),
  hidePlatform(platform) {
    set((state) => {
      if (state.hiddenPlatforms.includes(platform)) return state;
      const hiddenPlatforms = [...state.hiddenPlatforms, platform];
      writeLocalStorageNow(STORAGE_KEY, JSON.stringify(hiddenPlatforms));
      return { hiddenPlatforms };
    });
  },
  restorePlatforms(platforms) {
    set((state) => {
      const hiddenPlatforms = state.hiddenPlatforms.filter((id) => !platforms.includes(id));
      if (hiddenPlatforms.length === state.hiddenPlatforms.length) return state;
      writeLocalStorageNow(STORAGE_KEY, JSON.stringify(hiddenPlatforms));
      return { hiddenPlatforms };
    });
  },
}));
