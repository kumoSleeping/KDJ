/**
 * 下载队列单条配置草稿。
 *
 * 后端任务在入队时就把 VideoDownloadRequest 冻进闭包，排队期间改不了参数。
 * 所以前端自己记一份草稿：点开队列行改分 P / 画质 / Offset 时先写这里；
 * 仍是 queued 时，应用 = 取消旧任务 + 按草稿重新入队。
 */

import type { Quality, VideoDownloadRequest } from "../types";

export type OffsetMode = "none" | "player" | "bound";

export interface VideoQueueDraft {
  kind: "video";
  request: VideoDownloadRequest;
  /** Offset 识别方式；真正写入 request.offset_ms 要等校准完成。 */
  offsetMode: OffsetMode;
  /** 绑定校准用的本地曲目（bound 模式）。 */
  boundTrackId: number | null;
  boundTrackTitle: string;
  boundTrackArtist: string;
}

export interface AudioQueueDraft {
  kind: "audio";
  quality: Quality | null;
}

export type QueueTaskDraft = VideoQueueDraft | AudioQueueDraft;

const drafts = new Map<string, QueueTaskDraft>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getQueueDraft(taskId: string): QueueTaskDraft | undefined {
  return drafts.get(taskId);
}

export function setQueueDraft(taskId: string, draft: QueueTaskDraft): void {
  drafts.set(taskId, draft);
  emit();
}

export function patchVideoDraft(
  taskId: string,
  patch: Partial<Omit<VideoQueueDraft, "kind" | "request">> & {
    request?: Partial<VideoDownloadRequest>;
  },
): VideoQueueDraft | undefined {
  const current = drafts.get(taskId);
  if (!current || current.kind !== "video") return undefined;
  const next: VideoQueueDraft = {
    ...current,
    ...patch,
    kind: "video",
    request: { ...current.request, ...patch.request },
  };
  drafts.set(taskId, next);
  emit();
  return next;
}

export function rememberVideoEnqueue(taskId: string, request: VideoDownloadRequest): void {
  drafts.set(taskId, {
    kind: "video",
    request: { ...request },
    offsetMode: request.offset_ms ? "bound" : "none",
    boundTrackId: null,
    boundTrackTitle: "",
    boundTrackArtist: "",
  });
  emit();
}

export function forgetQueueDraft(taskId: string): void {
  if (!drafts.delete(taskId)) return;
  emit();
}

export function rekeyQueueDraft(fromId: string, toId: string): void {
  const draft = drafts.get(fromId);
  if (!draft) return;
  drafts.delete(fromId);
  drafts.set(toId, draft);
  emit();
}

/** 供 React 订阅：任意草稿变更时强制重渲染。 */
export function subscribeQueueDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
