import type { FolderSnapshotResponse, FolderTree } from "../types";

export type FolderStartupSource = "snapshot" | "live";

export interface FolderStartupResult {
  tree: FolderTree;
  source: FolderStartupSource;
  generatedAt: string | null;
}

/**
 * 启动只走一条读取路径：有完整 SQLite 快照就立刻返回，不在后台偷偷同时枚举磁盘；
 * 没有快照（首次升级、版本或根指纹变化）才等待一次实时树。实时校验由工作台首帧后
 * 的独立刷新触发，因此慢盘不会重新把启动闸门拖住。
 */
export async function restoreFolderTreeForStartup(
  readSnapshot: () => Promise<FolderSnapshotResponse>,
  readLive: () => Promise<FolderTree>,
): Promise<FolderStartupResult> {
  try {
    const snapshot = await readSnapshot();
    if (snapshot.tree) {
      return {
        tree: snapshot.tree,
        source: "snapshot",
        generatedAt: snapshot.generated_at ?? null,
      };
    }
  } catch {
    // 兼容旧后端，或把损坏/不匹配的快照当成 cache miss；首次恢复继续等实时树。
  }

  return {
    tree: await readLive(),
    source: "live",
    generatedAt: null,
  };
}
