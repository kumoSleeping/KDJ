/**
 * 下载任务的展示字段（标题/艺人/封面/目标文件夹）本地备份。
 *
 * 服务端任务在内存里，刷新页面会重新拉；旧二进制或不带 cover 的快照
 * 会把搜索结果盖上去的信息冲掉。按 task id 记一份，refresh / WS 合并时再盖回去。
 */

import type { DownloadTask } from "../types";
import { writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-download-display-v1";

export type DownloadDisplayHint = {
  title?: string;
  artist?: string;
  cover?: string;
  dest_dir?: string;
};

let memoryCache: Record<string, DownloadDisplayHint> | null = null;

function readAll(): Record<string, DownloadDisplayHint> {
  if (memoryCache) return memoryCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return (memoryCache = {});
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return (memoryCache = {});
    return (memoryCache = parsed as Record<string, DownloadDisplayHint>);
  } catch {
    return (memoryCache = {});
  }
}

function writeAll(map: Record<string, DownloadDisplayHint>): void {
  memoryCache = map;
  writeLocalStorageNow(STORAGE_KEY, JSON.stringify(map));
}

function displayHint(task: DownloadTask): DownloadDisplayHint {
  const hint: DownloadDisplayHint = {};
  if (task.title?.trim() && task.title !== "未命名" && !/^BV[\w]+$/i.test(task.title.trim())) {
    hint.title = task.title.trim();
  }
  if (task.artist?.trim()) hint.artist = task.artist.trim();
  if (task.cover?.trim()) hint.cover = task.cover.trim();
  if (task.dest_dir?.trim()) hint.dest_dir = task.dest_dir.trim();
  return hint;
}

function sameHint(left: DownloadDisplayHint | undefined, right: DownloadDisplayHint): boolean {
  return left?.title === right.title
    && left?.artist === right.artist
    && left?.cover === right.cover
    && left?.dest_dir === right.dest_dir;
}

/**
 * 批量合并展示字段，一批任务只提交一次 localStorage。
 * download.updated 的高频进度字段不在 hint 中；内容没变时连这一次也跳过。
 */
export function rememberDownloadDisplays(tasks: Iterable<DownloadTask>): void {
  const current = readAll();
  let next: Record<string, DownloadDisplayHint> | null = null;
  for (const task of tasks) {
    const hint = displayHint(task);
    const all = next ?? current;
    const empty = !hint.title && !hint.artist && !hint.cover && !hint.dest_dir;
    if (empty) {
      if (!(task.id in all)) continue;
      next ??= { ...current };
      delete next[task.id];
      continue;
    }
    const merged = { ...all[task.id], ...hint };
    if (sameHint(all[task.id], merged)) continue;
    next ??= { ...current };
    next[task.id] = merged;
  }
  if (next) writeAll(next);
}

/** 用服务端整份任务列表一次完成更新与淘汰，避免 N 个任务触发 N 次整表序列化。 */
export function syncDownloadDisplayCache(tasks: Iterable<DownloadTask>): void {
  const list = [...tasks];
  const keep = new Set(list.map((task) => task.id));
  const current = readAll();
  let next: Record<string, DownloadDisplayHint> | null = null;
  for (const task of list) {
    const hint = displayHint(task);
    const all = next ?? current;
    if (!hint.title && !hint.artist && !hint.cover && !hint.dest_dir) {
      if (task.id in all) {
        next ??= { ...current };
        delete next[task.id];
      }
      continue;
    }
    const merged = { ...all[task.id], ...hint };
    if (sameHint(all[task.id], merged)) continue;
    next ??= { ...current };
    next[task.id] = merged;
  }
  for (const id of Object.keys(next ?? current)) {
    if (keep.has(id)) continue;
    next ??= { ...current };
    delete next[id];
  }
  if (next) writeAll(next);
}

/** 只保留还在队列里的 id，清掉已完成很久的残骸。 */
export function pruneDownloadDisplayCache(aliveIds: Iterable<string>): void {
  const keep = new Set(aliveIds);
  const current = readAll();
  let next: Record<string, DownloadDisplayHint> | null = null;
  for (const id of Object.keys(current)) {
    if (keep.has(id)) continue;
    next ??= { ...current };
    delete next[id];
  }
  if (next) writeAll(next);
}

export function hintForDownload(taskId: string): DownloadDisplayHint | undefined {
  return readAll()[taskId];
}
