import type { IntakeItem, MergedGroup } from "../types";

/** 选中键：group_id 在不同 item 之间可能重复（同一首歌被两条关键词搜到）。 */
export function selectionKey(itemIndex: number, groupId: string): string {
  return `${itemIndex}:${groupId}`;
}

/**
 * 右键落在现有选区内时，行级动作必须作用于整个选区；落在选区外才只作用于该行。
 * 这与本地曲库的多选菜单一致，也避免“全选后右键下载却只加入点中的一个”。
 */
export function resultRowActionUsesSelection(
  selected: ReadonlySet<string>,
  rowKey: string,
): boolean {
  return selected.has(rowKey);
}

/** 歌曲和视频共用批量选择；纯本地组没有可下载来源。 */
export function selectableGroups(item: IntakeItem): MergedGroup[] {
  return item.groups.filter(
    (group) => group.sources.some((source) => source.platform !== "local"),
  );
}
