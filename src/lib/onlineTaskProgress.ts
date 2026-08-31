import type {
  DownloadTask,
  Platform,
  SongSource,
  TaskPhase,
} from "../types";

export type OnlineProgressStageKind = "resolve" | "cache" | "download";
export type OnlineProgressStageState = "waiting" | "running" | "done" | "failed";

export interface OnlineProgressStage {
  kind: OnlineProgressStageKind;
  state: OnlineProgressStageState;
  status: string;
  value: number;
  indeterminate: boolean;
  tail: boolean;
}

export interface PlaybackCacheProgressInput {
  platform: Platform;
  phase: "resolving" | "ready" | "error";
  cachedBytes: number;
  totalBytes: number;
  complete: boolean;
  active: boolean;
}

const ACTIVE_STATES = new Set(["queued", "running", "processing", "paused"]);
const PRE_DOWNLOAD_PHASES = new Set<TaskPhase>([
  "waiting",
  "authorizing",
  "resolving",
]);

/**
 * 只为真实存在多步来源准备的平台画「解析」。QQ / 网易云通常从现成的
 * 搜索结果直接换播放或下载地址，短到画出来只会闪一下。
 *
 * SoundCloud 需要选择 transcoding，再把授权端点换成 CDN URL；在部分网络
 * 下首包也明显偏慢，因此保留解析反馈。
 */
export function platformShowsResolveStage(platform: Platform): boolean {
  return (
    platform === "youtube" ||
    platform === "ytm" ||
    platform === "bilibili" ||
    platform === "soundcloud"
  );
}

export function isActiveDownloadTask(task: DownloadTask): boolean {
  return ACTIVE_STATES.has(task.state);
}

export function terminalTaskRetentionSeconds(task: DownloadTask): number {
  if (task.state === "failed") return 8;
  if (task.state === "done" || task.state === "canceled") return 2.4;
  return 0;
}

export function isRecentlyFinishedDownloadTask(
  task: DownloadTask,
  nowSeconds: number,
): boolean {
  const retention = terminalTaskRetentionSeconds(task);
  return retention > 0 && nowSeconds - task.updated_at < retention;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function downloadTaskMatchesSource(
  task: DownloadTask,
  source: SongSource | null,
): boolean {
  if (!source || task.platform !== source.platform) return false;
  const sourceTitle = normalized(source.title);
  const taskTitle = normalized(task.title);
  if (sourceTitle && taskTitle && sourceTitle === taskTitle) return true;
  if (sourceTitle || taskTitle) return false;
  const sourceArtist = normalized(source.artists.join(", "));
  return Boolean(sourceArtist && sourceArtist === normalized(task.artist));
}

/**
 * 紧凑板块一次只跟踪一项，完整并发列表仍由下载队列负责。优先保持当前
 * 详情曲目的任务；没有时选择最早仍在执行的任务，避免每个进度事件都换行。
 */
export function selectOnlineProgressTask(
  tasks: DownloadTask[],
  source: SongSource | null,
  nowSeconds: number,
): DownloadTask | null {
  const active = tasks.filter(isActiveDownloadTask);
  const matchingActive = active.find((task) => downloadTaskMatchesSource(task, source));
  if (matchingActive) return matchingActive;

  const recent = tasks
    .filter((task) => isRecentlyFinishedDownloadTask(task, nowSeconds))
    .sort((left, right) => right.updated_at - left.updated_at);
  const matchingRecent = recent.find((task) => downloadTaskMatchesSource(task, source));
  if (matchingRecent) return matchingRecent;
  return active[0] ?? recent[0] ?? null;
}

function resolveStatus(task: DownloadTask): string {
  if (task.state === "paused") return "已暂停";
  if (!PRE_DOWNLOAD_PHASES.has(task.phase)) return "完成";
  if (task.state === "failed") return "失败";
  if (task.state === "canceled") return "已取消";
  if (task.phase === "waiting") return "等待";
  if (task.phase === "authorizing") return "授权中";
  if (task.phase === "resolving") return "处理中";
  return "处理中";
}

function downloadStatus(task: DownloadTask): string {
  if (task.state === "paused") return "已暂停";
  if (task.state === "done") return "完成";
  if (task.state === "failed") return "失败";
  if (task.state === "canceled") return "已取消";
  if (task.phase === "waiting") return "等待";
  if (task.phase === "authorizing" || task.phase === "resolving") return "准备中";
  if (task.phase === "post_processing") return "整理中";
  if (task.phase === "relocating" || task.phase === "importing") return "收尾中";
  if (task.total_bytes <= 0) return "下载中";
  return `${Math.round(Math.min(1, Math.max(0, task.progress)) * 100)}%`;
}

function resolveStage(task: DownloadTask): OnlineProgressStage {
  const beforeDownload = PRE_DOWNLOAD_PHASES.has(task.phase);
  const failedBeforeDownload =
    beforeDownload && (task.state === "failed" || task.state === "canceled");
  const waiting =
    (task.state === "queued" || task.state === "paused") && task.phase === "waiting";
  return {
    kind: "resolve",
    state: failedBeforeDownload
      ? "failed"
      : beforeDownload
        ? waiting
          ? "waiting"
          : "running"
        : "done",
    status: resolveStatus(task),
    value: beforeDownload ? 0 : 1,
    indeterminate: beforeDownload && !waiting && !failedBeforeDownload,
    tail: false,
  };
}

function downloadStage(task: DownloadTask): OnlineProgressStage {
  const tail =
    task.phase === "post_processing" ||
    task.phase === "relocating" ||
    task.phase === "importing";
  const waiting =
    (task.state === "queued" || task.state === "paused") && task.phase === "waiting";
  const failed = task.state === "failed" || task.state === "canceled";
  const done = task.state === "done";
  return {
    kind: "download",
    state: failed ? "failed" : done ? "done" : waiting ? "waiting" : "running",
    status: downloadStatus(task),
    value: done ? 1 : tail ? Math.max(0.94, task.progress) : task.progress,
    indeterminate:
      !failed &&
      !done &&
      !waiting &&
      !tail &&
      (task.phase !== "downloading" || task.total_bytes <= 0),
    tail,
  };
}

function cacheStage(input: PlaybackCacheProgressInput): OnlineProgressStage {
  const failed = input.phase === "error";
  const total = Math.max(0, input.totalBytes);
  const cached = Math.max(0, input.cachedBytes);
  const value = total > 0 ? Math.min(1, cached / total) : input.complete ? 1 : 0;
  const done = input.complete;
  const status = failed
    ? "失败"
    : done
      ? "已缓存"
      : total > 0
        ? `${Math.round(value * 100)}%`
        : input.phase === "resolving"
          ? "准备中"
          : input.active || cached > 0
            ? "缓存中"
            : "等待数据";
  return {
    kind: "cache",
    state: failed ? "failed" : done ? "done" : "running",
    status,
    value,
    indeterminate: !failed && !done && total <= 0,
    tail: false,
  };
}

/**
 * 在线播放使用播放器已经在拉取的同一份媒体来汇报缓存。网易云 / QQ 直接进入
 * 缓存行；需要额外换取媒体资源的平台先完成解析，再出现缓存行。
 */
export function playbackCacheProgressStages(
  input: PlaybackCacheProgressInput,
): OnlineProgressStage[] {
  const cache = cacheStage(input);
  if (!platformShowsResolveStage(input.platform)) return [cache];
  if (input.phase === "resolving") {
    return [{
      kind: "resolve",
      state: "running",
      status: "处理中",
      value: 0,
      indeterminate: true,
      tail: false,
    }];
  }
  if (input.phase === "error") {
    return [{
      kind: "resolve",
      state: "failed",
      status: "失败",
      value: 0,
      indeterminate: false,
      tail: false,
    }];
  }
  return [
    {
      kind: "resolve",
      state: "done",
      status: "完成",
      value: 1,
      indeterminate: false,
      tail: false,
    },
    cache,
  ];
}

/** 解析行永远在下载行之前；复杂来源解析完成前不提前画下载行。 */
export function downloadTaskProgressStages(task: DownloadTask): OnlineProgressStage[] {
  if (!platformShowsResolveStage(task.platform)) return [downloadStage(task)];

  const resolve = resolveStage(task);
  if (PRE_DOWNLOAD_PHASES.has(task.phase)) return [resolve];
  return [resolve, downloadStage(task)];
}
