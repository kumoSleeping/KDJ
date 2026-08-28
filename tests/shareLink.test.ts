import test from "node:test";
import assert from "node:assert/strict";
import {
  firstSourceShareLink,
  matchedTrackShareLink,
  platformShareLink,
  songSourceShareLink,
  trackShareLink,
  trackShareSearchQuery,
} from "../src/lib/shareLink";
import type { SongSource } from "../src/types";

function source(
  platform: SongSource["platform"],
  key: string,
  payload: Record<string, unknown> = {},
  title = "",
  artists: string[] = [],
  duration: number | null = null,
): SongSource {
  return {
    platform,
    key,
    payload,
    title,
    artists,
    album: "",
    duration,
    cover: "",
    max_quality: null,
    vip: false,
  };
}

test("music platform sources build public HTTPS share pages", () => {
  assert.equal(
    songSourceShareLink(source("wyy", "347230")),
    "https://y.music.163.com/m/song?id=347230",
  );
  assert.equal(
    songSourceShareLink(source("qqm", "002v8JmQ3rkWK6")),
    "https://y.qq.com/n/ryqq/songDetail/002v8JmQ3rkWK6",
  );
  assert.equal(
    songSourceShareLink(source("ytm", "abc_DEF-123")),
    "https://music.youtube.com/watch?v=abc_DEF-123",
  );
});

test("video platform sources use their canonical watch pages", () => {
  assert.equal(
    platformShareLink("youtube", "fallback", { video_id: "dQw4w9WgXcQ" }),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(
    platformShareLink("bilibili", "fallback", { bvid: "BV1L94y1H7CV" }),
    "https://www.bilibili.com/video/BV1L94y1H7CV",
  );
});

test("SoundCloud only copies a trusted public permalink", () => {
  assert.equal(
    songSourceShareLink(
      source("soundcloud", "123", { permalink_url: "http://soundcloud.com/dj/nightdrive" }),
    ),
    "https://soundcloud.com/dj/nightdrive",
  );
  assert.equal(
    songSourceShareLink(
      source("soundcloud", "123", { permalink_url: "https://example.com/not-soundcloud" }),
    ),
    null,
  );
});

test("merged rows fall back from a local source to a shareable online source", () => {
  assert.equal(
    firstSourceShareLink([source("local", "9"), source("wyy", "347230")], 0),
    "https://y.music.163.com/m/song?id=347230",
  );
});

test("local files share immediately when they retain a supported platform identity", () => {
  assert.equal(
    trackShareLink({ source_platform: "qqm", source_key: "002v8JmQ3rkWK6" }),
    "https://y.qq.com/n/ryqq/songDetail/002v8JmQ3rkWK6",
  );
  assert.equal(trackShareLink({ source_platform: "local", source_key: "" }), null);
  assert.equal(trackShareLink({ source_platform: "onelibrary", source_key: "/disk:7" }), null);
});

test("imported local files can use a strict QQ or NetEase metadata match", () => {
  const track = {
    title: "夜曲",
    filename: "夜曲.flac",
    artist: "周杰伦",
    duration: 226,
    source_platform: "local",
    source_key: "",
  };
  assert.equal(trackShareSearchQuery(track), "夜曲 周杰伦");
  assert.equal(
    matchedTrackShareLink(track, [
      source("wyy", "185811", {}, "夜曲", ["其他艺人"], 226),
      source("qqm", "001zMQr71F1Qo8", {}, "夜曲", ["周杰伦"], 227),
    ]),
    "https://y.qq.com/n/ryqq/songDetail/001zMQr71F1Qo8",
  );
});

test("local metadata matching rejects a different version by artist or duration", () => {
  const track = {
    title: "同名歌曲",
    filename: "同名歌曲.flac",
    artist: "原唱",
    duration: 200,
    source_platform: "local",
    source_key: "",
  };
  assert.equal(
    matchedTrackShareLink(track, [
      source("wyy", "1", {}, "同名歌曲", ["翻唱"], 200),
      source("qqm", "abc", {}, "同名歌曲", ["原唱"], 230),
    ]),
    null,
  );
});

test("a missing title falls back to the local filename for search", () => {
  assert.equal(
    trackShareSearchQuery({ title: "", filename: "Local Song.flac", artist: "Artist" }),
    "Local Song Artist",
  );
});

test("malformed platform keys never become links", () => {
  assert.equal(platformShareLink("wyy", "347230&x=1"), null);
  assert.equal(platformShareLink("qqm", "javascript:alert(1)"), null);
  assert.equal(platformShareLink("bilibili", "not-a-bvid"), null);
});
