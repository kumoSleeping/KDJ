import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

const STORAGE_KEY = "kd-sidebar-root-order-v1";
const MAX_ITEMS = 2_000;
const MAX_ID_LENGTH = 4_096;

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > MAX_ID_LENGTH ||
      seen.has(item)
    ) {
      continue;
    }
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
}

export function normalizeSidebarRootOrder(value: unknown): string[] {
  return uniqueIds(value);
}

export function readSidebarRootOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeSidebarRootOrder(
      JSON.parse(readLocalStorage(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return [];
  }
}

export function writeSidebarRootOrder(order: readonly string[]): void {
  writeLocalStorageNow(
    STORAGE_KEY,
    JSON.stringify(normalizeSidebarRootOrder(order)),
  );
}

/** 已保存的根项优先；新出现且尚未排过的根项保持默认相对次序并追加在后。 */
export function orderSidebarRootItems<T extends { id: string }>(
  items: readonly T[],
  savedOrder: readonly string[],
): T[] {
  const rank = new Map(
    normalizeSidebarRootOrder(savedOrder).map((id, index) => [id, index]),
  );
  return items
    .map((item, defaultIndex) => ({ item, defaultIndex }))
    .sort((left, right) => {
      const leftRank = rank.get(left.item.id);
      const rightRank = rank.get(right.item.id);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.defaultIndex - right.defaultIndex;
    })
    .map(({ item }) => item);
}

export type SidebarRootDropEdge = "before" | "after";

/** 以当前实际可见顺序为准移动，避免新根项第一次拖动时跳位。 */
export function moveSidebarRootOrder(
  visibleOrder: readonly string[],
  from: string,
  to: string,
  edge: SidebarRootDropEdge,
): string[] {
  const current = normalizeSidebarRootOrder(visibleOrder);
  if (from === to || !current.includes(from) || !current.includes(to)) return current;
  const next = current.filter((id) => id !== from);
  const targetIndex = next.indexOf(to);
  next.splice(edge === "after" ? targetIndex + 1 : targetIndex, 0, from);
  return next;
}

/**
 * 把新的可见顺序写回旧记录，同时保留当前被关闭的平台或暂时离线的目录位置。
 * 它们重新出现时仍能回到先前参与过的排序中。
 */
export function mergeSidebarRootOrder(
  savedOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const saved = normalizeSidebarRootOrder(savedOrder);
  const visible = normalizeSidebarRootOrder(visibleOrder);
  const visibleSet = new Set(visible);
  let visibleIndex = 0;
  const merged = saved.map((id) =>
    visibleSet.has(id) ? visible[visibleIndex++] : id,
  );
  merged.push(...visible.slice(visibleIndex));
  return normalizeSidebarRootOrder(merged);
}
