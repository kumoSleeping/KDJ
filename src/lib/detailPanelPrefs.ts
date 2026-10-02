import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const HIDDEN_KEY = "kd-detail-panels-hidden";
function readHiddenPanels(): string[] {
  try {
    const value: unknown = JSON.parse(readLocalStorage(HIDDEN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export const useDetailPanelPrefs = create<{
  hiddenIds: string[];
  setVisible(id: string, visible: boolean): void;
}>((set) => ({
  hiddenIds: readHiddenPanels(),
  setVisible(id, visible) {
    set(state => {
      const hiddenIds = visible ? state.hiddenIds.filter(value => value !== id)
        : [...new Set([...state.hiddenIds, id])];
      writeLocalStorageNow(HIDDEN_KEY, JSON.stringify(hiddenIds));
      return { hiddenIds };
    });
  },
}));

// 固定布局沿用已有排序偏好；没有历史偏好时视频优先。
// 本地与在线曲目共用同一份排序，切换曲目类型时不移动板块。
export const DETAIL_PANELS_STORAGE_KEY = "kd-detail-panels-v2";
export const DETAIL_PANELS_DEFAULT_FIRST_IDS = ["video"] as const;
