import { useEffect, useRef, useState } from "react";
import { FolderOpen, Send } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { api } from "../../lib/api";
import { useReportProblem } from "../../lib/errorReport";
import { useSettingsFocus } from "../../lib/settingsPages";
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
  // 「上报」 of an error's notice lands here: the report unfolds and is brought into view.
  const asked = useSettingsFocus(state => (state.section === "report" ? state.epoch : 0));
  // The report asked for from a notice opens with that notice as its problem; opened by hand, blank.
  const [request, setRequest] = useState({ epoch: 0, problem: "" });
  const anchor = useRef<HTMLDivElement>(null);
  const landing = useRef<number[]>([]);
  useEffect(() => {
    if (!asked) return;
    useSettingsFocus.getState().clear();
    setRequest({ epoch: asked, problem: useReportProblem.getState().text });
    useReportProblem.getState().set("");
    setReporting(true);
    const show = () => {
      const node = anchor.current;
      const host = node?.closest(".kd-scroll") as HTMLElement | null;
      if (!node || !host) return;
      const top = node.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      host.scrollTop = Math.max(0, top - 12);
    };
    // The page may still be changing places with the one before it, and the report has just been
    // unfolded: the place is taken again once both have settled. (Taking the request above runs
    // this effect once more, so the timers are the panel's, not this run's.)
    landing.current.forEach(timer => window.clearTimeout(timer));
    landing.current = [0, 150, 450].map(wait => window.setTimeout(show, wait));
  }, [asked]);
  useEffect(() => () => landing.current.forEach(timer => window.clearTimeout(timer)), []);
  return <Panel heading="日志" dense>
    <div ref={anchor} className="kd-diagnostic-actions">
      <Button variant="ghost" size="sm" disabled={opening} onClick={() => {
        setOpening(true); setError("");
        void api.diagnostics.directory().then(({ path }) => getBridge().openPath(path))
          .catch(error => setError(error instanceof Error ? error.message : String(error)))
          .finally(() => setOpening(false));
      }}><FolderOpen size={14}/>打开日志文件夹</Button>
      <Button variant="ghost" size="sm" aria-expanded={reporting} onClick={() => {
        setRequest(current => ({ epoch: current.epoch, problem: "" }));
        setReporting(open => !open);
      }}>
        <Send size={14}/>{reporting ? "收起" : "上报错误"}
      </Button>
    </div>
    <InlineNotice text={error} block onDismiss={() => setError("")}/>
    {reporting && <ErrorReport key={request.epoch} problem={request.problem} />}
  </Panel>;
}
