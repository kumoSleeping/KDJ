import type { Platform } from "../types";

/** 平台一览（仅在线源）。YTM 音乐与普通 YouTube 视频是两个独立来源。 */
export const SEARCH_PLATFORMS: ReadonlyArray<{ id: Platform; label: string; video?: boolean }> = [
  { id: "wyy", label: "网易云" },
  { id: "qqm", label: "QQ 音乐" },
  { id: "soundcloud", label: "SOUNDCLOUD" },
  { id: "ytm", label: "YouTube Music" },
  { id: "youtube", label: "YouTube Video", video: true },
  { id: "bilibili", label: "哔哩哔哩", video: true },
];

export const DEFAULT_PRIORITY: readonly string[] = [
  "wyy",
  "qqm",
  "soundcloud",
  "ytm",
  "youtube",
  "bilibili",
];
/** 默认开启 / 勾选：仅网易云与 QQ。 */
export const DEFAULT_SEARCH_PLATFORMS: readonly Platform[] = ["wyy", "qqm"];

/** 补齐缺失平台；丢掉已下线的 local 等旧项。 */
export function normalizePriority(priority: readonly string[]): Platform[] {
  const known = SEARCH_PLATFORMS.map((item) => item.id);
  const ordered = priority.filter((id): id is Platform => known.includes(id as Platform));
  for (const id of known) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

/** 勾选列表：只保留仍在线的平台；空/缺省回落到默认勾选。 */
export function normalizeSearchPlatforms(selected: readonly string[] | undefined): Platform[] {
  const known = SEARCH_PLATFORMS.map((item) => item.id);
  const next = (selected ?? []).filter((id): id is Platform => known.includes(id as Platform));
  return next.length > 0 ? next : [...DEFAULT_SEARCH_PLATFORMS];
}

/** 设置里开启的下载源；缺省/空时回落默认（网易云 + QQ）。 */
export function normalizeEnabledPlatforms(selected: readonly string[] | undefined): Platform[] {
  const known = SEARCH_PLATFORMS.map((item) => item.id);
  const next = (selected ?? []).filter((id): id is Platform => known.includes(id as Platform));
  return next.length > 0 ? next : [...DEFAULT_SEARCH_PLATFORMS];
}
