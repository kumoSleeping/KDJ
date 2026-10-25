import { startTransition, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useProjectExportStore } from "../../stores/projectExportStore";
import { Panel } from "../common";
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
    void useVisualizerExportStore.getState().initialize().catch(() => undefined);
    void useProjectExportStore.getState().initialize().catch(() => undefined);
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
