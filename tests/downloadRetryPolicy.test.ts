import assert from "node:assert/strict";
import test from "node:test";

import { shouldRefreshYtmDownloadAuthorization } from "../src/lib/downloadRetryPolicy";
import type { DownloadTask } from "../src/types";

const failedYtm: DownloadTask = {
  id: "ytm-1",
  kind: "audio",
  platform: "ytm",
  title: "LOUDER",
  artist: "Roselia",
  quality: "flac",
  state: "failed",
  phase: "authorizing",
  progress: 0,
  downloaded_bytes: 0,
  total_bytes: 0,
  speed_bps: 0,
  path: "",
  error: "YouTube Music 播放授权已过期，请重试生成新的下载流",
  track_id: null,
  created_at: 1,
  updated_at: 2,
};

test("expired YTM GVS authorization receives one fresh-stream retry", () => {
  assert.equal(shouldRefreshYtmDownloadAuthorization(failedYtm), true);
  assert.equal(
    shouldRefreshYtmDownloadAuthorization({ ...failedYtm, error: "磁盘空间不足" }),
    false,
  );
  assert.equal(
    shouldRefreshYtmDownloadAuthorization({ ...failedYtm, platform: "wyy" }),
    false,
  );
});
