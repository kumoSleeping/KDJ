import { useLayoutEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { resultText } from "../../lib/aiTasks";
import { peekShots } from "../../lib/aiShots";
import type { AiTrace } from "../../lib/aiTrace";
import { StepRow } from "./AiSessions";
import "./AiTaskTrace.css";

/**
 * What the AI is doing, inside its task bubble: each tool it called, in the words of the drawer's
 * steps, and a single 正在思考 line while it thinks or writes. Its own words — the thinking and
 * the text it streams — are not shown, nor the raw arguments and results of its tools.
 */
export function AiTaskTrace({ snapshot }: { snapshot?: AiTrace }) {
  const live = useAiStore(state => snapshot ? undefined : state.run?.trace);
  const trace = snapshot ?? live;
  const node = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const scroller = node.current?.closest<HTMLElement>(".kd-task-body");
    if (!scroller) return;
    const scroll = () => { following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32; };
    scroller.addEventListener("scroll", scroll, { passive: true });
    return () => scroller.removeEventListener("scroll", scroll);
  }, []);
  useLayoutEffect(() => {
    const scroller = node.current?.closest<HTMLElement>(".kd-task-body");
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [trace]);
  // Only a live task is thinking; a finished one's snapshot has no message under way.
  const thinking = !snapshot && trace?.message !== null && trace?.message !== undefined;
  return <div ref={node} className="kd-ai-trace" aria-label="AI 执行记录">
    <ol className="kd-ai-steps">
      {trace?.entries.map((entry, index) => entry.kind === "tool"
        ? <StepRow key={index} tool={entry.name} args={entry.args}
          state={entry.state === "running" ? "running" : entry.state === "done" ? "done" : "failed"}
          details={(entry.result as { details?: unknown } | undefined)?.details}
          shots={entry.name === "kdj_peek" && entry.state === "done" ? peekShots(entry.result) : undefined}
          text={entry.state === "stopped" ? "已停止" : resultText(entry.result)} />
        : entry.kind === "error" ? <li key={index} className="kd-ai-trace-error">{entry.text}</li>
        : null)}
      {thinking && <li className="kd-ai-step" data-state="running">
        <span className="kd-ai-step-mark" aria-hidden="true"><LoaderCircle size={12} className="kd-spin" /></span>
        <span className="kd-ai-step-copy"><span>正在思考</span></span>
      </li>}
    </ol>
  </div>;
}
