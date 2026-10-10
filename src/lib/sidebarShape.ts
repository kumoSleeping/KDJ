import { readLocalStorage, removeLocalStorage, writeLocalStorageNow } from "./storageWrite";

/**
 * 侧栏的宽窄按窗口形状各记各的：横向窗口（wide）和竖长窗口（tall，见
 * useLayoutMode）各有一份，用户在哪种形状里调，就只改哪一份。
 *
 * - wide 沿用原来的两个键，升级前的选择原样带过来。
 * - tall 只有一个键。还没有它的时候读 wide 当前的值，所以升级后不会跳；
 *   用户在竖长窗口里第一次调整时才写下它，从此两边各走各的。
 * - 只在用户调整时写。启动、窗口变形都只读。
 */
export type SidebarShape = "wide" | "tall";

export interface SidebarState {
  /** false = 只剩图标的窄轨。 */
  expanded: boolean;
  /** 展开时的宽度（px）。null = 没拖过，用样式表的默认宽度。 */
  width: number | null;
}

export const SIDEBAR_WIDE_EXPANDED_KEY = "kd-compact-tree-expanded";
export const SIDEBAR_WIDE_WIDTH_KEY = "kd-split-left";
export const SIDEBAR_TALL_KEY = "kd-sidebar-tall-v1";

function storedWidth(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

function readWide(defaultExpanded: boolean): SidebarState {
  const expanded = readLocalStorage(SIDEBAR_WIDE_EXPANDED_KEY);
  return {
    expanded: expanded === null ? defaultExpanded : expanded === "1",
    width: storedWidth(readLocalStorage(SIDEBAR_WIDE_WIDTH_KEY)),
  };
}

function readTall(): SidebarState | null {
  const raw = readLocalStorage(SIDEBAR_TALL_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SidebarState> | null;
    if (!value || typeof value !== "object" || typeof value.expanded !== "boolean") return null;
    return { expanded: value.expanded, width: storedWidth(value.width) };
  } catch {
    // 损坏的值当作没存过：回到 wide 的值，等用户下一次调整时重写。
    return null;
  }
}

/** `defaultExpanded` 只在 wide 也没存过展开状态时生效。 */
export function readSidebarState(shape: SidebarShape, defaultExpanded: boolean): SidebarState {
  return (shape === "tall" ? readTall() : null) ?? readWide(defaultExpanded);
}

/** 只由用户的调整调用；写的是 `shape` 这一份，另一份不动。 */
export function writeSidebarState(shape: SidebarShape, state: SidebarState): void {
  if (shape === "tall") {
    writeLocalStorageNow(SIDEBAR_TALL_KEY, JSON.stringify({ expanded: state.expanded, width: state.width }));
    return;
  }
  writeLocalStorageNow(SIDEBAR_WIDE_EXPANDED_KEY, state.expanded ? "1" : "0");
  if (state.width === null) removeLocalStorage(SIDEBAR_WIDE_WIDTH_KEY);
  else writeLocalStorageNow(SIDEBAR_WIDE_WIDTH_KEY, String(state.width));
}

export function sameSidebarState(a: SidebarState, b: SidebarState): boolean {
  return a.expanded === b.expanded && a.width === b.width;
}
