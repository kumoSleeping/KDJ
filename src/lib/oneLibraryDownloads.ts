import { api } from "./api";
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

async function flush(row: PendingOneLibraryDownload): Promise<void> {
  if (row.track_id == null || activeWrites.has(row.id)) return;
  activeWrites.add(row.id);
  try {
    const { usePlaylistStore } = await import("../stores/playlistStore");
    const state = usePlaylistStore.getState();
    const device = state.devices.find((candidate) =>
      row.target.is_virtual
        ? candidate.is_virtual
        : candidate.path === row.target.device_path || candidate.name === row.target.device_name,
    );
    if (!device) return;
    await state.addTracks(device.path, row.target.playlist_id, [row.track_id]);
    update(row.id, () => null);
  } catch {
    // 卷被推出、UAC 被取消或空间暂时不足：保留记录，下次刷新设备后继续。
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
      await flush(ready);
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
        const [replacement] = await api.enqueue({ sources: [row.source] });
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
