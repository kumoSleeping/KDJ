import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionPageWindow,
  openedCollectionItem,
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

test("resolved collection keeps the collection cover", () => {
  const resolved = resolvedCollectionItem(collection, response);

  assert.equal(resolved.title, "详情标题");
  assert.equal(resolved.groups[0]?.cover, "playlist-cover");
});

test("a resolved collection becomes a standalone detail page", () => {
  const resolved = resolvedCollectionItem(collection, response);

  assert.equal(openedCollectionItem([resolved]), resolved);
  assert.equal(openedCollectionItem([resolved, searchItem([collection])]), null);
  assert.equal(openedCollectionItem([searchItem([collection])]), null);
});

test("loaded collections paginate fifty tracks without changing the full total", () => {
  assert.equal(RESOLVED_COLLECTION_PAGE_SIZE, 50);
  assert.deepEqual(collectionPageWindow(300, 1), {
    total: 300,
    page: 1,
    pageCount: 6,
    start: 0,
    end: 50,
  });
  assert.deepEqual(collectionPageWindow(300, 6), {
    total: 300,
    page: 6,
    pageCount: 6,
    start: 250,
    end: 300,
  });
});

test("collection pagination clamps stale pages after a shorter refresh", () => {
  assert.deepEqual(collectionPageWindow(71, 99), {
    total: 71,
    page: 2,
    pageCount: 2,
    start: 50,
    end: 71,
  });
  assert.deepEqual(collectionPageWindow(0, Number.NaN), {
    total: 0,
    page: 1,
    pageCount: 1,
    start: 0,
    end: 0,
  });
});
