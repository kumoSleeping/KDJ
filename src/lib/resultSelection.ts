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

/**
 * Shift-click: the rows from the one touched last to the one clicked, both included, in the
 * order they are shown. Null when either is not among the rows shown (the anchor was on another
 * page, or was folded away) — the click then picks its own row only.
 */
export function selectionRun(
  shown: readonly string[],
  anchor: string | null,
  target: string,
): string[] | null {
  if (anchor === null) return null;
  const from = shown.indexOf(anchor);
  const to = shown.indexOf(target);
  if (from < 0 || to < 0) return null;
  return shown.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** All of a set of rows is picked, a part of it, or none: what the head's mark shows. */
export function pickStateOf(
  keys: readonly string[],
  selected: ReadonlySet<string>,
): "none" | "some" | "all" {
  let picked = 0;
  for (const key of keys) if (selected.has(key)) picked += 1;
  if (picked === 0) return "none";
  return picked === keys.length ? "all" : "some";
}
