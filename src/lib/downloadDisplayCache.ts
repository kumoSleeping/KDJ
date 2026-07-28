/**
 * 下载任务的展示字段（标题/艺人/封面/目标文件夹）本地备份。
 *
 * 服务端任务在内存里，刷新页面会重新拉；旧二进制或不带 cover 的快照
 * 会把搜索结果盖上去的信息冲掉。按 task id 记一份，refresh / WS 合并时再盖回去。
 */

import type { DownloadTask } from "../types";

const STORAGE_KEY = "kd-download-display-v1";

export type DownloadDisplayHint = {
  title?: string;
  artist?: string;
  cover?: string;
  dest_dir?: string;
};

function readAll(): Record<string, DownloadDisplayHint> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, DownloadDisplayHint>;
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, DownloadDisplayHint>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode：丢缓存只影响刷新后的封面，不挡下载 */
  }
}

/** 有展示信息就记下来；全空则删掉这条，避免越攒越多。 */
export function rememberDownloadDisplay(task: DownloadTask): void {
  const hint: DownloadDisplayHint = {};
  if (task.title?.trim() && task.title !== "未命名" && !/^BV[\w]+$/i.test(task.title.trim())) {
    hint.title = task.title.trim();
  }
  if (task.artist?.trim()) hint.artist = task.artist.trim();
  if (task.cover?.trim()) hint.cover = task.cover.trim();
  if (task.dest_dir?.trim()) hint.dest_dir = task.dest_dir.trim();

  const all = readAll();
  if (!hint.title && !hint.artist && !hint.cover && !hint.dest_dir) {
    if (!(task.id in all)) return;
    delete all[task.id];
    writeAll(all);
    return;
  }
  all[task.id] = { ...all[task.id], ...hint };
  writeAll(all);
}

/** 只保留还在队列里的 id，清掉已完成很久的残骸。 */
export function pruneDownloadDisplayCache(aliveIds: Iterable<string>): void {
  const keep = new Set(aliveIds);
  const all = readAll();
  let changed = false;
  for (const id of Object.keys(all)) {
    if (keep.has(id)) continue;
    delete all[id];
    changed = true;
  }
  if (changed) writeAll(all);
}

export function hintForDownload(taskId: string): DownloadDisplayHint | undefined {
  return readAll()[taskId];
}
