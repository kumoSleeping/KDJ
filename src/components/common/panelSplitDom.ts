import { completeSplit, inferSplit, insertSplit, removeSplit, splitGeometry, splitIds, usePanelSplits,
  type SplitEdge, type SplitRect, type SplitSide, type SplitTree, type SplitLayout } from "../../lib/panelSplitLayout";

import { optimizePanelLayout, type PanelDropOrder } from "../../lib/panelAutoLayout";
import { panelItemsForIds, panelLayoutBudget } from "./autoPanelLayoutDom";

// Derived layouts are transient. Resizing/reflow must never rewrite the user's saved composition.
const renderedTrees = new WeakMap<HTMLElement, { saved: SplitLayout | undefined; tree: SplitTree }>();
export function setRenderedPanelTree(zone: HTMLElement, side: SplitSide, tree: SplitTree | null) {
  if (tree) renderedTrees.set(zone, { saved: usePanelSplits.getState().document[side], tree });
  else renderedTrees.delete(zone);
}

export function splitHosts(zone: HTMLElement, measure = true) {
  // Only reparented hosts belong to the dock solver. Inline portal anchors
  // inside the dock's normal-flow content retain their own layout, including
  // while the dock registry is initializing or refreshing during HMR.
  return Array.from(zone.querySelectorAll<HTMLElement>(":scope > [data-panel-dock-id]")).flatMap(host => {
    const id = host.dataset.panelDockId;
    const slot = host.querySelector<HTMLElement>(":scope > .kd-panel-slot, :scope > .kd-internal-window[data-docked]");
    if (!id || !slot || !slot.children.length || slot.hidden
      || (slot.classList.contains("kd-panel-slot") && !slot.querySelector(".kd-panel"))) return [];
    for (let parent: HTMLElement | null = slot; parent && parent !== zone; parent = parent.parentElement) {
      if (parent.hidden) return [];
    }
    return [{ id, host, slot, box: measure ? slot.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } }];
  });
}

export function dockSplitModel(zone: HTMLElement, side: SplitSide) {
  const hosts = splitHosts(zone);
  const saved = usePanelSplits.getState().document[side];
  const preferenceTree = completeSplit(saved?.tree ?? inferSplit(hosts) ?? undefined, hosts.map(item => item.id));
  const rendered = renderedTrees.get(zone);
  const tree = completeSplit(rendered?.saved === saved ? rendered?.tree ?? preferenceTree ?? undefined : preferenceTree ?? undefined, hosts.map(item => item.id));
  // Download/settings panels are not portable stack cards. Keep their normal-flow
  // area above the split surface instead of placing live cards over them.
  const fixed = side === "right" ? Array.from(zone.children).filter((node): node is HTMLElement => node instanceof HTMLElement
    && !node.matches(".kd-panel-live-host, .kd-activity-panel-host, .kd-panel-split-divider, .kd-panel-split-height")) : [];
  const fixedHeight = fixed.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
  const slots = new Map(hosts.map(item => [item.id, item.slot]));
  const heightFor = (id: string) => slots.get(id)?.getBoundingClientRect().height ?? 0;
  const height = tree ? splitGeometry(tree, new Set(slots.keys()),
    { left: 0, top: 0, width: zone.clientWidth, height: 0 }, heightFor).height + 8 : 0;
  const bounds = { left: 4, top: fixedHeight + 4, width: Math.max(0, zone.clientWidth - 8), height: Math.max(0, height - 8) };
  return { hosts, tree, preferenceTree, keepOrder: saved?.ordered === true, height, bounds, fixedHeight, fixed, heightFor };
}

export function panelCompositionPlan(zone: HTMLElement, side: SplitSide, ids: Iterable<string>, preference?: SplitTree, dropOrder?: PanelDropOrder) {
  const model = dockSplitModel(zone, side);
  const items = panelItemsForIds(ids);
  const tree = completeSplit(preference, items.map(item => item.id));
  if (!tree || !items.length) return null;
  const wideId = zone.parentElement?.querySelector<HTMLElement>(".kd-top-wide-search [data-panel-dock-id]")?.dataset.panelDockId;
  const { unit, budget, rows } = panelLayoutBudget(zone, model.fixedHeight, items.some(item => item.id === wideId));
  const exact = optimizePanelLayout(items, model.bounds, budget, unit, tree, undefined, side === "right", !!preference, undefined, rows);
  if (exact || !dropOrder) return exact;
  // A direct insertion can create a third row even though the same cards fit in
  // two. Repack while enforcing the requested relative position, not the old nesting.
  return optimizePanelLayout(items, model.bounds, budget, unit, tree, undefined, side === "right", false, dropOrder, rows);
}

export function dockSplitPlan(zone: HTMLElement, side: SplitSide, id: string, target: string, edge: SplitEdge, scope: "panel" | "dock" = "panel") {
  const model = dockSplitModel(zone, side);
  const base = model.tree ? removeSplit(model.tree, id) : null;
  const first = edge === "top" || edge === "left";
  if (side === "right") {
    // A scrolling sidebar is a list, not a capacity-limited split surface.
    // Any edge gesture means insertion before/after the target; width never rejects a card.
    const ids = model.hosts.slice().sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
      .map(item => item.id).filter(key => key !== id);
    const at = ids.indexOf(target);
    ids.splice(at < 0 ? ids.length : at + (first ? 0 : 1), 0, id);
    const visibleTree = completeSplit(undefined, ids)!;
    const tree = completeSplit(visibleTree, model.tree ? splitIds(model.tree) : [])!;
    const geometry = panelCompositionPlan(zone, side, ids, tree);
    return { ...model, tree, fits: true, reason: "position",
      cells: geometry?.cells ?? new Map<string, SplitRect>(), height: geometry ? geometry.height + 8 : 0 };
  }
  const tree: SplitTree = scope === "dock" && base
    ? { axis: edge === "top" || edge === "bottom" ? "y" : "x", ratio: .5,
      a: first ? { id } : base, b: first ? base : { id } }
    : insertSplit(base, id, target, edge);
  const visible = new Set([...model.hosts.map(item => item.id), id]);
  const geometry = panelCompositionPlan(zone, side, visible, tree, { id, target, edge, scope });
  const hasCapacity = geometry !== null || panelCompositionPlan(zone, side, visible) !== null;
  // Save the feasible composition actually previewed, including retained hidden IDs.
  // Never save a rejected intermediate tree with an extra row.
  return { ...model, tree: geometry?.tree ?? tree, fits: geometry !== null,
    reason: hasCapacity ? "position" : "capacity", cells: geometry?.cells ?? new Map<string, SplitRect>(),
    height: geometry ? geometry.height + 8 : 0 };
}

let preview: HTMLDivElement | null = null;
export function clearSplitPreview() { preview?.remove(); preview = null; }
export function showSplitPreview(box: SplitRect) {
  if (!preview) {
    preview = document.createElement("div");
    preview.className = "kd-panel-resize-preview";
    preview.setAttribute("aria-hidden", "true");
    document.body.append(preview);
  }
  Object.assign(preview.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
}
export function viewportSplitRect(zone: HTMLElement, box: SplitRect): SplitRect {
  const rect = zone.getBoundingClientRect();
  return { ...box, left: rect.left + zone.clientLeft + box.left - zone.scrollLeft,
    top: rect.top + zone.clientTop + box.top - zone.scrollTop };
}
