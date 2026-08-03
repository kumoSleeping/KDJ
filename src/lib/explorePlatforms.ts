import { create } from "zustand";
import type { Platform } from "../types";
import {
  DEFAULT_PRIORITY,
  normalizePriority,
  normalizeSearchPlatforms,
} from "./searchPlatforms";

/**
 * Explore 自己的平台勾选 / 排序。
 * 和顶栏搜索的 search_platforms / platform_priority 完全独立，互不同步。
 */
const PLATFORMS_KEY = "kd-explore-platforms";
const PRIORITY_KEY = "kd-explore-priority";

/** 默认勾 SoundCloud + B 站：原先 Explore 上下两块的目标源。 */
export const DEFAULT_EXPLORE_PLATFORMS: readonly Platform[] = ["soundcloud", "bilibili"];

function loadPlatforms(): Platform[] {
  try {
    const raw = localStorage.getItem(PLATFORMS_KEY);
    if (!raw) return [...DEFAULT_EXPLORE_PLATFORMS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_EXPLORE_PLATFORMS];
    return normalizeSearchPlatforms(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return [...DEFAULT_EXPLORE_PLATFORMS];
  }
}

function loadPriority(): Platform[] {
  try {
    const raw = localStorage.getItem(PRIORITY_KEY);
    if (!raw) return normalizePriority([...DEFAULT_PRIORITY]);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return normalizePriority([...DEFAULT_PRIORITY]);
    return normalizePriority(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return normalizePriority([...DEFAULT_PRIORITY]);
  }
}

interface ExplorePlatformState {
  platforms: Platform[];
  priority: Platform[];
  toggle(platform: Platform): void;
  reorder(next: Platform[]): void;
}

export const useExplorePlatforms = create<ExplorePlatformState>((set, get) => ({
  platforms: loadPlatforms(),
  priority: loadPriority(),

  toggle(platform) {
    const current = get().platforms;
    const next = current.includes(platform)
      ? current.filter((id) => id !== platform)
      : [...current, platform];
    // 全关掉就搜不了——至少留一个。
    if (next.length === 0) return;
    localStorage.setItem(PLATFORMS_KEY, JSON.stringify(next));
    set({ platforms: next });
  },

  reorder(next) {
    const ordered = normalizePriority(next);
    localStorage.setItem(PRIORITY_KEY, JSON.stringify(ordered));
    set({ priority: ordered });
  },
}));

/** 按 Explore 自己的优先级排出勾选源。 */
export function orderedExplorePlatforms(
  platforms: readonly Platform[],
  priority: readonly Platform[],
): Platform[] {
  const ordered = normalizePriority(priority);
  return [...platforms]
    .filter((id) => id !== "local")
    .sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
}
