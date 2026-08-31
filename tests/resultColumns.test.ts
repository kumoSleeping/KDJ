import test from "node:test";
import assert from "node:assert/strict";
import { resultColumnKeysWithData } from "../src/components/download/resultColumns";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";

function source(overrides: Partial<SongSource> = {}): SongSource {
  return {
    platform: "bilibili",
    key: "BV1test",
    title: "视频",
    artists: [],
    album: "",
    duration: null,
    cover: "",
    max_quality: null,
    vip: false,
    payload: {},
    ...overrides,
  };
}

function item(group: MergedGroup): IntakeItem {
  return {
    entry: "视频",
    kind: "search",
    platform: null,
    title: "视频",
    groups: [group],
    collections: [],
    errors: {},
    error: "",
  };
}

function group(overrides: Partial<MergedGroup> = {}): MergedGroup {
  return {
    group_id: "video",
    title: "视频",
    artists: [],
    album: "",
    duration: 60,
    cover: "",
    sources: [source({ duration: 60 })],
    best_source_index: 0,
    score: 1,
    ...overrides,
  };
}

test("video-only results omit metadata columns that are empty for every row", () => {
  const keys = resultColumnKeysWithData([item(group())], null);

  assert.equal(keys.has("artist"), false);
  assert.equal(keys.has("album"), false);
  assert.equal(keys.has("vip"), false);
  assert.equal(keys.has("duration"), true);
  assert.equal(keys.has("quality"), true);
});

test("a metadata column returns as soon as one result can fill it", () => {
  const withAlbum = group({
    group_id: "song",
    album: "专辑 A",
    sources: [
      source({
        platform: "wyy",
        key: "1",
        artists: ["歌手"],
        album: "专辑 A",
        max_quality: "flac",
        vip: true,
      }),
    ],
  });
  const keys = resultColumnKeysWithData([item(withAlbum), item(group())], null);

  assert.equal(keys.has("artist"), true);
  assert.equal(keys.has("album"), true);
  assert.equal(keys.has("vip"), true);
});
