import type { VisualizerDraft } from "./visualizerStudio";

export type VisualizerExportPhase = "ready" | "queued" | "preparing" | "encoding" | "validating" | "done" | "failed" | "canceled";
export interface VisualizerExportTask {
  id: string;
  name: string;
  filename: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  phase: VisualizerExportPhase;
  progress: number;
  status: string;
  error: string;
  createdAt: number;
}
export const visualizerExportActive = (task: VisualizerExportTask) => ["queued", "preparing", "encoding", "validating"].includes(task.phase);
export const visualizerExportStartable = (task: VisualizerExportTask) => ["ready", "failed", "canceled"].includes(task.phase);

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kdj-visualizer-export-queue-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("tasks", { keyPath: "id" });
      request.result.createObjectStore("snapshots");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开可视化导出队列"));
  });
}
async function writeQueue(action: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openQueue();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["tasks", "snapshots"], "readwrite");
      let failure: DOMException | null = null;
      tx.onerror = () => { failure = tx.error; };
      tx.onabort = () => reject(failure || tx.error || new Error("导出队列保存被中断"));
      tx.oncomplete = () => resolve();
      action(tx);
    });
  } finally { db.close(); }
}
interface StoredSnapshot {
  project: VisualizerDraft["project"];
  images: { bytes: ArrayBuffer; type: string }[];
}
export async function saveVisualizerExport(task: VisualizerExportTask, draft?: VisualizerDraft): Promise<void> {
  // Use bytes rather than IndexedDB Blob backing files (unreliable in WebKit).
  const snapshot: StoredSnapshot | undefined = draft ? {
    project: draft.project,
    images: await Promise.all(draft.images.map(async image => ({ bytes: await image.arrayBuffer(), type: image.type }))),
  } : undefined;
  await writeQueue(tx => {
    tx.objectStore("tasks").put(task);
    if (snapshot) tx.objectStore("snapshots").put(snapshot, task.id);
  });
}
export async function deleteVisualizerExport(id: string): Promise<void> {
  await writeQueue(tx => { tx.objectStore("tasks").delete(id); tx.objectStore("snapshots").delete(id); });
}
export async function loadVisualizerExports(): Promise<VisualizerExportTask[]> {
  const db = await openQueue();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("tasks").objectStore("tasks").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function loadVisualizerExportSnapshot(id: string): Promise<VisualizerDraft> {
  const db = await openQueue();
  try {
    const stored = await new Promise<StoredSnapshot | undefined>((resolve, reject) => {
      const request = db.transaction("snapshots").objectStore("snapshots").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!stored) throw new Error("导出快照不存在，请重新加入队列");
    return { project: stored.project, images: stored.images.map(image => new Blob([image.bytes], { type: image.type })) };
  } finally { db.close(); }
}
