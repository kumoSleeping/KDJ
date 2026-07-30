/**
 * 曲库表 / 下载结果表共用的列偏好：顺序、显隐、宽度。
 * 存 id 列表而不是完整快照——以后加新列时旧存档仍可用。
 */

export interface TableColumnPrefs {
  order: string[];
  hidden: string[];
  /** 用户拖过的列宽（rem / px 字符串）。 */
  widths: Record<string, string>;
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

export function loadTableColumnPrefs(
  storageKey: string,
  /** 永远不准藏的列（读档时就滤掉）。 */
  lockedVisible: readonly string[] = ["title"],
): TableColumnPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (raw && typeof raw === "object") {
      const { order, hidden, widths } = raw as Record<string, unknown>;
      const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
      const widthMap: Record<string, string> = {};
      if (widths && typeof widths === "object") {
        for (const [key, value] of Object.entries(widths as Record<string, unknown>)) {
          if (typeof value === "string" && remStringToPx(value) > 0) widthMap[key] = value;
        }
      }
      const locked = new Set(lockedVisible);
      return {
        order: strings(order),
        hidden: strings(hidden).filter((key) => !locked.has(key)),
        widths: widthMap,
      };
    }
  } catch {
    // 存档坏了就用默认
  }
  return { ...EMPTY_COLUMN_PREFS, widths: {} };
}

export function saveTableColumnPrefs(storageKey: string, prefs: TableColumnPrefs): void {
  localStorage.setItem(storageKey, JSON.stringify(prefs));
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
      callbacks.onDragged?.();
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
