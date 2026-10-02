import { useLayoutEffect, useRef, type RefObject } from "react";
import { usePanelViewport } from "../../lib/panelViewport";
import { autoPanelKind, optimizePanelLayout, type AutoPanelItem } from "../../lib/panelAutoLayout";
import { type SplitTree } from "../../lib/panelSplitLayout";
import { measuredPanelItems } from "./autoPanelLayoutDom";

/** Keep at least a third of the workspace for the library, independently of screen orientation. */
export function useResponsivePanels(root: RefObject<HTMLDivElement | null>, narrow: boolean) {
  const entryHeight = useRef(0);
  useLayoutEffect(() => {
    const workspace = root.current;
    if (!workspace) return;
    let frame = 0;
    let fittedKey = "";
    const initial = usePanelViewport.getState();
    if (initial.narrow !== narrow) {
      entryHeight.current = workspace.clientHeight;
      usePanelViewport.getState().setMode(narrow, narrow);
    }
    const fit = () => {
      frame = 0;
      const width = workspace.clientWidth, height = workspace.clientHeight;
      if (!width || !height) return;
      const budget = Math.floor(height * 2 / 3);
      workspace.style.setProperty("--kd-panel-budget", `${budget}px`);
      const state = usePanelViewport.getState();
      const slots = Array.from(document.querySelectorAll<HTMLElement>(".kd-panel-slot[data-panel-enabled='true']"))
        .filter(slot => state.narrow || slot.dataset.homeDock === "top");
      const unit = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // Loading descendants are not a viewport/configuration change. Re-probing them
      // can otherwise switch the entire workspace into compact mode halfway through a song.
      const key = JSON.stringify([width, height, unit, state.narrow, slots.map(slot =>
        [slot.parentElement?.dataset.panelDockId, slot.dataset.homeDock]).sort()]);
      if (key === fittedKey) return;
      fittedKey = key;
      const measurements = new Map(Array.from(document.querySelectorAll<HTMLElement>("[data-panel-dock]"))
        .flatMap(zone => measuredPanelItems(zone)).map(item => [item.id, item]));
      const items: AutoPanelItem[] = slots.flatMap(slot => {
        const id = slot.parentElement?.dataset.panelDockId;
        if (!id) return [];
        return [measurements.get(id) ?? { id, kind: autoPanelKind(id), chrome: 2 * unit,
          measure: () => slot.dataset.panelId === "search" ? 5 * unit : 9 * unit }];
      });
      if (!items.length) return;
      let tree: SplitTree = { id: items[0].id };
      for (const item of items.slice(1)) tree = { axis: "y", ratio: .5, a: tree, b: { id: item.id } };
      // Probe all enabled cards, not just the current compact selection. No DOM writes here.
      const plan = optimizePanelLayout(items, { left: 4, top: 4, width: Math.max(1, width - 8), height: budget },
        Math.max(1, budget - 10), unit, tree);
      if (!state.compact && (!plan || plan.height > budget + unit)) {
        entryHeight.current = height;
        state.setMode(narrow, true);
      } else if (state.compact && plan && height > entryHeight.current + 2 * unit && plan.height <= budget - unit) {
        state.setMode(narrow, false);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit); };
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace);
    const mutations = new MutationObserver(schedule);
    mutations.observe(workspace, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-panel-enabled", "data-home-dock"] });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && usePanelViewport.getState().compact) usePanelViewport.getState().closePanel();
    };
    fit();
    window.addEventListener("resize", schedule);
    window.addEventListener("keydown", escape);
    return () => {
      observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule); window.removeEventListener("keydown", escape);
      workspace.style.removeProperty("--kd-panel-budget");
    };
  }, [root, narrow]);
}
