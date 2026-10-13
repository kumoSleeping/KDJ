import { useState } from "react";
import { FolderOpen, Send } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { api } from "../../lib/api";
import { Button, InlineNotice, Panel } from "../common";
import { ErrorReport } from "./ErrorReport";
import "./DiagnosticsPanel.css";

/**
 * 日志：打开日志文件夹，或把错误上报给开发者（展开在原处，见 ErrorReport）。
 * 只是打开这个面板不轮询、不联网。
 */
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
      <Button variant="ghost" size="sm" aria-expanded={reporting} onClick={() => setReporting(open => !open)}>
        <Send size={14}/>{reporting ? "收起" : "上报错误"}
      </Button>
    </div>
    <InlineNotice text={error} block onDismiss={() => setError("")}/>
    {reporting && <ErrorReport />}
  </Panel>;
}
