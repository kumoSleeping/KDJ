import { useEffect } from "react";
import { Download, ExternalLink, Radio, Square, X } from "lucide-react";
import { useDownloadStore } from "../../stores/downloadStore";
import { projectDuration } from "../../lib/workshop";
import { useAppStore } from "../../stores/appStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useLiveVjStore } from "../../stores/liveVjStore";
import { liveVjRunning, liveVjSupported } from "../../lib/liveVj";
import { useLiveVjStatus } from "../../lib/useLiveVjStatus";
import { getBridge } from "../../lib/bridge";
import { api } from "../../lib/api";
import { InlineNotice, Panel } from "../common";
import { QueuePanel } from "../download/QueuePanel";
import { VisualizerExportTasks } from "../composition/VisualizerExportTasks";

const exportPhases: Record<string, string> = {
  queued: "等待导出", rendering: "导出中", validating: "校验中", committing: "保存中",
  importing: "入库中", complete: "已完成", failed: "导出失败", import_failed: "入库失败", canceled: "已取消",
};
const activeExport = (phase: string) => ["queued", "rendering", "validating", "committing", "importing"].includes(phase);

function ExportTaskContents() {
  const projects = useWorkshopStore(state => state.projects);
  const jobs = useWorkshopStore(state => state.jobs);
  const error = useWorkshopStore(state => state.error);
  const visualizerError = useVisualizerExportStore(state => state.error);
  useEffect(() => {
    void useWorkshopStore.getState().refresh();
    void useVisualizerExportStore.getState().initialize().catch(error => useVisualizerExportStore.setState({ error: String(error) }));
  }, []);
  const fail = (error: unknown) => useWorkshopStore.setState({ error: String(error) });
  return (
    <div className="kd-task-window-body">
      <InlineNotice text={error} onDismiss={() => useWorkshopStore.setState({ error: "" })} />
      <InlineNotice text={visualizerError} onDismiss={() => useVisualizerExportStore.setState({ error: "" })} />
      {projects.filter(project => !jobs.some(job => job.project_id === project.id)).map(project =>
        <div className="kd-task-window-entry kd-task-window-line" key={project.id}>
          <span className="kd-task-window-name">{project.name}</span>
          <button type="button" disabled={projectDuration(project) <= 0} onClick={() => void useWorkshopStore.getState().export(project.id).catch(fail)}>
            <Download size={13} />导出
          </button>
        </div>)}
      {jobs.map(job => <div className="kd-task-window-entry" key={job.id}>
        <div className="kd-task-window-line">
          <span className="kd-task-window-name" title={job.path}>{projects.find(p => p.id === job.project_id)?.name ?? job.path}</span>
          <span>{exportPhases[job.phase] ?? job.phase}</span>
          {activeExport(job.phase) && <button type="button" title="取消导出" aria-label="取消导出"
            disabled={["committing", "importing"].includes(job.phase)}
            onClick={() => void useWorkshopStore.getState().cancelExport(job.id).catch(fail)}><X size={13} /></button>}
          {["failed", "canceled"].includes(job.phase) && projects.some(project => project.id === job.project_id)
            && !jobs.some(other => other.project_id === job.project_id && activeExport(other.phase))
            && <button type="button" onClick={() => void useWorkshopStore.getState().export(job.project_id).catch(fail)}>重试</button>}
          {job.phase === "complete" && job.path && <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹"
            onClick={() => void getBridge().revealPath(job.path).catch(fail)}><ExternalLink size={13} /></button>}
          {job.phase === "import_failed" && <button type="button" onClick={() => void api.importWorkshopExport(job.id)
            .then(snapshot => useWorkshopStore.getState().accept(snapshot)).catch(fail)}>重试入库</button>}
        </div>
        {activeExport(job.phase) && <progress max={1} value={job.progress} aria-label="VJ 导出进度" />}
        {job.detail && <div>{job.detail}</div>}
        {job.error && <div role="status" className="kd-task-window-error">{job.error}</div>}
      </div>)}
      <VisualizerExportTasks />
    </div>
  );
}

export function ExportTaskPanel() {
  return <Panel heading="导出" padded={false} dense className="kd-task-window" actions={
    <button type="button" className="kd-manager-panel-action" title="打开视频项目与导出" aria-label="打开视频项目与导出"
      onClick={() => useAppStore.getState().openCompositionPanel()}><ExternalLink size={13} /></button>
  }><ExportTaskContents /></Panel>;
}

export function DownloadTaskPanel() {
  const hasDownloads = useDownloadStore(state => state.list.length > 0);
  return <Panel heading="下载" padded={false} dense className="kd-task-window kd-download-window">
    <div className="kd-task-window-body" data-empty={!hasDownloads}><QueuePanel /></div>
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
