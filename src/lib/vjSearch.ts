/** 从 Explore 面板跳到工作台搜索，避免挂在 Workspace 组件文件上导致 Fast Refresh 失效。 */

export type ExploreSearchPlatform = "bilibili" | "soundcloud";

export type ExploreSearchDetail = {
  query: string;
  platform: ExploreSearchPlatform;
};

export const EXPLORE_SEARCH_EVENT = "kd:explore-search";

export function requestExploreSearch(query: string, platform: ExploreSearchPlatform): void {
  window.dispatchEvent(
    new CustomEvent<ExploreSearchDetail>(EXPLORE_SEARCH_EVENT, {
      detail: { query, platform },
    }),
  );
}

/** 搜 VJ（B 站）快捷入口。 */
export function requestVjSearch(query: string): void {
  requestExploreSearch(query, "bilibili");
}

/** 搜 SoundCloud 快捷入口。 */
export function requestScSearch(query: string): void {
  requestExploreSearch(query, "soundcloud");
}
