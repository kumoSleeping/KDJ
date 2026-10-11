import { startTransition, useCallback, useEffect, useId, useRef, useState } from "react";
import { ExternalLink, Radio, Square } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useLiveVjStore } from "../../stores/liveVjStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { liveVjRunning, liveVjSupported } from "../../lib/liveVj";
import { useLiveVjStatus } from "../../lib/useLiveVjStatus";
import { useTrackCoverStack } from "../../lib/useTaskCovers";
import { InlineNotice, Panel } from "../common";
import { TaskCoverStack } from "../common/TaskCover";
import { QueuePanel } from "../download/QueuePanel";
import { ExportQueuePanel } from "../composition/ExportQueuePanel";
import { SlidePages } from "../drawer/SlidePages";
import type { QueueListPosition } from "../queue/QueueTaskList";
import "./TaskPanels.css";

/** The task pages in title order: what is running and what is done, for downloads and for exports. */
export const taskViews: { id: TaskPanelView; label: string; title?: string }[] = [
  { id: "downloads", label: "下载" },
  { id: "history", label: "历史", title: "下载历史" },
  { id: "exports", label: "导出" },
  { id: "export-history", label: "成品", title: "导出历史" },
];
const taskViewIds = taskViews.map(item => item.id);

/** Give the title and slide a painted frame before building the requested page. */
function TaskPageBody({ view, position, onReady }: {
  view: TaskPanelView; position: QueueListPosition; onReady(): void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => startTransition(() => setReady(true)));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => { if (ready) onReady(); }, [ready, onReady]);
  const exportView = view === "exports" || view === "export-history";
  return <div className="kd-task-page" data-drawer-pending={!ready || undefined} aria-busy={!ready || undefined}>
    {ready && (exportView
      ? <ExportQueuePanel history={view === "export-history"} position={position} />
      : <QueuePanel history={view === "history"} position={position} />)}
  </div>;
}

/** Only the requested page is mounted; the stores retain data, not hidden copies of the lists. */
export function DownloadTaskPages() {
  const view = useTaskPanelStore(state => state.view);
  const positions = useRef<Record<TaskPanelView, QueueListPosition>>({
    downloads: {}, history: {}, exports: {}, "export-history": {},
  });
  const visitedExports = useRef(false);
  const onReady = useCallback(() => {
    if ((view !== "exports" && view !== "export-history") || visitedExports.current) return;
    visitedExports.current = true;
    void useWorkshopStore.getState().refresh();
    void useVisualizerExportStore.getState().initialize().catch(() => undefined);
  }, [view]);
  return <SlidePages page={view} order={taskViewIds}>
    <TaskPageBody key={view} view={view} position={positions.current[view]} onReady={onReady} />
  </SlidePages>;
}

/** The task list as a panel with its own tabs: the phone's sheet. On a wide window it is a drawer. */
export function DownloadTaskPanel() {
  const view = useTaskPanelStore(state => state.view);
  const setView = useTaskPanelStore(state => state.setView);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
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
  </span>} visibleHeader padded={false} dense className="kd-task-window kd-download-window">
    <div className="kd-task-window-body" id={`${id}-page`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
      <DownloadTaskPages />
    </div>
  </Panel>;
}

/** A set stands for its songs: the covers of the first few, overlapped. Its row states the count. */
function LiveVjSetCovers({ id, trackIds }: { id: string; trackIds: readonly number[] }) {
  const { covers } = useTrackCoverStack(trackIds);
  return <TaskCoverStack covers={covers} owner={id} kind="set" layout="row" />;
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
      {document?.sets.map(set => <div className="kd-task-window-entry kd-task-window-line" key={set.id} data-task-id={set.id}>
        <LiveVjSetCovers id={set.id} trackIds={set.entries.map(entry => entry.track_id)} />
        <button type="button" className="kd-task-window-name" onClick={() => open(set.id)}>{set.name}</button>
        <span>{set.entries.length} 首</span>
      </div>)}
    </div>
  </Panel>;
}
