import { useState } from "react";
import { isTrackDrag, readTrackDragIds, finishTrackDrop } from "../../lib/trackDrag";
import { exportVisualizerTracks, reportVisualizerExportError } from "../../lib/visualizerExportActions";
import { useLibraryStore } from "../../stores/libraryStore";
import { Trash2 } from "lucide-react";
import { visualizerExportActive, visualizerExportStartable } from "../../lib/visualizerExportQueue";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { Button, InlineNotice } from "../common";
import { QueueFrame, QueueOverview } from "../queue/QueuePrimitives";
import { QueueTaskList, type QueueListPosition } from "../queue/QueueTaskList";
import { VisualizerExportRow } from "./VisualizerExportTasks";
import { QueueEmptyDemo } from "../common/PointerDemo";
import "./ExportQueuePanel.css";

/** The visualizer's exports: the queue, or the finished ones. Clearing never deletes a file. */
export function ExportQueuePanel({ history = false, position }: { history?: boolean; position: QueueListPosition }) {
  const [clearing, setClearing] = useState(false);
  const visualizerTasks = useVisualizerExportStore(state => state.tasks);
  const visualizerError = useVisualizerExportStore(state => state.error);
  const [canceling, setCanceling] = useState(false);
  const fail = (error: unknown) => useVisualizerExportStore.setState({ error: error instanceof Error ? error.message : String(error) });
  const visible = visualizerTasks.filter(task => (task.phase === "done") === history);
  const workingCount = visible.filter(task => visualizerExportActive(task) && task.phase !== "queued").length;
  const pendingCount = visible.filter(task => ["ready", "queued", "canceled"].includes(task.phase)).length;
  const failedCount = visible.filter(task => task.phase === "failed").length;
  const facts = [
    { count: workingCount, label: "进行中", tone: "running" },
    { count: pendingCount, label: "待开始", tone: "queued" },
    { count: failedCount, label: "失败", tone: "failed" },
  ].filter(fact => fact.count > 0);
  const finishedCount = history ? visible.length : 0;
  const canStart = !clearing && !canceling && visible.some(visualizerExportStartable);
  const canCancel = !clearing && !canceling && visible.some(visualizerExportActive);
  const clearButton = <Button variant="ghost" size="sm" disabled={clearing || canceling || !visible.length}
    title="停止并清除当前列表全部任务，保留导出文件" onClick={() => {
      setClearing(true);
      void Promise.allSettled(visible.map(task => useVisualizerExportStore.getState().remove(task.id))).then(results => {
        const errors = results.filter(result => result.status === "rejected");
        if (errors.length) fail(errors.map(result => String(result.reason)).join("；"));
      }).finally(() => setClearing(false));
    }}><Trash2 size={11} />清除</Button>;
  return <QueueFrame className="kd-export-page" data-kd-visualizer-export-drop={history ? undefined : true}
    onDragOver={event => { if (!history && isTrackDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDrop={event => {
      if (history || !isTrackDrag(event)) return;
      event.preventDefault(); event.stopPropagation();
      const ids = readTrackDragIds(event.dataTransfer);
      finishTrackDrop();
      const from = { x: event.clientX, y: event.clientY };
      void useLibraryStore.getState().resolveSummaries(ids).then(tracks => exportVisualizerTracks(tracks, from)).catch(reportVisualizerExportError);
    }}>
    {!history && <section className="kd-download-prefs" aria-label="导出队列概览"><QueueOverview facts={facts} total={visible.length} canStart={canStart}
      extraActions={clearButton} startTitle="开始待导出任务并重试失败任务" onStart={() => useVisualizerExportStore.getState().start()}
      canSecondary={canCancel} secondaryKind="cancel" secondaryLabel={canceling ? "正在取消" : "取消"}
      secondaryTitle="取消全部未完成的导出" onSecondary={() => {
        setCanceling(true);
        void useVisualizerExportStore.getState().cancel().catch(fail).finally(() => setCanceling(false));
      }} /></section>}
    {/* The finished page opens with its count where the other pages have their overview, so the
        first row starts at the same height on all four. */}
    {history && <section className="kd-download-prefs kd-download-overview" aria-label="导出成品概览">
      <div className="kd-download-summary" aria-live="polite">
        {finishedCount > 0 && <span className="kd-download-summary-fact" data-tone="finished">
          <strong>{finishedCount}</strong><span>成品</span>
        </span>}
      </div>
      <div className="kd-download-overview-actions">{clearButton}</div>
    </section>}
    <InlineNotice text={visualizerError} onDismiss={() => useVisualizerExportStore.setState({ error: "" })} block />
    <QueueTaskList empty={history ? undefined : <QueueEmptyDemo tray="export" label="将本地歌曲拖入此处准备导出，或右键导出" />} count={visible.length} position={position}
      getKey={index => `visualizer:${visible[index].id}`}>
      {index => <VisualizerExportRow task={visible[index]} order={index + 1} />}
    </QueueTaskList>
  </QueueFrame>;
}
