import assert from "node:assert/strict";
import test from "node:test";

import { sortDownloadTasks } from "../src/lib/downloadOrder";
import type { DownloadTask } from "../src/types";

function task(id: string, created: number, updated: number): DownloadTask {
  return {
    id,
    kind: "audio",
    platform: "wyy",
    title: id,
    artist: "",
    quality: "flac",
    state: "queued",
    phase: "waiting",
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed_bps: 0,
    path: "",
    error: "",
    track_id: null,
    created_at: created,
    updated_at: updated,
  };
}

test("download rows stay in enqueue order when progress timestamps change", () => {
  const first = task("first", 1, 999);
  const second = task("second", 2, 3);
  assert.deepEqual(sortDownloadTasks([second, first]).map((item) => item.id), ["first", "second"]);
});
