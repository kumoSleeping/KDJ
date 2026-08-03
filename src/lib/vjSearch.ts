import type { Platform } from "../types";

/** 从 Explore 面板跳到工作台搜索，避免挂在 Workspace 组件文件上导致 Fast Refresh 失效。 */

export type ExploreSearchDetail = {
  query: string;
  platforms: Platform[];
};

export const EXPLORE_SEARCH_EVENT = "kd:explore-search";

export function requestExploreSearch(query: string, platforms: Platform[]): void {
  const cleaned = platforms.filter((id) => id !== "local");
  if (cleaned.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<ExploreSearchDetail>(EXPLORE_SEARCH_EVENT, {
      detail: { query, platforms: cleaned },
    }),
  );
}

/** 搜 VJ（B 站）快捷入口。 */
export function requestVjSearch(query: string): void {
  requestExploreSearch(query, ["bilibili"]);
}

/** 搜 SoundCloud 快捷入口。 */
export function requestScSearch(query: string): void {
  requestExploreSearch(query, ["soundcloud"]);
}
