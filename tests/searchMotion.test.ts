import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTextEm,
  searchMarkState,
  searchOutcomeOf,
} from "../src/components/download/searchMotion";
import type { IntakeItem, MergedGroup, SongSource } from "../src/types";

function source(platform: SongSource["platform"]): SongSource {
  return {
    platform,
    key: `${platform}-1`,
    title: "t",
    artists: [],
    album: "",
    duration: null,
    cover: "",
    max_quality: null,
    vip: false,
    payload: {},
  };
}

function group(...platforms: SongSource["platform"][]): MergedGroup {
  return {
    group_id: platforms.join("+"),
    title: "t",
    artists: [],
    album: "",
    duration: null,
    cover: "",
    sources: platforms.map(source),
    best_source_index: 0,
    score: 1,
  };
}

function item(patch: Partial<IntakeItem>): IntakeItem {
  return {
    entry: "q",
    kind: "search",
    platform: null,
    title: "q",
    groups: [],
    collections: [],
    errors: {},
    error: "",
    ...patch,
  };
}

test("the ink's reach grows with the text and counts wide glyphs as one em", () => {
  assert.equal(estimateTextEm(""), 0);
  assert.equal(estimateTextEm("夜に駆ける"), 5);
  assert.ok(estimateTextEm("YOASOBI") > estimateTextEm("yoasobi"));
  assert.ok(estimateTextEm("a b") < estimateTextEm("aab"));
});

test("a mark settles on what its source brought back", () => {
  const outcome = searchOutcomeOf(
    [
      item({ groups: [group("wyy", "local"), group("wyy")], errors: { soundcloud: "HTTP 403" } }),
      item({ errors: { wyy: "timeout" } }),
    ],
    null,
  );
  assert.equal(searchMarkState("run", "wyy", null), "run");
  // Answered one entry of the batch: not a failure, and a local copy is not a searched source.
  assert.equal(searchMarkState("done", "wyy", outcome), "hit");
  assert.equal(outcome.hits.has("local"), false);
  assert.equal(searchMarkState("done", "soundcloud", outcome), "fail");
  assert.equal(searchMarkState("done", "qqm", outcome), "miss");
  // Nothing published for this search: the mark only settles.
  assert.equal(searchMarkState("done", "qqm", null), "settle");
});
