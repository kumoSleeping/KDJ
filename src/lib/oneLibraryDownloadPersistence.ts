import type { DownloadTask, OneLibraryTarget, SongSource } from "../types";

export const ONE_LIBRARY_DOWNLOAD_STORAGE_KEY = "kd-onelibrary-download-targets-v1";

export interface PendingOneLibraryDownload {
  id: string;
  task_id: string;
  target: OneLibraryTarget;
  source: SongSource;
  track_id: number | null;
  created_at: number;
}

export function loadPendingOneLibraryDownloads(): PendingOneLibraryDownload[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ONE_LIBRARY_DOWNLOAD_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PendingOneLibraryDownload => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<PendingOneLibraryDownload>;
      return Boolean(
        row.id && row.task_id && row.target?.device_path &&
        Number.isInteger(row.target?.playlist_id) && row.source?.platform && row.source?.key,
      );
    });
  } catch {
    return [];
  }
}

export function savePendingOneLibraryDownloads(rows: PendingOneLibraryDownload[]): void {
  try {
    if (rows.length === 0) localStorage.removeItem(ONE_LIBRARY_DOWNLOAD_STORAGE_KEY);
    else localStorage.setItem(ONE_LIBRARY_DOWNLOAD_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // 当前下载继续；受限存储只会影响跨重启补写。
  }
}

export function updatePendingOneLibraryDownload(
  id: string,
  mutate: (row: PendingOneLibraryDownload) => PendingOneLibraryDownload | null,
): void {
  const next: PendingOneLibraryDownload[] = [];
  for (const row of loadPendingOneLibraryDownloads()) {
    if (row.id !== id) next.push(row);
    else {
      const changed = mutate(row);
      if (changed) next.push(changed);
    }
  }
  savePendingOneLibraryDownloads(next);
}

/** 用户取消下载后同时清掉对应的设备补写，避免下次启动又把它重新入队。 */
export function removePendingOneLibraryDownloadTasks(taskIds: Iterable<string>): void {
  const ids = new Set(taskIds);
  if (ids.size === 0) return;
  savePendingOneLibraryDownloads(
    loadPendingOneLibraryDownloads().filter((row) => !ids.has(row.task_id)),
  );
}

/** 彻底删除 KDJ 虚拟盘后，旧下载不能在将来重建的新盘上继续补写。 */
export function removePendingVirtualDiskDownloads(): void {
  savePendingOneLibraryDownloads(
    loadPendingOneLibraryDownloads().filter((row) => !row.target.is_virtual),
  );
}

export function persistOneLibraryDownloadTasks(
  target: OneLibraryTarget,
  sources: SongSource[],
  tasks: DownloadTask[],
): void {
  const rows = loadPendingOneLibraryDownloads();
  tasks.forEach((task, index) => {
    const source = sources[index];
    if (!source) return;
    rows.push({
      id: crypto.randomUUID(),
      task_id: task.id,
      target,
      source,
      track_id: task.track_id,
      created_at: Date.now(),
    });
  });
  savePendingOneLibraryDownloads(rows);
}
