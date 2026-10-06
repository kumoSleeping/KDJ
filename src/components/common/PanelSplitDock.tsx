import { useLayoutEffect, useRef, type RefObject } from "react";
import { dockSplitModel, splitHosts, clearSplitPreview, setRenderedPanelTree } from "./panelSplitDom";
import { splitIds, usePanelSplits, type SplitSide, type SplitTree } from "../../lib/panelSplitLayout";
import { usePanelDock } from "./panelDock";
import { autoPanelLayout, clearAutoPanelLayout, panelFormAtWidth, panelLayoutBudget } from "./autoPanelLayoutDom";
import "./PanelSplitDock.css";
import type { AutoPanelLayout } from "../../lib/panelAutoLayout";
import { useThemePack } from "../../lib/themePack";
import { preservePanelScroll } from "./panelScrollAnchor";

/** One sizing owner for each dock. Users compose cards; the solver owns widths/heights. */
export function PanelSplitDock({ root, side }: { root: RefObject<HTMLDivElement | null>; side: SplitSide }) {
  const layout = usePanelSplits(state => state.document[side]);
  const registeredZone = usePanelDock(state => state.zones[side]);
  const placements = usePanelDock(state => state.placements);
  const themeRevision = useThemePack(state => `${state.active?.id ?? ""}:${state.epoch}`);
  const previous = useRef<SplitTree | undefined>(undefined);
  useLayoutEffect(() => {
    const zone = root.current;
    const viewport = zone?.closest<HTMLElement>(".kd-split-aside-body, .kd-sheet-body");
    if (side === "right" && zone && viewport) return preservePanelScroll(zone, viewport);
  }, [root, side, registeredZone]);
  useLayoutEffect(() => {
    const zone = root.current;
    if (!zone) return;
    previous.current = undefined;
    let frame = 0;
    let locked: { key: string; plan: AutoPanelLayout } | null = null;
    let rightWidth = -1;
    let rightHosts: ReturnType<typeof splitHosts> = [];
    let sidebarFill: HTMLElement | undefined;
    const styled = new Set<HTMLElement>(), observed = new Set<HTMLElement>();
    zone.dataset.freeSplit = "true";
    if (side === "top") zone.scrollTop = 0;
    const fit = () => {
      frame = 0;
      if (!zone.clientWidth || zone.closest("[hidden]")) return;
      if (side === "right") {
        const width = zone.clientWidth;
        const hosts = splitHosts(zone, false);
        // Only the download list (first choice) or resolved lyrics absorb spare
        // height. CSS handles resizing without measuring or freezing card heights.
        const fill = (hosts.find(item => item.slot.dataset.panelId === "downloads")
          ?? hosts.find(item => item.slot.dataset.panelId === "lyrics"
            && item.slot.querySelector('.kd-async-panel-body[data-state="ready"] .kd-lyrics[data-has-content="true"]')))?.host;
        if (sidebarFill !== fill) {
          if (sidebarFill) delete sidebarFill.dataset.sidebarFill;
          sidebarFill = fill;
          if (sidebarFill) sidebarFill.dataset.sidebarFill = "true";
        }
        // Content readiness can change the fill owner, but not sidebar order or
        // widths. Skip geometry probes unless its structure changed.
        if (width === rightWidth && hosts.length === rightHosts.length && hosts.every((item, index) =>
          item.id === rightHosts[index].id && item.host === rightHosts[index].host && item.slot === rightHosts[index].slot)) return;
        rightWidth = width;
        rightHosts = hosts;
      }
      zone.dataset.freeSplit = "true";
      const model = dockSplitModel(zone, side);
      if (side === "right") {
        // The sidebar scrolls as a whole. Never freeze a loading placeholder's
        // height or give each card a slice of the viewport's height budget.
        const visibleIds = new Set(model.hosts.map(item => item.id));
        const ids = model.preferenceTree ? splitIds(model.preferenceTree).filter(id => visibleIds.has(id)) : [];
        const active = new Set(model.hosts.map(item => item.host));
        for (const host of styled) if (!active.has(host)) {
          host.style.removeProperty("order");
          delete host.dataset.dockDivider;
          styled.delete(host);
        }
        for (const { id, host, slot } of model.hosts) {
          clearAutoPanelLayout(host);
          delete host.dataset.splitCell;
          for (const name of ["left", "top", "width", "height"]) host.style.removeProperty(`--kd-cell-${name}`);
          host.style.removeProperty("--kd-preview-max-height");
          host.style.order = String(ids.indexOf(id) + 1);
          host.dataset.dockDivider = id === ids[0] ? "" : "top";
          slot.dataset.autoPanelForm = panelFormAtWidth(slot.dataset.panelId, model.bounds.width);
          styled.add(host);
        }
        setRenderedPanelTree(zone, side, model.preferenceTree);
        return;
      }
      const { budget, unit, rows } = panelLayoutBudget(zone, model.fixedHeight);
      // Media URLs, aspect changes, loading states and track IDs are deliberately
      // absent. A song change updates contents inside the existing rectangles.
      const key = JSON.stringify([model.bounds.width, model.fixedHeight, budget, unit, rows, model.hosts.map(item => item.id)]);
      const result = autoPanelLayout(zone, model, previous.current, locked?.key === key ? locked.plan : undefined);
      locked = result ? { key, plan: result } : null;
      const active = new Set(model.hosts.map(item => item.host));
      for (const host of styled) if (!active.has(host)) {
        clearAutoPanelLayout(host);
        delete host.dataset.splitCell;
        for (const name of ["left", "top", "width", "height"]) host.style.removeProperty(`--kd-cell-${name}`);
        host.style.removeProperty("--kd-preview-max-height");
        styled.delete(host);
      }
      const nextObserved = new Set([...model.fixed, ...model.hosts.map(item => item.slot), ...(result?.pictures ?? [])]);
      for (const element of observed) if (!nextObserved.has(element)) { resize.unobserve(element); observed.delete(element); }
      for (const element of nextObserved) if (!observed.has(element)) { resize.observe(element); observed.add(element); }
      if (!result) {
        // Failed probes must not leave absolute cells at trial widths or an
        // empty fixed-height dock. Restore normal flow until a plan fits.
        for (const { host } of model.hosts) {
          clearAutoPanelLayout(host);
          delete host.dataset.splitCell;
          for (const name of ["left", "top", "width", "height"]) host.style.removeProperty(`--kd-cell-${name}`);
          host.style.removeProperty("--kd-preview-max-height");
        }
        delete zone.dataset.freeSplit;
        zone.style.removeProperty("--kd-split-height");
        setRenderedPanelTree(zone, side, null);
        return;
      }
      for (const { id, host } of model.hosts) {
        styled.add(host);
        const box = result.cells.get(id);
        if (box) {
          for (const [name, value] of Object.entries(box)) host.style.setProperty(`--kd-cell-${name}`, `${value}px`);
          host.dataset.dockDivider = [box.left > model.bounds.left + .5 ? "left" : "",
            box.top > model.bounds.top + .5 ? "top" : ""].filter(Boolean).join(" ");
        }
      }
      zone.style.setProperty("--kd-split-height", `${model.fixedHeight + result.height + 8}px`);
      previous.current = result.tree;
      setRenderedPanelTree(zone, side, result.tree);
      if (side === "top") {
        const first = [...result.cells.entries()].sort((a, b) => a[1].top - b[1].top || a[1].left - b[1].left)[0]?.[0] ?? null;
        usePanelDock.getState().setFirstTopPanel(first);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit); };
    const resize = new ResizeObserver(schedule);
    resize.observe(zone);
    const wideSearch = zone.parentElement?.querySelector<HTMLElement>(":scope > .kd-top-wide-search");
    if (side === "top" && wideSearch) resize.observe(wideSearch);
    const sidebar = zone.closest<HTMLElement>(".kd-split-aside-body, .kd-sheet-body");
    if (sidebar) resize.observe(sidebar);
    const mutations = new MutationObserver(schedule);
    mutations.observe(zone, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "data-panel-dock-id", "data-state", "data-expanded"] });
    fit();
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      setRenderedPanelTree(zone, side, null);
      delete zone.dataset.freeSplit;
      zone.style.removeProperty("--kd-split-height");
      if (sidebarFill) delete sidebarFill.dataset.sidebarFill;
      for (const host of styled) {
        clearAutoPanelLayout(host);
        delete host.dataset.splitCell;
        host.style.removeProperty("order");
        for (const name of ["left", "top", "width", "height"]) host.style.removeProperty(`--kd-cell-${name}`);
        host.style.removeProperty("--kd-preview-max-height");
      }
      clearSplitPreview();
    };
  }, [layout, root, side, registeredZone, placements, themeRevision]);
  return null;
}
