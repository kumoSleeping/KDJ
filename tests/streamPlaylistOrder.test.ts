import assert from "node:assert/strict";
import test from "node:test";
import { orderStreamPlaylistsByRecent } from "../src/lib/streamPlaylistOrder";
import type { StreamPlaylist } from "../src/types";

function playlist(key: string): StreamPlaylist {
  return {
    platform: "qqm",
    key,
    title: key,
    cover: "",
    count: 0,
    is_favorite: false,
    origin: "created",
  };
}

test("没有最近打开记录时严格保留平台接口顺序", () => {
  const source = [playlist("manual-first"), playlist("newer"), playlist("older")];
  assert.deepEqual(
    orderStreamPlaylistsByRecent(source, []).map((item) => item.key),
    ["manual-first", "newer", "older"],
  );
  assert.deepEqual(source.map((item) => item.key), ["manual-first", "newer", "older"]);
});

test("最近打开项降序在前，其余项目继续沿用平台接口顺序", () => {
  const source = [playlist("a"), playlist("b"), playlist("c"), playlist("d")];
  assert.deepEqual(
    orderStreamPlaylistsByRecent(source, [
      { key: "c", openedAt: 100 },
      { key: "b", openedAt: 200 },
    ]).map((item) => item.key),
    ["b", "c", "a", "d"],
  );
});

test("已删除歌单和无效时间不会扰乱默认顺序", () => {
  const source = [playlist("a"), playlist("b"), playlist("c")];
  assert.deepEqual(
    orderStreamPlaylistsByRecent(source, [
      { key: "missing", openedAt: 300 },
      { key: "b", openedAt: Number.NaN },
    ]).map((item) => item.key),
    ["a", "b", "c"],
  );
});
