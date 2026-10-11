import type { CollectionResult, IntakeItem, MergedGroup, VideoInfo } from "../../types";
import { collectionToken, isResolvedCollectionItem } from "../../lib/searchCollections";
import { selectableGroups, selectionKey } from "../../lib/resultSelection";

/**
 * The search results as the row list places them (components/common/rowList.ts): a flat run of
 * blocks, top to bottom. A block is what stays together on screen and is measured as one — a
 * song with the sources that unfold under it, a video with its parts, a collection, or a whole
 * package (an entry of a batch with its head row and everything under it, which folds as one).
 * The list of a single search or an opened collection is flat: every song is a block of its own,
 * so a long playlist is virtualized song by song.
 */
export type ResultBlock =
  | { kind: "video"; key: string; video: VideoInfo; rows: number }
  | {
      kind: "collection"; key: string; itemIndex: number; item: IntakeItem;
      collection: CollectionResult; collectionIndex: number; indent: boolean; rows: number;
    }
  | {
      kind: "group"; key: string; itemIndex: number; item: IntakeItem; group: MergedGroup;
      /** The group's place among its item's shown groups, and the number its row shows. */
      position: number; rowNumber: number; indent: boolean; rows: number;
    }
  | {
      kind: "package"; key: string; itemIndex: number; item: IntakeItem;
      /** Groups of the package that are reached (an opened collection shows a prefix). */
      shownGroups: number; collapsed: boolean; rows: number;
    };

export interface ResultBlocksInput {
  items: readonly IntakeItem[];
  video: VideoInfo | null;
  /** Per item, how many of its groups are shown; `null` for an item not reached yet (searchCollections). */
  shownRows: readonly (number | null | undefined)[];
  collapsedItems: ReadonlySet<number>;
  /** Groups whose sources are open: their blocks hold more rows. */
  expandedGroups: ReadonlySet<string>;
}

/**
 * 单条关键词搜索和单次合集搜索都直接铺列表：查询词与结果总数已经在顶部工作条表达，再套一层
 * "查询词 · N 个集合"的父行只会重复语义。
 */
export function resultListIsFlat(items: readonly IntakeItem[]): boolean {
  return items.length === 1
    && (items[0].kind === "search" || (items[0].groups.length === 0 && items[0].collections.length > 0));
}

export function resultBlocks(input: ResultBlocksInput): ResultBlock[] {
  const { items, video, shownRows, collapsedItems, expandedGroups } = input;
  const blocks: ResultBlock[] = [];
  const flat = resultListIsFlat(items);
  if (video) blocks.push({ kind: "video", key: `video:${video.bvid}`, video, rows: 1 });
  // 已解析合集是独立详情页：它的歌曲直接铺开，序号接着前面的合集数。
  let flatRowOffset = video ? 1 : 0;
  for (const [itemIndex, item] of items.entries()) {
    const shown = shownRows[itemIndex];
    // Not reached yet: a collection above this item is only partly shown.
    if (shown === null || shown === undefined) continue;
    const directCollection = isResolvedCollectionItem(item);
    const itemFlat = flat || directCollection;
    const shownGroups = Math.min(shown, item.groups.length);
    if (!itemFlat) {
      const collapsed = collapsedItems.has(itemIndex);
      blocks.push({ kind: "package", key: `package:${itemIndex}:${item.entry}`, itemIndex, item, shownGroups, collapsed,
        rows: collapsed ? 1 : 1 + item.collections.length + shownGroups });
      continue;
    }
    for (const [collectionIndex, collection] of item.collections.entries()) {
      blocks.push({ kind: "collection", key: `collection:${itemIndex}:${collectionToken(collection)}`,
        itemIndex, item, collection, collectionIndex, indent: false, rows: 1 });
    }
    for (let position = 0; position < shownGroups; position += 1) {
      const group = item.groups[position];
      const open = expandedGroups.has(group.group_id);
      blocks.push({ kind: "group", key: `group:${itemIndex}:${group.group_id}`, itemIndex, item, group, position,
        rowNumber: flatRowOffset + position + 1, indent: false, rows: 1 + (open ? group.sources.length : 0) });
    }
    if (directCollection) flatRowOffset += item.groups.length;
  }
  return blocks;
}

/** The keys of the rows that can be picked, in the order they are shown: what a Shift-click's run follows. */
export function resultPickKeys(blocks: readonly ResultBlock[]): string[] {
  const keys: string[] = [];
  for (const block of blocks) {
    if (block.kind === "group") {
      if (block.group.sources.some((source) => source.platform !== "local")) keys.push(selectionKey(block.itemIndex, block.group.group_id));
    } else if (block.kind === "package" && !block.collapsed) {
      const shown = new Set(block.item.groups.slice(0, block.shownGroups).map((group) => group.group_id));
      for (const group of selectableGroups(block.item)) {
        if (shown.has(group.group_id)) keys.push(selectionKey(block.itemIndex, group.group_id));
      }
    }
  }
  return keys;
}

/** Rows the blocks hold between them, for aria-rowcount. */
export function resultRowCount(blocks: readonly ResultBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.rows, 0);
}
