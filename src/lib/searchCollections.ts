import type {
  CollectionResolveResponse,
  CollectionResult,
  IntakeItem,
  MergedGroup,
} from "../types";

export const RESOLVED_COLLECTION_PAGE_SIZE = 50;

export interface CollectionPageWindow {
  total: number;
  page: number;
  pageCount: number;
  start: number;
  end: number;
}

/**
 * 已完整载入的远程集合只分页渲染，下载、全选和试听队列仍使用完整曲目集。
 * requestedPage 可能来自旧 UI state；集合刷新变短时在这里统一夹回有效页。
 */
export function collectionPageWindow(
  total: number,
  requestedPage: number | undefined,
  pageSize = RESOLVED_COLLECTION_PAGE_SIZE,
): CollectionPageWindow {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.trunc(pageSize)) : 1;
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const numericPage =
    typeof requestedPage === "number" && Number.isFinite(requestedPage)
      ? Math.trunc(requestedPage)
      : 1;
  const page = Math.min(pageCount, Math.max(1, numericPage));
  const start = Math.min(safeTotal, (page - 1) * safePageSize);
  return {
    total: safeTotal,
    page,
    pageCount,
    start,
    end: Math.min(safeTotal, start + safePageSize),
  };
}

export function collectionToken(collection: CollectionResult): string {
  return `${collection.platform}:${collection.kind}:${collection.key}`;
}

/** 把集合详情响应转换成结果表可直接播放、选择和下载的普通曲目包。 */
export function resolvedCollectionItem(
  collection: CollectionResult,
  response: CollectionResolveResponse,
): IntakeItem {
  const token = collectionToken(collection);
  const groups: MergedGroup[] = response.sources.map((source, index) => ({
    group_id: `${token}:${source.key}:${index}`,
    title: source.title,
    artists: source.artists,
    album: source.album,
    duration: source.duration,
    cover: source.cover || collection.cover,
    sources: [source],
    best_source_index: 0,
    score: 0,
  }));

  return {
    entry: token,
    kind: collection.kind,
    platform: response.platform,
    title: response.title || collection.title,
    groups,
    collections: [],
    errors: {},
    error: "",
  };
}

export function isResolvedCollectionItem(item: IntakeItem): boolean {
  return (
    item.groups.length > 0 &&
    (
      item.kind === "playlist" ||
      item.kind === "artist" ||
      item.kind === "album" ||
      item.kind === "radio"
    )
  );
}

/** 集合详情是独立页面：只有唯一一个已解析合集时才进入详情语义。 */
export function openedCollectionItem(items: IntakeItem[]): IntakeItem | null {
  const item = items.length === 1 ? items[0] : undefined;
  return item && isResolvedCollectionItem(item) ? item : null;
}
