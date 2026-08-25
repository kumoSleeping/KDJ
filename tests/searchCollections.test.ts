import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionPageWindow,
  promoteResolvedCollection,
  RESOLVED_COLLECTION_PAGE_SIZE,
  resolvedCollectionItem,
} from "../src/lib/searchCollections.ts";
import type {
  CollectionResolveResponse,
  CollectionResult,
  IntakeItem,
  SongSource,
} from "../src/types.ts";

const collection: CollectionResult = {
  kind: "playlist",
  platform: "wyy",
  key: "42",
  title: "搜索结果标题",
  subtitle: "2 首 · 创建者",
  cover: "playlist-cover",
  count: 2,
};

const source: SongSource = {
  platform: "wyy",
  key: "song-1",
  title: "曲目一",
  artists: ["艺人"],
  album: "专辑",
  duration: 180,
  cover: "",
  max_quality: "320",
  vip: false,
  payload: {},
};

const response: CollectionResolveResponse = {
  kind: "playlist",
  platform: "wyy",
  title: "详情标题",
  sources: [source],
  in_library_source_keys: ["wyy:song-1"],
};

function searchItem(collections: CollectionResult[]): IntakeItem {
  return {
    entry: "关键词",
    kind: "search",
    platform: null,
    title: "关键词",
    groups: [],
    collections,
    errors: {},
    error: "",
  };
}

test("resolved collection keeps collection cover and local-library state", () => {
  const resolved = resolvedCollectionItem(collection, response);

  assert.equal(resolved.title, "详情标题");
  assert.equal(resolved.groups[0]?.cover, "playlist-cover");
  assert.equal(resolved.groups[0]?.in_library, true);
});

test("loaded collection is promoted while the remaining search results stay available", () => {
  const other = { ...collection, key: "99", title: "另一个歌单" };
  const resolved = resolvedCollectionItem(collection, response);
  const next = promoteResolvedCollection([searchItem([collection, other])], collection, resolved);

  assert.equal(next[0]?.entry, "wyy:playlist:42");
  assert.deepEqual(next[1]?.collections, [other]);
});

test("stale collection result does not replace a newer result set", () => {
  const newer = searchItem([{ ...collection, key: "new" }]);
  const resolved = resolvedCollectionItem(collection, response);

  assert.equal(promoteResolvedCollection([newer], collection, resolved)[0], newer);
});

test("loaded collections paginate fifty tracks without changing the full total", () => {
  assert.equal(RESOLVED_COLLECTION_PAGE_SIZE, 50);
  assert.deepEqual(collectionPageWindow(300, 1), {
    page: 1,
    pageCount: 6,
    start: 0,
    end: 50,
  });
  assert.deepEqual(collectionPageWindow(300, 6), {
    page: 6,
    pageCount: 6,
    start: 250,
    end: 300,
  });
});

test("collection pagination clamps stale pages after a shorter refresh", () => {
  assert.deepEqual(collectionPageWindow(71, 99), {
    page: 2,
    pageCount: 2,
    start: 50,
    end: 71,
  });
  assert.deepEqual(collectionPageWindow(0, Number.NaN), {
    page: 1,
    pageCount: 1,
    start: 0,
    end: 0,
  });
});
