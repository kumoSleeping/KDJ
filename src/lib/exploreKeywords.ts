import { create } from "zustand";

/**
 * Explore 的预设词（作者另算，不进这张表）。
 * Remix / Trance / Bootleg 偏改版；ニコカラ / MV / MAD 偏画面素材。
 */
export const DEFAULT_EXPLORE_KEYWORDS = [
  "Remix",
  "Trance",
  "Bootleg",
  "ニコカラ",
  "MV",
  "MAD",
];

/** 新装默认只勾 Remix。 */
export const DEFAULT_EXPLORE_PICKED = ["Remix"];

const KEYWORDS_KEY = "kd-explore-keywords";
const PICKED_KEY = "kd-explore-picked";
const ARTIST_KEY = "kd-explore-with-artist";

/** 旧两块面板的默认表：若用户没改过，启动时收成 Explore 精选。 */
const LEGACY_DEFAULTS: readonly (readonly string[])[] = [
  ["Remix", "Bootleg", "Mashup", "Edit", "VIP", "House", "Techno", "Trance"],
  [
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
  ],
  ["MV", "官方", "PV", "MAD", "手书", "现场", "4K", "ニコカラ", "投屏"],
];

function sameList(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

function loadFrom(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return fallback;
  }
}

function loadKeywords(): string[] {
  const own = localStorage.getItem(KEYWORDS_KEY);
  if (own !== null) {
    try {
      const parsed: unknown = JSON.parse(own);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      /* fall through */
    }
    return DEFAULT_EXPLORE_KEYWORDS;
  }

  // 首次迁到 Explore：旧 SC / VJ 词表若仍是出厂默认，收成精选；用户自改过的保留。
  const sc = loadFrom("kd-sc-keywords", []);
  const vj = loadFrom("kd-vj-keywords", []);
  const scLegacy = LEGACY_DEFAULTS.some((list) => sameList(sc, list)) || sc.length === 0;
  const vjLegacy = LEGACY_DEFAULTS.some((list) => sameList(vj, list)) || vj.length === 0;
  if (scLegacy && vjLegacy) {
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(DEFAULT_EXPLORE_KEYWORDS));
    return DEFAULT_EXPLORE_KEYWORDS;
  }
  const merged: string[] = [];
  for (const word of [...sc, ...vj]) {
    if (!merged.some((k) => k.toLowerCase() === word.toLowerCase())) merged.push(word);
  }
  const next = merged.length > 0 ? merged : DEFAULT_EXPLORE_KEYWORDS;
  localStorage.setItem(KEYWORDS_KEY, JSON.stringify(next));
  return next;
}

function loadPicked(): string[] {
  const own = localStorage.getItem(PICKED_KEY);
  if (own !== null) {
    try {
      const parsed: unknown = JSON.parse(own);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      /* fall through */
    }
    return DEFAULT_EXPLORE_PICKED;
  }
  const sc = loadFrom("kd-sc-picked", DEFAULT_EXPLORE_PICKED);
  localStorage.setItem(PICKED_KEY, JSON.stringify(sc));
  return sc;
}

interface ExploreKeywordState {
  keywords: string[];
  picked: string[];
  withArtist: boolean;
  add(word: string): void;
  remove(word: string): void;
  reset(): void;
  toggle(word: string): void;
  setWithArtist(value: boolean): void;
}

function loadWithArtist(): boolean {
  const own = localStorage.getItem(ARTIST_KEY);
  if (own !== null) return own !== "0";
  // 旧两块只要有一个显式关掉，就默认关
  if (
    localStorage.getItem("kd-sc-with-artist") === "0" ||
    localStorage.getItem("kd-vj-with-artist") === "0"
  ) {
    return false;
  }
  return true;
}

export const useExploreKeywords = create<ExploreKeywordState>((set, get) => ({
  keywords: loadKeywords(),
  picked: loadPicked(),
  withArtist: loadWithArtist(),

  toggle(word) {
    const picked = get().picked;
    const next = picked.includes(word)
      ? picked.filter((k) => k !== word)
      : [...picked, word];
    localStorage.setItem(PICKED_KEY, JSON.stringify(next));
    set({ picked: next });
  },

  add(word) {
    const clean = word.trim();
    if (!clean || get().keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) return;
    const next = [...get().keywords, clean];
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(next));
    set({ keywords: next });
  },

  remove(word) {
    const next = get().keywords.filter((k) => k !== word);
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(next));
    const picked = get().picked.filter((k) => k !== word);
    localStorage.setItem(PICKED_KEY, JSON.stringify(picked));
    set({ keywords: next, picked });
  },

  reset() {
    localStorage.removeItem(KEYWORDS_KEY);
    localStorage.removeItem(PICKED_KEY);
    set({ keywords: DEFAULT_EXPLORE_KEYWORDS, picked: DEFAULT_EXPLORE_PICKED });
  },

  setWithArtist(value) {
    localStorage.setItem(ARTIST_KEY, value ? "1" : "0");
    set({ withArtist: value });
  },
}));
