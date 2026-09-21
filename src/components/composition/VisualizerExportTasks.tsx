import { Download, Trash2, X } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { visualizerExportActive, visualizerExportStartable } from "../../lib/visualizerExportQueue";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { QueueStateMark } from "../queue/QueuePrimitives";

export function VisualizerExportTasks() {
  const tasks = useVisualizerExportStore(state => state.tasks);
  if (!tasks.length) return null;
  return <section aria-label="可视化导出队列" className="vj-visualizer-tasks">
    <h3 className="vj-task-section-title">可视化 <small>{tasks.length}</small></h3>
    {tasks.map(task => {
      const active = visualizerExportActive(task);
      const running = active && task.phase !== "queued";
      return <section key={task.id} className="vj-task-entry" aria-label={`可视化 ${task.name}`}>
        <div className="vj-task-heading-row">
          <div className="vj-task-heading"><span title={task.name}>{task.name}</span></div>
          {visualizerExportStartable(task) && <button type="button" aria-label={`导出可视化 ${task.name}`}
            onClick={() => useVisualizerExportStore.getState().start(task.id)}><Download size={14} />{task.phase === "failed" ? "重试" : "导出"}</button>}
          <span className="vj-task-progress vj-task-heading-progress" role="status">
            <QueueStateMark state={running ? "processing" : task.phase} />
            {task.status}{running && ` ${(task.progress * 100).toFixed(1)}%`}
            {active && <progress aria-label={`${task.name} 可视化导出进度`} max={1} value={task.progress} />}
          </span>
          {active ? <button type="button" aria-label={`取消可视化导出 ${task.name}`} title="取消导出" disabled={task.status === "正在取消"}
            onClick={() => void useVisualizerExportStore.getState().cancel(task.id)}><X size={14} /></button>
            : <button type="button" aria-label={`删除可视化任务 ${task.name}`} title="删除任务"
              onClick={() => void useVisualizerExportStore.getState().remove(task.id)}><Trash2 size={14} /></button>}
        </div>
        <div className="vj-task-export-meta">
          <span>{task.width} × {task.height} · {task.fps} fps</span>
          <span className="vj-output-path" title={task.outputPath}>{task.outputPath}</span>
          {task.phase === "done" && <button type="button" onClick={() => void getBridge().revealPath(task.outputPath)
            .catch(error => useVisualizerExportStore.setState({ error: String(error) }))}>打开所在文件夹</button>}
          {task.error && <span className="vj-error" role="status">{task.error}</span>}
        </div>
      </section>;
    })}
  </section>;
}
