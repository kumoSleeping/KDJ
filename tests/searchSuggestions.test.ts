import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchSuggestions } from "../src/lib/searchSuggestions";
import type { TrackSummary } from "../src/types";

const track = (title: string, artist = "") => ({ title, artist, filename: "fallback.mp3" }) as TrackSummary;

test("selection precedes independent playback and artists always include a song title", () => {
  assert.deepEqual(buildSearchSuggestions(track("选中歌曲", "作者甲"), track("播放歌曲", "作者乙"))
    .map(({ label }) => label), [
    "选中歌曲", "选中歌曲 作者甲",
    "播放歌曲", "播放歌曲 作者乙",
  ]);
});

test("missing metadata is handled and identical sources appear only once", () => {
  assert.deepEqual(buildSearchSuggestions(), []);
  assert.deepEqual(buildSearchSuggestions(null, track("歌曲", "  ")).map(item => item.label), ["歌曲"]);
  const same = track("歌曲", "作者");
  assert.deepEqual(buildSearchSuggestions(same, same).map(item => item.label), ["歌曲", "歌曲 作者"]);
  assert.deepEqual(buildSearchSuggestions(track("", "作者")).map(item => item.label), ["fallback.mp3", "fallback.mp3 作者"]);
});

test("matching titles deduplicate without losing distinct artist queries", () => {
  assert.deepEqual(buildSearchSuggestions(track("歌曲", "甲"), track("歌曲", "乙")).map(item => item.label),
    ["歌曲", "歌曲 甲", "歌曲 乙"]);
});
