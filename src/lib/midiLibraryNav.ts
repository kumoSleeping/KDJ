/**
 * MIDI 选歌旋钮：侧边栏 ↔ 列表板块，转动步进，Load 装入 Deck。
 * Reloop Buddy 的 browse 旋钮按下会在这两个焦点之间切换；侧边栏当前项
 * 决定进哪一个板块（本地曲库 / 搜索）。
 */

export const MIDI_BROWSE_EVENT = "kd:midi-browse";
export const MIDI_LOAD_DECK_EVENT = "kd:midi-load-deck";
export const MIDI_BROWSE_ITEM_ATTR = "data-kd-browse-item";
export const MIDI_BROWSE_PANE_ATTR = "data-kd-browse-pane";
export const MIDI_BROWSE_CURSOR_ATTR = "data-kd-browse-cursor";
export const MIDI_BROWSE_ID_ATTR = "data-kd-browse-id";

export function midiBrowseItemProps(pane: MidiBrowsePane, id: string): Record<string, string> {
  return {
    [MIDI_BROWSE_ITEM_ATTR]: "",
    [MIDI_BROWSE_PANE_ATTR]: pane,
    [MIDI_BROWSE_ID_ATTR]: id,
  };
}

export type MidiBrowseFocus = "sidebar" | "pane";
export type MidiBrowsePane = "local" | "search";

export type MidiBrowseDetail =
  | { type: "step"; delta: number }
  | { type: "press" }
  | { type: "load"; deck: 0 | 1 };

export interface MidiLoadDeckDetail {
  side: 0 | 1;
  trackId?: number;
  contentId?: number;
}

export function toggleBrowseFocus(focus: MidiBrowseFocus): MidiBrowseFocus {
  return focus === "sidebar" ? "pane" : "sidebar";
}

export function paneForSidebarHint(value: string | undefined): MidiBrowsePane {
  if (value === "search" || value === "local") return value;
  return "local";
}

/** 旋钮每一格只走一步，到头停住，不循环。未选时正向从 0、反向从末尾开始。 */
export function nextBrowseIndex(length: number, current: number, delta: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(delta) || delta === 0) return Math.min(length - 1, Math.max(0, current));
  const step = delta > 0 ? 1 : -1;
  if (current < 0 || current >= length) return step > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + step));
}

/**
 * 侧栏步进位置。优先用上次旋钮停过的 id；React 重绘会丢掉 DOM cursor。
 * 不能用「第一个 data-active」：全部曲目和网易云可以同时亮，会永远卡在这两项之间。
 */
export function currentBrowseIndex(items: HTMLElement[], cursorId: string | null): number {
  if (cursorId) {
    const byId = items.findIndex((item) => item.getAttribute(MIDI_BROWSE_ID_ATTR) === cursorId);
    if (byId >= 0) return byId;
  }
  const byCursor = items.findIndex((item) => item.getAttribute(MIDI_BROWSE_CURSOR_ATTR) === "true");
  if (byCursor >= 0) return byCursor;
  const actives = items.flatMap((item, index) => (item.dataset.active === "true" ? [index] : []));
  return actives.length === 1 ? actives[0] : -1;
}

let midiBrowseActivating = false;

/** 旋钮打开侧栏项时为 true；文件夹/网易云根不要按单击那样再点一次就收起。 */
export function isMidiBrowseActivate(): boolean {
  return midiBrowseActivating;
}

export function activateBrowseItem(item: HTMLElement): void {
  midiBrowseActivating = true;
  try {
    item.click();
  } finally {
    midiBrowseActivating = false;
  }
}
