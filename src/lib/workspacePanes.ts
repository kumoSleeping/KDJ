export const WORKSPACE_PANE_KINDS = ["local", "search"] as const;

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
export type WorkspacePaneWeights = Readonly<Record<WorkspacePaneKind, number>>;

/**
 * CSS Grid 对总和小于 1 的 fr 轨道不会铺满容器，而会故意留下未分配空间。
 * 板块宽度是长期保存的：三栏里把本地栏拖到 0.92 后切回单栏，如果原样写成
 * 0.92fr，列表右侧就会永久空出 8%。这里只归一化当前可见板块的 CSS 份额，
 * 保存的原始权重不变，重新打开多栏时仍保留用户拖过的比例。
 */
export function normalizedWorkspacePaneFractions(
  visible: readonly WorkspacePaneKind[],
  weights: WorkspacePaneWeights,
): number[] {
  if (visible.length === 0) return [];
  const values = visible.map((kind) => {
    const value = weights[kind];
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => (value / total) * visible.length);
}

/**
 * Delete/Backspace 只能由当前点亮板块消费；两张表会同时保留选区，不能各自在
 * window keydown 上看见选区就一起删除。保留两类表原有的 Backspace 语义。
 */
export function shouldHandleWorkspaceDelete(
  active: boolean,
  _owner: "local",
  key: string,
  modified: boolean,
): boolean {
  if (!active) return false;
  return key === "Delete" || (key === "Backspace" && modified);
}

const isWorkspacePaneKind = (value: unknown): value is WorkspacePaneKind =>
  value === "local" || value === "search";

/**
 * 本地曲库是整个工作流的锚点，始终固定在最左侧；在线内容位于其右侧。
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
 * 把一个板块拖到目标板块原来的位置；本地曲库始终保持为左侧锚点。
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

/**
 * 详情固定锁定的是“内容来源”，不是某个详情内部面板的位置。
 * 固定时只要播放器仍有曲目，就由正在播放曲目覆盖列表选择；换到下一首后
 * playingTrack 换对象，这个纯函数会自然返回下一首。播放快照在换源边沿短暂为空时
 * 保留最近一次有效快照，不能把列表选择漏进已经固定的详情。
 */
export function resolveWorkspaceDetailTrack<T>(
  playingDetailPinned: boolean,
  playingTrack: T | null,
  requestedTrack: T | null,
  retainedPlayingTrack: T | null = null,
): T | null {
  return playingDetailPinned
    ? playingTrack ?? retainedPlayingTrack ?? requestedTrack
    : requestedTrack;
}

/**
 * An unpinned detail normally keeps its explicit list target. One exception is a visible detail
 * that was showing the outgoing playback track itself: when playback advances, that target must
 * advance with it. This is what removes the local VIDEO panel during an automatic video -> audio
 * handoff, without making an unrelated track the user is browsing follow playback.
 *
 * `previousPlayingTrackId` deliberately means the last non-null playback snapshot. A transient
 * empty snapshot during source replacement must not break the A -> B relationship.
 */
export function resolveWorkspacePlaybackDetailTarget(
  requestedTrackId: number | null,
  previousPlayingTrackId: number | null,
  nextPlayingTrackId: number | null,
  playingDetailPinned: boolean,
): number | null {
  if (
    playingDetailPinned ||
    requestedTrackId === null ||
    previousPlayingTrackId === null ||
    nextPlayingTrackId === null ||
    previousPlayingTrackId === nextPlayingTrackId ||
    requestedTrackId !== previousPlayingTrackId
  ) {
    return requestedTrackId;
  }
  return nextPlayingTrackId;
}

/**
 * 未固定详情只解析它自己的显式目标 id。
 *
 * 换文件夹、翻页或远程元数据回填时，selected/registry 可能短暂缺席；此时保留同 id
 * 的详情快照，绝不能拿一首无关的正在播放曲目兜底，否则右栏会先闪回播放页再跳目标。
 */
export function resolveWorkspaceRequestedTrack<T extends { id: number }>(
  requestedTrackId: number | null,
  playingTrack: T | null,
  selectedTrack: T | null,
  registeredTrack: T | null,
  retainedRequestedTrack: T | null,
): T | null {
  // 没有显式 id 时，当前列表选择就是未固定详情的唯一导航意图；播放器仅在
  // 列表也没有目标时兜底，不能盖过刚发生的本地跳转。
  if (requestedTrackId === null) return selectedTrack ?? playingTrack;
  for (const candidate of [playingTrack, selectedTrack, registeredTrack, retainedRequestedTrack]) {
    if (candidate?.id === requestedTrackId) return candidate;
  }
  return null;
}
