import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, summarize } from "../src/summary.js";

test("versions order with their release candidates by number", () => {
  assert.ok(compareVersions("1.1.0-rc9", "1.1.0-rc13") < 0);
  assert.ok(compareVersions("1.1.0-rc13", "1.1.0") < 0);
  assert.ok(compareVersions("1.0.2", "1.1.0-rc1") < 0);
  assert.equal(compareVersions("1.1.0-rc2", "1.1.0-rc2"), 0);
  assert.equal(compareVersions("latest", "1.1.0"), null);
});

test("the list shows the description and the commonest real error, not an ordinary state", () => {
  const entry = (level, source, message) => ({ timestamp: "2026-10-20T15:45:30.000Z", session: "0".repeat(32), level, category: "local", source, message });
  const report = {
    note: "做了什么操作：整包下载\n\n遇到了什么问题：无法连接本地服务",
    entries: [
      ...Array.from({ length: 30 }, (_, n) => entry("error", "/api/library/cover/{id}", `GET status=404 duration_ms=${n} detail=没有可用封面`)),
      ...Array.from({ length: 6 }, () => entry("error", "unhandledrejection", "播放协调器没有及时返回状态")),
      entry("warn", "queue", "something"),
      entry("info", "play", "播放 local mp3"),
    ],
  };
  assert.deepEqual(summarize(report), {
    note: "做了什么操作：整包下载 / 遇到了什么问题：无法连接本地服务",
    top_error: "error · unhandledrejection · 播放协调器没有及时返回状态 ×6",
  });
});
