import assert from "node:assert/strict";
import test from "node:test";
import { orderStreamPlaylists } from "../src/lib/streamPlaylistOrder";
import type { StreamPlaylist } from "../src/types";

function playlist(key: string, title: string): StreamPlaylist {
  return {
    platform: "wyy",
    key,
    title,
    cover: "",
    count: 0,
    is_favorite: false,
    origin: "created",
  };
}

const lists = [playlist("a", "夜跑"), playlist("b", "10 首"), playlist("c", "安静"), playlist("d", "2 首")];
const recents = [{ key: "c", openedAt: 20 }, { key: "d", openedAt: 10 }];
const keys = (items: StreamPlaylist[]) => items.map((item) => item.key);

test("the sidebar orders a platform's playlists by recent opening, the platform's order, or name", () => {
  assert.deepEqual(keys(orderStreamPlaylists(lists, recents, "recent")), ["c", "d", "a", "b"]);
  assert.deepEqual(keys(orderStreamPlaylists(lists, recents, "platform")), ["a", "b", "c", "d"]);
  // Numbers by value, then Chinese by pinyin (安 an before 夜 ye).
  assert.deepEqual(keys(orderStreamPlaylists(lists, recents, "title")), ["d", "b", "c", "a"]);
  // The cached list keeps the platform's order.
  assert.deepEqual(keys(lists), ["a", "b", "c", "d"]);
});
