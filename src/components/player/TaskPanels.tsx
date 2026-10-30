import { visualizerExportAvailable } from "../../lib/platformFeatures";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
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
export const shownTaskViews = () => visualizerExportAvailable() ? taskViews : taskViews.filter(item => item.id === "downloads" || item.id === "history");

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
  const exportView = visualizerExportAvailable() && (view === "exports" || view === "export-history");
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
    if (!visualizerExportAvailable() || (view !== "exports" && view !== "export-history") || visitedExports.current) return;
    visitedExports.current = true;
    void useVisualizerExportStore.getState().initialize().catch(() => undefined);
  }, [view]);
  return <SlidePages page={view} order={shownTaskViews().map(item => item.id)}>
    <TaskPageBody key={view} view={view} position={positions.current[view]} onReady={onReady} />
  </SlidePages>;
}
