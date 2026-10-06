import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleMinus, Download, FolderOpen, Music2, RotateCcw, Video } from "lucide-react";
import { api } from "../../lib/api";
import { getBridge } from "../../lib/bridge";
import { folderName, formatPercent } from "../../lib/format";
import { projectDuration } from "../../lib/workshop";
import { visualizerExportActive, visualizerExportStartable } from "../../lib/visualizerExportQueue";
import { useWorkshopStore } from "../../stores/workshopStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import type { CompositionProject, WorkshopJob } from "../../types/workshop";
import { Button, InlineNotice } from "../common";
import { QueueCover, QueueEntry, QueueFrame, QueueList, QueueOverview } from "../queue/QueuePrimitives";
import { VisualizerExportTasks } from "./VisualizerExportTasks";
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
  return <QueueEntry order={String(order)} title={title} subtitle="VJ 剪辑" state={state}
    status={job ? phases[job.phase] ?? job.phase : "待导出"}
    percent={rendering ? formatPercent(job.progress) : undefined} cover={<QueueCover artwork="" video={video} />}
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
    {rendering && <progress className="kd-export-task-progress" max={1} value={job.progress} aria-label={`${title} 导出进度`} />}
    {!history && job?.detail && <div className="kd-export-task-detail">{job.detail}</div>}
    {job?.error && <div className="kd-download-task-error" role="status">{job.error}</div>}
  </QueueEntry>;
}

/** Queue and completed exports are read-only views of the same task sources. */
export function ExportQueuePanel({ history = false }: { history?: boolean }) {
  const projects = useWorkshopStore(state => state.projects);
  const jobs = useWorkshopStore(state => state.jobs);
  const batchSubmitting = useWorkshopStore(state => state.batchSubmitting);
  const error = useWorkshopStore(state => state.error);
  const visualizerTasks = useVisualizerExportStore(state => state.tasks);
  const visualizerError = useVisualizerExportStore(state => state.error);
  const [canceling, setCanceling] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef({ queue: 0, history: 0 });
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollPositions.current[history ? "history" : "queue"];
  }, [history]);
  useEffect(() => {
    void useWorkshopStore.getState().refresh();
    void useVisualizerExportStore.getState().initialize().catch(() => undefined);
  }, []);
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
  const canStart = !batchSubmitting && !canceling && (startableIds.length > 0 || visibleVisualizerTasks.some(visualizerExportStartable));
  const canCancel = !canceling && (batchSubmitting || visibleJobs.some(cancelable) || visibleVisualizerTasks.some(visualizerExportActive));
  return <QueueFrame className="kd-export-page">
    {!history && <QueueOverview facts={facts} total={pending.length + visibleJobs.length + visibleVisualizerTasks.length} canStart={canStart}
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
      }} />}
    <InlineNotice text={error} onDismiss={() => useWorkshopStore.setState({ error: "" })} block />
    <InlineNotice text={visualizerError} onDismiss={() => useVisualizerExportStore.setState({ error: "" })} block />
    <QueueList ref={scrollRef} onScroll={event => {
      scrollPositions.current[history ? "history" : "queue"] = event.currentTarget.scrollTop;
    }}>
      {pending.map((project, index) => <WorkshopExportRow key={project.id} project={project} job={currentJobs.get(project.id)}
        order={index + 1} canStart={startableIds.includes(project.id)} />)}
      {visibleJobs.map((job, index) => <WorkshopExportRow key={job.id} job={job} project={projectsById.get(job.project_id)}
        order={pending.length + index + 1} canStart={false} history={history} />)}
      <VisualizerExportTasks heading={false} firstOrder={pending.length + visibleJobs.length + 1} tasks={visibleVisualizerTasks} />
    </QueueList>
  </QueueFrame>;
}
