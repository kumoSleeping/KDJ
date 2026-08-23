import assert from "node:assert/strict";
import test from "node:test";
import { selectableGroups, selectionKey } from "../src/lib/resultSelection";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";

function biliSource(key: string): SongSource {
  return {
    platform: "bilibili",
    key,
    title: key,
    artists: ["UP主"],
    album: "",
    duration: 120,
    cover: "",
    max_quality: null,
    vip: false,
    payload: { bvid: key },
  };
}

function group(id: string, source: SongSource, inLibrary = false): MergedGroup {
  return {
    group_id: id,
    title: source.title,
    artists: source.artists,
    album: "",
    duration: source.duration,
    cover: "",
    sources: [source],
    best_source_index: 0,
    score: 0,
    in_library: inLibrary,
  };
}

test("B 站收藏夹视频进入全选集合，已入库和纯本地条目除外", () => {
  const first = group("bili-1", biliSource("BV1L94y1H7CV"));
  const second = group("bili-2", biliSource("BV1xx411c7mD"));
  const inLibrary = group("bili-local", biliSource("BV1Q541167Qg"), true);
  const local = group("local", { ...biliSource("local"), platform: "local" });
  const item: IntakeItem = {
    entry: "https://space.bilibili.com/1/favlist?fid=2",
    kind: "playlist",
    platform: "bilibili",
    title: "收藏夹",
    groups: [first, second, inLibrary, local],
    collections: [],
    errors: {},
    error: "",
  };

  assert.deepEqual(selectableGroups(item).map((entry) => entry.group_id), [
    "bili-1",
    "bili-2",
  ]);
  assert.notEqual(selectionKey(0, first.group_id), selectionKey(1, first.group_id));
});
