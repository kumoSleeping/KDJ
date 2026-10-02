import { completeSplit, splitGeometry, splitIds, type SplitDivider, type SplitRect, type SplitTree } from "./panelSplitLayout";

export type AutoPanelKind = "media" | "waveform" | "control" | "search" | "information" | "metadata" | "lyrics" | "content";
export interface AutoPanelItem {
  id: string;
  kind: AutoPanelKind;
  chrome: number;
  aspectRatio?: number;
  /** Natural content height at this width; the DOM adapter caches measurements per layout pass. */
  measure(width: number): number;
}
export interface PanelSizeRange {
  minWidth: number;
  preferredWidth: number;
  minHeight: number;
  preferredHeight: number;
  maxHeight: number;
}
export interface PanelDropOrder {
  id: string;
  target: string;
  edge: "top" | "bottom" | "left" | "right";
  scope: "panel" | "dock";
}
export interface AutoPanelLayout {
  tree: SplitTree;
  cells: Map<string, SplitRect>;
  ranges: Map<string, PanelSizeRange>;
  dividers: SplitDivider[];
  height: number;
  score: number;
}
const GAP = 6;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const widthUnits: Record<AutoPanelKind, [number, number]> = {
  media: [15, 32], waveform: [15, 36], control: [15, 33], search: [19, 34],
  information: [17, 24], metadata: [18, 25], lyrics: [16, 25], content: [16, 24],
};

export function autoPanelKind(id: string, picture = false): AutoPanelKind {
  if (picture) return "media";
  const kind = id.slice(id.lastIndexOf(":") + 1);
  if (kind === "visualizer") return "media";
  return ["waveform", "control", "search", "information", "metadata", "lyrics"].includes(kind) ? kind as AutoPanelKind : "content";
}

/** Limits describe readable content, not selectable pixel heights. Text is measured, not guessed. */
export function panelSizeRange(item: AutoPanelItem, width: number, budget: number, unit: number): PanelSizeRange {
  const [minimum, preferred] = widthUnits[item.kind];
  const base = { minWidth: minimum * unit, preferredWidth: preferred * unit };
  if (item.kind === "media") {
    const maximum = Math.min(width / (item.aspectRatio || 16 / 9), Math.max(0, budget - item.chrome));
    const minimum = Math.min(6 * unit, maximum);
    return { ...base, minHeight: item.chrome + minimum,
      preferredHeight: item.chrome + clamp(Math.min(16 * unit, budget * .7), minimum, maximum),
      maxHeight: item.chrome + maximum };
  }
  if (item.kind === "waveform") return { ...base, minHeight: item.chrome + 3 * unit,
    preferredHeight: item.chrome + clamp(width * .22, 5 * unit, 8 * unit), maxHeight: item.chrome + 16 * unit };
  if (item.kind === "lyrics") return { ...base, minHeight: item.chrome + 5 * unit,
    preferredHeight: item.chrome + Math.min(14 * unit, budget * .65), maxHeight: Math.max(item.chrome + 5 * unit, budget) };
  const natural = Math.max(item.chrome, item.measure(width));
  // Forms, metadata and long lists may scroll at the limit; ordinary short content never stretches.
  const maximum = Math.max(item.chrome + 4 * unit, budget * (item.kind === "control" || item.kind === "search" ? .6 : .85));
  const height = Math.min(natural, maximum);
  return { ...base, minHeight: height, preferredHeight: height, maxHeight: height };
}

type LayoutNode = {
  tree: SplitTree; width: number; height: number; min: number; max: number;
  item?: AutoPanelItem; range?: PanelSizeRange; a?: LayoutNode; b?: LayoutNode;
};
function updateHeight(node: LayoutNode) {
  if (!node.a || !node.b || "id" in node.tree) return;
  const combine = (a: number, b: number) => node.tree && !("id" in node.tree) && node.tree.axis === "x" ? Math.max(a, b) : a + GAP + b;
  node.height = combine(node.a.height, node.b.height);
  node.min = combine(node.a.min, node.b.min);
  node.max = combine(node.a.max, node.b.max);
}
function resizeHeight(node: LayoutNode, wanted: number) {
  const target = clamp(wanted, node.min, node.max);
  if (!node.a || !node.b || "id" in node.tree) { node.height = target; return; }
  if (node.tree.axis === "x") {
    resizeHeight(node.a, target); resizeHeight(node.b, target);
  } else {
    const delta = target - node.height;
    const aSpace = delta >= 0 ? node.a.max - node.a.height : node.a.height - node.a.min;
    const bSpace = delta >= 0 ? node.b.max - node.b.height : node.b.height - node.b.min;
    if (aSpace + bSpace > 0) {
      resizeHeight(node.a, node.a.height + delta * aSpace / (aSpace + bSpace));
      resizeHeight(node.b, node.b.height + delta * bSpace / (aSpace + bSpace));
    }
  }
  updateHeight(node);
}
function alignRows(node: LayoutNode) {
  if (!node.a || !node.b || "id" in node.tree) return;
  alignRows(node.a); alignRows(node.b); updateHeight(node);
  if (node.tree.axis === "x") {
    // Match the actual EQ form: a slim waveform beside one-row controls, or a
    // taller waveform beside the two-row form, without stretching the EQ frame.
    const control = node.a.item?.kind === "control" ? node.a : node.b.item?.kind === "control" ? node.b : null;
    const waveform = node.a.item?.kind === "waveform" ? node.a : node.b.item?.kind === "waveform" ? node.b : null;
    if (control && waveform) {
      resizeHeight(waveform, control.height);
      updateHeight(node);
    }
    resizeHeight(node.a, node.height); resizeHeight(node.b, node.height);
    updateHeight(node);
  }
}
function join(axis: "x" | "y", a: SplitTree, b: SplitTree, ratio = .5): SplitTree { return { axis, ratio, a, b }; }
function stack(trees: SplitTree[]): SplitTree | null {
  return trees.length ? trees.slice(1).reduce((a, b) => join("y", a, b), trees[0]) : null;
}
function rowTree(items: AutoPanelItem[]): SplitTree | null {
  if (!items.length) return null;
  if (items.length === 1) return { id: items[0].id };
  const weight = (item: AutoPanelItem) => widthUnits[item.kind][1];
  return join("x", { id: items[0].id }, rowTree(items.slice(1))!,
    weight(items[0]) / items.reduce((sum, item) => sum + weight(item), 0));
}
function rowCount(tree: SplitTree): number {
  if ("id" in tree) return 1;
  const a = rowCount(tree.a), b = rowCount(tree.b);
  return tree.axis === "x" ? Math.max(a, b) : a + b;
}
function growLyrics(node: LayoutNode, extra: number) {
  if (extra <= 0) return;
  if (node.item?.kind === "lyrics") { resizeHeight(node, node.height + extra); return; }
  if (!node.a || !node.b || "id" in node.tree) return;
  const oldHeight = node.height;
  if (node.tree.axis === "x") {
    growLyrics(node.a, oldHeight + extra - node.a.height);
    growLyrics(node.b, oldHeight + extra - node.b.height);
  } else {
    growLyrics(node.a, extra);
    updateHeight(node);
    growLyrics(node.b, Math.max(0, oldHeight + extra - node.height));
  }
  updateHeight(node);
}
function rowVariants(items: AutoPanelItem[]): SplitTree[] {
  const leaves = items.map(item => ({ id: item.id }));
  const result: SplitTree[] = [];
  const row = rowTree(items);
  if (row) result.push(row);
  for (let cut = 1; cut < items.length; cut++) {
    result.push(join("y", rowTree(items.slice(0, cut))!, rowTree(items.slice(cut))!));
  }
  if (items.length === 2 && items.some(item => item.kind === "control") && items.some(item => item.kind === "waveform")) {
    for (const ratio of [.3, .4, .5, .6, .7]) result.push(join("x", leaves[0], leaves[1], ratio));
  }
  const plain = stack(leaves);
  if (plain) result.push(plain);
  // Adjacent pairs let waveform/details share a row without squeezing every other panel.
  for (let index = 0; index < leaves.length - 1; index++) {
    result.push(stack([...leaves.slice(0, index), join("x", leaves[index], leaves[index + 1]), ...leaves.slice(index + 2)])!);
  }
  if (leaves.length > 3) result.push(stack(leaves.flatMap((leaf, index) => index % 2 ? []
    : [index + 1 < leaves.length ? join("x", leaf, leaves[index + 1]) : leaf]))!);
  return result;
}

/** Bounded candidate search: component readability, aspect, unused area, height and drag preferences. */
export function optimizePanelLayout(items: AutoPanelItem[], bounds: SplitRect, budget: number, unit: number,
  preference: SplitTree, previous?: SplitTree, scrollable = false, keepOrder = false, dropOrder?: PanelDropOrder, rowLimit = 2): AutoPanelLayout | null {
  if (!items.length || bounds.width <= 0) return null;
  const byId = new Map(items.map(item => [item.id, item]));
  const activeTree = (tree: SplitTree): SplitTree | null => {
    if ("id" in tree) return byId.has(tree.id) ? tree : null;
    const a = activeTree(tree.a), b = activeTree(tree.b);
    return a && b ? { ...tree, a, b } : a ?? b;
  };
  const order: Record<AutoPanelKind, number> = { search: 0, control: 1, waveform: 2, information: 3, metadata: 4, lyrics: 5, media: 6, content: 7 };
  const preferredIds = splitIds(preference);
  const ordered = [...items].sort((a, b) => order[a.kind] - order[b.kind] || preferredIds.indexOf(a.id) - preferredIds.indexOf(b.id));
  const candidates: SplitTree[] = [];
  const add = (tree: SplitTree | null) => {
    const full = completeSplit(tree ?? undefined, items.map(item => item.id));
    if (!full || (!scrollable && rowCount(full) > rowLimit)
      || (hasColumns(full) && minimumWidth(full) > bounds.width)) return null;
    candidates.push(full);
    return full;
  };
  const previousCandidate = previous ? add(activeTree(previous)) : null;
  const requested = add(activeTree(preference));
  const orderedKeys = new Set(requested ? [JSON.stringify(requested)] : []);
  if (keepOrder && requested) {
    // Users choose the composition; candidate widths may change without changing its ordering.
    const withRatio = (tree: SplitTree, ratio: number): SplitTree => "id" in tree ? tree
      : { ...tree, ratio: tree.axis === "x" ? ratio : tree.ratio,
        a: withRatio(tree.a, ratio), b: withRatio(tree.b, ratio) };
    for (const ratio of [.3, .4, .5, .6, .7]) {
      const candidate = add(withRatio(requested, ratio));
      if (candidate) orderedKeys.add(JSON.stringify(candidate));
    }
  }
  rowVariants(preferredIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])).forEach(add);
  rowVariants(ordered).forEach(add);
  const spanning = items.filter(item => item.kind === "media" || item.kind === "lyrics" || item.kind === "waveform");
  const ratios = [.36, .42, .48, .54, .60, .66];
  if (!("id" in preference) && preference.axis === "x") ratios.push(preference.ratio);
  const media = items.find(item => item.kind === "media");
  const waveform = items.find(item => item.kind === "waveform");
  if (media && waveform) {
    const middle = ordered.filter(item => item !== media && item !== waveform);
    for (const column of rowVariants(middle)) for (const ratio of [.28, .33, .38]) {
      add(join("x", { id: media.id }, join("x", column, { id: waveform.id }, .5), ratio));
    }
  }
  for (const picture of spanning) {
    const rest = ordered.filter(item => item !== picture);
    for (const column of rowVariants(rest)) for (const ratio of ratios) {
      add(join("x", { id: picture.id }, column, ratio));
      add(join("x", column, { id: picture.id }, 1 - ratio));
    }
  }
  if (!spanning.length) {
    for (let cut = 1; cut < ordered.length; cut++) for (const ratio of [.4, .5, .6]) {
      add(join("x", stack(ordered.slice(0, cut).map(item => ({ id: item.id })))!,
        stack(ordered.slice(cut).map(item => ({ id: item.id })))!, ratio));
    }
  }
  function minimumWidth(tree: SplitTree): number {
    if ("id" in tree) return widthUnits[byId.get(tree.id)!.kind][0] * unit;
    const a = minimumWidth(tree.a), b = minimumWidth(tree.b);
    return tree.axis === "x" ? a + GAP + b : Math.max(a, b);
  }
  const build = (tree: SplitTree, width: number): LayoutNode => {
    if ("id" in tree) {
      const item = byId.get(tree.id)!;
      const range = panelSizeRange(item, width, budget, unit);
      return { tree, width, height: range.preferredHeight, min: range.minHeight, max: range.maxHeight, item, range };
    }
    let aWidth = width, bWidth = width;
    if (tree.axis === "x") {
      const space = Math.max(0, width - GAP);
      aWidth = clamp(space * tree.ratio, minimumWidth(tree.a), space - minimumWidth(tree.b));
      bWidth = space - aWidth;
      tree = { ...tree, ratio: aWidth / Math.max(1, space) };
    }
    const a = build(tree.a, aWidth), b = build(tree.b, bWidth);
    const node: LayoutNode = { tree: { ...tree, a: a.tree, b: b.tree }, width, height: 0, min: 0, max: 0, a, b };
    updateHeight(node);
    return node;
  };
  const preferredBoxes = splitGeometry(preference, new Set(byId.keys()), bounds, () => 1).cells;
  const evaluate = (tree: SplitTree): AutoPanelLayout | null => {
    // A narrow viewport falls back to a full-width column, never unusably thin nested columns.
    if (minimumWidth(tree) > bounds.width && !("id" in tree) && hasColumns(tree)) return null;
    const root = build(tree, bounds.width);
    if (!scrollable && root.min > budget) return null;
    if (!scrollable && root.height > budget) resizeHeight(root, budget);
    // Sidebar scrolling preserves natural media size; spare height belongs to lyrics, not an empty footer.
    if (scrollable && root.height < budget) growLyrics(root, budget - root.height);
    alignRows(root);
    const cells = new Map<string, SplitRect>(), ranges = new Map<string, PanelSizeRange>();
    const dividers: SplitDivider[] = [];
    let occupied = 0, regret = 0, displacement = 0;
    const visit = (node: LayoutNode, left: number, top: number, path: string) => {
      if (node.item && node.range) {
        const { item, range } = node;
        const box = { left, top, width: node.width, height: node.height };
        cells.set(item.id, box); ranges.set(item.id, range);
        const body = Math.max(0, node.height - item.chrome);
        occupied += item.kind === "media" ? node.width * item.chrome + Math.min(node.width, body * (item.aspectRatio || 16 / 9)) * body : node.width * node.height;
        regret += Math.pow(Math.max(0, range.preferredWidth - node.width) / range.preferredWidth, 2) * (item.kind === "waveform" ? 2 : .6);
        regret += Math.pow((node.height - range.preferredHeight) / Math.max(1, range.preferredHeight), 2) * (item.kind === "media" ? 1.2 : .3);
        const preferred = preferredBoxes.get(item.id);
        if (preferred) displacement += Math.abs(left - preferred.left) / Math.max(1, bounds.width);
        return;
      }
      if (!node.a || !node.b || "id" in node.tree) return;
      visit(node.a, left, top, `${path}a`);
      if (node.tree.axis === "x") {
        dividers.push({ left: left + node.a.width, top, width: GAP, height: Math.min(node.a.height, node.b.height),
          bounds: { left, top, width: node.width, height: node.height }, path, axis: "x", ratio: node.tree.ratio });
        visit(node.b, left + node.a.width + GAP, top, `${path}b`);
      } else visit(node.b, left, top + node.a.height + GAP, `${path}b`);
    };
    visit(root, bounds.left, bounds.top, "");
    if (dropOrder) {
      const source = cells.get(dropOrder.id);
      const targets = dropOrder.scope === "dock" ? [...cells.entries()].filter(([id]) => id !== dropOrder.id).map(([, box]) => box)
        : cells.has(dropOrder.target) ? [cells.get(dropOrder.target)!] : [];
      if (!source || !targets.length || !targets.every(target => {
        const horizontalOverlap = source.left < target.left + target.width && source.left + source.width > target.left;
        const verticalOverlap = source.top < target.top + target.height && source.top + source.height > target.top;
        switch (dropOrder.edge) {
          case "top": return source.top + source.height <= target.top + .5 && horizontalOverlap;
          case "bottom": return source.top >= target.top + target.height - .5 && horizontalOverlap;
          case "left": return source.left + source.width <= target.left + .5 && verticalOverlap;
          case "right": return source.left >= target.left + target.width - .5 && verticalOverlap;
        }
      })) return null;
    }
    const area = Math.max(1, bounds.width * root.height);
    const score = (scrollable ? 0 : Math.max(0, root.height - budget) / Math.max(1, budget) * 40)
      + Math.max(0, 1 - occupied / area) * 5 + root.height / Math.max(1, budget) * .7
      + regret / items.length + displacement / items.length * .12;
    // Keep hidden cards in memory so a later explicit resize cannot discard their identities.
    return { tree: completeSplit(root.tree, preferredIds)!, cells, ranges, dividers, height: root.height, score };
  };
  let best: AutoPanelLayout | null = null, incumbent: AutoPanelLayout | null = null, orderedBest: AutoPanelLayout | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 160)) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = evaluate(candidate);
    if (candidate === previousCandidate) incumbent = result;
    if (result && orderedKeys.has(key) && (!orderedBest || result.score < orderedBest.score)) orderedBest = result;
    if (result && (!best || result.score < best.score)) best = result;
  }
  if (keepOrder) return orderedBest;
  // Small content/rounding changes must not make cards oscillate between equivalent layouts.
  return incumbent && best && incumbent.score <= best.score + .04 ? incumbent : best;
}
function hasColumns(tree: SplitTree): boolean { return !("id" in tree) && (tree.axis === "x" || hasColumns(tree.a) || hasColumns(tree.b)); }
