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
