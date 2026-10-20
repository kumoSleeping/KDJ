import type {
  CollectionResolveResponse,
  CollectionResult,
  IntakeItem,
  MergedGroup,
  SongSource,
} from "../types";

/**
 * An opened collection is one list that grows: this many rows are shown at first, and the same
 * number more each time the end of what is shown is reached.
 */
export const COLLECTION_BATCH_SIZE = 50;
/**
 * A list whose further rows are fetched from the provider is reopened at startup where it was
 * left only when that place lies within this many rows; a deeper one starts at its top instead
 * of walking the provider's pages before anything is shown.
 */
export const RESTORED_FETCH_ROWS = COLLECTION_BATCH_SIZE * 4;

/** What the top rail is told about the opened collection. `total` is its whole size. */
export interface CollectionPageWindow {
  total: number;
  page: number;
  pageCount: number;
  start: number;
  end: number;
}

function rowCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * The opened collection as the rail sees it: the whole size and how far it is shown. The list
 * is not cut into pages any more, so there is always exactly one.
 */
export function collectionListWindow(total: number, shown: number): CollectionPageWindow {
  const safeTotal = rowCount(total);
  return {
    total: safeTotal,
    page: 1,
    pageCount: 1,
    start: 0,
    end: Math.min(safeTotal, rowCount(shown)),
  };
}

/** Rows of opened collections the list has in hand, shown or not. */
export function collectionRowsInHand(items: readonly IntakeItem[]): number {
  return items.reduce(
    (sum, item) => (isResolvedCollectionItem(item) ? sum + item.groups.length : sum),
    0,
  );
}

export interface CollectionReveal {
  /**
   * Per item, how many of its rows are shown; `null` for an item that is not reached yet. An
   * item that is not an opened collection is shown whole or not at all.
   */
  rows: (number | null)[];
  /** Collection rows shown, over all items. */
  shown: number;
}

/**
 * Which rows a list shows once `shown` collection rows are revealed. The list is always a
 * prefix of the whole one: collections fill in order, and nothing below a collection that is
 * only partly shown is there yet. So rows are only ever added at the end.
 */
export function collectionReveal(items: readonly IntakeItem[], shown: number): CollectionReveal {
  let left = rowCount(shown);
  let cut = false;
  const rows = items.map((item) => {
    if (cut) return null;
    if (!isResolvedCollectionItem(item)) return item.groups.length;
    const count = Math.min(left, item.groups.length);
    left -= count;
    cut = count < item.groups.length;
    return count;
  });
  return { rows, shown: rowCount(shown) - left };
}

export interface CollectionBatchStep {
  /** Rows shown once the batch has landed. */
  shown: number;
  /**
   * The cumulative number of rows to ask the provider for, when the batch is not in hand;
   * `null` when it only has to be shown.
   */
  fetch: number | null;
}

/**
 * The next batch of a list that shows `shown` rows, has `inHand` and is `total` long (a
 * provider that hands its list over in pieces knows a longer total than what is in hand).
 * `null` when everything is shown.
 */
export function nextCollectionBatch(
  shown: number,
  inHand: number,
  total: number,
  batch = COLLECTION_BATCH_SIZE,
): CollectionBatchStep | null {
  const have = rowCount(inHand);
  const all = Math.max(have, rowCount(total));
  const now = Math.min(rowCount(shown), have);
  if (now >= all) return null;
  const next = Math.min(all, now + Math.max(1, rowCount(batch)));
  return { shown: next, fetch: next > have ? next : null };
}

/**
 * What a provider's answer to "the first `asked` rows" says about the list: one that comes
 * back short has ended there, whatever the directory claimed.
 */
export function fetchedCollectionTotal(asked: number, received: number, claimed: number): number {
  return received < asked ? rowCount(received) : Math.max(rowCount(claimed), rowCount(received));
}

function groupSourceKey(group: MergedGroup): string {
  const source = group.sources[0];
  return source ? `${source.platform}:${source.key}` : group.group_id;
}

/**
 * The rows in hand followed by the ones a longer answer added. Rows in hand stay the objects
 * they are (their ids carry the selection and the row's state); a song a list holds twice is
 * told apart by counting.
 */
export function appendFetchedGroups(
  inHand: readonly MergedGroup[],
  fetched: readonly MergedGroup[],
): MergedGroup[] {
  const held = new Map<string, number>();
  const ids = new Set<string>();
  for (const group of inHand) {
    const key = groupSourceKey(group);
    held.set(key, (held.get(key) ?? 0) + 1);
    ids.add(group.group_id);
  }
  const next = [...inHand];
  for (const group of fetched) {
    const key = groupSourceKey(group);
    const count = held.get(key) ?? 0;
    if (count > 0) {
      held.set(key, count - 1);
      continue;
    }
    // An id is the row's key in the table: never hand out one that is already taken.
    let id = group.group_id;
    while (ids.has(id)) id = `${id}+`;
    ids.add(id);
    next.push(id === group.group_id ? group : { ...group, group_id: id });
  }
  return next;
}

/**
 * Where a list that was open when the app closed is opened again: `shown` rows and the scroll
 * position, or its top when getting there would mean fetching more than RESTORED_FETCH_ROWS.
 */
export function restoredCollectionView(
  saved: { shown: number; scrollTop: number },
  fetched: boolean,
): { shown: number; scrollTop: number } {
  const shown = Math.max(COLLECTION_BATCH_SIZE, rowCount(saved.shown));
  if (fetched && shown > RESTORED_FETCH_ROWS) {
    return { shown: COLLECTION_BATCH_SIZE, scrollTop: 0 };
  }
  return { shown, scrollTop: Math.max(0, Number.isFinite(saved.scrollTop) ? saved.scrollTop : 0) };
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

function payloadId(value: unknown): string {
  if (typeof value === "number") return value > 0 ? String(value) : "";
  return typeof value === "string" && value.trim() && value.trim() !== "0" ? value.trim() : "";
}

/**
 * The album a song of an online list belongs to, as a collection that can be opened or
 * downloaded whole — from the platform's own song record the source carries. Only the platforms
 * that can list an album (NetEase, QQ Music) have one; a song outside any album has none.
 */
export function albumOfSource(source: SongSource): CollectionResult | null {
  const payload = source.payload;
  const field = (record: unknown, key: string) =>
    record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
  let key = "";
  if (source.platform === "wyy") {
    key = payloadId(field(payload.al, "id")) || payloadId(field(payload.album, "id"));
  } else if (source.platform === "qqm") {
    key = payloadId(field(payload.album, "mid"))
      || payloadId(payload.album_mid)
      || payloadId(payload.albummid)
      || payloadId(field(payload.album, "id"));
  }
  if (!key || !source.album.trim()) return null;
  return {
    kind: "album",
    platform: source.platform,
    key,
    title: source.album,
    subtitle: source.artists.join(" / "),
    cover: source.cover,
    count: 0,
  };
}

function searchable(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

/**
 * The opened collection as a search within it shows it: only the songs whose title, artists or
 * album hold every word of `query`. The rows keep their group ids, so a pick made while
 * searching is the same pick without it. No song matches: the list is empty — a plain list with
 * no rows, not a collection, which would be drawn as a package head.
 */
export function filteredCollectionItem(item: IntakeItem, query: string): IntakeItem {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return item;
  const groups = item.groups.filter((group) => {
    const text = searchable([
      group.title,
      group.album,
      ...group.artists,
      ...group.sources.flatMap((source) => [source.title, source.album, ...source.artists]),
    ].join("\n"));
    return words.every((word) => text.includes(word));
  });
  return groups.length > 0
    ? { ...item, groups }
    : { ...item, kind: "search", groups: [], collections: [] };
}
