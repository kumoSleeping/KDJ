import { CircleMinus, Download, FolderOpen, RotateCcw, Trash2, Video } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { folderName, formatPercent } from "../../lib/format";
import { visualizerExportActive, visualizerExportStartable, type VisualizerExportTask } from "../../lib/visualizerExportQueue";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useVisualizerExportCovers } from "../../lib/useTaskCovers";
import { Button } from "../common";
import { TaskCover } from "../common/TaskCover";
import { QueueEntry } from "../queue/QueuePrimitives";
import "./ExportQueuePanel.css";

const fail = (error: unknown) => useVisualizerExportStore.setState({ error: error instanceof Error ? error.message : String(error) });

/** The picture of a visualizer export: the project's own picture, then the cover of its song. */
function VisualizerExportCover({ task }: { task: VisualizerExportTask }) {
  const { urls, pending } = useVisualizerExportCovers(task);
  return <TaskCover urls={urls} pending={pending} owner={task.id} kind="visualizer" />;
}

export function VisualizerExportTasks({ heading = true, firstOrder = 1, tasks: visibleTasks }: {
  heading?: boolean; firstOrder?: number; tasks?: readonly VisualizerExportTask[];
}) {
  const tasks = useVisualizerExportStore(state => visibleTasks ?? state.tasks);
  if (!tasks.length) return null;
  return <section aria-label="可视化导出" className="kd-visualizer-export-list">
    {heading && <h3 className="vj-task-section-title">可视化 <small>{tasks.length}</small></h3>}
    {tasks.map((task, index) => <VisualizerExportRow key={task.id} task={task} order={firstOrder + index} />)}
  </section>;
}

/** One row can also be mounted by the shared, windowed export list. */
export function VisualizerExportRow({ task, order }: { task: VisualizerExportTask; order: number }) {
  const active = visualizerExportActive(task);
  const running = active && task.phase !== "queued";
  const directory = task.outputPath.replace(/[\\/][^\\/]*$/, "");
  return <QueueEntry data-task-id={task.id} order={String(order)} title={task.name} subtitle="可视化"
    state={running ? "processing" : task.phase} status={task.status}
    percent={running ? formatPercent(task.progress) : undefined} progress={running ? task.progress : undefined}
    cover={<VisualizerExportCover task={task} />}
    metadata={<>
      <span className="kd-download-task-quality kd-mono"><Video size={10} />{task.width} × {task.height} · {task.fps} fps</span>
      {directory && <span className="kd-download-task-target kd-mono" title={task.outputPath}><FolderOpen size={10} />{folderName(directory)}</span>}
    </>}
    actions={<>
      {visualizerExportStartable(task) && <Button variant="primary" size="sm" aria-label={`导出可视化 ${task.name}`}
        onClick={() => useVisualizerExportStore.getState().start(task.id)}>
        {task.phase === "failed" ? <RotateCcw size={11} /> : <Download size={11} />}{task.phase === "failed" ? "重试" : "导出"}
      </Button>}
      {active ? <Button variant="ghost" size="sm" iconOnly aria-label={`取消可视化导出 ${task.name}`} title="取消导出" disabled={task.status === "正在取消"}
        onClick={() => void useVisualizerExportStore.getState().cancel(task.id).catch(fail)}><CircleMinus size={12} /></Button>
        : <>
          {task.phase === "done" && <Button variant="ghost" size="sm" iconOnly aria-label={`打开所在文件夹 ${task.name}`} title={`打开所在文件夹：${task.outputPath}`}
            onClick={() => void getBridge().revealPath(task.outputPath).catch(fail)}><FolderOpen size={12} /></Button>}
          <Button variant="ghost" size="sm" iconOnly aria-label={`删除可视化任务 ${task.name}`} title="只移除记录，不删除导出文件"
            onClick={() => void useVisualizerExportStore.getState().remove(task.id).catch(fail)}><Trash2 size={12} /></Button>
        </>}
    </>}>
    {task.error && <div className="kd-download-task-error" role="status">{task.error}</div>}
  </QueueEntry>;
}
