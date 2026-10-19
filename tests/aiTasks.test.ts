import assert from "node:assert/strict";
import test from "node:test";
import { noticeOnEnd, noticeOnStart, resultText } from "../src/lib/aiTasks";

test("a search says what it looks for, then how much it found", () => {
  assert.deepEqual(noticeOnStart("kdj_search", { text: "FX战士久留美 OP" }), { icon: "search", title: "AI 搜索“FX战士久留美 OP”", tone: "info" });
  const end = noticeOnEnd("kdj_search", { text: "x" }, { items: [{}, {}], collections: [{}] }, false, "");
  assert.equal(end?.detail, "3 条结果");
  assert.equal(end?.tone, "success");
});

test("downloads, playing and questions report elsewhere", () => {
  for (const tool of ["kdj_download", "kdj_play", "ask_user", "kdj_status"]) {
    assert.equal(noticeOnStart(tool, {}), null);
    assert.equal(noticeOnEnd(tool, {}, {}, false, ""), null);
  }
});

test("a failure says so in amber with its first line, even for a silent tool", () => {
  const end = noticeOnEnd("kdj_download", { refs: ["wyy:1"] }, undefined, true, "引用不存在或已过期：wyy:1\n详情");
  assert.equal(end?.tone, "error");
  assert.equal(end?.detail, "引用不存在或已过期：wyy:1");
});

test("the network probe tells which engine is used", () => {
  assert.equal(noticeOnEnd("browser_probe", {}, { google: false, bing: true }, false, "")?.detail, "使用必应");
  assert.equal(noticeOnEnd("browser_probe", {}, { google: true, bing: true }, false, "")?.detail, "Google 可用");
});

test("tool results read only their text blocks", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
});
