/**
 * 下载队列。数据源有两个：启动时的 GET /downloads，以及 WS 的
 * `download.list` / `download.updated`。两者都走合并，任务以 id 为准。
 *
 * 注意：`download.list` **不能整表替换丢掉本地字段**——前端会给拖进文件夹
 * 的任务盖上 dest_dir；快照若直接覆盖，待下载行和目标文件夹记忆就会
 * 「加一条忘一条」。
 */

import { create } from "zustand";
import { api } from "../lib/api";
import { isSparseDownloadTitle, withDownloadDisplay } from "../lib/downloadDisplay";
import { forgetQueueDraft, rememberVideoEnqueue } from "../lib/queueTaskDraft";
import { sortDownloadTasks } from "../lib/downloadOrder";
import {
  hintForDownload,
  pruneDownloadDisplayCache,
  rememberDownloadDisplays,
  syncDownloadDisplayCache,
} from "../lib/downloadDisplayCache";
import type {
  DownloadRequest,
  DownloadTask,
  Quality,
  SongSource,
  WsEvent,
} from "../types";

const ACTIVE_STATES = new Set(["queued", "running", "processing"]);
/** 成功项只是一条完成通知，不属于待办队列；失败/取消仍保留，方便重试或确认。 */
const belongsInQueue = (task: DownloadTask): boolean => task.state !== "done";
/** 挡住完成事件之后迟到的旧进度、入队 HTTP 响应或旧队列快照。 */
const completedTaskIds = new Set<string>();
const MAX_COMPLETED_TOMBSTONES = 512;
/** 兼容仍在运行的旧后端：queued 取消会回一条 canceled，前端必须把它挡掉。 */
const removedQueuedTasks = new Set<string>();

function rememberCompletedTask(taskId: string): void {
  completedTaskIds.delete(taskId);
  completedTaskIds.add(taskId);
  while (completedTaskIds.size > MAX_COMPLETED_TOMBSTONES) {
    const oldest = completedTaskIds.values().next().value;
    if (oldest === undefined) break;
    completedTaskIds.delete(oldest);
  }
}

function prepareAuthorizingTask(task: DownloadTask): void {
  if (task.state !== "running" || task.phase !== "authorizing") return;
  void api.preparePendingDownloads(task.id).catch((error) => {
    console.warn("下载来源准备失败", error);
  });
}

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
  const list = sortDownloadTasks(tasks.values());
  let activeCount = 0;
  for (const task of list) if (ACTIVE_STATES.has(task.state)) activeCount += 1;
  return { list, activeCount };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 服务端快照常不带 dest_dir / cover，标题也可能还是 BV 占位。
 * 合并顺序：服务端 → 内存里上一版 → localStorage 备份（扛得住整页刷新）。
 */
function mergeTask(prev: DownloadTask | undefined, next: DownloadTask): DownloadTask {
  const cached = hintForDownload(next.id);
  const fromPrev = withDownloadDisplay(next, {
    title: prev?.title,
    artist: prev?.artist,
    cover: prev?.cover,
    dest_dir: prev?.dest_dir,
  });
  const merged = withDownloadDisplay(fromPrev, cached ?? {});
  // 服务端已经解析出真标题时，别被缓存里的旧 BV 盖回去
  if (!isSparseDownloadTitle(next.title) && merged.title !== next.title) {
    return { ...merged, title: next.title };
  }
  return merged;
}

function commitTasks(map: Map<string, DownloadTask>): void {
  syncDownloadDisplayCache(map.values());
}

/**
 * 用服务端整份列表对齐本地：保留仍在飞的 local: 乐观占位，并保住 dest_dir。
 * 不再 `new Map(payload)` 一把换掉——那会把刚盖上的目标文件夹冲掉。
 */
function applyServerList(
  prev: Map<string, DownloadTask>,
  payload: DownloadTask[],
): Map<string, DownloadTask> {
  const map = new Map<string, DownloadTask>();
  for (const task of payload) {
    if (removedQueuedTasks.has(task.id)) continue;
    if (!belongsInQueue(task)) {
      rememberCompletedTask(task.id);
      forgetQueueDraft(task.id);
      continue;
    }
    if (completedTaskIds.has(task.id)) continue;
    map.set(task.id, mergeTask(prev.get(task.id), task));
  }
  for (const [id, task] of prev) {
    if (id.startsWith("local:") && !map.has(id)) map.set(id, task);
  }
  return map;
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
    options?: {
      quality?: Quality | null;
      analyze?: boolean | null;
      dest_dir?: string;
    },
  ): Promise<DownloadTask[]>;
  cancel(taskId: string): Promise<void>;
  cancelAll(): Promise<void>;
  pauseAll(): Promise<void>;
  retry(taskId: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  clear(): Promise<void>;
  /** 视频下载等"接口直接返回任务"的场景，先本地插一条，等 WS 覆盖。 */
  mergeTasks(tasks: DownloadTask[]): void;
  /** 去掉本地乐观占位（`local:` 前缀那些），真任务进来后用。 */
  removeLocal(taskId: string): void;
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
      const map = applyServerList(get().tasks, tasks);
      commitTasks(map);
      set({ tasks: map, ...derive(map), loading: false, error: "" });
      map.forEach(prepareAuthorizingTask);
    } catch (error) {
      set({ loading: false, error: errorText(error) });
    }
  },

  async enqueue(sources, options) {
    if (sources.length === 0) return [];
    const destDir = options?.dest_dir?.trim() || "";
    const body: DownloadRequest = {
      sources,
      quality: options?.quality ?? null,
      analyze: options?.analyze ?? null,
      dest_dir: destDir || undefined,
    };
    const tasks = await api.enqueue(body);
    tasks.forEach((task, index) => {
      const source = sources[index];
      if (
        task.kind !== "video" ||
        (source?.platform !== "youtube" && source?.platform !== "bilibili")
      ) return;
      rememberVideoEnqueue(task.id, {
        platform: source.platform,
        bvid: source.key,
        page_index: Number(source.payload.page_index) || 0,
        page_count: Number(source.payload.page_count) || 0,
        page_title:
          typeof source.payload.page_title === "string" ? source.payload.page_title : undefined,
        max_height: Number(source.payload.max_height) || 1080,
        audio_only: Boolean(source.payload.audio_only),
        transcode: Boolean(source.payload.transcode),
        title: source.title,
        artist: source.artists.join(", "),
        cover: source.cover,
        dest_dir: destDir || undefined,
      });
    });
    // 旧后端可能不回 dest_dir；本地盖上，左表待下载行才能对上文件夹。
    const stamped = destDir
      ? tasks.map((task) => ({ ...task, dest_dir: task.dest_dir || destDir }))
      : tasks;
    get().mergeTasks(stamped);
    const autoStart = (await import("./appStore")).useAppStore.getState().settings
      ?.auto_start_downloads;
    if (autoStart) {
      // 入队和播放授权是两件事：先把 queued 行交给统一下载管理并立即返回，
      // 再在后台运行平台注册的来源准备适配器。以前 await 在这里，调用方要等“解析”完
      // 才打开下载栏，看起来像根本没入队；QQ/网易云却立即出现，行为完全不一致。
      void api.preparePendingDownloads().catch((error) => {
        console.warn("下载来源准备失败", error);
      });
    }
    return stamped;
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

  async cancelAll() {
    const ids = get().list
      .filter((task) => ACTIVE_STATES.has(task.state))
      .map((task) => task.id);
    if (ids.length === 0) return;
    await api.cancelAllDownloads();
    ids.forEach(forgetQueueDraft);
    await get().refresh();
  },

  async pauseAll() {
    await api.pauseDownloads();
    // 暂停保留每条任务和改单曲质量草稿；完整快照负责把 queued/running
    // 一次性收敛为 paused，避免逐条事件抵达时按钮短暂反复切换。
    await get().refresh();
  },

  async retry(taskId) {
    const task = await api.retryDownload(taskId);
    get().mergeTasks([task]);
  },

  async remove(taskId) {
    await api.removeDownload(taskId);
    const map = new Map(get().tasks);
    map.delete(taskId);
    set({ tasks: map, ...derive(map) });
  },

  async clear() {
    await api.clearDownloads();
    // 后端清掉未开始和已结束任务，进行中的留着，所以这里重新拉一次而不是本地清空。
    await get().refresh();
  },

  mergeTasks(tasks) {
    if (tasks.length === 0) return;
    const map = new Map(get().tasks);
    let sawCompletedTask = false;
    for (const task of tasks) {
      if (!belongsInQueue(task)) {
        sawCompletedTask = true;
        rememberCompletedTask(task.id);
        map.delete(task.id);
        forgetQueueDraft(task.id);
        continue;
      }
      if (completedTaskIds.has(task.id)) continue;
      const merged = mergeTask(map.get(task.id), task);
      map.set(task.id, merged);
    }
    if (sawCompletedTask) pruneDownloadDisplayCache(map.keys());
    rememberDownloadDisplays(
      tasks
        .map((task) => map.get(task.id))
        .filter((task): task is DownloadTask => Boolean(task)),
    );
    set({ tasks: map, ...derive(map) });
    tasks
      .map((task) => map.get(task.id))
      .filter((task): task is DownloadTask => Boolean(task))
      .forEach(prepareAuthorizingTask);
  },

  removeLocal(taskId) {
    const map = new Map(get().tasks);
    if (!map.delete(taskId)) return;
    pruneDownloadDisplayCache(map.keys());
    set({ tasks: map, ...derive(map) });
  },

  handleEvent(event) {
    if (event.type === "download.updated") {
      if (removedQueuedTasks.has(event.payload.id)) return;
      get().mergeTasks([event.payload]);
      return;
    }
    if (event.type === "download.list") {
      const map = applyServerList(get().tasks, event.payload);
      commitTasks(map);
      set({ tasks: map, ...derive(map), error: "" });
      map.forEach(prepareAuthorizingTask);
    }
  },
}));
