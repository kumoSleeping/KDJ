import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sanitizeYoutubeSabrFailure } from "../src/lib/youtubeSabrFailure";

test("YouTube Music SABR exposes the first failed request without retrying", () => {
  const source = readFileSync("src/lib/youtubeSabr.ts", "utf8");
  assert.match(source, /YOUTUBE_SABR_MAX_RETRIES\s*=\s*0/);
  assert.match(source, /maxRetries:\s*YOUTUBE_SABR_MAX_RETRIES/);
  assert.match(source, /format\.itag\s*===\s*bootstrap\.audioItag/);
  assert.match(source, /YOUTUBE_SABR_FIRST_PUBLISH_BYTES\s*=\s*128\s*\*\s*1024/);
  assert.match(source, /catch \(error\) \{\s*sabr\.abort\(\);\s*await failSpool\(token, error\)/);
  assert.doesNotMatch(source, /console\.warn\([^\n]+,\s*error\)/);
});

test("YouTube Music SABR failure text never exposes URLs or proofs", () => {
  const sanitized = sanitizeYoutubeSabrFailure(
    "Server returned 403 https://example.googlevideo.com/videoplayback?pot=secret",
  );
  assert.equal(sanitized, "YouTube SABR 上游返回 HTTP 403");
  assert.doesNotMatch(sanitized, /https?:\/\/|googlevideo|secret|pot=/i);
  assert.equal(
    sanitizeYoutubeSabrFailure("request timed out token=secret"),
    "YouTube SABR 媒体会话超时",
  );
  assert.equal(
    sanitizeYoutubeSabrFailure("unclassified Cookie=session"),
    "YouTube SABR 媒体会话失败",
  );
});
