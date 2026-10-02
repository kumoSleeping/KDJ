import { autoPanelKind, optimizePanelLayout, type AutoPanelItem, type AutoPanelLayout } from "../../lib/panelAutoLayout";
import type { dockSplitModel } from "./panelSplitDom";
import type { SplitTree } from "../../lib/panelSplitLayout";

const measuredLayouts = new WeakMap<HTMLElement, AutoPanelItem[]>();
export function measuredPanelItems(zone: HTMLElement) { return measuredLayouts.get(zone) ?? []; }
/** Frozen measurements for admission/drag previews; never resize mounted media during a pointer move. */
export function panelItemsForIds(ids: Iterable<string>): AutoPanelItem[] {
  const measured = new Map(Array.from(document.querySelectorAll<HTMLElement>("[data-panel-dock]"))
    .flatMap(zone => measuredPanelItems(zone)).map(item => [item.id, item]));
  const hosts = Array.from(document.querySelectorAll<HTMLElement>("[data-panel-dock-id]"));
  const unit = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return [...new Set(ids)].map(id => {
    const known = measured.get(id);
    if (known) return known;
    const slot = hosts.find(host => host.dataset.panelDockId === id)
      ?.querySelector<HTMLElement>(":scope > .kd-panel-slot, :scope > .kd-internal-window");
    const height = slot?.getBoundingClientRect().height ?? 0;
    const kind = autoPanelKind(id);
    return { id, kind, chrome: 2 * unit, measure: () => height || (kind === "search" ? 6 : 10) * unit };
  });
}
export function panelLayoutBudget(zone: HTMLElement, fixedHeight: number, ignoreWideSearch = false) {
  const unit = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const limit = Number.parseFloat(getComputedStyle(zone).maxHeight);
  const sidebar = zone.closest<HTMLElement>(".kd-split-aside-body, .kd-sheet-body");
  const available = zone.dataset.panelDock === "right" && sidebar?.clientHeight
    ? sidebar.clientHeight : Number.isFinite(limit) ? limit : window.innerHeight * .65;
  const wide = zone.dataset.panelDock === "top" && !ignoreWideSearch
    ? zone.parentElement?.querySelector<HTMLElement>(":scope > .kd-top-wide-search") : null;
  const wideHeight = wide?.getBoundingClientRect().height ?? 0;
  return { unit, budget: Math.max(1, available - fixedHeight - wideHeight - 10), rows: wideHeight > 0 ? 1 : 2 };
}

const pictureSelector = ".kd-preview-frame:not([data-fullscreen='true']), .kd-detail-viz-panel .kd-viz-preview:not([data-fullscreen='true'])";
export function panelFormAtWidth(id: string | undefined, width: number) {
  return id === "control" ? width >= 520 ? "slim" : width < 240 ? "portrait" : "strip" : id === "visualizer" ? "landscape" : "strip";
}

/** Measure only for a new composition/viewport; content updates reuse the fitted rectangles. */
export function autoPanelLayout(zone: HTMLElement, model: ReturnType<typeof dockSplitModel>, previous?: SplitTree, locked?: AutoPanelLayout) {
  if (!model.preferenceTree || !model.hosts.length) return null;
  const { unit, budget, rows } = panelLayoutBudget(zone, model.fixedHeight);
  const pictures: HTMLElement[] = [];
  const snapshots: { id: string; samples: Map<number, number>; fallback: number }[] = [];
  const retained = new Map(measuredPanelItems(zone).map(item => [item.id, item]));
  const items: AutoPanelItem[] = model.hosts.map(({ id, host, slot }) => {
    host.dataset.splitCell = "true";
    slot.dataset.optimizedPanel = "true";
    const picture = slot.querySelector<HTMLElement>(pictureSelector);
    if (picture) pictures.push(picture);
    // Do not even temporarily release sizes on a lyrics/metadata/media update.
    // In particular, never replace frozen admission measurements with loading states.
    if (locked && retained.has(id)) return retained.get(id)!;
    // Remove only derived constraints, never persisted preferences. All probes finish before paint.
    slot.style.removeProperty("--kd-auto-panel-limit");
    slot.style.removeProperty("--kd-auto-panel-height");
    const panelId = slot.dataset.panelId;
    const kind = autoPanelKind(panelId ?? id, !!picture);
    const flexible = picture ?? slot.querySelector<HTMLElement>(kind === "waveform" ? ".kd-manager-scroll-wave" : ".kd-lyrics[data-has-content]");
    const chrome = flexible ? Math.max(0, slot.getBoundingClientRect().height - flexible.getBoundingClientRect().height)
      : slot.querySelector(".kd-panel-head")?.getBoundingClientRect().height ?? 24;
    const aspectRatio = picture ? Number.parseFloat(getComputedStyle(picture).getPropertyValue("--kd-preview-ratio")) || 16 / 9 : undefined;
    const cache = new Map<number, number>();
    snapshots.push({ id, samples: cache, fallback: slot.getBoundingClientRect().height });
    return { id, kind, chrome, aspectRatio,
      measure(width) {
        const key = Math.round(width * 10) / 10;
        const found = cache.get(key);
        if (found !== undefined) return found;
        host.style.setProperty("--kd-cell-width", `${width}px`);
        slot.dataset.autoPanelForm = panelFormAtWidth(panelId, width);
        const height = slot.getBoundingClientRect().height;
        cache.set(key, height);
        return height;
      } };
  });
  const scrollable = zone.dataset.panelDock === "right";
  let result = locked ?? optimizePanelLayout(items, model.bounds, budget, unit, model.preferenceTree, previous, scrollable, model.keepOrder, undefined, rows);
  // Only a genuinely smaller viewport may force a different composition.
  if (!result && model.keepOrder) result = optimizePanelLayout(items, model.bounds, budget, unit, model.preferenceTree, previous, scrollable, false, undefined, rows);
  // Keep measurements of temporarily closed cards as well as currently visible cards.
  // The index needs the full set when admitting another compact-mode card.
  for (const item of items) {
    const snapshot = snapshots.find(entry => entry.id === item.id);
    if (!snapshot) continue;
    const samples = [...snapshot.samples];
    retained.set(item.id, { ...item, measure: (width: number) => samples.length
      ? samples.reduce((best, entry) => Math.abs(entry[0] - width) < Math.abs(best[0] - width) ? entry : best)[1]
      : snapshot.fallback });
  }
  measuredLayouts.set(zone, [...retained.values()]);
  if (!result) return null;
  const byId = new Map(items.map(item => [item.id, item]));
  for (const { id, host, slot } of model.hosts) {
    const box = result.cells.get(id), item = byId.get(id);
    if (!box || !item) continue;
    host.style.setProperty("--kd-cell-width", `${box.width}px`);
    slot.dataset.autoPanelForm = panelFormAtWidth(slot.dataset.panelId, box.width);
    slot.style.setProperty("--kd-auto-panel-limit", `${box.height}px`);
    slot.style.setProperty("--kd-auto-panel-height", `${box.height}px`);
    if (item.kind === "media") host.style.setProperty("--kd-preview-max-height", `${Math.max(0, box.height - item.chrome)}px`);
    else host.style.removeProperty("--kd-preview-max-height");
    if (item.kind === "waveform" || item.kind === "lyrics") slot.style.setProperty("--kd-auto-content-height", `${Math.max(0, box.height - item.chrome)}px`);
    else slot.style.removeProperty("--kd-auto-content-height");
  }
  return { ...result, pictures };
}

export function clearAutoPanelLayout(host: HTMLElement) {
  const slot = host.querySelector<HTMLElement>(":scope > .kd-panel-slot, :scope > .kd-internal-window");
  if (!slot) return;
  delete slot.dataset.optimizedPanel;
  slot.style.removeProperty("--kd-auto-panel-limit");
  slot.style.removeProperty("--kd-auto-panel-height");
  slot.style.removeProperty("--kd-auto-content-height");
}
