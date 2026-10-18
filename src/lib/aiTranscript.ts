/**
 * pi's RPC stream (`pi --mode rpc`, JSON event stream) folded into what the AI dock draws: the
 * listener's lines, the model's text, and one step per tool call. Pure, so the dock and the tests
 * read the same thing.
 */
import type { AiAskPart, AiPart, AiTextPart, AiToolStep, PiEvent } from "../types/ai";

export interface AiTranscript {
  parts: AiPart[];
  /** pi is working: from `agent_start` until it settles. */
  running: boolean;
  /** Counts assistant messages, so the blocks of each have keys of their own. */
  message: number;
}

export const EMPTY_TRANSCRIPT: AiTranscript = { parts: [], running: false, message: 0 };

type Fields = Record<string, unknown>;

const record = (value: unknown): Fields => (value && typeof value === "object" ? value as Fields : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The text blocks of a tool result (`{ content: [{ type: "text", text }] }`). */
export function resultText(result: unknown): string {
  const content = record(result).content;
  if (!Array.isArray(content)) return "";
  return content.map(block => record(block).type === "text" ? text(record(block).text) : "").filter(Boolean).join("\n");
}

function replace<T extends AiPart>(parts: AiPart[], id: string, change: (part: T) => T): AiPart[] {
  const index = parts.findIndex(part => part.id === id);
  if (index < 0) return parts;
  const next = parts.slice();
  next[index] = change(parts[index] as T);
  return next;
}

function block(t: AiTranscript, kind: AiTextPart["kind"], index: unknown, change: (part: AiTextPart) => AiTextPart): AiTranscript {
  const id = `m${t.message}:${typeof index === "number" ? index : 0}`;
  const parts = t.parts.some(part => part.id === id)
    ? t.parts
    : [...t.parts, { kind, id, text: "", streaming: true } satisfies AiTextPart];
  return { ...t, parts: replace<AiTextPart>(parts, id, change) };
}

function settle(parts: AiPart[]): AiPart[] {
  return parts.some(part => (part.kind === "text" || part.kind === "thinking") && part.streaming)
    ? parts.map(part => (part.kind === "text" || part.kind === "thinking") && part.streaming ? { ...part, streaming: false } : part)
    : parts;
}

function note(t: AiTranscript, id: string, message: string, tone: "info" | "error"): AiTranscript {
  if (!message || t.parts.some(part => part.id === id)) return t;
  return { ...t, parts: [...t.parts, { kind: "note", id, text: message, tone }] };
}

function messageUpdate(t: AiTranscript, update: Fields): AiTranscript {
  const index = update.contentIndex;
  switch (update.type) {
    case "text_start":
      return block(t, "text", index, part => part);
    case "thinking_start":
      return block(t, "thinking", index, part => part);
    case "text_delta":
      return block(t, "text", index, part => ({ ...part, text: part.text + text(update.delta) }));
    case "thinking_delta":
      return block(t, "thinking", index, part => ({ ...part, text: part.text + text(update.delta) }));
    case "text_end":
      return block(t, "text", index, part => ({ ...part, text: text(update.content) || part.text, streaming: false }));
    case "thinking_end":
      return block(t, "thinking", index, part => ({ ...part, text: text(update.content) || part.text, streaming: false }));
    default:
      return t;
  }
}

/** The final assistant message is authoritative: its blocks replace what the deltas built. */
function messageEnd(t: AiTranscript, message: Fields): AiTranscript {
  if (message.role !== "assistant") return t;
  let parts = t.parts;
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((raw, index) => {
    const item = record(raw);
    const value = item.type === "text" ? text(item.text) : item.type === "thinking" ? text(item.thinking) : "";
    if (!value) return;
    parts = replace<AiTextPart>(parts, `m${t.message}:${index}`, part => ({ ...part, text: value, streaming: false }));
  });
  let next = { ...t, parts };
  if (message.stopReason === "error") next = note(next, `m${t.message}:error`, text(message.errorMessage) || "模型返回错误", "error");
  if (message.stopReason === "aborted") next = note(next, `m${t.message}:aborted`, "已停止", "info");
  return next;
}

function ask(t: AiTranscript, event: PiEvent): AiTranscript {
  const id = text(event.id);
  const method = text(event.method);
  if (!id) return t;
  if (method === "notify") {
    const tone = event.notifyType === "error" ? "error" : "info";
    return note(t, `ui:${id}`, text(event.message), tone);
  }
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return t;
  if (t.parts.some(part => part.id === `ui:${id}`)) return t;
  const part: AiAskPart = {
    kind: "ask",
    id: `ui:${id}`,
    method: method === "editor" ? "input" : method,
    title: text(event.title),
    message: text(event.message) || undefined,
    options: Array.isArray(event.options) ? event.options.filter((option): option is string => typeof option === "string") : undefined,
    placeholder: text(event.placeholder) || text(event.prefill) || undefined,
  };
  return { ...t, parts: [...t.parts, part] };
}

export function reducePiEvent(t: AiTranscript, event: PiEvent): AiTranscript {
  switch (event.type) {
    case "agent_start":
      return t.running ? t : { ...t, running: true };
    case "agent_settled":
      return { ...t, running: false, parts: settle(t.parts) };
    case "message_start":
      return record(event.message).role === "assistant" ? { ...t, message: t.message + 1 } : t;
    case "message_update":
      return messageUpdate(t, record(event.assistantMessageEvent));
    case "message_end":
      return messageEnd(t, record(event.message));
    case "tool_execution_start": {
      const id = text(event.toolCallId);
      if (!id || t.parts.some(part => part.id === id)) return t;
      const step: AiToolStep = { kind: "tool", id, tool: text(event.toolName), args: record(event.args), state: "running" };
      return { ...t, parts: [...t.parts, step] };
    }
    case "tool_execution_update":
      return { ...t, parts: replace<AiToolStep>(t.parts, text(event.toolCallId), step => ({ ...step, partial: record(event.partialResult).details })) };
    case "tool_execution_end":
      return {
        ...t,
        parts: replace<AiToolStep>(t.parts, text(event.toolCallId), step => ({
          ...step,
          state: event.isError ? "error" : "done",
          details: record(event.result).details,
          text: resultText(event.result),
          durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
        })),
      };
    case "extension_ui_request":
      return ask(t, event);
    // kdj-server's own lines about the process it runs.
    case "kdj_exit":
      return note({ ...t, running: false, parts: settle(t.parts) }, `exit:${text(event.at)}`, text(event.message) || "pi 已退出", "error");
    case "kdj_error":
      return note({ ...t, running: false, parts: settle(t.parts) }, `error:${text(event.at)}`, text(event.message), "error");
    default:
      return t;
  }
}

let localId = 0;

/** The listener's own line, added when it is sent. */
export function addUserLine(t: AiTranscript, line: string): AiTranscript {
  localId += 1;
  return { ...t, parts: [...t.parts, { kind: "user", id: `u${localId}`, text: line }] };
}

export function answerAsk(t: AiTranscript, id: string, answer: string | boolean | null): AiTranscript {
  return { ...t, parts: replace<AiAskPart>(t.parts, id, part => ({ ...part, answer })) };
}

export function addNote(t: AiTranscript, message: string, tone: "info" | "error"): AiTranscript {
  localId += 1;
  return note(t, `n${localId}`, message, tone);
}
