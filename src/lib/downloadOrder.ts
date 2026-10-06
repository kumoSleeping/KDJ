import type { DownloadTask } from "../types";

/**
 * 下载队列的唯一显示顺序：先加入的永远在前。
 * 进度更新时间不能参与排序，否则活跃任务会随着每个 chunk 上下跳动。
 */
export function sortDownloadTasks(tasks: Iterable<DownloadTask>): DownloadTask[] {
  return [...tasks].sort(
    (left, right) =>
      left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

/**
 * 历史视图的显示顺序：最近结束的在最上面。
 * 结束态任务的 updated_at 不再变化，所以行不会跳动。
 */
export function sortDownloadHistory(tasks: Iterable<DownloadTask>): DownloadTask[] {
  return [...tasks].sort(
    (left, right) =>
      right.updated_at - left.updated_at ||
      right.created_at - left.created_at ||
      right.id.localeCompare(left.id),
  );
}
