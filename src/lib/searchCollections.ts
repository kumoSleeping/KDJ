import type {
  CollectionResolveResponse,
  CollectionResult,
  IntakeItem,
  MergedGroup,
} from "../types";

export const RESOLVED_COLLECTION_PAGE_SIZE = 50;

export interface CollectionPageWindow {
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
    page,
    pageCount,
    start,
    end: Math.min(safeTotal, start + safePageSize),
  };
}

export function collectionToken(collection: CollectionResult): string {
  return `${collection.platform}:${collection.kind}:${collection.key}`;
}

function isSameCollection(
  candidate: CollectionResult,
  collection: CollectionResult,
): boolean {
  return (
    candidate.platform === collection.platform &&
    candidate.kind === collection.kind &&
    candidate.key === collection.key
  );
}

/** 把集合详情响应转换成结果表可直接播放、选择和下载的普通曲目包。 */
export function resolvedCollectionItem(
  collection: CollectionResult,
  response: CollectionResolveResponse,
): IntakeItem {
  const token = collectionToken(collection);
  const inLibrary = new Set(response.in_library_source_keys ?? []);
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
    in_library: inLibrary.has(`${source.platform}:${source.key}`),
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

/**
 * 从搜索结果中移除已展开的集合，并把它的曲目包提升到第一项。
 *
 * 旧实现把新包插在命中的搜索包之后；几十条歌单结果会把刚载入的曲目压到
 * 当前视口下面，看起来就像没有打开。提升到首位既保留其余搜索结果，也让
 * 这次明确打开的内容立即成为当前上下文。
 */
export function promoteResolvedCollection(
  items: IntakeItem[],
  collection: CollectionResult,
  resolved: IntakeItem,
): IntakeItem[] {
  let matched = false;
  const remaining: IntakeItem[] = [];

  for (const item of items) {
    const containsCollection = item.collections.some((candidate) =>
      isSameCollection(candidate, collection),
    );
    if (!containsCollection) {
      // 同一个集合曾被打开过时移除旧副本，新的响应会回到第一项。
      if (item.entry !== resolved.entry) remaining.push(item);
      continue;
    }

    matched = true;
    const parent: IntakeItem = {
      ...item,
      collections: item.collections.filter(
        (candidate) => !isSameCollection(candidate, collection),
      ),
    };
    const parentStillUseful =
      parent.groups.length > 0 ||
      parent.collections.length > 0 ||
      parent.error.length > 0 ||
      Object.keys(parent.errors).length > 0;
    if (parentStillUseful) remaining.push(parent);
  }

  return matched ? [resolved, ...remaining] : items;
}
