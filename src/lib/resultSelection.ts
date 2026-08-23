import type { IntakeItem, MergedGroup } from "../types";

/** 选中键：group_id 在不同 item 之间可能重复（同一首歌被两条关键词搜到）。 */
export function selectionKey(itemIndex: number, groupId: string): string {
  return `${itemIndex}:${groupId}`;
}

/** 歌曲和 B 站视频共用批量选择；已入库及纯本地组不重复入队。 */
export function selectableGroups(item: IntakeItem): MergedGroup[] {
  return item.groups.filter(
    (group) =>
      !group.in_library &&
      group.sources.some((source) => source.platform !== "local"),
  );
}
