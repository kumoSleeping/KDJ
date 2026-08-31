import { create } from "zustand";
import { readLocalStorage, removeLocalStorage, writeLocalStorageNow } from "./storageWrite";

/**
 * 「搜索 SoundCloud」的风格预设（精选，约两行）。
 *
 * 默认只勾 Remix——找改版/翻制的最常用入口。
 * 前半是改版形态，后半是几大门派风格词。
 */
export const DEFAULT_SC_KEYWORDS = [
  "Remix",
  "Bootleg",
  "Mashup",
  "Edit",
  "VIP",
  "House",
  "Techno",
  "Trance",
];

/** 上一版默认表：若用户没改过，启动时收成精选两行。 */
const LEGACY_SC_KEYWORDS = [
  "Remix",
  "Bootleg",
  "Mashup",
  "Edit",
  "VIP",
  "Extended",
  "House",
  "Techno",
  "Trance",
  "Melodic",
  "DnB",
  "Hardstyle",
  "Future Bass",
  "Deep House",
];

/** 新装 / 重置后默认只勾 Remix。 */
export const DEFAULT_SC_PICKED = ["Remix"];

const KEYWORDS_KEY = "kd-sc-keywords";
const PICKED_KEY = "kd-sc-picked";
const ARTIST_KEY = "kd-sc-with-artist";

function sameList(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

function load(): string[] {
  try {
    const raw = readLocalStorage(KEYWORDS_KEY);
    if (!raw) return DEFAULT_SC_KEYWORDS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SC_KEYWORDS;
    const list = parsed.filter((item): item is string => typeof item === "string");
    // 还停在旧默认长表上 → 收成精选，不打扰用户自己加过的词。
    if (sameList(list, LEGACY_SC_KEYWORDS)) {
      writeLocalStorageNow(KEYWORDS_KEY, JSON.stringify(DEFAULT_SC_KEYWORDS));
      return DEFAULT_SC_KEYWORDS;
    }
    return list;
  } catch {
    return DEFAULT_SC_KEYWORDS;
  }
}

function loadPicked(): string[] {
  try {
    const raw = readLocalStorage(PICKED_KEY);
    if (raw === null) return DEFAULT_SC_PICKED;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : DEFAULT_SC_PICKED;
  } catch {
    return DEFAULT_SC_PICKED;
  }
}

interface ScKeywordState {
  keywords: string[];
  picked: string[];
  /** 拼搜索词时要不要带上艺人名。 */
  withArtist: boolean;
  add(word: string): void;
  remove(word: string): void;
  reset(): void;
  toggle(word: string): void;
  setWithArtist(value: boolean): void;
}

export const useScKeywords = create<ScKeywordState>((set, get) => ({
  keywords: load(),
  picked: loadPicked(),
  // 未写过开关时默认带上艺人；显式存 "0" 才关掉。
  withArtist: readLocalStorage(ARTIST_KEY) !== "0",

  toggle(word) {
    const picked = get().picked;
    const next = picked.includes(word)
      ? picked.filter((k) => k !== word)
      : [...picked, word];
    writeLocalStorageNow(PICKED_KEY, JSON.stringify(next));
    set({ picked: next });
  },

  add(word) {
    const clean = word.trim();
    if (!clean || get().keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) return;
    const next = [...get().keywords, clean];
    writeLocalStorageNow(KEYWORDS_KEY, JSON.stringify(next));
    set({ keywords: next });
  },

  remove(word) {
    const next = get().keywords.filter((k) => k !== word);
    writeLocalStorageNow(KEYWORDS_KEY, JSON.stringify(next));
    const picked = get().picked.filter((k) => k !== word);
    writeLocalStorageNow(PICKED_KEY, JSON.stringify(picked));
    set({ keywords: next, picked });
  },

  reset() {
    removeLocalStorage(KEYWORDS_KEY);
    removeLocalStorage(PICKED_KEY);
    set({ keywords: DEFAULT_SC_KEYWORDS, picked: DEFAULT_SC_PICKED });
  },

  setWithArtist(value) {
    writeLocalStorageNow(ARTIST_KEY, value ? "1" : "0");
    set({ withArtist: value });
  },
}));
