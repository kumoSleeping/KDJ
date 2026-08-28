import type { DownloadTask, OneLibraryTarget, SongSource } from "../types";
import { api, ApiError } from "./api";
import {
  loadPendingOneLibraryDownloads as load,
  persistOneLibraryDownloadTasks,
  updatePendingOneLibraryDownload as update,
  type PendingOneLibraryDownload,
} from "./oneLibraryDownloadPersistence";

const activeWrites = new Set<string>();
let resumeInFlight: Promise<void> | null = null;

function isMissingLocalTrack(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 404
    && error.message.startsWith("曲目不存在");
}

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
    // 已完成下载的本地记录可能后来被用户删除。先做一次无副作用检查，避免
    // addTracks 把这个永久失效的 id 写进 OneLibrary 全局错误栏。
    await api.track(row.track_id);
    await state.addTracks(device.path, row.target.playlist_id, [row.track_id]);
    update(row.id, () => null);
    return "";
  } catch (error) {
    if (isMissingLocalTrack(error)) {
      // 用户已经删除本地成品，不再把旧下载强行复活；这条补写也随之作废。
      update(row.id, () => null);
      const { usePlaylistStore } = await import("../stores/playlistStore");
      if (usePlaylistStore.getState().deviceError === error.message) {
        usePlaylistStore.setState({ deviceError: "" });
      }
      return "";
    }
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
