/**
 * 下载队列。数据源有两个：启动时的 GET /downloads，以及 WS 的
 * `download.list` / `download.updated`。两者都走 mergeTasks 合并，任务以 id 为准。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import type { DownloadRequest, DownloadTask, Quality, SongSource, WsEvent } from "../types";

const ACTIVE_STATES = new Set(["queued", "running"]);
/** 兼容仍在运行的旧后端：queued 取消会回一条 canceled，前端必须把它挡掉。 */
const removedQueuedTasks = new Set<string>();

interface Derived {
  list: DownloadTask[];
  activeCount: number;
}

/**
 * Map 是权威存储（按 id 覆盖最省事），但组件要的是稳定的数组。
 * 每次变更时算一份派生结果存进 state —— 若放在 selector 里算，
 * zustand v5 每次 render 都会拿到新数组引用，直接触发无限重渲染。
 */
function derive(tasks: Map<string, DownloadTask>): Derived {
  const list = [...tasks.values()].sort(
    (a, b) => b.created_at - a.created_at || b.updated_at - a.updated_at || a.id.localeCompare(b.id),
  );
  let activeCount = 0;
  for (const task of list) if (ACTIVE_STATES.has(task.state)) activeCount += 1;
  return { list, activeCount };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DownloadStore {
  tasks: Map<string, DownloadTask>;
  list: DownloadTask[];
  activeCount: number;
  loading: boolean;
  error: string;

  refresh(): Promise<void>;
  enqueue(
    sources: SongSource[],
    options?: { quality?: Quality | null; analyze?: boolean | null },
  ): Promise<DownloadTask[]>;
  cancel(taskId: string): Promise<void>;
  clear(): Promise<void>;
  /** 视频下载等"接口直接返回任务"的场景，先本地插一条，等 WS 覆盖。 */
  mergeTasks(tasks: DownloadTask[]): void;
  handleEvent(event: WsEvent): void;
}

export const useDownloadStore = create<DownloadStore>()((set, get) => ({
  tasks: new Map(),
  list: [],
  activeCount: 0,
  loading: false,
  error: "",

  async refresh() {
    set({ loading: true });
    try {
      const tasks = await api.downloads();
      const map = new Map(
        tasks.filter((task) => !removedQueuedTasks.has(task.id)).map((task) => [task.id, task]),
      );
      set({ tasks: map, ...derive(map), loading: false, error: "" });
    } catch (error) {
      set({ loading: false, error: errorText(error) });
    }
  },

  async enqueue(sources, options) {
    if (sources.length === 0) return [];
    const body: DownloadRequest = {
      sources,
      quality: options?.quality ?? null,
      analyze: options?.analyze ?? null,
    };
    const tasks = await api.enqueue(body);
    get().mergeTasks(tasks);
    return tasks;
  },

  async cancel(taskId) {
    const wasQueued = get().tasks.get(taskId)?.state === "queued";
    if (wasQueued) removedQueuedTasks.add(taskId);
    let task: DownloadTask;
    try {
      task = await api.cancelDownload(taskId);
    } catch (error) {
      if (wasQueued) removedQueuedTasks.delete(taskId);
      throw error;
    }
    if (wasQueued) {
      const map = new Map(get().tasks);
      map.delete(taskId);
      set({ tasks: map, ...derive(map) });
      return;
    }
    get().mergeTasks([task]);
  },

  async clear() {
    await api.clearDownloads();
    // 后端清掉的是已结束的任务，进行中的留着，所以这里重新拉一次而不是本地清空。
    await get().refresh();
  },

  mergeTasks(tasks) {
    if (tasks.length === 0) return;
    const map = new Map(get().tasks);
    for (const task of tasks) map.set(task.id, task);
    set({ tasks: map, ...derive(map) });
  },

  handleEvent(event) {
    if (event.type === "download.updated") {
      if (removedQueuedTasks.has(event.payload.id)) return;
      get().mergeTasks([event.payload]);
      return;
    }
    if (event.type === "download.list") {
      const map = new Map(
        event.payload
          .filter((task) => !removedQueuedTasks.has(task.id))
          .map((task) => [task.id, task]),
      );
      set({ tasks: map, ...derive(map), error: "" });
    }
  },
}));
