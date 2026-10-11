import { useState } from "react";
import { CircleMinus, Download, FolderOpen, Music2, RotateCcw, Video } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { folderName, formatPercent } from "../../lib/format";
import { projectDuration } from "../../lib/workshop";
import { visualizerExportActive, visualizerExportStartable } from "../../lib/visualizerExportQueue";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import type { CompositionProject, WorkshopJob } from "../../types/workshop";
import { useWorkshopExportCovers } from "../../lib/useTaskCovers";
import { Button, InlineNotice } from "../common";
import { TaskCoverStack } from "../common/TaskCover";
import { QueueEntry, QueueFrame, QueueOverview } from "../queue/QueuePrimitives";
import { QueueTaskList, type QueueListPosition } from "../queue/QueueTaskList";
import { VisualizerExportRow } from "./VisualizerExportTasks";
import "./ExportQueuePanel.css";

const phases: Record<string, string> = {
  queued: "等待导出", rendering: "导出中", validating: "校验中", committing: "保存中",
  importing: "入库中", complete: "已完成", failed: "导出失败", import_failed: "入库失败", canceled: "已取消",
};
const active = (job: WorkshopJob) => ["queued", "rendering", "validating", "committing", "importing"].includes(job.phase);
const cancelable = (job: WorkshopJob) => ["queued", "rendering", "validating"].includes(job.phase);
// An import failure still has a committed export; only library insertion remains.
const exported = (job: WorkshopJob | undefined) => job?.phase === "complete" || job?.phase === "import_failed";
const fail = (error: unknown) => useWorkshopStore.setState({ error: error instanceof Error ? error.message : String(error) });

/**
 * The picture of a mixing-editor export: the finished file once it is in the library, and until
 * then the sources it is made of, as a stack.
 */
function WorkshopExportCover({ project, job }: { project?: CompositionProject; job?: WorkshopJob }) {
  const { covers, more } = useWorkshopExportCovers(project, job);
  return <TaskCoverStack covers={covers} more={more} owner={job?.id ?? project?.id ?? ""} kind="mix" />;
}

function WorkshopExportRow({ project, job, order, canStart, history = false }: {
  project?: CompositionProject; job?: WorkshopJob; order: number; canStart: boolean; history?: boolean;
}) {
  const running = !!job && active(job);
  const rendering = running && job.phase !== "queued";
  const state = !job || job.phase === "queued" ? "queued" : running ? "processing"
    : job.phase === "complete" ? "done" : job.phase === "canceled" ? "canceled" : "failed";
  const title = history && job?.path ? folderName(job.path) : project?.name || folderName(job?.path || "");
  const snapshotProject = project && (!job || job.revision === project.revision) ? project : undefined;
  const video = job?.path ? /\.mp4$/i.test(job.path) : (project?.output.format ?? "mp4") === "mp4";
  const directory = job?.path ? job.path.replace(/[\\/][^\\/]*$/, "") : project?.output.directory || "";
  return <QueueEntry data-task-id={job?.id ?? project?.id} order={String(order)} title={title} subtitle="VJ 剪辑" state={state}
    status={job ? phases[job.phase] ?? job.phase : "待导出"}
    percent={rendering ? formatPercent(job.progress) : undefined} progress={rendering ? job.progress : undefined}
    cover={<WorkshopExportCover project={project} job={job} />}
    metadata={<>
      {snapshotProject && <span className="kd-download-task-quality kd-mono">
        {video ? <Video size={10} /> : <Music2 size={10} />}
        {video ? `${snapshotProject.canvas.width} × ${snapshotProject.canvas.height} · ${snapshotProject.canvas.fps} fps` : snapshotProject.output.format?.toUpperCase()}
      </span>}
      {directory && <span className="kd-download-task-target kd-mono" title={job?.path || directory}>
        <FolderOpen size={10} />{folderName(directory)}
      </span>}
    </>}
    actions={<>
      {canStart && project && <Button variant="primary" size="sm" aria-label={job ? `重试导出 ${title}` : `导出 ${title}`}
        onClick={() => void useWorkshopStore.getState().export(project.id).catch(fail)}>
        {job ? <RotateCcw size={11} /> : <Download size={11} />}{job ? "重试" : "导出"}
      </Button>}
      {running && <Button variant="ghost" size="sm" iconOnly title="取消导出" aria-label={`取消导出 ${title}`}
        disabled={!cancelable(job)} onClick={() => void useWorkshopStore.getState().cancelExport(job.id).catch(fail)}>
        <CircleMinus size={12} />
      </Button>}
      {job?.phase === "import_failed" && <Button variant="primary" size="sm" title="重试入库" aria-label={`重试入库 ${title}`}
        onClick={() => void api.importWorkshopExport(job.id).then(snapshot => useWorkshopStore.getState().accept(snapshot)).catch(fail)}>
        <RotateCcw size={11} />入库
      </Button>}
      {job?.path && !running && <Button variant="ghost" size="sm" iconOnly title={`打开所在文件夹：${job.path}`} aria-label={`打开所在文件夹 ${title}`}
        onClick={() => void getBridge().revealPath(job.path).catch(fail)}><FolderOpen size={12} /></Button>}
    </>}>
    {!history && job?.detail && <div className="kd-export-task-detail">{job.detail}</div>}
    {job?.error && <div className="kd-download-task-error" role="status">{job.error}</div>}
  </QueueEntry>;
}

/** Queue and completed exports are read-only views of the same task sources. */
export function ExportQueuePanel({ history = false, position }: { history?: boolean; position: QueueListPosition }) {
  const projects = useWorkshopStore(state => state.projects);
  const jobs = useWorkshopStore(state => state.jobs);
  const batchSubmitting = useWorkshopStore(state => state.batchSubmitting);
  const error = useWorkshopStore(state => state.error);
  const visualizerTasks = useVisualizerExportStore(state => state.tasks);
  const visualizerError = useVisualizerExportStore(state => state.error);
  const [canceling, setCanceling] = useState(false);
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const currentJobs = new Map<string, WorkshopJob>();
  for (const job of jobs) {
    if (job.revision === projectsById.get(job.project_id)?.revision) currentJobs.set(job.project_id, job);
  }
  const activeProjects = new Set(jobs.filter(active).map(job => job.project_id));
  // Superseded failures must not become extra runnable rows for the same project.
  // Editing an exported project makes its new revision eligible again.
  const pending = history ? [] : projects.filter(project => !activeProjects.has(project.id) && !exported(currentJobs.get(project.id)));
  const visibleJobs = jobs.filter(history ? exported : active);
  const visibleVisualizerTasks = visualizerTasks.filter(task => (task.phase === "done") === history);
  const startableIds = pending.filter(project => projectDuration(project) > 0).map(project => project.id);
  const workingCount = visibleJobs.filter(job => active(job) && job.phase !== "queued").length
    + visibleVisualizerTasks.filter(task => visualizerExportActive(task) && task.phase !== "queued").length;
  const pendingCount = pending.filter(project => currentJobs.get(project.id)?.phase !== "failed").length
    + visibleJobs.filter(job => job.phase === "queued").length
    + visibleVisualizerTasks.filter(task => ["ready", "queued", "canceled"].includes(task.phase)).length;
  const failedCount = pending.filter(project => currentJobs.get(project.id)?.phase === "failed").length
    + visibleVisualizerTasks.filter(task => task.phase === "failed").length;
  const facts = [
    { count: workingCount, label: "进行中", tone: "running" },
    { count: pendingCount, label: "待开始", tone: "queued" },
    { count: failedCount, label: "失败", tone: "failed" },
  ].filter(fact => fact.count > 0);
  const finishedCount = history ? visibleJobs.length + visibleVisualizerTasks.length : 0;
  const canStart = !batchSubmitting && !canceling && (startableIds.length > 0 || visibleVisualizerTasks.some(visualizerExportStartable));
  const canCancel = !canceling && (batchSubmitting || visibleJobs.some(cancelable) || visibleVisualizerTasks.some(visualizerExportActive));
  return <QueueFrame className="kd-export-page">
    {!history && <section className="kd-download-prefs" aria-label="导出队列概览"><QueueOverview facts={facts} total={pending.length + visibleJobs.length + visibleVisualizerTasks.length} canStart={canStart}
      startTitle="开始待导出任务并重试失败任务" onStart={() => {
        if (visibleVisualizerTasks.some(visualizerExportStartable)) useVisualizerExportStore.getState().start();
        void useWorkshopStore.getState().exportAll(undefined, startableIds).catch(fail);
      }}
      canSecondary={canCancel} secondaryKind="cancel" secondaryLabel={canceling ? "正在取消" : "取消"}
      secondaryTitle="取消全部未完成的导出" onSecondary={() => {
        setCanceling(true);
        void Promise.allSettled([
          useWorkshopStore.getState().cancelAllExports(),
          ...(visibleVisualizerTasks.some(visualizerExportActive) ? [useVisualizerExportStore.getState().cancel()] : []),
        ]).then(results => {
          const errors = results.filter(result => result.status === "rejected");
          if (errors.length) fail(errors.map(result => String(result.reason)).join("；"));
        }).finally(() => setCanceling(false));
      }} /></section>}
    {/* The finished page opens with its count where the other pages have their overview, so the
        first row starts at the same height on all four. */}
    {history && <section className="kd-download-prefs kd-download-overview" aria-label="导出成品概览">
      <div className="kd-download-summary" aria-live="polite">
        {finishedCount > 0 && <span className="kd-download-summary-fact" data-tone="finished">
          <strong>{finishedCount}</strong><span>成品</span>
        </span>}
      </div>
    </section>}
    <InlineNotice text={error} onDismiss={() => useWorkshopStore.setState({ error: "" })} block />
    <InlineNotice text={visualizerError} onDismiss={() => useVisualizerExportStore.setState({ error: "" })} block />
    <QueueTaskList count={pending.length + visibleJobs.length + visibleVisualizerTasks.length} position={position}
      getKey={index => index < pending.length ? `project:${pending[index].id}`
        : index < pending.length + visibleJobs.length ? `job:${visibleJobs[index - pending.length].id}`
        : `visualizer:${visibleVisualizerTasks[index - pending.length - visibleJobs.length].id}`}>
      {index => {
        if (index < pending.length) {
          const project = pending[index];
          return <WorkshopExportRow project={project} job={currentJobs.get(project.id)}
            order={index + 1} canStart={startableIds.includes(project.id)} />;
        }
        if (index < pending.length + visibleJobs.length) {
          const job = visibleJobs[index - pending.length];
          return <WorkshopExportRow job={job} project={projectsById.get(job.project_id)}
            order={index + 1} canStart={false} history={history} />;
        }
        return <VisualizerExportRow task={visibleVisualizerTasks[index - pending.length - visibleJobs.length]} order={index + 1} />;
      }}
    </QueueTaskList>
  </QueueFrame>;
}
