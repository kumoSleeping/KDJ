import assert from "node:assert/strict";
import test from "node:test";
import { noticeOnEnd, noticeOnStart, resultText, stepLine } from "../src/lib/aiTasks";

test("a search says what it looks for, then how much it found", () => {
  assert.deepEqual(noticeOnStart("kdj_search", { text: "FX战士久留美 OP" }), { icon: "search", title: "AI 搜索“FX战士久留美 OP”", tone: "info" });
  const end = noticeOnEnd("kdj_search", { text: "x" }, { items: [{}, {}], collections: [{}] }, false, "");
  assert.equal(end?.detail, "3 条结果");
  assert.equal(end?.tone, "success");
});

test("downloads, playing and questions report elsewhere", () => {
  for (const tool of ["kdj_download", "kdj_play", "ask_user", "tell_user", "kdj_status"]) {
    assert.equal(noticeOnStart(tool, {}), null);
    assert.equal(noticeOnEnd(tool, {}, {}, false, ""), null);
  }
});

test("a failure says so in amber with its first line, even for a silent tool", () => {
  const end = noticeOnEnd("kdj_download", { refs: ["wyy:1"] }, undefined, true, "引用不存在或已过期：wyy:1\n详情");
  assert.equal(end?.tone, "error");
  assert.equal(end?.detail, "引用不存在或已过期：wyy:1");
});

test("web searches say what they look for, whichever tool runs them", () => {
  assert.equal(noticeOnStart("kdj_web_search", { query: "ギリギリ愛" })?.title, "网页搜索“ギリギリ愛”");
  assert.equal(noticeOnStart("web_search", { queries: ["a", "b"] })?.title, "网页搜索“a、b”");
  assert.equal(noticeOnEnd("kdj_web_search", {}, { engine: "deepseek", results: [{}, {}] }, false, "")?.detail, "DeepSeek · 2 条");
  assert.equal(noticeOnStart("fetch_content", { urls: ["https://www.example.com/a", "https://b.org"] })?.title, "读取 example.com 等 2 个网页");
});

test("the drawer lists every step, the quiet ones too, in the words of their bubbles", () => {
  assert.deepEqual(stepLine("kdj_search", { text: "x" }, "done", { items: [{}] }, ""), { title: "AI 搜索“x”", detail: "1 条结果" });
  assert.deepEqual(stepLine("kdj_play", {}, "done", null, ""), { title: "播放", detail: undefined });
  assert.deepEqual(stepLine("ask_user", { question: "哪一版？" }, "done", { choices: ["Live"] }, ""), { title: "询问：哪一版？", detail: "选了 Live" });
  assert.deepEqual(stepLine("write", { path: "remotion/src/Title.tsx" }, "failed", null, "只能写在工作目录里\n…"),
    { title: "写入 Title.tsx 失败", detail: "只能写在工作目录里" });
  assert.equal(stepLine("kdj_ffmpeg", { output: "intro.mp4" }, "running", null, "").title, "渲染 intro.mp4");
});

test("tool results read only their text blocks", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
});
