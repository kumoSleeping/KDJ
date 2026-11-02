import { Download, FolderOpen, Pause, RotateCcw, Trash2, Video } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { folderName, formatPercent } from "../../lib/format";
import { projectExportActive, projectExportStartable, type ProjectExportTask } from "../../lib/projectExportQueue";
import { useProjectExportCovers } from "../../lib/useTaskCovers";
import { useProjectExportStore } from "../../stores/projectExportStore";
import { Button } from "../common";
import { TaskCover } from "../common/TaskCover";
import { QueueEntry } from "../queue/QueuePrimitives";
import "./ExportQueuePanel.css";

const fail = (error: unknown) => useProjectExportStore.setState({ error: error instanceof Error ? error.message : String(error) });

function ProjectExportCover({ task }: { task: ProjectExportTask }) {
  const urls = useProjectExportCovers(task.trackId);
  return <TaskCover urls={urls} owner={task.id} kind="mix" />;
}

/** One export of a 剪辑/VJ project in the export list: it can be paused and started again. */
export function ProjectExportRow({ task, order }: { task: ProjectExportTask; order: number }) {
  const active = projectExportActive(task);
  const running = task.phase === "rendering";
  const where = task.outputPath || task.folder;
  return <QueueEntry className="kd-export-task" data-task-id={task.id} order={String(order)} title={task.name} subtitle="剪辑"
    state={running ? "processing" : task.phase} status={task.status}
    percent={running ? formatPercent(task.progress) : undefined} progress={running ? task.progress : undefined}
    cover={<ProjectExportCover task={task} />}
    metadata={<>
      <span className="kd-download-task-quality kd-mono"><Video size={10} />{task.format}</span>
      {task.folder && <span className="kd-download-task-target kd-mono" title={where}><FolderOpen size={10} />{folderName(task.folder)}</span>}
    </>}
    actions={<>
      {projectExportStartable(task) && <Button variant="primary" size="sm" aria-label={`导出 ${task.name}`}
        title={task.phase === "failed" ? undefined : "从头导出工程现在的样子"}
        onClick={() => useProjectExportStore.getState().start(task.id)}>
        {task.phase === "failed" ? <RotateCcw size={11} /> : <Download size={11} />}{task.phase === "failed" ? "重试" : "导出"}
      </Button>}
      {active ? <Button variant="ghost" size="sm" iconOnly aria-label={`暂停导出 ${task.name}`} title="暂停导出" disabled={task.status === "正在暂停"}
        onClick={() => void useProjectExportStore.getState().pause(task.id).catch(fail)}><Pause size={12} /></Button>
        : task.phase === "done" && <Button variant="ghost" size="sm" iconOnly aria-label={`打开所在文件夹 ${task.name}`} title={`打开所在文件夹：${task.outputPath}`}
          onClick={() => void getBridge().revealPath(task.outputPath).catch(fail)}><FolderOpen size={12} /></Button>}
      <Button variant="ghost" size="sm" iconOnly aria-label={`清除剪辑导出 ${task.name}`} title="停止并清除任务，保留导出文件"
        onClick={() => void useProjectExportStore.getState().remove(task.id).catch(fail)}><Trash2 size={12} /></Button>
    </>}>
    {task.error && <div className="kd-download-task-error" role="status">{task.error}</div>}
  </QueueEntry>;
}
