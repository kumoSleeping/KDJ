export const TRACK_DRAG_STATE_EVENT = "kd:track-drag-state";
export const TRACK_TRASH_DROP_EVENT = "kd:track-trash-drop";
/** 详情栏封面框接收曲目拖放时的跨组件事件。 */
export const TRACK_COVER_DROP_EVENT = "kd:track-cover-drop";
/** 不用字符串散落在 TrackTable 和 TrackDetail 两处，避免拖放目标漂移。 */
export const TRACK_COVER_DROP_TARGET_ATTR = "data-kd-track-cover-drop";

export interface TrackCoverDropDetail {
  ids: number[];
  targetTrackId: number;
}

/** 与 FolderTree 里的 MIME 保持一致；WebKit 有时在 dragover 不暴露它。 */
export const TRACK_DND_TYPE = "application/x-kdj-tracks";
/** text/plain 后备前缀：Safari/WKWebView 常只肯在 dragover 里报 text/plain。 */
export const TRACK_DND_TEXT_PREFIX = "kdj-tracks:";
const TRACK_DRAG_END_GRACE_MS = 1800;

export interface TrackDragDetail {
  ids: number[];
}

/** pointer 拖放结束后，挡住封面框上的合成 click，避免误打开文件选择器。 */
let suppressCoverClickUntil = 0;

export function suppressCoverClickAfterTrackDrop(): void {
  suppressCoverClickUntil = Date.now() + 700;
}

export function consumeSuppressedCoverClick(): boolean {
  if (Date.now() > suppressCoverClickUntil) {
    suppressCoverClickUntil = 0;
    return false;
  }
  suppressCoverClickUntil = 0;
  return true;
}

/** 统一发出“把这些曲目的封面给目标曲目复用”事件。 */
export function dispatchTrackCoverDrop(ids: number[], targetTrackId: number): void {
  if (ids.length === 0 || !Number.isFinite(targetTrackId)) return;
  window.dispatchEvent(
    new CustomEvent<TrackCoverDropDetail>(TRACK_COVER_DROP_EVENT, {
      detail: { ids: [...ids], targetTrackId },
    }),
  );
}

/** 进程内当前正在拖的曲目。drop 目标在 MIME 读不到时靠它认人。 */
let activeIds: number[] = [];
let dragEpoch = 0;
/** dragend 兜底和稍后到达的原生 drop 只能有一个消费这次载荷。 */
let dropClaimed = false;

function emitTrackDragState(ids: number[]): void {
  window.dispatchEvent(new CustomEvent<TrackDragDetail>(TRACK_DRAG_STATE_EVENT, { detail: { ids } }));
}

export function announceTrackDrag(ids: number[]): void {
  activeIds = [...ids];
  dragEpoch += 1;
  dropClaimed = false;
  emitTrackDragState(ids);
}

export function endTrackDrag(): void {
  // WKWebView 偶尔先送 dragend、后送 drop，而且跨过横向滚动表格到文件夹树时
  // 两者可能隔开多个 event loop。短暂保留进程内载荷；新的拖动开始后不清它。
  const endingEpoch = dragEpoch;
  // 载荷可以为迟到的 drop 暂存，但界面反馈必须在松手时马上消失。
  emitTrackDragState([]);
  window.setTimeout(() => {
    if (dragEpoch !== endingEpoch) return;
    activeIds = [];
  }, TRACK_DRAG_END_GRACE_MS);
}

/** drop 已经读取完 id 时立即收尾；与 dragend 的容错延迟分开。 */
export function finishTrackDrop(): void {
  dragEpoch += 1;
  activeIds = [];
  emitTrackDragState([]);
}

export function activeTrackDragIds(): readonly number[] {
  return activeIds;
}

/**
 * dragend 坐标兜底专用：同步认领仍在进程内的曲目，防止迟到的原生 drop 再执行一次。
 */
export function claimActiveTrackDragIds(): number[] {
  if (dropClaimed || activeIds.length === 0) return [];
  dropClaimed = true;
  const ids = [...activeIds];
  finishTrackDrop();
  return ids;
}

/** dragover 阶段判断是不是曲目拖拽（兼容 WebKit 隐藏自定义 MIME）。 */
export function isTrackDrag(event: { dataTransfer: DataTransfer | null }): boolean {
  // 进程内登记优先：WKWebView 常常在 dragover 里不暴露 application/x-*。
  if (activeIds.length > 0) return true;
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  return types.some((type) => type.toLowerCase() === TRACK_DND_TYPE);
}

/** 写入拖拽载荷：自定义 MIME + text/plain 双份。 */
export function writeTrackDragData(dataTransfer: DataTransfer, ids: number[]): void {
  const payload = JSON.stringify(ids);
  // 先登记，再写 WebKit 接受度最高的 text/plain；自定义 MIME 被拒绝时，
  // text/plain + activeIds 仍能让文件夹、OneLibrary 和播放器完成 drop。
  announceTrackDrag(ids);
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData("text/plain", `${TRACK_DND_TEXT_PREFIX}${payload}`);
  try {
    dataTransfer.setData(TRACK_DND_TYPE, payload);
  } catch {
    // text/plain + activeIds 足够完成拖放。
  }
}

/** drop 时读出曲目 id。 */
export function readTrackDragIds(dataTransfer: DataTransfer): number[] {
  if (dropClaimed) return [];
  const parse = (raw: string): number[] => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
        : [];
    } catch {
      return [];
    }
  };
  const typed = dataTransfer.getData(TRACK_DND_TYPE);
  if (typed) {
    const ids = parse(typed);
    if (ids.length) return ids;
  }
  const plain = dataTransfer.getData("text/plain");
  if (plain.startsWith(TRACK_DND_TEXT_PREFIX)) {
    const ids = parse(plain.slice(TRACK_DND_TEXT_PREFIX.length));
    if (ids.length) return ids;
  }
  // 最后兜底：MIME 读空但进程内还记着这次拖拽
  return [...activeIds];
}
