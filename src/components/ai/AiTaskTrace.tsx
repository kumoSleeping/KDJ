import { useLayoutEffect, useRef } from "react";
import { useAiStore } from "../../stores/aiStore";
import type { AiTrace } from "../../lib/aiTrace";
import "./AiTaskTrace.css";

function printable(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, (key, item) => {
    if (key === "data" && typeof item === "string" && item.length > 1024) return "[二进制内容]";
    return item;
  }, 2);
}

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
  return <div ref={node} className="kd-ai-trace" aria-label="AI 执行记录">
    {trace?.entries.map((entry, index) => entry.kind === "message"
      ? <div key={index} className="kd-ai-trace-message">{entry.blocks.map((block, i) => block.text && <section key={i}>
        <strong>{block.kind === "thinking" ? "思考" : "AI"}</strong><pre>{block.text}</pre>
      </section>)}</div>
      : entry.kind === "error" ? <p key={index} data-failed="true">{entry.text}</p>
      : <section key={index} data-failed={entry.state === "failed" || undefined}>
        <strong>{entry.name} · {{ running: "调用中", done: "完成", failed: "失败", stopped: "已停止" }[entry.state]}</strong>
        {entry.args !== undefined && <><span>参数</span><pre>{printable(entry.args)}</pre></>}
        {entry.result !== undefined && <><span>结果</span><pre>{printable(entry.result)}</pre></>}
      </section>)}
  </div>;
}
