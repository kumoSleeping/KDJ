import { mediaProductionAvailable } from "../lib/platformFeatures";
import { create } from "zustand";
import { captureDiagnostic } from "../lib/diagnostics";
import type { ExportOptions } from "../lib/lanes";
import { exportProjectSound, runProjectExport } from "../lib/projectExport";
import { deleteProjectExport, loadProjectExports, projectExportActive, projectExportStartable, saveProjectExport,
  type ProjectExportTask } from "../lib/projectExportQueue";

/**
 * The export queue's 剪辑 tasks: `.kdjv` projects written out beside themselves, one at a time
 * (projectExport.ts: the server mixes the sound and muxes, this window draws and encodes the
 * picture). Every export of a project goes through here — the editor's 导出 and the library's
 * 导出 MP4 — so each one is listed in 下载 → 导出 and can be paused there (its job is canceled).
 * A project written while its export runs in a way that changes it stops it at once (the server
 * watches the file); it is not made again by itself. The window draws the frames, so an export
 * does not outlive it: one left running when the window went away waits to be started again.
 */
interface State {
  tasks: ProjectExportTask[];
  error: string;
  initialize(): Promise<void>;
  enqueue(track: { id: number; title: string; filename: string; path: string }, options?: ExportOptions): Promise<void>;
  start(id?: string): void;
  pause(id?: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** The server's word on the sound of a running task (`kdjv.progress` with `export`). */
  progress(id: string, progress: number, detail: string): void;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** What an export makes, in short, for its row. */
function describe(options?: ExportOptions): string {
  if (options?.audio_only) return options.from !== undefined || options.to !== undefined ? "WAV · 片段" : "WAV";
  return ["MP4", options?.width && options.height ? `${options.width} × ${options.height}` : "",
    options?.fps ? `${options.fps} fps` : "", options?.from !== undefined || options?.to !== undefined ? "片段" : ""]
    .filter(Boolean).join(" · ");
}

let initializing: Promise<void> | undefined;
let running: { id: string; finished: Promise<void>; stop: AbortController; pausing: boolean } | undefined;
let pumping = false;
let writes = Promise.resolve();
const removals = new Map<string, Promise<void>>();
function persist(task: ProjectExportTask): Promise<void> {
  const write = writes.catch(() => undefined).then(() => saveProjectExport(task));
  writes = write;
  return write;
}
function update(id: string, patch: Partial<ProjectExportTask>): ProjectExportTask | undefined {
  let result: ProjectExportTask | undefined;
  useProjectExportStore.setState(state => ({ tasks: state.tasks.map(task => {
    if (task.id !== id) return task;
    result = { ...task, ...patch }; return result;
  }) }));
  return result;
}
function report(error: unknown) {
  captureDiagnostic("kdjv-export", "queue.persistence", error);
  useProjectExportStore.setState({ error: message(error) });
}

/** One export at a time: the server renders one anyway, and a waiting one can still be paused. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const task = useProjectExportStore.getState().tasks.find(task => task.phase === "queued");
      if (!task) return;
      let finish!: () => void;
      const current = running = { id: task.id, finished: new Promise<void>(resolve => { finish = resolve; }), stop: new AbortController(), pausing: false };
      try {
        const rendering = update(task.id, { phase: "rendering", progress: 0, status: "正在导出", error: "", changed: false, outputPath: "" });
        if (rendering) await persist(rendering).catch(report);
        if (task.options?.audio_only) {
          const path = await exportProjectSound(task.trackId, task.options);
          update(task.id, { phase: "done", progress: 1, status: "已导出", outputPath: path, folder: folderOf(path) });
          continue;
        }
        const final = await runProjectExport(task.trackId, task.options, current.stop.signal, status => {
          if (status.phase === "done" || status.phase === "failed" || status.phase === "canceled" || current.pausing) return;
          update(task.id, { progress: Math.max(0, Math.min(1, status.progress)), status: status.status || "正在导出" });
        });
        if (final.phase === "done") {
          update(task.id, { phase: "done", progress: 1, status: "已导出", outputPath: final.output_path, folder: folderOf(final.output_path) });
        } else if (final.code === "kdjv_project_changed") {
          update(task.id, { phase: "canceled", changed: true, progress: 0, status: "工程已改动，已停止", error: "" });
        } else if (final.phase === "canceled" || current.pausing) {
          update(task.id, { phase: "paused", progress: 0, status: "已暂停", error: "" });
        } else {
          captureDiagnostic("kdjv-export", "render", final.error, `track=${task.trackId}`);
          update(task.id, { phase: "failed", progress: 0, status: "导出失败", error: final.error || final.status });
        }
      } catch (error) {
        if (current.pausing || current.stop.signal.aborted) {
          update(task.id, { phase: "paused", progress: 0, status: "已暂停", error: "" });
        } else {
          captureDiagnostic("kdjv-export", "render", error, `track=${task.trackId}`);
          update(task.id, { phase: "failed", progress: 0, status: "导出失败", error: message(error) });
        }
      } finally {
        const final = useProjectExportStore.getState().tasks.find(t => t.id === task.id);
        if (final) await persist(final).catch(report);
        running = undefined;
        finish();
      }
    }
  } finally { pumping = false; }
}

export const useProjectExportStore = create<State>((set, get) => ({
  tasks: [], error: "",
  initialize() {
    if (!mediaProductionAvailable()) return Promise.resolve();
    if (!initializing) initializing = loadProjectExports().then(tasks => {
      const live = new Map(get().tasks.map(task => [task.id, task]));
      // An export left running when the window went away ended with it (this window drew its
      // frames): it waits to be started again, as the visualizer's do.
      const stored = tasks.filter(task => !live.has(task.id)).map(task => projectExportActive(task)
        ? { ...task, phase: "paused" as const, progress: 0, status: "上次导出已中断", error: "" } : task);
      set({ tasks: [...stored, ...live.values()].sort((a, b) => a.createdAt - b.createdAt) });
    }).catch(error => { initializing = undefined; report(error); throw error; });
    return initializing;
  },
  async enqueue(track, options) {
    if (!mediaProductionAvailable()) throw new Error("移动版不提供视频导出");
    await get().initialize().catch(() => undefined);
    const same = JSON.stringify(options ?? {});
    // A second press while the same export is still waiting or running adds nothing.
    if (get().tasks.some(task => task.trackId === track.id && projectExportActive(task) && JSON.stringify(task.options ?? {}) === same)) return;
    const task: ProjectExportTask = {
      id: crypto.randomUUID(), trackId: track.id, name: track.title || track.filename, folder: folderOf(track.path),
      format: describe(options), options, phase: "queued", progress: 0, status: "等待导出", error: "", outputPath: "",
      createdAt: Date.now(),
    };
    set(state => ({ tasks: [...state.tasks, task] }));
    await persist(task).catch(report);
    void pump().catch(report);
  },
  start(id) {
    set(state => ({ tasks: state.tasks.map(task => (!id || task.id === id) && !removals.has(task.id) && projectExportStartable(task)
      ? { ...task, phase: "queued", progress: 0, status: "等待导出", error: "", changed: false } : task) }));
    void pump().catch(report);
  },
  async pause(id) {
    const tasks = get().tasks.filter(task => (!id || task.id === id) && projectExportActive(task));
    // The waiting ones first: the running one must not hand over to one of them meanwhile.
    for (const task of tasks) if (running?.id !== task.id) update(task.id, { phase: "paused", progress: 0, status: "已暂停" });
    await Promise.all(tasks.filter(task => running?.id !== task.id).map(task => {
      const current = get().tasks.find(t => t.id === task.id);
      return current ? persist(current) : undefined;
    })).catch(report);
    const current = tasks.find(task => running?.id === task.id);
    if (!current) return;
    update(current.id, { status: "正在暂停" });
    // Its job is canceled (projectExport.ts), which marks it paused.
    const run = running;
    if (run?.id !== current.id) return;
    run.pausing = true;
    run.stop.abort();
    await run.finished;
  },
  async remove(id) {
    const existing = removals.get(id);
    if (existing) return existing;
    const removal = Promise.resolve().then(async () => {
      const task = get().tasks.find(t => t.id === id);
      if (!task) return;
      const finished = running?.id === id ? running.finished : undefined;
      if (projectExportActive(task)) await get().pause(id);
      await finished;
      set(state => ({ tasks: state.tasks.filter(task => task.id !== id) }));
      await writes.catch(() => undefined);
      // The record only: a file exported stays where it is.
      await deleteProjectExport(id);
    }).catch(error => { report(error); throw error; }).finally(() => { removals.delete(id); });
    removals.set(id, removal);
    return removal;
  },
  progress(id, progress, detail) {
    const task = get().tasks.find(t => t.id === id);
    if (task?.phase !== "rendering" || task.status === "正在暂停") return;
    update(id, { progress: Math.max(0, Math.min(1, progress)), status: detail || "正在导出" });
  },
}));
