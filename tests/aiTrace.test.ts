import test from "node:test";
import assert from "node:assert/strict";
import { emptyTrace, reduceAiTrace } from "../src/lib/aiTrace";

test("streamed thinking and text reconcile with final content without duplicates", () => {
  let trace = emptyTrace();
  trace = reduceAiTrace(trace, { type: "message_start", message: { role: "assistant", content: [] } });
  for (const delta of ["先", "检查"]) trace = reduceAiTrace(trace, {
    type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta },
  });
  trace = reduceAiTrace(trace, { type: "message_update", assistantMessageEvent: {
    type: "text_delta", partial: { content: [{ type: "thinking", thinking: "先检查", thinkingSignature: "secret" }, { type: "text", text: "完成" }] },
  } });
  trace = reduceAiTrace(trace, { type: "message_end", message: { role: "assistant", content: [
    { type: "thinking", thinking: "先检查" }, { type: "text", text: "完成" },
  ] } });
  assert.deepEqual(trace.entries, [{ kind: "message", blocks: [{ kind: "thinking", text: "先检查" }, { kind: "text", text: "完成" }] }]);
  assert.equal(trace.message, null);
});

test("parallel tools keep their own streamed results and interrupted state", () => {
  let trace = emptyTrace();
  for (const id of ["a", "b"]) trace = reduceAiTrace(trace, { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: id } });
  trace = reduceAiTrace(trace, { type: "tool_execution_update", toolCallId: "a", partialResult: { text: "partial" } });
  const before = trace;
  trace = reduceAiTrace(trace, { type: "tool_execution_end", toolCallId: "b", result: { text: "denied" }, isError: true });
  trace = reduceAiTrace(trace, { type: "agent_settled" });
  assert.equal(trace.entries[0].kind === "tool" && trace.entries[0].state, "stopped");
  assert.equal(trace.entries[1].kind === "tool" && trace.entries[1].state, "failed");
  assert.equal(before.entries[1].kind === "tool" && before.entries[1].state, "running");
  assert.deepEqual(trace.entries[0].kind === "tool" && trace.entries[0].result, { text: "partial" });
});

test("separate messages stay ordered around a tool call", () => {
  let trace = emptyTrace();
  for (const event of [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "开始" }] } },
    { type: "tool_execution_start", toolCallId: "a", toolName: "read" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "收尾" }] } },
  ]) trace = reduceAiTrace(trace, event);
  assert.deepEqual(trace.entries.map(entry => entry.kind), ["message", "tool", "message"]);
});
