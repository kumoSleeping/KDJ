import assert from "node:assert/strict";
import test from "node:test";
import {
  resultRowActionUsesSelection,
  selectableGroups,
  selectionKey,
} from "../src/lib/resultSelection";
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

function group(id: string, source: SongSource): MergedGroup {
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
  };
}

test("B 站收藏夹视频全部可重新下载，纯本地条目除外", () => {
  const first = group("bili-1", biliSource("BV1L94y1H7CV"));
  const second = group("bili-2", biliSource("BV1xx411c7mD"));
  const redownload = group("bili-redownload", biliSource("BV1Q541167Qg"));
  const local = group("local", { ...biliSource("local"), platform: "local" });
  const item: IntakeItem = {
    entry: "https://space.bilibili.com/1/favlist?fid=2",
    kind: "playlist",
    platform: "bilibili",
    title: "收藏夹",
    groups: [first, second, redownload, local],
    collections: [],
    errors: {},
    error: "",
  };

  assert.deepEqual(selectableGroups(item).map((entry) => entry.group_id), [
    "bili-1",
    "bili-2",
    "bili-redownload",
  ]);
  assert.notEqual(selectionKey(0, first.group_id), selectionKey(1, first.group_id));
});

test("选中视频的右键下载作用于整个选区，选区外行仍只作用于自身", () => {
  const selected = new Set([
    selectionKey(0, "bili-1"),
    selectionKey(0, "bili-2"),
    selectionKey(0, "bili-3"),
  ]);

  assert.equal(resultRowActionUsesSelection(selected, selectionKey(0, "bili-2")), true);
  assert.equal(resultRowActionUsesSelection(selected, selectionKey(0, "bili-4")), false);
});
