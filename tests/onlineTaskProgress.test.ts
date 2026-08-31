import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadTaskProgressStages,
  playbackCacheProgressStages,
  platformShowsResolveStage,
  selectOnlineProgressTask,
} from "../src/lib/onlineTaskProgress";
import { lyricsCacheBytes, waveformCacheBytes } from "../src/lib/onlineCacheUsage";
import type { DownloadTask, Platform, SongSource } from "../src/types";

function task(
  id: string,
  platform: Platform,
  patch: Partial<DownloadTask> = {},
): DownloadTask {
  return {
    id,
    kind: "audio",
    platform,
    title: id,
    artist: "artist",
    quality: "320",
    state: "running",
    phase: "resolving",
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed_bps: 0,
    path: "",
    error: "",
    track_id: null,
    created_at: 1,
    updated_at: 1,
    ...patch,
  };
}

function source(platform: Platform, title: string): SongSource {
  return {
    platform,
    key: `key:${title}`,
    title,
    artists: ["artist"],
    album: "",
    duration: 180,
    cover: "",
    max_quality: "320",
    vip: false,
    payload: {},
  };
}

test("only multi-step online platforms expose a resolve stage", () => {
  assert.equal(platformShowsResolveStage("qqm"), false);
  assert.equal(platformShowsResolveStage("wyy"), false);
  assert.equal(platformShowsResolveStage("youtube"), true);
  assert.equal(platformShowsResolveStage("ytm"), true);
  assert.equal(platformShowsResolveStage("bilibili"), true);
  assert.equal(platformShowsResolveStage("soundcloud"), true);
});

test("YouTube resolve completes before its download row appears", () => {
  const resolving = downloadTaskProgressStages(task("video", "youtube"));
  assert.deepEqual(resolving.map((stage) => stage.kind), ["resolve"]);
  assert.equal(resolving[0]?.state, "running");
  assert.equal(resolving[0]?.indeterminate, true);

  const downloading = downloadTaskProgressStages(
    task("video", "youtube", {
      phase: "downloading",
      progress: 0.42,
      downloaded_bytes: 42,
      total_bytes: 100,
    }),
  );
  assert.deepEqual(downloading.map((stage) => stage.kind), ["resolve", "download"]);
  assert.equal(downloading[0]?.state, "done");
  assert.equal(downloading[1]?.value, 0.42);
  assert.equal(downloading[1]?.status, "42%");
});

test("QQ Music and NetEase skip resolve without hiding real download preparation", () => {
  for (const platform of ["qqm", "wyy"] as const) {
    const stages = downloadTaskProgressStages(task(platform, platform));
    assert.deepEqual(stages.map((stage) => stage.kind), ["download"]);
    assert.equal(stages[0]?.status, "准备中");
    assert.equal(stages[0]?.indeterminate, true);
  }
});

test("NetEase playback exposes its real cache row without a resolve flash", () => {
  const stages = playbackCacheProgressStages({
    platform: "wyy",
    phase: "ready",
    cachedBytes: 3,
    totalBytes: 10,
    complete: false,
    active: true,
  });
  assert.deepEqual(stages.map((stage) => stage.kind), ["cache"]);
  assert.equal(stages[0]?.status, "30%");
  assert.equal(stages[0]?.value, 0.3);
});

test("YouTube playback resolves before its cache row appears", () => {
  const resolving = playbackCacheProgressStages({
    platform: "ytm",
    phase: "resolving",
    cachedBytes: 0,
    totalBytes: 0,
    complete: false,
    active: false,
  });
  assert.deepEqual(resolving.map((stage) => stage.kind), ["resolve"]);

  const ready = playbackCacheProgressStages({
    platform: "ytm",
    phase: "ready",
    cachedBytes: 5,
    totalBytes: 10,
    complete: false,
    active: true,
  });
  assert.deepEqual(ready.map((stage) => stage.kind), ["resolve", "cache"]);
  assert.equal(ready[0]?.state, "done");
  assert.equal(ready[1]?.status, "50%");
});

test("SoundCloud keeps the resolve row for transcoding authorization", () => {
  const stages = downloadTaskProgressStages(task("cloud", "soundcloud"));
  assert.deepEqual(stages.map((stage) => stage.kind), ["resolve"]);
});

test("the compact global lane prefers the task belonging to the visible track", () => {
  const tasks = [
    task("older", "youtube", { title: "Other", created_at: 1 }),
    task("visible", "youtube", { title: "Current", created_at: 2 }),
  ];
  assert.equal(
    selectOnlineProgressTask(tasks, source("youtube", "Current"), 10)?.id,
    "visible",
  );
  assert.equal(selectOnlineProgressTask(tasks, null, 10)?.id, "older");
});

test("a completed task is retained briefly and then leaves the compact lane", () => {
  const completed = task("done", "youtube", {
    state: "done",
    phase: "completed",
    progress: 1,
    updated_at: 100,
  });
  assert.equal(selectOnlineProgressTask([completed], null, 101)?.id, "done");
  assert.equal(selectOnlineProgressTask([completed], null, 103), null);
});

test("online cache usage reports media-sized waveform columns and UTF-8 lyric bytes", () => {
  const buckets = 4_096;
  assert.equal(
    waveformCacheBytes({
      track_id: -1,
      duration: 180,
      amp: Array(buckets).fill(0),
      minimum: Array(buckets).fill(0),
      maximum: Array(buckets).fill(0),
      r: Array(buckets).fill(0),
      g: Array(buckets).fill(0),
      b: Array(buckets).fill(0),
      transient: Array(buckets).fill(0),
      known: Array(buckets).fill(true),
    }),
    68 * 1024,
  );
  assert.equal(
    lyricsCacheBytes({
      lrc: "你",
      word_lrc: "a",
      translated_lrc: "",
      romaji_lrc: "",
      platform: "wyy",
      key: "1",
      title: "title",
      artist: "artist",
      score: 1,
    }),
    5,
  );
});
