/** 从导出 VJ 面板跳到工作台搜索，避免挂在 Workspace 组件文件上导致 Fast Refresh 失效。 */

export const VJ_SEARCH_EVENT = "kd:vj-search";

export function requestVjSearch(query: string): void {
  window.dispatchEvent(new CustomEvent<string>(VJ_SEARCH_EVENT, { detail: query }));
}
