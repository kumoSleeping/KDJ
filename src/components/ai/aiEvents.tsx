/**
 * pi's stream turned into what the window does (docs/ai-dock.md). The AI says nothing in words:
 *
 * - each tool call is a bubble at the top while it runs and for a moment after (aiTasks.ts says
 *   what it reads); downloads report in the download list and its bubbles like any other;
 * - `kdj_search` runs the same search in the search pane, `kdj_play` plays the track;
 * - `ask_user` (an extension dialog) is a bubble at the bottom right with its choices and, when
 *   the AI gave one, a countdown after which its default is taken;
 * - what goes wrong is an amber bubble at the top.
 */
import { useState, type ReactNode } from "react";
import { FileVideo, Globe, Library, LogIn, Search, Settings2, Sparkles, Wrench } from "lucide-react";
import { aiApi } from "../../lib/api";
import { requestAiSearch } from "../../lib/aiSearch";
import { openAiSettings } from "../../lib/aiSettings";
import { noticeOnEnd, noticeOnStart, resultText, type AiNotice, type AiNoticeIcon } from "../../lib/aiTasks";
import type { PiEvent } from "../../types/ai";
import { dismissTask, showTask } from "../tasks/taskBubbleStore";
import "./AiAsk.css";

/** How long a finished step stays at the top. */
const DONE_STAY_MS = 2_500;

const ICONS: Record<AiNoticeIcon, ReactNode> = {
  search: <Search size={16} aria-hidden="true" />,
  web: <Globe size={16} aria-hidden="true" />,
  login: <LogIn size={16} aria-hidden="true" />,
  library: <Library size={16} aria-hidden="true" />,
  video: <FileVideo size={16} aria-hidden="true" />,
  tool: <Wrench size={16} aria-hidden="true" />,
};

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => (value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The calls under way: their tool and arguments, for the line their end writes. */
const calls = new Map<string, { tool: string; args: Fields }>();
/** The arguments of the `ask_user` call under way: the dialog it opens carries no default. */
let asking: Fields | null = null;

function noticeBubble(id: string, notice: AiNotice, stay: number) {
  showTask({
    id: `ai:${id}`,
    kind: "ai",
    title: notice.title,
    detail: notice.detail,
    icon: ICONS[notice.icon],
    tone: notice.tone,
    placement: "top",
    size: notice.detail ? "regular" : "small",
    stay,
  });
}

/** One sentence at the top, for the AI's own troubles. */
export function aiProblem(message: string, actions?: Parameters<typeof showTask>[0]["actions"]) {
  showTask({
    id: "ai:problem",
    kind: "ai",
    title: message,
    icon: <Sparkles size={16} aria-hidden="true" />,
    tone: "error",
    placement: "top",
    actions,
  });
}

/** No pi, or no model: said where the request was made, with the way to set it up. */
export function aiBlocked(message: string) {
  aiProblem(message, [{ id: "ai-settings", label: "AI 设置", icon: <Settings2 size={14} aria-hidden="true" />, onSelect: openAiSettings }]);
}

function answer(id: string, body: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
  void aiApi.answer({ id, ...body }).catch(() => undefined);
}

/** The choices of a question, as a row of keys; the AI's default is written in full ink. */
function AskChoices({ id, method, options, fallback }: { id: string; method: string; options: string[]; fallback?: string }) {
  const [value, setValue] = useState("");
  const choose = (body: { value?: string; confirmed?: boolean }) => {
    answer(id, body);
    dismissTask(`ai-ask:${id}`);
  };
  if (method === "input" || method === "editor") {
    return <form className="kd-ai-ask-row" onSubmit={event => { event.preventDefault(); choose({ value }); }}>
      <input className="kd-ai-ask-input" value={value} onChange={event => setValue(event.target.value)} aria-label="回答" autoFocus />
      <button type="submit" className="kd-ai-choice" data-default="true">确定</button>
    </form>;
  }
  return <div className="kd-ai-ask-row" role="group" aria-label="选项">
    {options.map(option => <button key={option} type="button" className="kd-ai-choice" data-default={option === fallback || undefined}
      onClick={() => choose(method === "confirm" ? { confirmed: option === options[0] } : { value: option })}>
      {option}
    </button>)}
  </div>;
}

function askBubble(event: PiEvent) {
  const id = str(event.id);
  const method = str(event.method);
  if (!id) return;
  if (method === "notify") {
    showTask({ id: `ai:notify:${id}`, kind: "ai", title: str(event.message), icon: <Sparkles size={16} aria-hidden="true" />,
      tone: event.notifyType === "error" ? "error" : "info", placement: "top", size: "small" });
    return;
  }
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
  const timeout = typeof event.timeout === "number" ? event.timeout : 0;
  const options = method === "select" && Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === "string")
    : method === "confirm" ? ["确定", "取消"] : [];
  const fallback = asking && typeof asking.default === "string" ? asking.default : undefined;
  showTask({
    id: `ai-ask:${id}`,
    kind: "ai",
    title: str(event.title) || "AI 需要你决定",
    detail: str(event.message) || undefined,
    icon: <Sparkles size={16} aria-hidden="true" />,
    stay: timeout,
    controls: <AskChoices id={id} method={method} options={options} fallback={fallback} />,
    // Put away by hand, the question is cancelled; run out, pi takes the default itself.
    onDismiss: reason => { if (reason === "user") answer(id, { cancelled: true }); },
  });
}

/** Everything the window does for one line of pi's stream. */
export function handlePiEvent(event: PiEvent) {
  switch (event.type) {
    case "tool_execution_start": {
      const id = str(event.toolCallId), tool = str(event.toolName), args = fields(event.args);
      if (!id) return;
      calls.set(id, { tool, args });
      if (tool === "kdj_search") requestAiSearch(args);
      if (tool === "kdj_play") {
        const trackId = Number(args.track_id);
        void import("../../lib/aiPlay").then(module => module.playLibraryTrack(trackId));
      }
      if (tool === "ask_user") asking = args;
      const notice = noticeOnStart(tool, args);
      if (notice) noticeBubble(id, notice, 0);
      return;
    }
    case "tool_execution_end": {
      const id = str(event.toolCallId);
      const call = calls.get(id) ?? { tool: str(event.toolName), args: {} };
      calls.delete(id);
      if (call.tool === "ask_user") asking = null;
      const result = fields(event.result);
      const notice = noticeOnEnd(call.tool, call.args, result.details, event.isError === true, resultText(result));
      if (notice) noticeBubble(id, notice, notice.tone === "error" ? 0 : DONE_STAY_MS);
      else dismissTask(`ai:${id}`);
      return;
    }
    case "extension_ui_request":
      askBubble(event);
      return;
    case "message_end": {
      const message = fields(event.message);
      if (message.role === "assistant" && message.stopReason === "error") aiProblem(str(message.errorMessage) || "AI 出错了");
      return;
    }
    case "agent_settled":
      // A step that never ended (an aborted run) does not stay up.
      for (const id of calls.keys()) dismissTask(`ai:${id}`);
      calls.clear();
      asking = null;
      return;
    case "kdj_exit":
    case "kdj_error":
      for (const id of calls.keys()) dismissTask(`ai:${id}`);
      calls.clear();
      aiProblem(str(event.message) || "pi 已退出");
      return;
  }
}
