import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_BRAND } from "../src/components/download/PlatformMark";
import {
  estimateTextEm,
  foldOrder,
  foldOutDuration,
  searchMarkState,
  searchOutcomeOf,
  searchTones,
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

test("the submitted text's reach grows with the text and counts wide glyphs as one em", () => {
  assert.equal(estimateTextEm(""), 0);
  assert.equal(estimateTextEm("夜に駆ける"), 5);
  assert.ok(estimateTextEm("YOASOBI") > estimateTextEm("yoasobi"));
  assert.ok(estimateTextEm("a b") < estimateTextEm("aab"));
});

test("a search is drawn in the selected sources' colours, in the order of the marks", () => {
  const marks = ["soundcloud", "wyy", "ytm", "youtube", "qqm", "bilibili"] as const;
  // One source: its own colour, twice, so the list is always a gradient.
  assert.deepEqual(searchTones(marks, ["qqm"]), [PLATFORM_BRAND.qqm, PLATFORM_BRAND.qqm]);
  // Several: the marks' order, not the order they were ticked in.
  assert.deepEqual(searchTones(marks, ["qqm", "wyy", "soundcloud"]), [
    PLATFORM_BRAND.soundcloud,
    PLATFORM_BRAND.wyy,
    PLATFORM_BRAND.qqm,
  ]);
  // Neighbours of one colour count once.
  assert.deepEqual(searchTones(marks, ["ytm", "youtube"]), [PLATFORM_BRAND.ytm, PLATFORM_BRAND.ytm]);
  // Nothing selected: the stylesheet's neutral pair stands.
  assert.deepEqual(searchTones(marks, []), []);
});

test("folded rows leave from the last one up, and a long fold is as quick as a short one", () => {
  assert.equal(foldOrder(2, 3), 0);
  assert.equal(foldOrder(0, 3), 2);
  assert.equal(foldOrder(0, 40), foldOrder(0, 7));
  assert.equal(foldOutDuration(1), 100);
  assert.equal(foldOutDuration(3), 124);
  assert.equal(foldOutDuration(40), foldOutDuration(7));
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
