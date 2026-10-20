import type { PiEvent } from "../types/ai";

export type TraceBlock = { kind: "thinking" | "text"; text: string };
export type TraceEntry =
  | { kind: "message"; blocks: TraceBlock[] }
  | { kind: "tool"; id: string; name: string; args: unknown; result?: unknown; state: "running" | "done" | "failed" | "stopped" }
  | { kind: "error"; text: string };
export interface AiTrace { entries: TraceEntry[]; message: number | null }
export const emptyTrace = (): AiTrace => ({ entries: [], message: null });
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
function blocks(message: unknown): TraceBlock[] | null {
  const content = object(message).content;
  if (!Array.isArray(content)) return null;
  return content.flatMap<TraceBlock>(raw => {
    const block = object(raw);
    if (block.type === "thinking") return [{ kind: "thinking" as const, text: string(block.thinking) }];
    if (block.type === "text") return [{ kind: "text" as const, text: string(block.text) }];
    return [];
  });
}

export function reduceAiTrace(trace: AiTrace, event: PiEvent): AiTrace {
  const entries = [...trace.entries];
  let message = trace.message;
  const setMessage = (next: TraceBlock[]) => {
    if (message === null) { message = entries.length; entries.push({ kind: "message", blocks: next }); }
    else entries[message] = { kind: "message", blocks: next };
  };
  switch (event.type) {
    case "message_start":
      if (object(event.message).role !== "assistant") return trace;
      message = null;
      setMessage(blocks(event.message) ?? []);
      break;
    case "message_update": {
      const update = object(event.assistantMessageEvent);
      const snapshot = blocks(update.partial);
      if (snapshot) setMessage(snapshot);
      else if (update.type === "thinking_delta" || update.type === "text_delta") {
        const kind = update.type === "thinking_delta" ? "thinking" : "text";
        const current = message === null ? undefined : entries[message];
        const next = current?.kind === "message" ? [...current.blocks] : [];
        const last = next[next.length - 1];
        if (last?.kind === kind) next[next.length - 1] = { kind, text: last.text + string(update.delta) };
        else next.push({ kind, text: string(update.delta) });
        setMessage(next);
      } else return trace;
      break;
    }
    case "message_end":
      if (object(event.message).role !== "assistant") return trace;
      if (blocks(event.message)) setMessage(blocks(event.message)!);
      if (object(event.message).errorMessage) entries.push({ kind: "error", text: string(object(event.message).errorMessage) });
      message = null;
      break;
    case "tool_execution_start":
      if (!event.toolCallId || entries.some(entry => entry.kind === "tool" && entry.id === event.toolCallId)) return trace;
      entries.push({ kind: "tool", id: string(event.toolCallId), name: string(event.toolName), args: event.args, state: "running" });
      break;
    case "tool_execution_update":
    case "tool_execution_end": {
      const index = entries.findIndex(entry => entry.kind === "tool" && entry.id === event.toolCallId);
      const entry = entries[index];
      if (entry?.kind !== "tool") return trace;
      entries[index] = { ...entry, result: event.type === "tool_execution_end" ? event.result : event.partialResult,
        state: event.type === "tool_execution_end" ? (event.isError ? "failed" : "done") : "running" };
      break;
    }
    case "kdj_error":
    case "kdj_exit":
    case "agent_settled":
      if (event.type !== "agent_settled") entries.push({ kind: "error", text: string(event.message) || "pi 已退出" });
      return { message: null, entries: entries.map(entry => entry.kind === "tool" && entry.state === "running" ? { ...entry, state: "stopped" } : entry) };
    default: return trace;
  }
  return { entries, message };
}
