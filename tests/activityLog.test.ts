import assert from "node:assert/strict";
import test from "node:test";

import {
  describeApiActivity,
  settingsActivityHint,
} from "../src/lib/activityLog";

test("search is one network record without retaining the query", () => {
  const descriptor = describeApiActivity("/search", {
    method: "POST",
    body: JSON.stringify({
      query: "private search words",
      platforms: ["wyy", "qqm"],
      limit: 30,
      merge: true,
    }),
  });
  assert.equal(descriptor?.category, "network");
  assert.equal(descriptor?.action, "搜索 API");
  assert.match(descriptor?.target ?? "", /music\.163\.com/);
  assert.match(descriptor?.target ?? "", /y\.qq\.com/);
  assert.doesNotMatch(JSON.stringify(descriptor), /private search words/);
});

test("download and local file mutations have distinct semantics", () => {
  const download = describeApiActivity("/downloads", {
    method: "POST",
    body: JSON.stringify({
      sources: [{ platform: "bilibili" }, { platform: "youtube" }],
    }),
  });
  assert.deepEqual(
    { category: download?.category, action: download?.action, detail: download?.detail },
    { category: "network", action: "下载 API", detail: "2 项" },
  );

  const move = describeApiActivity("/library/folders/apply", {
    method: "POST",
    body: JSON.stringify({ track_ids: [1, 2, 3], op: "move" }),
  });
  assert.equal(move?.category, "user");
  assert.equal(move?.action, "移动本地文件");
  assert.equal(move?.detail, "3 项");

  assert.equal(
    describeApiActivity("/library/tracks/7?delete_file=false", { method: "DELETE" })?.action,
    "从曲库移除曲目",
  );
  assert.equal(
    describeApiActivity("/library/tracks/7?delete_file=true", { method: "DELETE" })?.action,
    "永久删除本地文件",
  );
});

test("normal analysis and interface-only activity stay out of the log", () => {
  const analysis = describeApiActivity("/library/analyze", {
    method: "POST",
    body: JSON.stringify({ track_ids: Array.from({ length: 10_000 }, (_, index) => index) }),
  });
  assert.equal(analysis?.category, "analysis");
  assert.equal(analysis?.onlyFailures, true);
  assert.equal(describeApiActivity("/settings", { method: "GET" }), null);
  assert.equal(settingsActivityHint(["theme"]), null);
  assert.deepEqual(settingsActivityHint(["download_dir"]), {
    category: "user",
    action: "设定下载文件夹",
  });
  assert.equal(
    describeApiActivity("/accounts/qqm/login/qr/session-id", { method: "GET" }),
    null,
  );
});

test("retry is a network request while cancellation is one local queue action", () => {
  assert.deepEqual(
    describeApiActivity("/downloads/42/retry", { method: "POST" }),
    { category: "network", action: "重试下载 API", target: "", detail: "" },
  );
  assert.equal(
    describeApiActivity("/downloads/42/cancel", { method: "POST" })?.action,
    "取消下载任务",
  );
});

test("log polling and clearing do not recursively log themselves", () => {
  assert.equal(describeApiActivity("/activity/logs?category=network"), null);
  assert.equal(describeApiActivity("/activity/logs", { method: "DELETE" }), null);
});
