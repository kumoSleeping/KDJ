import assert from "node:assert/strict";
import test from "node:test";
import { interleaveSearches } from "../src/lib/searchInterleave";
import type { IntakeItem, MergedGroup } from "../src/types";

const group = (id: string, key: string): MergedGroup => ({
  group_id: id, title: key, artists: [], album: "", duration: null, cover: "", score: 1, best_source_index: 0,
  sources: [{ platform: "wyy", key, title: key, artists: [], album: "", duration: null, cover: "", max_quality: null, vip: false, payload: {} }],
});
const line = (entry: string, groups: MergedGroup[], kind: IntakeItem["kind"] = "search"): IntakeItem => ({
  entry, kind, platform: null, title: entry, groups, collections: [], errors: {}, error: "",
});

test("keyword lines become one list, their answers taken in turn", () => {
  const [merged, ...rest] = interleaveSearches([
    line("a", [group("g0", "a1"), group("g1", "a2"), group("g2", "a3")]),
    line("b", [group("g0", "b1")]),
  ]);
  assert.equal(rest.length, 0);
  assert.deepEqual(merged.groups.map(g => g.title), ["a1", "b1", "a2", "a3"]);
  assert.equal(merged.entry, "a / b");
  // Group ids stay apart although each line numbered its own from g0.
  assert.equal(new Set(merged.groups.map(g => g.group_id)).size, 4);
});

test("a song found by two lines is listed once", () => {
  const [merged] = interleaveSearches([line("a", [group("g0", "same")]), line("b", [group("g0", "same"), group("g1", "b2")])]);
  assert.deepEqual(merged.groups.map(g => g.title), ["same", "b2"]);
});

test("links and single searches keep their own shape", () => {
  const items = [line("https://x", [group("g0", "x")], "song"), line("b", [group("g0", "b1")])];
  assert.deepEqual(interleaveSearches(items), items);
  const one = [line("a", [group("g0", "a1")])];
  assert.deepEqual(interleaveSearches(one), one);
});
