import type { KdjBridge } from "../types";

// Matches the permission diagnostic from workshop::signature, including paths
// containing spaces. Other media failures must never open a native dialog.
export function workshopAccessDirectory(error: string): string | null {
  const match = error.match(/素材访问被系统拒绝：[\s\S]*。请点击“授权文件夹”并选择 (\/[\s\S]+)$/);
  return match?.[1] ?? null;
}

export function createWorkshopFolderAccess() {
  const attempted = new Set<string>();
  const pending = new Map<string, Promise<string | null>>();
  let queue: Promise<unknown> = Promise.resolve();
  return (directory: string, pickFolder: KdjBridge["pickFolder"], manual = false): Promise<string | null> => {
    const existing = pending.get(directory);
    if (existing) return existing;
    // A canceled dialog or an ineffective grant must not create a prompt loop.
    // Keep the explicit button available for another user-initiated attempt.
    if (!manual && attempted.has(directory)) return Promise.resolve(null);
    attempted.add(directory);
    const result = queue.then(() => pickFolder({ defaultPath: directory, title: "授权素材文件夹" }));
    pending.set(directory, result);
    queue = result.catch(() => {}).finally(() => pending.delete(directory));
    return result;
  };
}

// Both inline and floating previews share a single native authorization dialog.
export const requestWorkshopFolderAccess = createWorkshopFolderAccess();
