import { useEffect, useId, useRef, useState } from "react";
import { Download, ExternalLink, Radio, Square } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useLiveVjStore } from "../../stores/liveVjStore";
import { liveVjRunning, liveVjSupported } from "../../lib/liveVj";
import { useLiveVjStatus } from "../../lib/useLiveVjStatus";
import { InlineNotice, Panel } from "../common";
import { QueuePanel } from "../download/QueuePanel";
import { ExportQueuePanel } from "../composition/ExportQueuePanel";
import "./TaskPanels.css";

const taskViews: { id: TaskPanelView; label: string; title?: string }[] = [
  { id: "downloads", label: "下载" },
  { id: "history", label: "历史", title: "下载历史" },
  { id: "exports", label: "导出" },
  { id: "export-history", label: "成品", title: "导出历史" },
];

export function DownloadTaskPanel() {
  const view = useTaskPanelStore(state => state.view);
  const setView = useTaskPanelStore(state => state.setView);
  const exportView = view === "exports" || view === "export-history";
  const [visitedExports, setVisitedExports] = useState(exportView);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  useEffect(() => { if (exportView) setVisitedExports(true); }, [exportView]);
  return <Panel heading={<span className="kd-task-tabs" role="tablist" aria-label="任务页面"
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const index = taskViews.findIndex(item => item.id === view);
      const next = event.key === "ArrowRight" ? (index + 1) % taskViews.length
        : event.key === "ArrowLeft" ? (index + taskViews.length - 1) % taskViews.length
        : event.key === "Home" ? 0 : event.key === "End" ? taskViews.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      event.stopPropagation();
      setView(taskViews[next].id);
      tabs.current[next]?.focus({ preventScroll: true });
    }}>
    {taskViews.map((item, index) => <button key={item.id} ref={node => { tabs.current[index] = node; }}
      type="button" role="tab" id={`${id}-${item.id}`} aria-controls={`${id}-page`} title={item.title} aria-label={item.title}
      aria-selected={view === item.id} tabIndex={view === item.id ? 0 : -1} onClick={() => setView(item.id)}>
      {item.label}
    </button>)}
  </span>} maximizable visibleHeader expandKey="kd-activity-panels:downloads" padded={false} dense className="kd-task-window kd-download-window">
    <div className="kd-task-window-body" id={`${id}-page`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
      <div className="kd-task-page" hidden={exportView}><QueuePanel history={view === "history"} /></div>
      {(visitedExports || exportView) && <div className="kd-task-page" hidden={!exportView}><ExportQueuePanel history={view === "export-history"} /></div>}
    </div>
  </Panel>;
}

const livePhases: Record<string, string> = {
  indexing: "分析素材", permission: "等待声音输入授权", listening: "监听中", matched: "已匹配",
  searching: "重新搜索", prepared: "特征索引已就绪", stopped: "已停止", failed: "运行失败",
  connecting: "连接中", sending: "音频发送中",
};
export function LiveVjTaskPanel() {
  const document = useLiveVjStore(state => state.document);
  const view = useLiveVjStore(state => state.view);
  const busy = useLiveVjStore(state => state.busy);
  const error = useLiveVjStore(state => state.error);
  useLiveVjStatus();
  useEffect(() => {
    if (window.__TAURI_INTERNALS__ && liveVjSupported()) void useLiveVjStore.getState().initialize();
  }, []);
  const open = (id?: string) => {
    if (id) useLiveVjStore.getState().select(id);
    useAppStore.getState().openLiveVjPanel();
  };
  return <Panel heading="实时 VJ 任务" padded={false} dense className="kd-task-window" actions={
    <button type="button" className="kd-manager-panel-action" title="打开实时 VJ" aria-label="打开实时 VJ"
      onClick={() => open()}><ExternalLink size={13} /></button>
  }>
    <div className="kd-task-window-body">
      <InlineNotice text={error || view?.error || ""} onDismiss={() => useLiveVjStore.setState({ error: "" })} />
      {view?.phase && view.phase !== "idle" && <div className="kd-task-window-entry" role="status">
        <div className="kd-task-window-line"><Radio size={13} /><span>{livePhases[view.phase] ?? view.phase}</span>
          {liveVjRunning(view) && <button type="button" title="停止实时 VJ" aria-label="停止实时 VJ" disabled={busy}
            onClick={() => void useLiveVjStore.getState().stop()}><Square size={13} /></button>}
        </div>
        {view.phase === "indexing" && <progress max={Math.max(1, view.total)} value={view.indexed} aria-label="实时 VJ 素材分析进度" />}
        {view.matched && <div>{view.matched.entry.title}</div>}
      </div>}
      {document?.sets.map(set => <div className="kd-task-window-entry kd-task-window-line" key={set.id}>
        <button type="button" className="kd-task-window-name" onClick={() => open(set.id)}>{set.name}</button>
        <span>{set.entries.length} 首</span>
      </div>)}
    </div>
  </Panel>;
}

export const taskPanelItems = {
  downloads: { label: "下载", icon: <Download size={14} /> },
};
