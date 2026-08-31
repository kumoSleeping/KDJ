import { create } from "zustand";

const STORAGE_KEY = "kd-share-prefs";

/** 分享到外部应用时，普通文本里附带多少歌曲信息。 */
export type ShareContentMode = "link_only" | "song_info" | "more_info";
export const DEFAULT_SHARE_CONTENT_MODE: ShareContentMode = "song_info";

interface SharePrefs {
  contentMode: ShareContentMode;
}

interface SharePrefsState extends SharePrefs {
  setContentMode(value: ShareContentMode): void;
}

const DEFAULTS: SharePrefs = {
  contentMode: DEFAULT_SHARE_CONTENT_MODE,
};

export function normalizeShareContentMode(value: unknown): ShareContentMode {
  return value === "link_only" || value === "more_info" ? value : DEFAULT_SHARE_CONTENT_MODE;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function load(): SharePrefs {
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      contentMode: normalizeShareContentMode((raw as Partial<SharePrefs>).contentMode),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: SharePrefs): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存储不可用时仍保留本次会话里的选择。
  }
}

export const useSharePrefs = create<SharePrefsState>((set) => ({
  ...load(),
  setContentMode(contentMode) {
    const next = { contentMode: normalizeShareContentMode(contentMode) };
    set(next);
    save(next);
  },
}));
