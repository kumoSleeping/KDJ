import type { ExportOptions } from "./lanes";

/**
 * An export of a `.kdjv` project (剪辑, VJ) in the export queue: queued → rendering → done, or
 * failed, or paused by the listener, or canceled because the project was written while it ran
 * (`changed`). One that is started again starts from the beginning, from the project as it is
 * then: the server renders it in one go and keeps nothing of a stopped one.
 */
export type ProjectExportPhase = "queued" | "rendering" | "done" | "failed" | "paused" | "canceled";
export interface ProjectExportTask {
  id: string;
  /** The project's library row. */
  trackId: number;
  name: string;
  /** Where the file is written: beside the project. */
  folder: string;
  /** What is made, in short: "MP4 · 1920 × 1080 · 60 fps", "WAV". */
  format: string;
  options?: ExportOptions;
  phase: ProjectExportPhase;
  progress: number;
  status: string;
  error: string;
  /** The file made, once done. */
  outputPath: string;
  /** Stopped because its project was written while it ran. */
  changed?: boolean;
  createdAt: number;
}
export const projectExportActive = (task: ProjectExportTask) => task.phase === "queued" || task.phase === "rendering";
export const projectExportStartable = (task: ProjectExportTask) => ["failed", "paused", "canceled"].includes(task.phase);

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kdj-project-export-queue-v1", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("tasks", { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开剪辑导出队列"));
  });
}
async function writeQueue(action: (tasks: IDBObjectStore) => void): Promise<void> {
  const db = await openQueue();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("tasks", "readwrite");
      let failure: DOMException | null = null;
      tx.onerror = () => { failure = tx.error; };
      tx.onabort = () => reject(failure || tx.error || new Error("导出队列保存被中断"));
      tx.oncomplete = () => resolve();
      action(tx.objectStore("tasks"));
    });
  } finally { db.close(); }
}
export const saveProjectExport = (task: ProjectExportTask) => writeQueue(tasks => tasks.put(task));
export const deleteProjectExport = (id: string) => writeQueue(tasks => tasks.delete(id));
export async function loadProjectExports(): Promise<ProjectExportTask[]> {
  const db = await openQueue();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("tasks").objectStore("tasks").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
