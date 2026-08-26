import type { DownloadTask, OneLibraryTarget, SongSource } from "../types";
import {
  loadPendingOneLibraryDownloads as load,
  persistOneLibraryDownloadTasks,
  updatePendingOneLibraryDownload as update,
  type PendingOneLibraryDownload,
} from "./oneLibraryDownloadPersistence";

const activeWrites = new Set<string>();
let resumeInFlight: Promise<void> | null = null;

export function registerOneLibraryDownloads(
  target: OneLibraryTarget,
  sources: SongSource[],
  tasks: DownloadTask[],
): void {
  persistOneLibraryDownloadTasks(target, sources, tasks);
  for (const task of tasks) void handleOneLibraryDownloadTask(task);
}

async function flush(row: PendingOneLibraryDownload): Promise<string> {
  if (row.track_id == null || activeWrites.has(row.id)) return "";
  activeWrites.add(row.id);
  try {
    const { usePlaylistStore } = await import("../stores/playlistStore");
    const state = usePlaylistStore.getState();
    // 不能按卷名兜底：Windows 上两个 U 盘可以同名，盘符变化时会把歌写到另一块盘。
    const device = state.devices.find(
      (candidate) =>
        candidate.path === row.target.device_path && candidate.is_virtual === row.target.is_virtual,
    );
    if (!device) return `目标设备未连接：${row.target.device_name}`;
    await state.addTracks(device.path, row.target.playlist_id, [row.track_id]);
    update(row.id, () => null);
    return "";
  } catch (error) {
    // 卷被推出、UAC 被取消或空间暂时不足：保留记录，下次刷新设备后继续，
    // 同时把原因放回下载行，不能继续静默显示“完成”。
    return `写入 ${row.target.device_name} 失败：${(error as Error).message}`;
  } finally {
    activeWrites.delete(row.id);
  }
}

export async function handleOneLibraryDownloadTask(task: DownloadTask): Promise<void> {
  const rows = load().filter((row) => row.task_id === task.id);
  for (const row of rows) {
    if (task.state === "canceled") {
      update(row.id, () => null);
      continue;
    }
    if (task.state === "done" && task.track_id != null) {
      const ready = { ...row, track_id: task.track_id };
      update(row.id, () => ready);
      const error = await flush(ready);
      const { useDownloadStore } = await import("../stores/downloadStore");
      useDownloadStore.getState().mergeTasks([{ ...task, one_library_error: error }]);
    }
  }
}

export async function resumeOneLibraryDownloads(): Promise<void> {
  if (resumeInFlight) return resumeInFlight;
  resumeInFlight = (async () => {
    const { useDownloadStore } = await import("../stores/downloadStore");
    const downloads = useDownloadStore.getState();
    const tasks = new Map(downloads.list.map((task) => [task.id, task]));
    for (const row of load()) {
      if (row.track_id != null) {
        await flush(row);
        continue;
      }
      const task = tasks.get(row.task_id);
      if (task) {
        await handleOneLibraryDownloadTask(task);
        continue;
      }
      try {
        const { enqueueMediaDownloads } = await import("./mediaActions");
        const [replacement] = await enqueueMediaDownloads([row.source], { revealQueue: false });
        if (!replacement) continue;
        update(row.id, (current) => ({ ...current, task_id: replacement.id }));
        downloads.mergeTasks([replacement]);
      } catch {
        // 网络不可用时仍保留源和目标；下次设备/应用刷新再试。
      }
    }
  })().finally(() => {
    resumeInFlight = null;
  });
  return resumeInFlight;
}
