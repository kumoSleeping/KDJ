/**
 * The AI's app in the list's drawer (docs/ai-dock.md, "AI 抽屉"; src/lib/aiDrawer.ts):
 *
 * - 任务: the request under way, or the last one — the listener's words, what came with them,
 *   the supplements — and every step the AI took, as it runs (aiStore.run, kept by aiEvents.tsx);
 * - 历史: pi's earlier sessions in KDJ's folder, newest first (AiSessions.tsx, also in 设置 → AI).
 *   Every request is a session of its own; one opens to what was asked and what was done, and
 *   can be continued: the next request in the `/pi` field goes on from it.
 *
 * The title row holds 停止 while the AI works and + for a new session. Nothing here is written
 * by the AI; an empty page stays empty.
 */
import { Plus, Square } from "lucide-react";
import { aiApi } from "../../lib/api";
import { aiDrawerPages, useAiDrawer } from "../../lib/aiDrawer";
import { useAiStore } from "../../stores/aiStore";
import { SlidePages } from "../drawer/SlidePages";
import { AiSessions, Request, StepRow } from "./AiSessions";
import { PlanText } from "./AiMarkup";
import "./AiDrawer.css";

function TaskPage() {
  const run = useAiStore(state => state.run);
  return <div className="kd-ai-drawer kd-scroll" data-drawer-scroll>
    {run && <>
      <Request text={run.request} attached={run.attached} supplements={run.supplements} resumed={run.resumed} />
      <ol className="kd-ai-steps">
        {run.steps.map(step => <StepRow key={step.id} {...step} />)}
      </ol>
      {run.reply && <div className="kd-ai-message-md kd-ai-reply"><PlanText text={run.reply} /></div>}
    </>}
  </div>;
}

/** The two pages, one at a time. */
export function AiDrawer() {
  const page = useAiDrawer(state => state.page);
  return <SlidePages page={page} order={aiDrawerPages.map(item => item.id)}>
    {page === "tasks" ? <TaskPage key="tasks" /> : <AiSessions key="history" page />}
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
