import { create } from "zustand";
import { validateVisualizerProject, type VisualizerDraft } from "../lib/visualizerStudio";
import { deleteVisualizerExport, loadVisualizerExports, loadVisualizerExportSnapshot, saveVisualizerExport,
  visualizerExportActive, visualizerExportStartable, type VisualizerExportTask } from "../lib/visualizerExportQueue";
import { waitForSettingsWrites } from "../lib/settingsWriteBarrier";
import { useAppStore } from "./appStore";

interface State {
  tasks: VisualizerExportTask[];
  error: string;
  initialize(): Promise<void>;
  enqueue(draft: VisualizerDraft): Promise<void>;
  start(id?: string): void;
  cancel(id?: string): Promise<void>;
  remove(id: string): Promise<void>;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
let initializing: Promise<void> | undefined;
let worker: { id: string; controller: AbortController } | undefined;
let pumping = false;
let writes = Promise.resolve();
const reservedPaths = new Set<string>();
function persist(task: VisualizerExportTask): Promise<void> {
  const write = writes.catch(() => undefined).then(() => saveVisualizerExport(task));
  writes = write;
  return write;
}
function update(id: string, patch: Partial<VisualizerExportTask>): VisualizerExportTask | undefined {
  let result: VisualizerExportTask | undefined;
  useVisualizerExportStore.setState(state => ({ tasks: state.tasks.map(task => {
    if (task.id !== id) return task;
    result = { ...task, ...patch }; return result;
  }) }));
  return result;
}
function report(error: unknown) { useVisualizerExportStore.setState({ error: message(error) }); }

/** One frame producer at a time, independent of editor/component lifetimes.
 * The backend still arbitrates encoder resources with mixing exports. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let leavingApp = false;
  try {
    while (!leavingApp) {
      const task = useVisualizerExportStore.getState().tasks.find(task => task.phase === "queued");
      if (!task) return;
      const controller = new AbortController(); worker = { id: task.id, controller };
      const leaving = () => { leavingApp = true; controller.abort(); };
      window.addEventListener("pagehide", leaving);
      try {
        const preparing = update(task.id, { phase: "preparing", status: "正在准备画面", error: "", progress: 0 })!;
        await persist(preparing);
        const draft = await loadVisualizerExportSnapshot(task.id);
        const { runStudioExport } = await import("../lib/visualizerStudioExport");
        controller.signal.throwIfAborted();
        const final = await runStudioExport(draft, task.outputPath, controller.signal, status => {
          if (!["done", "failed", "canceled"].includes(status.phase)) {
            update(task.id, { phase: status.phase, progress: status.progress, status: status.status });
          }
        });
        update(task.id, { phase: final.phase, progress: final.progress, status: final.status,
          error: final.error, outputPath: final.output_path || task.outputPath });
      } catch (error) {
        const canceled = error instanceof DOMException && error.name === "AbortError";
        update(task.id, { phase: canceled ? "canceled" : "failed", status: canceled ? "已取消" : "导出失败", error: canceled ? "" : message(error) });
      } finally {
        window.removeEventListener("pagehide", leaving);
        const final = useVisualizerExportStore.getState().tasks.find(t => t.id === task.id);
        if (final) await persist(final).catch(report);
        worker = undefined;
      }
    }
  } finally { pumping = false; }
}

export const useVisualizerExportStore = create<State>((set, get) => ({
  tasks: [], error: "",
  initialize() {
    if (!initializing) initializing = loadVisualizerExports().then(tasks => {
      // Never silently resume frame production after a WebView/app restart.
      set({ tasks: tasks.sort((a, b) => a.createdAt - b.createdAt).map(task => visualizerExportActive(task)
        ? { ...task, phase: "ready", progress: 0, status: "上次导出已中断", error: "" } : task) });
    }).catch(error => { initializing = undefined; report(error); throw error; });
    return initializing;
  },
  async enqueue(draft) {
    // Freeze before the first await: the editor can immediately continue editing.
    const snapshot = { project: structuredClone(draft.project), images: [...draft.images] };
    validateVisualizerProject(snapshot.project);
    const requestedName = snapshot.project.output.filename.trim();
    if (!requestedName.toLowerCase().endsWith(".mp4") || /[<>:"/\\|?*\u0000-\u001f]/.test(requestedName) || requestedName.length > 160) throw new Error("请填写有效的 MP4 文件名（不能包含目录分隔符）");
    if (!snapshot.images.length) throw new Error("请先添加图片");
    await get().initialize();
    await waitForSettingsWrites();
    const directory = useAppStore.getState().settings?.download_dir?.trim() || "";
    if (!directory) throw new Error("请先在设置中配置下载目录");
    const sep = directory.includes("\\") ? "\\" : "/";
    const path = (name: string) => directory.replace(/[\\/]+$/, "") + sep + name;
    let filename = requestedName, suffix = 2;
    // Multiple snapshots of one song must not compete for the same destination.
    while (reservedPaths.has(path(filename).toLowerCase()) || get().tasks.some(task => task.outputPath.toLowerCase() === path(filename).toLowerCase())) {
      filename = requestedName.slice(0, -4).slice(0, 140) + ` (${suffix++}).mp4`;
    }
    const task: VisualizerExportTask = { id: crypto.randomUUID(), name: snapshot.project.text.title || snapshot.project.track.title || filename,
      filename, outputPath: path(filename), width: snapshot.project.scene.canvas.width, height: snapshot.project.scene.canvas.height,
      fps: snapshot.project.output.fps, phase: "ready", progress: 0, status: "待导出", error: "", createdAt: Date.now() };
    // Reserve the name synchronously, but don't expose an exportable task until
    // its image bytes and project snapshot have committed successfully.
    snapshot.project.output.filename = filename;
    reservedPaths.add(task.outputPath.toLowerCase());
    try {
      await saveVisualizerExport(task, snapshot);
      set(state => ({ tasks: [...state.tasks, task] }));
    } finally { reservedPaths.delete(task.outputPath.toLowerCase()); }
  },
  start(id) {
    set(state => ({ tasks: state.tasks.map(task => (!id || task.id === id) && visualizerExportStartable(task)
      ? { ...task, phase: "queued", progress: 0, status: "等待导出", error: "" } : task) }));
    void pump().catch(report);
  },
  async cancel(id) {
    const tasks = get().tasks.filter(task => (!id || task.id === id) && visualizerExportActive(task));
    // Remove all waiting work before aborting the producer; it must not start
    // another task while a batch cancellation is awaiting persistence.
    for (const task of tasks) {
      if (worker?.id === task.id) { worker.controller.abort(); update(task.id, { status: "正在取消" }); }
      else update(task.id, { phase: "canceled", status: "已取消", progress: 0, error: "" });
    }
    await Promise.all(tasks.filter(task => worker?.id !== task.id).map(task => {
      const current = get().tasks.find(t => t.id === task.id)!;
      return persist(current);
    })).catch(report);
  },
  async remove(id) {
    const task = get().tasks.find(t => t.id === id);
    if (!task || visualizerExportActive(task) || worker?.id === id) return;
    // Remove from the runnable list before awaiting IO; export/delete clicks
    // must never race a producer against deletion of its frozen snapshot.
    set(state => ({ tasks: state.tasks.filter(task => task.id !== id) }));
    reservedPaths.add(task.outputPath.toLowerCase());
    try {
      await writes.catch(() => undefined);
      await deleteVisualizerExport(id);
    } catch (error) {
      set(state => ({ tasks: [...state.tasks, task].sort((a, b) => a.createdAt - b.createdAt) }));
      report(error);
    } finally { reservedPaths.delete(task.outputPath.toLowerCase()); }
  },
}));
