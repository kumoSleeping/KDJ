import type { DownloadTask } from "../types";

/** 服务端还没解析出标题时会回 BV 号 / URL；有搜索结果标题就别盖掉。 */
export function isSparseDownloadTitle(title: string): boolean {
  const t = title.trim();
  if (!t || t === "视频" || t === "未命名") return true;
  return /^BV[\w]+$/i.test(t) || /^https?:\/\//i.test(t);
}

/** 用搜索结果的展示信息盖到任务上（不覆盖服务端已经解析好的标题）。 */
export function withDownloadDisplay(
  task: DownloadTask,
  display: {
    title?: string;
    artist?: string;
    cover?: string;
    dest_dir?: string;
  },
): DownloadTask {
  const title =
    display.title?.trim() && isSparseDownloadTitle(task.title)
      ? display.title.trim()
      : task.title;
  const artist = task.artist?.trim() || display.artist?.trim() || task.artist;
  const cover = task.cover?.trim() || display.cover?.trim() || undefined;
  const dest = task.dest_dir?.trim() || display.dest_dir?.trim() || undefined;
  return {
    ...task,
    title,
    artist,
    ...(cover ? { cover } : {}),
    ...(dest ? { dest_dir: dest } : {}),
  };
}
