import { createElement } from "react";
import { Clapperboard, FolderInput } from "lucide-react";
import { folderName } from "../../lib/format";
import { useSidePanels } from "../../lib/sidePanels";
import { useDownloadStore } from "../../stores/downloadStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useTaskPanelStore, type TaskPanelView } from "../../stores/taskPanelStore";
import { useVisualizerExportStore } from "../../stores/visualizerExportStore";
import { useWorkshopStore } from "../../stores/workshopStore";
import { createBatchReporter, type BatchMember } from "./taskBatch";
import { dismissTask, showTask } from "./taskBubbleStore";
import { downloadTaskCover, projectTaskCovers, visualizerTaskCover } from "./taskCovers";

/**
 * The app's own activities that report as task bubbles without a call from the code that
 * starts them: each watches the store the activity already lives in. `downloads` and `exports`
 * report a start, the progress while the bubble is up, and the end; `imports` reports the end.
 */
export type TaskSource = "downloads" | "exports" | "imports";

const openTasks = (view: TaskPanelView) => {
  useTaskPanelStore.getState().setView(view);
  useSidePanels.getState().setDownloads(true);
};
const tasksShow = (...views: TaskPanelView[]) =>
  useSidePanels.getState().downloads && views.includes(useTaskPanelStore.getState().view);

const DOWNLOAD_ACTIVE = new Set(["queued", "running", "processing"]);

function watchDownloads(): () => void {
  const since = Date.now() / 1000 - 3;
  const states = new Map<string, string>();
  const reporter = createBatchReporter({
    id: "downloads", kind: "download", unit: "首",
    started: "开始下载", running: "下载中", finished: "下载完成", failed: "下载失败",
    listed: () => tasksShow("downloads"),
    open: finished => openTasks(finished ? "history" : "downloads"),
  });
  const read = () => {
    const { tasks, history } = useDownloadStore.getState();
    const members: BatchMember[] = [];
    const add = (task: (typeof history)[number]) => {
      if (task.id.startsWith("local:")) return;
      const before = states.get(task.id);
      const active = DOWNLOAD_ACTIVE.has(task.state);
      states.set(task.id, task.state);
      const cover = downloadTaskCover(task);
      members.push({
        key: task.id,
        title: task.artist ? `${task.title} · ${task.artist}` : task.title,
        covers: cover ? [cover] : [],
        state: active ? "active" : task.state === "done" ? "done" : task.state === "failed" ? "failed" : "gone",
        progress: task.progress,
        error: task.error,
        fresh: before === undefined ? task.created_at >= since : !DOWNLOAD_ACTIVE.has(before),
      });
    };
    tasks.forEach(add);
    // A finished download has left the queue for the history.
    for (const task of history) if (states.has(task.id) && !tasks.has(task.id)) add(task);
    reporter.report(members);
  };
  const stop = useDownloadStore.subscribe((state, before) => {
    if (state.tasks !== before.tasks || state.history !== before.history) read();
  });
  return () => { stop(); reporter.stop(); };
}

const WORKSHOP_ACTIVE = new Set(["queued", "rendering", "validating", "committing", "importing"]);
const VISUALIZER_ACTIVE = new Set(["queued", "preparing", "encoding", "validating"]);

function watchExports(): () => void {
  const since = Date.now() - 3_000;
  const phases = new Map<string, string>();
  // The mixing jobs that come with the first snapshot were started before this window looked.
  let loaded = false;
  const reporter = createBatchReporter({
    id: "exports", kind: "export", unit: "项",
    started: "开始导出", running: "导出中", finished: "导出完成", failed: "导出失败",
    icon: createElement(Clapperboard, { size: 16, "aria-hidden": true }),
    listed: () => tasksShow("exports"),
    open: finished => openTasks(finished ? "export-history" : "exports"),
  });
  const read = () => {
    const { jobs, projects, session } = useWorkshopStore.getState();
    const visualizer = useVisualizerExportStore.getState().tasks;
    const members: BatchMember[] = [];
    const found = !loaded;
    if (session) loaded = true;
    for (const job of jobs) {
      const key = `mix:${job.id}`;
      const before = phases.get(key);
      const active = WORKSHOP_ACTIVE.has(job.phase);
      phases.set(key, job.phase);
      const project = projects.find(candidate => candidate.id === job.project_id);
      members.push({
        key,
        title: project?.name || folderName(job.path) || "VJ 剪辑",
        covers: projectTaskCovers(project),
        state: active ? "active" : job.phase === "complete" ? "done"
          : job.phase === "failed" || job.phase === "import_failed" ? "failed" : "gone",
        progress: job.phase === "queued" ? 0 : job.progress,
        error: job.error,
        fresh: before === undefined ? !found : !WORKSHOP_ACTIVE.has(before),
      });
    }
    for (const task of visualizer) {
      const key = `picture:${task.id}`;
      const before = phases.get(key);
      const added = before === undefined && task.createdAt >= since;
      phases.set(key, task.phase);
      const cover = visualizerTaskCover(task);
      // Added to the queue but not started: say so once, as the queue's own bubble.
      if (added && task.phase === "ready" && !tasksShow("exports")) {
        showTask({ id: "exports", kind: "export", title: task.name, detail: "已加入导出队列",
          covers: cover ? [cover] : [], icon: createElement(Clapperboard, { size: 16, "aria-hidden": true }),
          onOpen: () => openTasks("exports") });
      }
      members.push({
        key,
        title: task.name,
        covers: cover ? [cover] : [],
        state: VISUALIZER_ACTIVE.has(task.phase) ? "active" : task.phase === "done" ? "done"
          : task.phase === "failed" ? "failed" : "gone",
        progress: task.progress,
        error: task.error,
        fresh: before === undefined ? task.createdAt >= since : !VISUALIZER_ACTIVE.has(before),
      });
    }
    reporter.report(members);
  };
  read();
  const stops = [
    useWorkshopStore.subscribe((state, before) => { if (state.jobs !== before.jobs) read(); }),
    useVisualizerExportStore.subscribe((state, before) => { if (state.tasks !== before.tasks) read(); }),
  ];
  return () => { stops.forEach(stop => stop()); reporter.stop(); };
}

function watchImports(): () => void {
  return useLibraryStore.subscribe((state, before) => {
    const scan = state.scan, earlier = before.scan;
    // Only an import this window watched running: a finished one replayed on reconnect is old.
    if (!scan || scan === earlier || scan.phase !== "done" || !earlier || earlier.job_id !== scan.job_id || earlier.phase === "done") return;
    if (scan.cancelled) { dismissTask("import"); return; }
    showTask(scan.error
      ? { id: "import", kind: "import", tone: "error", title: "导入失败", detail: scan.error }
      : { id: "import", kind: "import", tone: "success", title: "导入完成", detail: `${scan.total} 个文件`,
        icon: createElement(FolderInput, { size: 16, "aria-hidden": true }) });
  });
}

/** Start reporting these activities; the returned function stops it. */
export function startTaskSources(sources: readonly TaskSource[]): () => void {
  const stops = sources.map(source => source === "downloads" ? watchDownloads() : source === "exports" ? watchExports() : watchImports());
  return () => stops.forEach(stop => stop());
}
