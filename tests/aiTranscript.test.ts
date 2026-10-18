import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_TRANSCRIPT, addUserLine, answerAsk, reducePiEvent, resultText, type AiTranscript } from "../src/lib/aiTranscript";
import type { PiEvent } from "../src/types/ai";

const run = (events: PiEvent[], from: AiTranscript = EMPTY_TRANSCRIPT) => events.reduce(reducePiEvent, from);

test("text deltas build one block per content index and message", () => {
  const t = run([
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "找到" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "了" } },
  ]);
  assert.equal(t.running, true);
  assert.deepEqual(t.parts, [{ kind: "text", id: "m1:0", text: "找到了", streaming: true }]);
  const ended = run([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "找到了 3 首" }] } },
    { type: "agent_settled", aborted: false },
  ], t);
  assert.equal(ended.running, false);
  assert.deepEqual(ended.parts, [{ kind: "text", id: "m1:0", text: "找到了 3 首", streaming: false }]);
});

test("a tool call is one step from start to end, with partial and final details", () => {
  const t = run([
    { type: "tool_execution_start", toolCallId: "c1", toolName: "kdj_download", args: { refs: ["wyy:1", "wyy:2"] } },
    { type: "tool_execution_update", toolCallId: "c1", toolName: "kdj_download", partialResult: { content: [], details: { done: 1, total: 2 } } },
  ]);
  assert.equal(t.parts.length, 1);
  const running = t.parts[0];
  assert.equal(running.kind, "tool");
  assert.ok(running.kind === "tool" && running.state === "running");
  assert.deepEqual(running.kind === "tool" && running.partial, { done: 1, total: 2 });
  const done = run([{
    type: "tool_execution_end", toolCallId: "c1", toolName: "kdj_download", isError: false, durationMs: 42,
    result: { content: [{ type: "text", text: "ok" }], details: { complete: true, items: [] } },
  }], t).parts[0];
  assert.ok(done.kind === "tool");
  assert.equal(done.state, "done");
  assert.equal(done.text, "ok");
  assert.equal(done.durationMs, 42);
  assert.deepEqual(done.details, { complete: true, items: [] });
});

test("a failed or aborted message says so once", () => {
  const t = run([
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid key" } },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid key" } },
  ]);
  assert.deepEqual(t.parts, [{ kind: "note", id: "m1:error", text: "401 invalid key", tone: "error" }]);
});

test("extension dialogs become questions and are answered in place", () => {
  const t = run([{ type: "extension_ui_request", id: "q1", method: "select", title: "下载哪个版本？", options: ["网易云", "QQ"] }]);
  assert.equal(t.parts[0].kind, "ask");
  const answered = answerAsk(t, "ui:q1", "QQ");
  assert.ok(answered.parts[0].kind === "ask" && answered.parts[0].answer === "QQ");
  const notified = run([{ type: "extension_ui_request", id: "n1", method: "notify", message: "已打开浏览器" }]);
  assert.deepEqual(notified.parts, [{ kind: "note", id: "ui:n1", text: "已打开浏览器", tone: "info" }]);
});

test("the process ending stops the run and is told", () => {
  const t = run([{ type: "agent_start" }, { type: "kdj_exit", at: "1", message: "pi 已退出（1）" }], addUserLine(EMPTY_TRANSCRIPT, "hi"));
  assert.equal(t.running, false);
  assert.equal(t.parts.at(-1)?.kind, "note");
});

test("tool results read only their text blocks", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(resultText(null), "");
});
