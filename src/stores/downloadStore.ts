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
/** 挡住取消/清记录之后才抵达的旧事件，避免刚删掉的行又闪回来。 */
const removedTaskIds = new Set<string>();
const MAX_REMOVED_TOMBSTONES = 512;
let downloadRefreshSequence = 0;
let missingFilesSequence = 0;
let downloadListRevision = 0;

function rememberCompletedTask(taskId: string): void {
  completedTaskIds.delete(taskId);
  completedTaskIds.add(taskId);
  while (completedTaskIds.size > MAX_COMPLETED_TOMBSTONES) {
    const oldest = completedTaskIds.values().next().value;
    if (oldest === undefined) break;
    completedTaskIds.delete(oldest);
  }
}

function rememberRemovedTask(taskId: string): void {
  removedTaskIds.delete(taskId);
  removedTaskIds.add(taskId);
  while (removedTaskIds.size > MAX_REMOVED_TOMBSTONES) {
    const oldest = removedTaskIds.values().next().value;
    if (oldest === undefined) break;
    removedTaskIds.delete(oldest);
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
  // 这里再守一次边界：即使以后某条新合并路径漏掉完成态，组件也永远拿不到完成行。
  const list = sortDownloadTasks([...tasks.values()].filter(belongsInQueue));
  let activeCount = 0;
  for (const task of list) if (ACTIVE_STATES.has(task.state)) activeCount += 1;
  return { list, activeCount };
}

/** 已完成任务只进历史视图；不放进 list，曲库左表等消费者仍把 list 当待办。 */
function historyFrom(tasks: Iterable<DownloadTask>): DownloadTask[] {
  return sortDownloadTasks(
    [...tasks].filter((task) => task.state === "done" && !removedTaskIds.has(task.id)),
  );
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
    if (removedTaskIds.has(task.id)) continue;
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
  /** 已完成的下载记录，按入队顺序。 */
  history: DownloadTask[];
  /** 已完成但文件已不在原位置的任务 id；只由 checkMissingFiles 显式刷新。 */
  missingIds: ReadonlySet<string>;

  refresh(): Promise<void>;
  checkMissingFiles(): Promise<void>;
  enqueue(
    sources: SongSource[],
    options?: {
      quality?: Quality | null;
      analyze?: boolean | null;
      dest_dir?: string;
      follow_default_dir?: boolean;
    },
  ): Promise<DownloadTask[]>;
  cancel(taskId: string): Promise<void>;
  cancelAll(): Promise<void>;
  pauseAll(): Promise<void>;
  retry(taskId: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  /** 「历史」视图的清记录：只移除已完成和已取消的记录，不删除文件。 */
  clearHistory(): Promise<void>;
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
  history: [],
  missingIds: new Set(),

  async refresh() {
    const sequence = ++downloadRefreshSequence;
    const listRevision = downloadListRevision;
    const before = get().tasks;
    const beforeHistory = get().history;
    set({ loading: true });
    try {
      const tasks = await api.downloads();
      if (sequence !== downloadRefreshSequence) return;
      if (listRevision !== downloadListRevision) { set({ loading: false }); return; }
      const current = get().tasks;
      const map = applyServerList(current, tasks);
      // A newer WS event or enqueue response can land during this HTTP snapshot.
      // Preserve those changes; terminal/removed tombstones are already applied above.
      for (const [id, task] of current) {
        if (before.get(id) !== task && !removedTaskIds.has(id) && !completedTaskIds.has(id)) map.set(id, task);
      }
      // 同理：快照在途时完成的任务只经 download.updated 进了 history，快照里还是旧状态。
      const history = new Map(historyFrom(tasks).map((task) => [task.id, task]));
      for (const task of get().history) if (!beforeHistory.includes(task)) history.set(task.id, task);
      commitTasks(map);
      set({ tasks: map, ...derive(map), history: historyFrom(history.values()), loading: false, error: "" });
      map.forEach(prepareAuthorizingTask);
    } catch (error) {
      if (sequence !== downloadRefreshSequence) return;
      set({ loading: false, error: errorText(error) });
    }
  },

  async checkMissingFiles() {
    const sequence = ++missingFilesSequence;
    try {
      const ids = await api.missingDownloadFiles();
      // 连续聚焦会叠出多次扫描；只认最后一次发起的结果。
      if (sequence === missingFilesSequence) set({ missingIds: new Set(ids) });
    } catch (error) {
      // 旧后端没有这条路由时保持“不标记”，不能把所有记录误判成丢失。
      console.warn("检查下载文件失败", error);
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
      follow_default_dir: (destDir && options?.follow_default_dir) || undefined,
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
    if (wasQueued) rememberRemovedTask(taskId);
    let task: DownloadTask;
    try {
      task = await api.cancelDownload(taskId);
    } catch (error) {
      if (wasQueued) removedTaskIds.delete(taskId);
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
    // A new attempt no longer refers to the old missing file, including in-flight scans.
    missingFilesSequence += 1;
    const missingIds = new Set(get().missingIds);
    missingIds.delete(taskId);
    set({ missingIds });
    get().mergeTasks([task]);
  },

  async remove(taskId) {
    await api.removeDownload(taskId);
    rememberRemovedTask(taskId);
    const map = new Map(get().tasks);
    map.delete(taskId);
    pruneDownloadDisplayCache(map.keys());
    set({
      tasks: map,
      ...derive(map),
      history: get().history.filter((task) => task.id !== taskId),
    });
  },

  async clearHistory() {
    await api.clearDownloadHistory();
    // 失败、排队、暂停和进行中的任务留在队列里，所以重新拉一次而不是本地清空。
    await get().refresh();
  },

  mergeTasks(tasks) {
    if (tasks.length === 0) return;
    const map = new Map(get().tasks);
    let sawCompletedTask = false;
    const finished = new Map(get().history.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (!belongsInQueue(task)) {
        finished.set(task.id, task);
        sawCompletedTask = true;
        rememberCompletedTask(task.id);
        forgetQueueDraft(task.id);
        map.delete(task.id);
        continue;
      }
      if (completedTaskIds.has(task.id)) continue;
      const merged = mergeTask(map.get(task.id), task);
      map.set(task.id, merged);
    }
    if (sawCompletedTask) {
      pruneDownloadDisplayCache(map.keys());
      set({ history: historyFrom(finished.values()) });
    }
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
    if (event.type === "connection.open") {
      void get().refresh();
      return;
    }
    if (event.type === "download.updated") {
      if (removedTaskIds.has(event.payload.id)) return;
      get().mergeTasks([event.payload]);
      return;
    }
    if (event.type === "download.list") {
      downloadListRevision += 1;
      const map = applyServerList(get().tasks, event.payload);
      commitTasks(map);
      set({ tasks: map, ...derive(map), history: historyFrom(event.payload), error: "" });
      map.forEach(prepareAuthorizingTask);
    }
  },
}));
