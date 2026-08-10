export const WORKSPACE_PANE_KINDS = ["local", "onelibrary", "search"] as const;

export type WorkspacePaneKind = (typeof WORKSPACE_PANE_KINDS)[number];

export interface WorkspacePaneState {
  /**
   * 板块的长期偏好顺序。暂时没有内容的板块也保留在这里，重新打开时才能回到
   * 用户上次拖到的位置，而不是每次都被追加到末尾。
   */
  order: WorkspacePaneKind[];
  active: WorkspacePaneKind;
}

export type WorkspacePaneAvailability = Record<WorkspacePaneKind, boolean>;

/**
 * Delete/Backspace 只能由当前点亮板块消费；两张表会同时保留选区，不能各自在
 * window keydown 上看见选区就一起删除。保留两类表原有的 Backspace 语义。
 */
export function shouldHandleWorkspaceDelete(
  active: boolean,
  owner: Extract<WorkspacePaneKind, "local" | "onelibrary">,
  key: string,
  modified: boolean,
): boolean {
  if (!active) return false;
  return key === "Delete" || (key === "Backspace" && (owner === "onelibrary" || modified));
}

const isWorkspacePaneKind = (value: unknown): value is WorkspacePaneKind =>
  value === "local" || value === "onelibrary" || value === "search";

/**
 * 本地曲库是整个工作流的锚点，始终固定在最左侧；OneLibrary 与在线内容则可在
 * 它右边自由换位。数组始终补齐三种类型，隐藏再恢复时不会丢掉用户的排序。
 */
export function normalizeWorkspacePaneOrder(value: unknown): WorkspacePaneKind[] {
  const unique: WorkspacePaneKind[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isWorkspacePaneKind(entry) && !unique.includes(entry)) unique.push(entry);
    }
  }
  for (const kind of WORKSPACE_PANE_KINDS) {
    if (!unique.includes(kind)) unique.push(kind);
  }
  const anchored: WorkspacePaneKind[] = [
    "local",
    ...unique.filter((kind) => kind !== "local"),
  ];
  return anchored.slice(
    0,
    WORKSPACE_PANE_KINDS.length,
  );
}

export function createWorkspacePaneState(
  order: unknown,
  active: unknown,
): WorkspacePaneState {
  const normalizedOrder = normalizeWorkspacePaneOrder(order);
  return {
    order: normalizedOrder,
    active: isWorkspacePaneKind(active) ? active : normalizedOrder[0],
  };
}

/** 读取 v2 顺序，并兼容旧版固定左右两个槽位的 v1 存档。 */
export function restoreWorkspacePaneState(
  stored: unknown,
  legacy: unknown,
): WorkspacePaneState {
  if (stored && typeof stored === "object") {
    const value = stored as { order?: unknown; active?: unknown };
    if (Array.isArray(value.order)) return createWorkspacePaneState(value.order, value.active);
  }

  if (legacy && typeof legacy === "object") {
    const value = legacy as {
      left?: unknown;
      right?: unknown;
      active?: unknown;
    };
    const legacyOrder = [value.left, value.right].filter(isWorkspacePaneKind);
    const legacyActive =
      value.active === "left"
        ? value.left
        : value.active === "right"
          ? value.right
          : undefined;
    return createWorkspacePaneState(legacyOrder, legacyActive);
  }

  return createWorkspacePaneState(WORKSPACE_PANE_KINDS, "local");
}

/**
 * 把一个板块拖到目标板块原来的位置。固定本地曲库后，在线与 OneLibrary 仍可
 * 交换中间/右侧位置；把任何板块拖到最左边也不会越过本地曲库。
 */
export function moveWorkspacePane(
  state: WorkspacePaneState,
  from: WorkspacePaneKind,
  target: WorkspacePaneKind,
): WorkspacePaneState {
  if (from === target) return state;
  const fromIndex = state.order.indexOf(from);
  const targetIndex = state.order.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0) return state;

  const next = state.order.filter((kind) => kind !== from);
  next.splice(Math.min(targetIndex, next.length), 0, from);
  return createWorkspacePaneState(next, from);
}

export function visibleWorkspacePanes(
  state: WorkspacePaneState,
  multiPane: boolean,
  availability: WorkspacePaneAvailability,
): WorkspacePaneKind[] {
  const available = state.order.filter((kind) => availability[kind]);
  if (multiPane) return available.slice(0, WORKSPACE_PANE_KINDS.length);
  if (availability[state.active]) return [state.active];
  return available.length > 0 ? [available[0]] : [];
}
