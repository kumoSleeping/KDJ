import type { StreamPlaylist } from "../types";

export interface StreamPlaylistRecentEntry {
  key: string;
  openedAt: number;
}

/**
 * How a platform's playlists are ordered in the sidebar. `recent`: the ones opened in KDJ first,
 * newest first, the rest as the platform lists them. `platform`: as the platform lists them.
 * `title`: by name.
 */
export type StreamPlaylistOrder = "recent" | "platform" | "title";

export const STREAM_PLAYLIST_ORDERS: ReadonlyArray<{ id: StreamPlaylistOrder; label: string }> = [
  { id: "recent", label: "最近打开" },
  { id: "platform", label: "平台顺序" },
  { id: "title", label: "名称" },
];

const titleCollator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/** The playlists in `order`; a new array, the platform's own order in the cache is kept. */
export function orderStreamPlaylists(
  playlists: readonly StreamPlaylist[],
  recentEntries: readonly StreamPlaylistRecentEntry[],
  order: StreamPlaylistOrder,
): StreamPlaylist[] {
  if (order === "recent") return orderStreamPlaylistsByRecent(playlists, recentEntries);
  if (order === "platform") return [...playlists];
  return playlists
    .map((playlist, index) => ({ playlist, index }))
    .sort((left, right) =>
      titleCollator.compare(left.playlist.title, right.playlist.title) || left.index - right.index)
    .map(({ playlist }) => playlist);
}

/**
 * 只把 KDJ 确实打开过的歌单提到前面；没有本地时间的项目严格保留平台接口顺序。
 * 返回新数组，不能改写缓存中的平台默认顺序。
 */
export function orderStreamPlaylistsByRecent(
  playlists: readonly StreamPlaylist[],
  recentEntries: readonly StreamPlaylistRecentEntry[],
): StreamPlaylist[] {
  if (playlists.length <= 1 || recentEntries.length === 0) return [...playlists];

  const openedAtByKey = new Map<string, number>();
  for (const entry of recentEntries) {
    if (
      !openedAtByKey.has(entry.key) &&
      Number.isFinite(entry.openedAt) &&
      entry.openedAt > 0
    ) {
      openedAtByKey.set(entry.key, entry.openedAt);
    }
  }
  if (openedAtByKey.size === 0) return [...playlists];

  return playlists
    .map((playlist, index) => ({ playlist, index }))
    .sort((left, right) => {
      const leftOpenedAt = openedAtByKey.get(left.playlist.key) ?? 0;
      const rightOpenedAt = openedAtByKey.get(right.playlist.key) ?? 0;
      if (leftOpenedAt !== rightOpenedAt) return rightOpenedAt - leftOpenedAt;
      return left.index - right.index;
    })
    .map(({ playlist }) => playlist);
}
