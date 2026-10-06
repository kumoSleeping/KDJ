import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { PanelSplitDock } from "./PanelSplitDock";
import { usePanelSplits, type SplitEdge } from "../../lib/panelSplitLayout";
import { splitHosts, panelCompositionPlan, dockSplitPlan, showSplitPreview, clearSplitPreview, viewportSplitRect } from "./panelSplitDom";
import { usePanelPresentation } from "../../lib/panelPresentation";
import { optimizePanelLayout } from "../../lib/panelAutoLayout";
import { panelItemsForIds, panelLayoutBudget } from "./autoPanelLayoutDom";
import { responsivePanelSelection, usePanelViewport } from "../../lib/panelViewport";
import { useToastStore } from "../../stores/toastStore";
import { create } from "zustand";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";

export type PanelDockSide = "top" | "right";
type Placement = { side: PanelDockSide | null; [key: string]: unknown };
const KEY = "kd-panel-docks-v1";
function load(): Record<string, Placement> {
  try {
    const value = JSON.parse(readLocalStorage(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export const usePanelDock = create<{
  placements: Record<string, Placement>;
  zones: Partial<Record<PanelDockSide, HTMLElement>>;
  dragging: boolean;
  rightHasPanels: boolean;
  rightRevealRevision: number;
  revealRight(): void;
  setRightHasPanels(value: boolean): void;
  wideSearchZone: HTMLElement | null;
  firstTopPanelId: string | null;
  registerWideSearch(node: HTMLElement | null): void;
  setFirstTopPanel(id: string | null): void;
  register(side: PanelDockSide, node: HTMLElement | null): void;
  setDragging(value: boolean): void;
  move(id: string, side: PanelDockSide | null, before?: string): void;
  arrange(ids: string[], side: PanelDockSide): void;
}>((set) => ({
  placements: load(), zones: {}, dragging: false, rightHasPanels: false, rightRevealRevision: 0, wideSearchZone: null, firstTopPanelId: null,
  revealRight: () => set(state => ({ rightRevealRevision: state.rightRevealRevision + 1 })),
  setRightHasPanels: rightHasPanels => set(state => state.rightHasPanels === rightHasPanels ? state : { rightHasPanels }),
  registerWideSearch: wideSearchZone => set({ wideSearchZone }),
  setFirstTopPanel: firstTopPanelId => set(state => state.firstTopPanelId === firstTopPanelId ? state : { firstTopPanelId }),
  register: (side, node) => set(state => ({ zones: { ...state.zones, [side]: node ?? undefined } })),
  setDragging: dragging => set({ dragging }),
  arrange: (ids, side) => set(state => {
    const ordered = [...new Set(ids)];
    const placements = Object.fromEntries([
      ...Object.entries(state.placements).filter(([id]) => !ordered.includes(id)),
      ...ordered.map(id => [id, { ...state.placements[id], side }] as const),
    ]);
    writeLocalStorageNow(KEY, JSON.stringify(placements));
    return { placements };
  }),
  move: (id, side, before) => set(state => {
    // Keep unknown entries/fields from newer builds, including panels not currently mounted.
    const entries = Object.entries(state.placements).filter(([key]) => key !== id);
    // Materialize implicit inline placements before inserting relative to one of them.
    // This keeps header dragging consistent with the index's cross-stack ordering.
    if (side) {
      const hosts = Array.from(state.zones[side]?.querySelectorAll<HTMLElement>("[data-panel-dock-id]") ?? []);
      const implicit = hosts.filter(host => host.dataset.panelDockId !== id && !state.placements[host.dataset.panelDockId!]
        && host.querySelector<HTMLElement>(".kd-panel-slot:not([hidden])")?.getBoundingClientRect().height);
      entries.unshift(...implicit.map(host => [host.dataset.panelDockId!, { side }] as [string, Placement]));
    }
    const at = before ? entries.findIndex(([key]) => key === before) : -1;
    entries.splice(at < 0 ? entries.length : at, 0, [id, { ...state.placements[id], side }]);
    const placements = Object.fromEntries(entries);
    writeLocalStorageNow(KEY, JSON.stringify(placements));
    return { placements };
  }),
}));

export type PanelDockTarget = { side: PanelDockSide; wideSearch?: boolean; before?: string; split?: { id: string; edge: SplitEdge; scope?: "panel" | "dock" };
  edgePreview?: { left: number; top: number; width: number; height: number } };
/** A collapsed sidebar still has a drop target at the workspace edge, not at a zero-sized hidden DOM box. */
function sidebarEdgeAt(x: number, y: number): PanelDockTarget | null {
  const viewport = usePanelViewport.getState();
  if (viewport.narrow || viewport.compact) return null;
  const { zones } = usePanelDock.getState();
  const right = zones.right;
  if (right && !right.closest("[hidden]") && right.getBoundingClientRect().width > 0) return null;
  const workspace = zones.top?.closest<HTMLElement>(".kd-table-wrap");
  const box = workspace?.getBoundingClientRect();
  if (!box || box.width <= 0 || x < box.right - 32 || x > box.right || y < box.top || y > box.bottom) return null;
  const width = Math.min(box.width, Math.max(240, Math.min(400, box.width * .32)));
  return { side: "right", edgePreview: { left: box.right - width, top: box.top, width, height: box.height } };
}
function wideSearchAt(x: number, y: number, id?: string): PanelDockTarget | null {
  const viewport = usePanelViewport.getState(), docks = usePanelDock.getState();
  if (!id?.endsWith(":search") || viewport.narrow || viewport.compact || !docks.zones.top || !docks.wideSearchZone) return null;
  const top = docks.zones.top, workspace = top.closest<HTMLElement>(".kd-table-wrap");
  if (!workspace) return null;
  const cards = [...splitHosts(top), ...splitHosts(docks.wideSearchZone)];
  const source = cards.find(item => item.id === id);
  if (!source || source.box.top > Math.min(...cards.map(item => item.box.top)) + 4) return null;
  const box = workspace.getBoundingClientRect(), topBox = top.getBoundingClientRect();
  const height = source.box.height;
  if (x < topBox.right - 24 || x > box.right || y < box.top || y > box.top + height + 8) return null;
  return { side: "top", wideSearch: true, edgePreview: { left: box.left + 4, top: box.top + 4,
    width: Math.max(0, box.width - 8), height } };
}
export function panelDockAt(x: number, y: number, excludeId?: string): PanelDockTarget | null {
  const spanning = wideSearchAt(x, y, excludeId);
  if (spanning) return spanning;
  const edge = sidebarEdgeAt(x, y);
  if (edge) return edge;
  const wide = usePanelDock.getState().wideSearchZone;
  const wideBox = wide?.getBoundingClientRect();
  if (wideBox && wideBox.height > 0 && x >= wideBox.left && x <= wideBox.right && y >= wideBox.top && y <= wideBox.bottom) {
    const id = wide?.querySelector<HTMLElement>("[data-panel-dock-id]")?.dataset.panelDockId;
    return { side: "top", before: id !== excludeId ? id : undefined };
  }
  for (const side of ["top", "right"] as const) {
    if (side === "right" && (usePanelViewport.getState().narrow || usePanelViewport.getState().compact)) continue;
    const zone = usePanelDock.getState().zones[side];
    if (!zone || zone.closest("[hidden]")) continue;
    const box = zone.getBoundingClientRect();
    const edgeBand = side === "top" ? 12 : 0;
    if (box.width <= 0 || box.height <= 0 || x < box.left || x > box.right || y < box.top - edgeBand || y > box.bottom + edgeBand) continue;
    // The outer edge inserts a full row, not a third cell under whichever column
    // happens to be under the pointer. This allows swapping EQ with the whole row below it.
    if (side === "top" && (y <= box.top + edgeBand || y >= box.bottom - edgeBand)) {
      return { side, split: { id: "", edge: y <= box.top + edgeBand ? "top" : "bottom", scope: "dock" } };
    }
    const target = splitHosts(zone).find(item => item.id !== excludeId
      && x >= item.box.left && x <= item.box.right && y >= item.box.top && y <= item.box.bottom);
    if (target) {
      const dx = (x - target.box.left) / Math.max(1, target.box.width);
      const dy = (y - target.box.top) / Math.max(1, target.box.height);
      if (side === "right") return { side, split: { id: target.id, edge: dy < .5 ? "top" : "bottom" } };
      const edges: [SplitEdge, number][] = [["left", dx], ["right", 1 - dx], ["top", dy], ["bottom", 1 - dy]];
      edges.sort((a, b) => a[1] - b[1]);
      return { side, split: { id: target.id, edge: edges[0][0] } };
    }
    const before = Array.from(zone.querySelectorAll<HTMLElement>("[data-panel-dock-id]"))
      .find(host => {
        if (host.dataset.panelDockId === excludeId) return false;
        const rect = host.getBoundingClientRect();
        return rect.height > 0 && y < rect.top + rect.height / 2;
      })?.dataset.panelDockId;
    return { side, before };
  }
  return null;
}
/** Admission is shared by header dragging, the index and compact-mode multi-selection. */
export function canPlacePanel(id: string, side: PanelDockSide) {
  if (side === "right") return true;
  const zone = usePanelDock.getState().zones.top;
  const viewport = usePanelViewport.getState();
  const ids = viewport.compact ? viewport.activeIds : zone ? splitHosts(zone).map(item => item.id) : [];
  if (ids.includes(id)) return true;
  if (zone && panelCompositionPlan(zone, "top", responsivePanelSelection(ids, id, viewport.narrow))) return true;
  useToastStore.getState().show("空间不足");
  return false;
}
export function toggleResponsivePanel(id: string) {
  const viewport = usePanelViewport.getState();
  if (viewport.activeIds.includes(id) || canPlacePanel(id, "top")) viewport.togglePanel(id);
}
export function dockPanel(id: string, target: PanelDockTarget): boolean {
  if (target.wideSearch && id.endsWith(":search") && target.edgePreview) {
    const docks = usePanelDock.getState(), top = docks.zones.top;
    if (!top || !docks.wideSearchZone) return false;
    const ids = splitHosts(top).map(item => item.id).filter(key => key !== id);
    const items = panelItemsForIds(ids);
    const { unit, budget } = panelLayoutBudget(top, 0, true);
    const tree = ids.length ? usePanelSplits.getState().document.top?.tree : undefined;
    const preference = tree ?? (ids.length ? { id: ids[0] } : { id });
    const fits = !items.length || optimizePanelLayout(items,
      { left: 4, top: 4, width: Math.max(0, top.clientWidth - 8), height: 0 },
      Math.max(1, budget - target.edgePreview.height - 8), unit, preference, undefined, false, false, undefined, 1);
    if (!fits) { useToastStore.getState().show("空间不足"); return false; }
    usePanelPresentation.getState().setSearchSpan(true);
    docks.move(id, "top", ids[0]);
    return true;
  }
  const zone = usePanelDock.getState().zones[target.side];
  if (zone && target.split) {
    const plan = dockSplitPlan(zone, target.side, id, target.split.id, target.split.edge, target.split.scope);
    if (!plan.fits) { useToastStore.getState().show(plan.reason === "capacity" ? "空间不足" : "该位置无法放置"); return false; }
    if (!usePanelSplits.getState().save(target.side, { tree: plan.tree, ordered: true }, id)) return false;
  } else if (!canPlacePanel(id, target.side)) return false;
  if (id.endsWith(":search")) usePanelPresentation.getState().setSearchSpan(false);
  if (target.side === "right") usePanelDock.getState().revealRight();
  usePanelDock.getState().move(id, target.side, target.before);
  return true;
}
export function clearPanelDockHighlight() {
  clearSplitPreview();
  for (const zone of Object.values(usePanelDock.getState().zones)) zone?.removeAttribute("data-drop-target");
}
export function highlightPanelDock(x: number, y: number, id?: string) {
  const target = panelDockAt(x, y, id);
  for (const zone of Object.values(usePanelDock.getState().zones)) zone?.removeAttribute("data-drop-target");
  const zone = target ? usePanelDock.getState().zones[target.side] : null;
  if (target?.edgePreview) {
    showSplitPreview(target.edgePreview);
  } else if (zone && target?.split && id) {
    const plan = dockSplitPlan(zone, target.side, id, target.split.id, target.split.edge, target.split.scope);
    const box = plan.cells.get(id);
    if (box) {
      const preview = viewportSplitRect(zone, box), bounds = zone.getBoundingClientRect();
      const left = Math.max(preview.left, bounds.left), top = Math.max(preview.top, bounds.top);
      const width = Math.max(0, Math.min(preview.left + preview.width, bounds.right) - left);
      const height = Math.max(0, Math.min(preview.top + preview.height, bounds.bottom) - top);
      if (width > 0 && height > 0) showSplitPreview({ left, top, width, height }); else clearSplitPreview();
    } else clearSplitPreview();
  } else {
    clearSplitPreview();
    zone?.setAttribute("data-drop-target", "true");
  }
  return target;
}
export function PanelDockZone({ side, children }: { side: PanelDockSide; children?: ReactNode }) {
  const register = usePanelDock(state => state.register);
  const dragging = usePanelDock(state => state.dragging);
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const zone = root.current;
    if (side !== "right" || !zone || typeof MutationObserver === "undefined") return;
    // Inspect mounted content rather than geometry: the aside itself may be hidden.
    // That lets a newly opened panel bring the column back without a visibility loop.
    const sync = () => usePanelDock.getState().setRightHasPanels(splitHosts(zone, false).length > 0);
    const observer = new MutationObserver(sync);
    observer.observe(zone, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "data-state", "data-expanded"] });
    sync();
    return () => observer.disconnect();
  }, [side]);
  const ref = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    register(side, node);
  }, [register, side]);
  return <div ref={ref} className={`kd-panel-dock kd-panel-dock-${side} kd-scroll`} data-panel-dock={side}
    data-dragging={dragging || undefined} aria-label={side === "top" ? "上侧板块区" : "右侧板块区"}>
    {children}
    <PanelSplitDock root={root} side={side} />
  </div>;
}

export function PanelWideSearchZone() {
  const register = usePanelDock(state => state.registerWideSearch);
  return <div ref={register} className="kd-top-wide-search" />;
}

/** Reparent the existing portal host, ordered among other docked hosts. */
export function placePanelHost(host: HTMLElement, target: HTMLElement, id: string, docked: boolean, placements: Record<string, Placement>) {
  host.dataset.panelDockId = id;
  host.classList.toggle("kd-panel-docked-host", docked);
  const ids = Object.keys(placements);
  const rank = ids.indexOf(id);
  const next = docked ? Array.from(target.children).find(node => node !== host && node instanceof HTMLElement
    && ids.indexOf(node.dataset.panelDockId ?? "") > rank) : undefined;
  // Re-inserting an already ordered live host still detaches its subtree in WebKit,
  // invalidating compositor animations/media even when another panel was the one moved.
  if (host.parentElement !== target || host.nextSibling !== (next ?? null)) {
    target.insertBefore(host, next ?? null);
  }
}
