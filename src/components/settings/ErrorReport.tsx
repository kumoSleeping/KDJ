import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { api } from "../../lib/api";
import { flushDiagnostics } from "../../lib/diagnostics";
import { reportNote, reportTemplate } from "../../lib/reportNote";
import { Button, InlineNotice } from "../common";
import "./DiagnosticsPanel.css";

type Preview = Awaited<ReturnType<typeof api.diagnostics.prepare>>;

/**
 * 把错误报告交给开发者，一步完成：照着说明里的三问写几句（可以不写），按「发送」。
 * `problem` 是从出错提示或崩溃页过来时已经知道的问题，先填在「遇到了什么问题」后面；没填的问句不发送。
 * 从上到下：说明、会发什么的一句话、状态和两个键、要看时展开的内容。
 *
 * 发送前的内容是冻结的：「查看内容」和「发送」用的是同一份脱敏后的报告，改了描述才会重新生成。
 * 失败后再按一次发送的是同一份报告（服务端按报告 ID 去重）。没有勾选、没有二次确认窗口，
 * 也没有自动上传：只有这个按键会联网。设置里的日志页和崩溃页共用它。
 */
export function ErrorReport({ problem = "" }: { problem?: string }) {
  const [note, setNote] = useState(() => reportTemplate(problem));
  const field = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<"idle" | "preparing" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The caret waits after the first question.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    const end = node.value.indexOf("\n");
    node.setSelectionRange(end < 0 ? node.value.length : end, end < 0 ? node.value.length : end);
  }, []);

  const freeze = async (): Promise<Preview> => {
    if (preview) return preview;
    await flushDiagnostics();
    const next = await api.diagnostics.prepare(reportNote(note));
    if (alive.current) setPreview(next);
    return next;
  };
  const fail = (cause: unknown) => {
    if (alive.current) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase("idle"); }
  };
  const look = async () => {
    if (shown) { setShown(false); return; }
    setError(""); setPhase("preparing");
    try { await freeze(); if (alive.current) { setShown(true); setPhase("idle"); } } catch (cause) { fail(cause); }
  };
  const send = async () => {
    setError(""); setPhase("preparing");
    try {
      const frozen = await freeze();
      if (!alive.current) return;
      setPhase("sending");
      const result = await api.diagnostics.submit(frozen.id);
      if (alive.current) { setReceipt(result.id); setPhase("sent"); }
    } catch (cause) { fail(cause); }
  };

  const busy = phase === "preparing" || phase === "sending";
  if (phase === "sent") return <section className="kd-report" aria-label="上报错误">
    <p className="kd-report-status" role="status">已发送 · {receipt.slice(0, 8)}</p>
  </section>;
  return <section className="kd-report" aria-label="上报错误">
    <label className="kd-report-field">
      <span>说说发生了什么</span>
      <textarea ref={field} className="kd-report-note" rows={4} maxLength={2000} value={note} disabled={busy}
        autoFocus autoComplete="off" spellCheck={false}
        onChange={event => { setNote(event.currentTarget.value); setPreview(null); setShown(false); }} />
    </label>
    <p className="kd-report-privacy">发送近期错误、软件版本和系统信息，不含媒体、曲库、账号或设置。</p>
    <div className="kd-report-actions">
      <span className="kd-report-status" role="status">
        {phase === "preparing" ? "正在整理" : phase === "sending" ? "正在发送" : preview ? `${Math.ceil(preview.bytes / 1024)} KB` : ""}
      </span>
      <Button size="sm" variant="ghost" disabled={busy} aria-expanded={shown} onClick={() => void look()}>
        {shown ? "收起内容" : "查看内容"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send()}><Send size={14} />发送</Button>
    </div>
    {shown && preview && <pre className="kd-report-body" tabIndex={0} aria-label="将发送的内容">{preview.body}</pre>}
    <InlineNotice text={error} block wrap report={false} onDismiss={() => setError("")} />
  </section>;
}
