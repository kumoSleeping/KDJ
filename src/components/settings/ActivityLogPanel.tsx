import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Send, X } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { api } from "../../lib/api";
import { flushDiagnostics } from "../../lib/diagnostics";
import { Button, InlineNotice, Panel } from "../common";
import "./DiagnosticsPanel.css";

type Preview = Awaited<ReturnType<typeof api.diagnostics.prepare>>;

function ReportDialog({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function prepare() {
    setBusy(true); setError(""); setConfirmed(false);
    try { await flushDiagnostics(); setPreview(await api.diagnostics.prepare(note)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function upload() {
    if (!preview || !confirmed || busy) return;
    setBusy(true); setError("");
    try { setReceipt((await api.diagnostics.submit(preview.id)).id); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="kd-diagnostic-dialog" aria-labelledby="kd-report-title"
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <header><strong id="kd-report-title">将错误上报至开发者</strong>
      <Button variant="ghost" size="sm" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16}/></Button></header>
    <p>仅在确认上传时发送到 bug.kdj.kumo.ltd，保存 30 天。包含近期错误、堆栈、软件版本、系统与 CPU 线程数，不附带媒体、曲库、账号或设置文件。</p>
    <p>已自动隐藏常见凭证、路径、网址、邮箱和 IP；自动脱敏无法保证识别所有私人内容，请核对下方完整报告。Cloudflare 处理连接时仍会接触来源 IP，本收集器不将其存入报告。</p>
    {!receipt && <>
      <label>问题描述<textarea value={note} maxLength={2000} disabled={busy} onChange={event => { setNote(event.target.value); setPreview(null); setConfirmed(false); }}/></label>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void prepare()}>生成脱敏预览</Button>
      {preview && <>
        <pre tabIndex={0} aria-label="将上传的完整报告">{preview.body}</pre>
        <label className="kd-diagnostic-consent"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={event => setConfirmed(event.target.checked)}/>已核对内容，同意仅上传本次报告（{Math.ceil(preview.bytes / 1024)} KB）</label>
        <Button variant="ghost" size="sm" disabled={busy || !confirmed} onClick={() => void upload()}><Send size={14}/>{busy ? "处理中" : "确认上传"}</Button>
      </>}
    </>}
    {receipt && <p role="status">上报成功 · {receipt}</p>}
    <InlineNotice text={error} block onDismiss={() => setError("")}/>
  </dialog>, document.body);
}

/** No polling, rolling log feed, or network activity when this panel is merely opened. */
export function ActivityLogPanel() {
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  return <Panel heading="日志" dense>
    <div className="kd-diagnostic-actions">
      <Button variant="ghost" size="sm" disabled={opening} onClick={() => {
        setOpening(true); setError("");
        void api.diagnostics.directory().then(({ path }) => getBridge().openPath(path))
          .catch(error => setError(error instanceof Error ? error.message : String(error)))
          .finally(() => setOpening(false));
      }}><FolderOpen size={14}/>打开日志文件夹</Button>
      <Button variant="ghost" size="sm" onClick={() => setReporting(true)}><Send size={14}/>将错误上报至开发者</Button>
    </div>
    <InlineNotice text={error} block onDismiss={() => setError("")}/>
    {reporting && <ReportDialog onClose={() => setReporting(false)}/>}
  </Panel>;
}
