/**
 * What the AI was asked and what it did (docs/ai-dock.md, "AI 抽屉"): a request with its steps,
 * and the list of pi's sessions in KDJ's folder, newest first. Every request is a session of its
 * own; one opens to what was asked and done, and 继续 makes the next request in Agent Mode go on
 * from it. The AI drawer's 历史 page and 设置 → AI show the same list.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { aiApi } from "../../lib/api";
import { stepLine } from "../../lib/aiTasks";
import { useAiStore } from "../../stores/aiStore";
import type { AiSessionStep, AiSessionSummary } from "../../types/ai";
import { InlineNotice } from "../common";
import { PlanText } from "./AiMarkup";
import "./AiAsk.css";
import "./AiDrawer.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function StepRow({ tool, args, state, details, text }: {
  tool: string; args: unknown; state: "running" | "done" | "failed"; details?: unknown; text?: string;
}) {
  const line = stepLine(tool, args, state, details, text ?? "");
  // A message is the AI's own words, written as Markdown: drawn as such, not as a line of text.
  const message = tool === "tell_user" && state !== "failed" ? line.detail : undefined;
  return <li className="kd-ai-step" data-state={state}>
    <span className="kd-ai-step-mark" aria-hidden="true">
      {state === "running" ? <LoaderCircle size={12} className="kd-spin" /> : state === "failed" ? <TriangleAlert size={12} /> : <Check size={12} />}
    </span>
    <span className="kd-ai-step-copy">
      <span>{line.title}</span>
      {message ? <div className="kd-ai-step-md"><PlanText text={message} /></div> : line.detail && <small>{line.detail}</small>}
    </span>
  </li>;
}

export function Request({ text, attached, supplements = [], resumed }: { text: string; attached: string[]; supplements?: string[]; resumed?: string }) {
  return <div className="kd-ai-request">
    {resumed && <small>接着：{resumed}</small>}
    <p>{text}</p>
    {attached.length > 0 && <small>附带：{attached.join("、")}</small>}
    {supplements.map((line, index) => <small key={index}>补充：{line}</small>)}
  </div>;
}

const when = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function SessionSteps({ steps }: { steps: AiSessionStep[] }) {
  return <ol className="kd-ai-steps">
    {steps.map((step, index) => step.kind === "request"
      ? <li key={index} className="kd-ai-step-request"><Request text={step.text} attached={step.attached} /></li>
      : <StepRow key={index} tool={step.tool} args={step.args} state={step.failed ? "failed" : "done"} details={step.details} text={step.text} />)}
  </ol>;
}

/**
 * The sessions. In the drawer (`page`) the list is the page itself and scrolls; in 设置 it is one
 * group among the others.
 */
export function AiSessions({ page = false }: { page?: boolean }) {
  const running = useAiStore(state => state.running);
  const [listing, setListing] = useState<{ current: string | null; sessions: AiSessionSummary[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, AiSessionStep[]>>({});
  const load = useCallback(() => {
    aiApi.sessions().then(setListing, cause => setError(message(cause)));
  }, []);
  // A run that starts or ends changes the sessions: the list is read again.
  useEffect(() => { load(); }, [load, running]);
  const toggle = (path: string) => {
    if (open === path) { setOpen(null); return; }
    setOpen(path);
    aiApi.session(path).then(read => setSteps(known => ({ ...known, [path]: read.steps })), cause => setError(message(cause)));
  };
  // 继续: the session becomes a card in Agent Mode, and the next request goes on in it.
  const goOn = (session: AiSessionSummary) => {
    useAiStore.getState().continueSession({ path: session.path, title: session.title }).then(load, cause => setError(message(cause)));
  };
  const list = <>
    <InlineNotice text={error} block onDismiss={error ? () => setError("") : undefined} />
    <ul className="kd-ai-sessions">
      {listing?.sessions.map(session => {
        const current = session.id === listing.current;
        return <li key={session.path} className="kd-ai-session" data-open={open === session.path || undefined}>
          <div className="kd-ai-session-head">
            <button type="button" className="kd-ai-session-title" aria-expanded={open === session.path} onClick={() => toggle(session.path)}>
              <span>{session.title}</span>
              <small>{when(session.updated)} · {session.requests} 个请求 · {session.steps} 步</small>
            </button>
            {current
              ? <span className="kd-ai-session-now">当前</span>
              : <button type="button" className="kd-ai-session-go" disabled={running} title="下一句话接着这个会话" onClick={() => goOn(session)}>继续</button>}
          </div>
          {open === session.path && steps[session.path] && <SessionSteps steps={steps[session.path]} />}
        </li>;
      })}
    </ul>
  </>;
  if (!page) return <div className="kd-ai-sessions-group">{list}</div>;
  return <div className="kd-ai-drawer kd-scroll" data-drawer-scroll data-drawer-pending={!listing && !error ? "" : undefined}>
    {list}
  </div>;
}
