import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "./storageWrite";
import { useToastStore } from "../stores/toastStore";

export type SplitSide = "top" | "right";
export type SplitEdge = "left" | "right" | "top" | "bottom";
export type SplitTree = { id: string } | { axis: "x" | "y"; ratio: number; a: SplitTree; b: SplitTree };
export type SplitRect = { left: number; top: number; width: number; height: number };
export type SplitLayout = { tree: SplitTree; height?: number; [key: string]: unknown };
export type SplitDivider = SplitRect & { path: string; axis: "x" | "y"; ratio: number; bounds: SplitRect };
const KEY = "kd-panel-splits-v1";
const GAP = 6;
type Document = Record<string, unknown> & { top?: SplitLayout; right?: SplitLayout };

function load(): { document: Document; readOnlyReason: string | null } {
  const paths: string[] = [];
  const check = (node: unknown, path: string, ids: Set<string>, depth = 0): boolean => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 64) { paths.push(path); return false; }
    const value = node as Record<string, unknown>;
    const leaf = typeof value.id === "string";
    const keys = leaf ? ["id"] : ["axis", "ratio", "a", "b"];
    for (const key of Object.keys(value)) if (!keys.includes(key)) paths.push(`${path}.${key}`);
    if (leaf) {
      if (!value.id || ids.has(value.id as string)) paths.push(`${path}.id`);
      ids.add(value.id as string);
    } else {
      if ((value.axis !== "x" && value.axis !== "y") || typeof value.ratio !== "number"
        || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio >= 1) paths.push(path);
      check(value.a, `${path}.a`, ids, depth + 1); check(value.b, `${path}.b`, ids, depth + 1);
    }
    return paths.length === 0;
  };
  try {
    const value = JSON.parse(readLocalStorage(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    for (const side of ["top", "right"] as const) {
      const layout = value[side];
      if (layout === undefined) continue;
      if (!layout || typeof layout !== "object" || Array.isArray(layout)
        || (layout.height !== undefined && (!Number.isFinite(layout.height) || layout.height <= 0))) paths.push(side);
      else check(layout.tree, `${side}.tree`, new Set());
    }
    if (!paths.length) return { document: value, readOnlyReason: null };
  } catch { paths.push(KEY); }
  return { document: {}, readOnlyReason: `分屏布局无法无损读取，已禁止覆盖：${paths.join("、")}` };
}

export function splitIds(tree: SplitTree): string[] {
  return "id" in tree ? [tree.id] : [...splitIds(tree.a), ...splitIds(tree.b)];
}
export function removeSplit(tree: SplitTree, id: string): SplitTree | null {
  if ("id" in tree) return tree.id === id ? null : tree;
  const a = removeSplit(tree.a, id), b = removeSplit(tree.b, id);
  return a && b ? { ...tree, a, b } : a ?? b;
}
export function insertSplit(tree: SplitTree | null, id: string, target: string, edge: SplitEdge): SplitTree {
  if (!tree) return { id };
  if ("id" in tree) {
    if (tree.id !== target) return tree;
    const first = edge === "left" || edge === "top";
    return { axis: edge === "left" || edge === "right" ? "x" : "y", ratio: .5,
      a: first ? { id } : tree, b: first ? tree : { id } };
  }
  return { ...tree, a: insertSplit(tree.a, id, target, edge), b: insertSplit(tree.b, id, target, edge) };
}
export function completeSplit(tree: SplitTree | undefined, ids: string[]): SplitTree | null {
  let next = tree ?? null;
  const existing = new Set(tree ? splitIds(tree) : []);
  for (const id of ids) if (!existing.has(id)) {
    next = next ? { axis: "y", ratio: .7, a: next, b: { id } } : { id };
    existing.add(id);
  }
  return next;
}
function changeRatio(tree: SplitTree, path: string, ratio: number): SplitTree {
  if ("id" in tree) return tree;
  if (!path) return { ...tree, ratio: Math.max(.05, Math.min(.95, ratio)) };
  const child = path[0] === "a" ? "a" : "b";
  return { ...tree, [child]: changeRatio(tree[child], path.slice(1), ratio) };
}

export const usePanelSplits = create<{
  document: Document;
  readOnlyReason: string | null;
  save(side: SplitSide, layout: SplitLayout, movedId?: string): boolean;
  resize(side: SplitSide, tree: SplitTree, path: string, ratio: number): void;
}>((set, get) => ({
  ...load(),
  save(side, layout, movedId) {
    const state = get();
    if (state.readOnlyReason) { useToastStore.getState().show(state.readOnlyReason); return false; }
    const document = { ...state.document, [side]: { ...state.document[side], ...layout } };
    const other = side === "top" ? "right" : "top";
    if (movedId && document[other]) {
      const tree = removeSplit(document[other].tree, movedId);
      if (tree) document[other] = { ...document[other], tree };
      else delete document[other];
    }
    writeLocalStorageNow(KEY, JSON.stringify(document));
    set({ document });
    return true;
  },
  resize(side, tree, path, ratio) {
    const layout = get().document[side];
    if (layout) get().save(side, { ...layout, tree: changeRatio(tree, path, ratio) });
  },
}));

/** Recover the current stacked/preset geometry on the first manual split. */
export function inferSplit(items: { id: string; box: SplitRect }[]): SplitTree | null {
  if (!items.length) return null;
  if (items.length === 1) return { id: items[0].id };
  for (const axis of ["y", "x"] as const) {
    const position = axis === "x" ? "left" : "top", size = axis === "x" ? "width" : "height";
    const sorted = [...items].sort((a, b) => a.box[position] - b.box[position]);
    for (let i = 1; i < sorted.length; i++) {
      const end = Math.max(...sorted.slice(0, i).map(item => item.box[position] + item.box[size]));
      if (end > sorted[i].box[position] + 2) continue;
      const start = sorted[0].box[position];
      const total = Math.max(...sorted.map(item => item.box[position] + item.box[size])) - start;
      return { axis, ratio: Math.max(.05, Math.min(.95, (end - start) / Math.max(1, total))),
        a: inferSplit(sorted.slice(0, i))!, b: inferSplit(sorted.slice(i))! };
    }
  }
  return { axis: "y", ratio: 1 / items.length, a: { id: items[0].id }, b: inferSplit(items.slice(1))! };
}

/** Hidden leaves retain their placement. With measured heights, only widths follow split ratios. */
export function splitGeometry(tree: SplitTree, visible: Set<string>, bounds: SplitRect, heightFor?: (id: string) => number) {
  const cells = new Map<string, SplitRect>();
  const dividers: SplitDivider[] = [];
  const active = (node: SplitTree): boolean => "id" in node ? visible.has(node.id) : active(node.a) || active(node.b);
  const heights = new Map<SplitTree, number>();
  const measure = (node: SplitTree): number => {
    if (!heightFor) return bounds.height;
    const cached = heights.get(node);
    if (cached !== undefined) return cached;
    const a = "id" in node ? 0 : measure(node.a), b = "id" in node ? 0 : measure(node.b);
    const height = "id" in node ? visible.has(node.id) ? heightFor(node.id) : 0
      : !a ? b : !b ? a : node.axis === "x" ? Math.max(a, b) : a + GAP + b;
    heights.set(node, height);
    return height;
  };
  let height = heightFor ? measure(tree) : bounds.height;
  const visit = (node: SplitTree, box: SplitRect, path: string) => {
    if (heightFor) box = { ...box, height: measure(node) };
    if ("id" in node) { if (visible.has(node.id)) cells.set(node.id, box); return; }
    if (!active(node.a)) { visit(node.b, box, `${path}b`); return; }
    if (!active(node.b)) { visit(node.a, box, `${path}a`); return; }
    if (heightFor && node.axis === "y") {
      visit(node.a, box, `${path}a`);
      visit(node.b, { ...box, top: box.top + measure(node.a) + GAP }, `${path}b`);
      return;
    }
    const size = node.axis === "x" ? "width" : "height", position = node.axis === "x" ? "left" : "top";
    const space = Math.max(0, box[size] - GAP);
    const minimum = Math.min(node.axis === "x" ? 100 : 48, space / 2);
    const first = Math.max(minimum, Math.min(space - minimum, space * node.ratio));
    visit(node.a, { ...box, [size]: first }, `${path}a`);
    dividers.push({ ...box, [position]: box[position] + first, [size]: GAP, bounds: box,
      axis: node.axis, ratio: space > 0 ? first / space : .5, path });
    visit(node.b, { ...box, [position]: box[position] + first + GAP, [size]: space - first }, `${path}b`);
  };
  visit(tree, bounds, "");
  if (heightFor) {
    // Keep the saved horizontal placement and reading order, but let each column
    // rise independently. A tall sibling must not reserve a whole empty row.
    const placed: SplitRect[] = [];
    for (const [id, box] of cells) {
      const top = placed.reduce((bottom, previous) =>
        previous.left < box.left + box.width - .5 && previous.left + previous.width > box.left + .5
          ? Math.max(bottom, previous.top + previous.height + GAP) : bottom, bounds.top);
      const next = { ...box, top };
      cells.set(id, next);
      placed.push(next);
    }
    height = Math.max(0, ...placed.map(box => box.top + box.height - bounds.top));
    // Draw handles only where two cards actually meet. Extending them through
    // empty space makes the old equal-height cell frames appear to remain.
    const segments: SplitDivider[] = [];
    for (const divider of dividers) {
      let node = tree;
      for (const branch of divider.path) if (!("id" in node)) node = branch === "a" ? node.a : node.b;
      if ("id" in node) continue;
      const boxes = (part: SplitTree) => splitIds(part).flatMap(id => cells.has(id) ? [cells.get(id)!] : []);
      const left = boxes(node.a).filter(box => Math.abs(box.left + box.width - divider.left) < 1);
      const right = boxes(node.b).filter(box => Math.abs(box.left - divider.left - GAP) < 1);
      for (const a of left) for (const b of right) {
        const top = Math.max(a.top, b.top), bottom = Math.min(a.top + a.height, b.top + b.height);
        if (bottom > top) segments.push({ ...divider, top, height: bottom - top,
          bounds: { ...divider.bounds, top, height: bottom - top } });
      }
    }
    dividers.splice(0, dividers.length, ...segments);
  }
  return { cells, dividers, height };
}

export function splitRatioAt(divider: SplitDivider, x: number, y: number) {
  const box = divider.bounds;
  const size = divider.axis === "x" ? box.width : box.height;
  const minimum = Math.min(divider.axis === "x" ? 100 : 48, Math.max(0, size - GAP) / 2);
  const offset = divider.axis === "x" ? x - box.left : y - box.top;
  return Math.max(.05, Math.min(.95, Math.max(minimum, Math.min(size - GAP - minimum, offset)) / Math.max(1, size - GAP)));
}
