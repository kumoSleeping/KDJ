import type { Platform, Settings } from "../types";
import { normalizeEnabledPlatforms } from "./searchPlatforms";

export { normalizeEnabledPlatforms } from "./searchPlatforms";

export function isPlatformEnabled(
  settings: Settings | null | undefined,
  platform: Platform,
): boolean {
  return normalizeEnabledPlatforms(settings?.enabled_platforms).includes(platform);
}

/** 开关某个下载源；关掉时同步从搜索勾选里摘掉；SoundCloud 旧字段一并对齐。 */
export function patchEnabledPlatform(
  settings: Settings,
  platform: Platform,
  on: boolean,
): Partial<Settings> {
  const current = normalizeEnabledPlatforms(settings.enabled_platforms);
  const enabled = on
    ? current.includes(platform)
      ? current
      : [...current, platform]
    : current.filter((id) => id !== platform);
  // 至少留一个，否则搜/下全瞎。
  const nextEnabled = enabled.length > 0 ? enabled : current;
  const search = (settings.search_platforms ?? []).filter((id) =>
    nextEnabled.includes(id as Platform),
  );
  const nextSearch = search.length > 0 ? search : nextEnabled.slice(0, 1).map(String);
  return {
    enabled_platforms: nextEnabled,
    search_platforms: nextSearch,
    soundcloud_enabled: nextEnabled.includes("soundcloud"),
  };
}
