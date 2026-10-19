/**
 * The AI's app in the list's drawer (docs/ai-dock.md, "AI 抽屉"; src/lib/aiDrawer.ts):
 *
 * - 任务: the request under way, or the last one — the listener's words, what came with them,
 *   the supplements — and every step the AI took, as it runs (aiStore.run, kept by aiEvents.tsx);
 * - 历史: pi's earlier sessions in KDJ's folder, newest first. One opens to what was asked and
 *   what was done, and can be continued: the next request in Agent Mode goes on from it.
 *
 * The title row holds 停止 while the AI works and + for a new session. Nothing here is written
 * by the AI; an empty page stays empty.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, Plus, Square, TriangleAlert } from "lucide-react";
import { aiApi } from "../../lib/api";
import { aiDrawerPages, useAiDrawer } from "../../lib/aiDrawer";
import { stepLine } from "../../lib/aiTasks";
import { useAiStore } from "../../stores/aiStore";
import type { AiSessionStep, AiSessionSummary } from "../../types/ai";
import { InlineNotice } from "../common";
import { SlidePages } from "../drawer/SlidePages";
import "./AiDrawer.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function StepRow({ tool, args, state, details, text }: {
  tool: string; args: unknown; state: "running" | "done" | "failed"; details?: unknown; text?: string;
}) {
  const line = stepLine(tool, args, state, details, text ?? "");
  return <li className="kd-ai-step" data-state={state}>
    <span className="kd-ai-step-mark" aria-hidden="true">
      {state === "running" ? <LoaderCircle size={12} className="kd-spin" /> : state === "failed" ? <TriangleAlert size={12} /> : <Check size={12} />}
    </span>
    <span className="kd-ai-step-copy">
      <span>{line.title}</span>
      {line.detail && <small>{line.detail}</small>}
    </span>
  </li>;
}

function Request({ text, attached, supplements = [] }: { text: string; attached: string[]; supplements?: string[] }) {
  return <div className="kd-ai-request">
    <p>{text}</p>
    {attached.length > 0 && <small>附带：{attached.join("、")}</small>}
    {supplements.map((line, index) => <small key={index}>补充：{line}</small>)}
  </div>;
}

function TaskPage() {
  const run = useAiStore(state => state.run);
  return <div className="kd-ai-drawer kd-scroll" data-drawer-scroll>
    {run && <>
      <Request text={run.request} attached={run.attached} supplements={run.supplements} />
      <ol className="kd-ai-steps">
        {run.steps.map(step => <StepRow key={step.id} {...step} />)}
      </ol>
    </>}
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

function HistoryPage() {
  const running = useAiStore(state => state.running);
  const [listing, setListing] = useState<{ current: string | null; sessions: AiSessionSummary[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, AiSessionStep[]>>({});
  const load = useCallback(() => {
    aiApi.sessions().then(setListing, cause => setError(message(cause)));
  }, []);
  // A run that ends has changed its session: the list is read again.
  useEffect(() => { if (!running) load(); }, [load, running]);
  const toggle = (path: string) => {
    if (open === path) { setOpen(null); return; }
    setOpen(path);
    aiApi.session(path).then(read => setSteps(known => ({ ...known, [path]: read.steps })), cause => setError(message(cause)));
  };
  const goOn = (session: AiSessionSummary) => {
    aiApi.switchSession(session.path).then(() => {
      useAiStore.setState({ run: null });
      load();
    }, cause => setError(message(cause)));
  };
  return <div className="kd-ai-drawer kd-scroll" data-drawer-scroll data-drawer-pending={!listing && !error ? "" : undefined}>
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
  </div>;
}

/** The two pages, one at a time. */
export function AiDrawer() {
  const page = useAiDrawer(state => state.page);
  return <SlidePages page={page} order={aiDrawerPages.map(item => item.id)}>
    {page === "tasks" ? <TaskPage key="tasks" /> : <HistoryPage key="history" />}
  </SlidePages>;
}

/** The title row's keys: stop the AI while it works, start a new session. */
export function AiDrawerTools() {
  const running = useAiStore(state => state.running);
  return <>
    {running && <button type="button" className="kd-ai-drawer-key" title="停止 AI" aria-label="停止 AI"
      onClick={() => void useAiStore.getState().abort()}><Square size={13} /></button>}
    <button type="button" className="kd-ai-drawer-key" title="新会话" aria-label="新会话" disabled={running}
      onClick={() => void aiApi.reset().then(() => useAiStore.setState({ run: null }))}><Plus size={15} /></button>
  </>;
}
