import { Children, isValidElement, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, GripVertical, List } from "lucide-react";
import { createPortal } from "react-dom";
import { PanelCollapseContext } from "./panelCollapse";
import { ContextMenu } from "./ContextMenu";
import { PanelReorderContext } from "./panelReorder";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import "./PanelStack.css";
import { usePanelDock, panelDockAt, highlightPanelDock, clearPanelDockHighlight, placePanelHost, dockPanel, canPlacePanel, toggleResponsivePanel } from "./panelDock";
import { PanelIndexSections } from "./PanelIndexSections";
import type { PanelDockSide } from "./panelDock";
import { PANEL_PRESENTATIONS, usePanelPresentation } from "../../lib/panelPresentation";
import "./PanelPresentation.css";
import "./PanelAutoSize.css";
import { usePanelViewport } from "../../lib/panelViewport";

type PanelInfo = { label: string; icon: ReactNode };
export interface PanelStackProps {
  storageKey: string;
  /** Shared identity when a panel can be owned by either the top or detail stack. */
  dockKey?: string;
  reorderable?: boolean;
  defaultFirstIds?: readonly string[];
  /** Start these panels first on mount, while still allowing manual reordering. */
  initialFirstIds?: readonly string[];
  defaultLastIds?: readonly string[];
  /** Each direct child has a stable key identifying its fixed panel slot. */
  children: ReactNode;
  index?: {
    panels: Record<string, PanelInfo>;
    target?: HTMLElement | null;
    triggerClassName?: string;
    hideTrigger?: boolean;
    collapsed?: boolean;
    compactId?: string;
    hiddenIds?: readonly string[];
    onReveal?(id: string): void;
    /** Controls shared with panels mounted outside this stack. */
    controls?: Record<string, { visible: boolean; setVisible(visible: boolean): void }>;
    sections?: {
      defaultSide: PanelDockSide;
      sidebar?: { open: boolean; toggle(): void };
      panels?: Record<string, { side: PanelDockSide; legacyDockId?: string }>;
    };
  };
  collapse?: {
    hiddenIds: readonly string[];
    setVisible(id: string, visible: boolean): void;
    restoreTarget: HTMLElement | null;
    panels: Record<string, PanelInfo>;
  };
}

function load(storageKey: string): string[] {
  try {
    const value: unknown = JSON.parse(readLocalStorage(storageKey) ?? "null");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/** Move a stable portal host, preserving the mounted media and local editor state. */
function PortablePanel({ children, dockId, legacyDockId, defaultSide }: {
  children: ReactNode; dockId: string; legacyDockId: string; defaultSide: PanelDockSide;
}) {
  const [host] = useState(() => { const element = document.createElement("div"); element.className = "kd-panel-live-host"; return element; });
  const docks = usePanelDock();
  const viewport = usePanelViewport();
  const spanSearch = usePanelPresentation(state => state.searchSpan);
  const placement = docks.placements[dockId] ?? docks.placements[legacyDockId];
  const effectiveSide = viewport.narrow || viewport.compact ? "top" : placement?.side ?? defaultSide;
  const dockTarget = spanSearch && dockId.endsWith(":search") && effectiveSide === "top" && !viewport.narrow && !viewport.compact
    ? docks.wideSearchZone ?? docks.zones.top : docks.zones[effectiveSide];
  const inline = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = dockTarget ?? inline.current;
    if (target) placePanelHost(host, target, dockId, !!dockTarget, docks.placements);
    host.classList.toggle("kd-playback-panels", !!dockTarget && dockId.startsWith("kd-activity-panels:"));
  }, [host, dockTarget, docks.placements, dockId]);
  useLayoutEffect(() => () => { host.remove(); }, [host]);
  return <>
    <div className="kd-panel-anchor" ref={inline} hidden={!!dockTarget} />
    {createPortal(children, host)}
  </>;
}

/** Fixed panel slots: collapsing never creates or moves a window or media host. */
export function PanelStack({ storageKey, dockKey = storageKey, defaultFirstIds = [], initialFirstIds = [], defaultLastIds = [], children, collapse, index, reorderable = false }: PanelStackProps) {
  const docks = usePanelDock();
  const parentReorder = useContext(PanelReorderContext);
  const viewport = usePanelViewport();
  const [order, setOrder] = useState(() => {
    const saved = load(storageKey);
    if (!saved.length || !initialFirstIds.length) return saved;
    return [...new Set([
      ...initialFirstIds,
      ...defaultFirstIds.filter(id => !saved.includes(id)),
      ...saved,
    ])];
  });
  const [hiddenIds, setHiddenIds] = useState(() => load(`${storageKey}-hidden`));
  const stackRoot = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; top: number; anchor: HTMLElement } | null>(null);
  const idOf = (child: { key: string | null }) => String(child.key ?? "").replace(/^\.\$/, "");
  const rank = (id: string) => {
    const stored = order.indexOf(id);
    if (stored !== -1) return stored;
    const last = defaultLastIds.indexOf(id);
    if (last !== -1) return Number.MAX_SAFE_INTEGER - defaultLastIds.length + last;
    const initial = defaultFirstIds.indexOf(id);
    return initial === -1 ? Number.MAX_SAFE_INTEGER - defaultLastIds.length - 1 : Number.MIN_SAFE_INTEGER + initial;
  };
  const sorted = Children.toArray(children).filter(isValidElement).sort((a, b) => rank(idOf(a)) - rank(idOf(b)));
  const move = (source: string, target: string) => {
    const ids = sorted.map(idOf);
    const from = ids.indexOf(source), to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1); ids.splice(to, 0, source);
    const next = [...ids, ...order.filter(id => !ids.includes(id))];
    setOrder(next);
    writeLocalStorageNow(storageKey, JSON.stringify(next));
  };
  const configuredHidden = (id: string) => index?.controls?.[id] ? !index.controls[id].visible : (collapse?.hiddenIds ?? index?.hiddenIds ?? hiddenIds).includes(id)
    || (!!index?.collapsed && index.compactId !== id);
  const hidden = (id: string) => viewport.compact ? !viewport.activeIds.includes(`${dockKey}:${id}`) : configuredHidden(id);
  const menuIds = [...new Set([...sorted.map(idOf), ...Object.keys(index?.controls ?? {})])];
  const toggleVisible = (id: string) => {
    if (viewport.compact) { toggleResponsivePanel(`${dockKey}:${id}`); return; }
    if (hidden(id)) {
      const dockId = `${dockKey}:${id}`;
      const side = viewport.narrow ? "top" : docks.placements[dockId]?.side
        ?? index?.sections?.panels?.[id]?.side
        ?? (storageKey.startsWith("kd-top-") ? "top" : index?.sections?.defaultSide ?? "right");
      if (!canPlacePanel(dockId, side)) return;
    }
    if (index?.controls?.[id]) index.controls[id].setVisible(hidden(id));
    else if (collapse) collapse.setVisible(id, hidden(id));
    else if (index?.onReveal) index.onReveal(id);
    else {
      const next = hidden(id) ? hiddenIds.filter(value => value !== id) : [...hiddenIds, id];
      setHiddenIds(next);
      writeLocalStorageNow(`${storageKey}-hidden`, JSON.stringify(next));
    }
  };
  const toggle = index && !index.hideTrigger && <button type="button" className={`${index.triggerClassName ?? "kd-aside-head-close"} kd-panel-index-toggle`}
    title="板块索引" aria-label="板块索引" aria-haspopup="menu" aria-expanded={!!menu}
    onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4, top: rect.top, anchor: event.currentTarget });
    }}><List size={index.triggerClassName === "kd-chrome-btn" ? 16 : 14} /></button>;
  return <div ref={stackRoot} className="kd-panel-stack" data-single-visible={sorted.filter(child => !hidden(idOf(child))).length === 1 || undefined}>
    {index?.target ? createPortal(toggle, index.target) : toggle}
    {menu && index && <ContextMenu x={menu.x} y={menu.y} anchorTop={menu.top} anchorElement={menu.anchor} label="板块索引" onClose={() => setMenu(null)}>
      {index.sections ? <PanelIndexSections items={menuIds.filter(id => index.panels[id]).map(id => ({
        id, dockId: `${dockKey}:${id}`, ...index.panels[id], visible: !hidden(id),
        side: index.sections!.panels?.[id]?.side ?? index.sections!.defaultSide,
        legacyDockId: index.sections!.panels?.[id]?.legacyDockId,
      }))} sidebar={index.sections.sidebar} onToggle={toggleVisible} /> : menuIds.map(id => {
        const panel = index.panels[id];
        if (!panel) return null;
        return <button key={id} type="button" role="menuitemcheckbox" aria-checked={!hidden(id)} className="kd-panel-index-item"
          onClick={() => { toggleVisible(id); setMenu(null); }}>
          {panel.icon}<span>{panel.label}</span>{!hidden(id) && <Check size={13} />}
        </button>;
      })}
    </ContextMenu>}
    {!index && collapse?.restoreTarget && createPortal(sorted.map(child => {
      const id = idOf(child), panel = collapse.panels[id];
      return panel && hidden(id) ? <button key={id} type="button" className="kd-aside-head-close"
        aria-label={`展开 ${panel.label} 面板`} title={`展开 ${panel.label} 面板`}
        onClick={() => collapse.setVisible(id, true)}>{panel.icon}</button> : null;
    }), collapse.restoreTarget)}
    {sorted.map(child => {
      const id = idOf(child), panel = index?.panels[id] ?? collapse?.panels[id];
      const dockId = `${dockKey}:${id}`;
      const defaultSide = storageKey.startsWith("kd-top-") ? "top" : index?.sections?.defaultSide ?? "right";
      const side = docks.placements[dockId]?.side ?? docks.placements[`${storageKey}:${id}`]?.side ?? defaultSide;
      const form = dockKey === "kd-activity-panels" && PANEL_PRESENTATIONS[id] ? "auto" : undefined;
      return <div key={id} className="kd-panel-mount">
        <PortablePanel defaultSide={defaultSide} dockId={dockId} legacyDockId={`${storageKey}:${id}`}>
        <div className="kd-panel-slot" data-panel-stack={storageKey} data-panel-id={id} hidden={hidden(id)}
          onDragOver={event => { if (reorderable && dragged) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDrop={event => { if (reorderable && dragged) { event.preventDefault(); event.stopPropagation(); move(dragged, id); setDragged(null); } }}
          data-panel-form={form} data-dock-side={viewport.narrow || viewport.compact ? "top" : side}
          data-panel-enabled={!configuredHidden(id)} data-home-dock={side}
          data-auto-height={reorderable || undefined}
          data-compact={index?.collapsed && index.compactId === id || undefined}>
          <PanelCollapseContext.Provider value={viewport.compact ? { label: panel?.label ?? id, collapse: () => viewport.closePanel(dockId) }
            : collapse && panel ? { label: panel.label, collapse: () => collapse.setVisible(id, false) } : null}>
            <PanelReorderContext.Provider value={reorderable ? <button type="button" className="kd-panel-reorder-handle"
              aria-label={`移动${panel?.label ?? id}板块`} title="拖动调整分区和组合"
              onPointerDown={event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.stopPropagation();
                pointerStart.current = { x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragged(id);
                docks.setDragging(true);
              }}
              onPointerMove={event => {
                if (!pointerStart.current) return;
                highlightPanelDock(event.clientX, event.clientY, dockId);
              }}
              onPointerUp={event => {
                const start = pointerStart.current;
                pointerStart.current = null;
                setDragged(null);
                docks.setDragging(false); clearPanelDockHighlight();
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
                const dock = panelDockAt(event.clientX, event.clientY, `${dockKey}:${id}`);
                if (dock) dockPanel(dockId, dock);
              }}
              onPointerCancel={() => { pointerStart.current = null; setDragged(null); docks.setDragging(false); clearPanelDockHighlight(); }}
              onLostPointerCapture={() => { pointerStart.current = null; setDragged(null); docks.setDragging(false); clearPanelDockHighlight(); }}
              onKeyDown={event => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const ids = sorted.map(idOf), at = ids.indexOf(id);
                const target = ids[at + (event.key === "ArrowUp" ? -1 : 1)];
                if (target) move(id, target);
              }}><GripVertical size={12} /></button> : parentReorder}>
              {child}
            </PanelReorderContext.Provider>
          </PanelCollapseContext.Provider>
        </div>
        </PortablePanel>
      </div>;
    })}
  </div>;
}
