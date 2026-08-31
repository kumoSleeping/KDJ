/**
 * 曲库表 / 下载结果表共用的列偏好：顺序、显隐、宽度。
 * 存 id 列表而不是完整快照——以后加新列时旧存档仍可用。
 */

import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";

export interface TableColumnPrefs {
  order: string[];
  hidden: string[];
  /** 用户拖过的列宽（rem / px 字符串）。 */
  widths: Record<string, string>;
}

/**
 * 一张表自己的列 schema。
 *
 * `columnKeys` 只包含可换序 / 显隐的数据列；固定在左侧的序号列等只放进
 * `widthKeys`。这样曲库表与在线结果表即使都有 title / artist，也只会在各自
 * storage key 和各自 schema 内恢复，旧存档里已经删除或来自别张表的 key 会被丢掉。
 */
export interface TableColumnPrefsSchema {
  columnKeys: readonly string[];
  widthKeys?: readonly string[];
  /** 永远不准藏的数据列。 */
  lockedVisible?: readonly string[];
  /** 每列允许的最小宽度；没写时只要求大于 0。 */
  minWidths?: Readonly<Record<string, string>>;
  /** 防止损坏的存档把表格撑到不可操作；正常拖拽远达不到这个上限。 */
  maxWidth?: string;
}

export const EMPTY_COLUMN_PREFS: TableColumnPrefs = {
  order: [],
  hidden: [],
  widths: {},
};

export function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function remStringToPx(value: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.trim().endsWith("px") ? n : n * rootFontPx();
}

export function pxToRemString(px: number): string {
  return `${Math.round((px / rootFontPx()) * 100) / 100}rem`;
}

function storedWidthToPx(value: unknown): number | null {
  if (typeof value !== "string") return null;
  // 只接受本模块会写出的两种 CSS 长度。parseFloat("12garbage") 也会得到 12，
  // 不能让这种损坏值进入 <col style>。
  const match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(rem|px)$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return match[2] === "px" ? number : number * rootFontPx();
}

function uniqueKnownStrings(value: unknown, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/** 把旧版本、缺列、重复 key 和损坏/越界宽度归一化到当前表 schema。 */
export function normalizeTableColumnPrefs(
  raw: unknown,
  schema: TableColumnPrefsSchema,
): TableColumnPrefs {
  const columnKeys = new Set(schema.columnKeys);
  const widthKeys = new Set(schema.widthKeys ?? schema.columnKeys);
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const locked = new Set(schema.lockedVisible ?? ["title"]);
  const maxPx = storedWidthToPx(schema.maxWidth ?? "80rem") ?? 80 * rootFontPx();
  const widths: Record<string, string> = {};

  const rawWidths = record.widths;
  if (rawWidths && typeof rawWidths === "object" && !Array.isArray(rawWidths)) {
    for (const [key, value] of Object.entries(rawWidths as Record<string, unknown>)) {
      if (!widthKeys.has(key)) continue;
      const widthPx = storedWidthToPx(value);
      if (widthPx === null) continue;
      const minPx = storedWidthToPx(schema.minWidths?.[key]) ?? 1;
      widths[key] = pxToRemString(Math.min(maxPx, Math.max(minPx, widthPx)));
    }
  }

  return {
    order: uniqueKnownStrings(record.order, columnKeys),
    hidden: uniqueKnownStrings(record.hidden, columnKeys).filter((key) => !locked.has(key)),
    widths,
  };
}

export function loadTableColumnPrefs(
  storageKey: string,
  schema: TableColumnPrefsSchema,
): TableColumnPrefs {
  try {
    const raw: unknown = JSON.parse(readLocalStorage(storageKey) ?? "null");
    return normalizeTableColumnPrefs(raw, schema);
  } catch {
    // 存档坏了就用默认
  }
  return { ...EMPTY_COLUMN_PREFS, widths: {} };
}

export function saveTableColumnPrefs(
  storageKey: string,
  prefs: TableColumnPrefs,
  schema: TableColumnPrefsSchema,
): TableColumnPrefs {
  const normalized = normalizeTableColumnPrefs(prefs, schema);
  try {
    writeLocalStorageNow(storageKey, JSON.stringify(normalized));
  } catch {
    // 存储不可用时不该让拖拽本身失效；本次会话仍由 React state 保留。
  }
  return normalized;
}

/** 按用户顺序排；没记过的列保持默认相对次序排在后面。 */
export function orderByPrefs<T extends { key: string }>(
  columns: readonly T[],
  order: readonly string[],
): T[] {
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...columns].sort((a, b) => rank(a.key) - rank(b.key));
}

export function moveColumnOrder(
  currentOrder: readonly string[],
  visibleKeys: readonly string[],
  from: string,
  to: string,
): string[] {
  if (from === to) return [...currentOrder];
  // 以当前可见顺序为基准重排（含尚未写入 order 的新列）
  const base = visibleKeys.length > 0 ? [...visibleKeys] : [...currentOrder];
  const next = base.filter((id) => id !== from);
  const toIndex = base.indexOf(to);
  if (toIndex < 0) return base;
  next.splice(toIndex, 0, from);
  return next;
}

interface ColumnPointerStart {
  button: number;
  clientX: number;
  clientY: number;
}

interface ColumnPointerReorderCallbacks {
  onStart: (key: string) => void;
  onOver: (key: string | null) => void;
  onMove: (from: string, to: string) => void;
  onEnd: () => void;
  /** 真正越过拖动阈值时调用，用来拦掉松手后浏览器补发的排序 click。 */
  onDragged?: () => void;
}

/**
 * 用指针事件拖排列头。
 *
 * WKWebView 对 `<th draggable>` 的 HTML5 drag/drop 支持不稳定：列宽可以拖，列头却
 * 经常只收到 click。改用和曲目拖放相同的 pointer 路径，移动到哪个表头就以哪个
 * 表头为落点；5px 阈值保留普通点击排序。
 */
export function beginColumnPointerReorder(
  event: ColumnPointerStart,
  sourceKey: string,
  visibleKeys: readonly string[],
  callbacks: ColumnPointerReorderCallbacks,
): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const allowed = new Set(visibleKeys);
  let active = false;
  let targetKey: string | null = null;

  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    document.body.removeAttribute("data-kd-col-dragging");
  };

  const onMove = (moveEvent: PointerEvent) => {
    if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
    if (!active) {
      active = true;
      document.body.dataset.kdColDragging = "true";
      callbacks.onStart(sourceKey);
    }
    moveEvent.preventDefault();
    const hit = document
      .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
      ?.closest<HTMLElement>("thead th[data-col]");
    const key = hit?.dataset.col ?? null;
    targetKey = key && key !== sourceKey && allowed.has(key) ? key : null;
    callbacks.onOver(targetKey);
  };

  const onUp = () => {
    finish();
    // 浏览器会在 pointerup 后补发 click。必须在松手这一刻才上锁：若在刚越过
    // 阈值时上锁，用户多拖一会儿，0ms 解锁早已执行，最终仍会误触发表头排序。
    // 只要定位线曾进入拖动态就消费 click，与是否命中有效落点无关。
    if (active) callbacks.onDragged?.();
    if (active && targetKey) callbacks.onMove(sourceKey, targetKey);
    callbacks.onEnd();
  };

  const onCancel = () => {
    finish();
    callbacks.onEnd();
  };

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
