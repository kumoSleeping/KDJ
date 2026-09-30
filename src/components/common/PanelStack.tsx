import { Children, isValidElement, useContext, useRef, useState, type ReactNode } from "react";
import { Check, GripVertical, List } from "lucide-react";
import { createPortal } from "react-dom";
import { PanelCollapseContext } from "./panelCollapse";
import { ContextMenu } from "./ContextMenu";
import { PanelReorderContext } from "./panelReorder";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import "./PanelStack.css";

type PanelInfo = { label: string; icon: ReactNode };
export interface PanelStackProps {
  storageKey: string;
  reorderable?: boolean;
  defaultFirstIds?: readonly string[];
  /** Each direct child has a stable key identifying its fixed panel slot. */
  children: ReactNode;
  index?: {
    panels: Record<string, PanelInfo>;
    target?: HTMLElement | null;
    collapsed?: boolean;
    compactId?: string;
    hiddenIds?: readonly string[];
    onReveal?(id: string): void;
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

/** Fixed panel slots: collapsing never creates or moves a window or media host. */
export function PanelStack({ storageKey, defaultFirstIds = [], children, collapse, index, reorderable = false }: PanelStackProps) {
  const parentReorder = useContext(PanelReorderContext);
  const [order, setOrder] = useState(() => load(storageKey));
  const [hiddenIds, setHiddenIds] = useState(() => load(`${storageKey}-hidden`));
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; top: number } | null>(null);
  const idOf = (child: { key: string | null }) => String(child.key ?? "").replace(/^\.\$/, "");
  const rank = (id: string) => {
    const stored = order.indexOf(id);
    if (stored !== -1) return stored;
    const initial = defaultFirstIds.indexOf(id);
    return initial === -1 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER + initial;
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
  const hidden = (id: string) => (collapse?.hiddenIds ?? index?.hiddenIds ?? hiddenIds).includes(id)
    || (!!index?.collapsed && index.compactId !== id);
  const toggle = index && <button type="button" className="kd-aside-head-close kd-panel-index-toggle"
    title="板块索引" aria-label="板块索引" aria-haspopup="menu" aria-expanded={!!menu}
    onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4, top: rect.top });
    }}><List size={14} /></button>;
  return <div className="kd-panel-stack">
    {index?.target ? createPortal(toggle, index.target) : toggle}
    {menu && index && <ContextMenu x={menu.x} y={menu.y} anchorTop={menu.top} label="板块索引" onClose={() => setMenu(null)}>
      {sorted.map(child => {
        const id = idOf(child), panel = index.panels[id];
        if (!panel) return null;
        return <button key={id} type="button" role="menuitemcheckbox" aria-checked={!hidden(id)} className="kd-panel-index-item"
          onClick={() => { if (collapse) collapse.setVisible(id, hidden(id));
            else if (index.onReveal) index.onReveal(id);
            else {
              const next = hidden(id) ? hiddenIds.filter(value => value !== id) : [...hiddenIds, id];
              setHiddenIds(next);
              writeLocalStorageNow(`${storageKey}-hidden`, JSON.stringify(next));
            }
            setMenu(null); }}>
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
      return <div key={id} className="kd-panel-mount">
        <div className="kd-panel-slot" data-panel-stack={storageKey} data-panel-id={id} hidden={hidden(id)}
          onDragOver={event => { if (reorderable && dragged) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDrop={event => { if (reorderable && dragged) { event.preventDefault(); event.stopPropagation(); move(dragged, id); setDragged(null); } }}
          data-compact={index?.collapsed && index.compactId === id || undefined}>
          <PanelCollapseContext.Provider value={collapse && panel ? { label: panel.label, collapse: () => collapse.setVisible(id, false) } : null}>
            <PanelReorderContext.Provider value={reorderable ? <button type="button" className="kd-panel-reorder-handle"
              aria-label={`移动${panel?.label ?? id}板块`} title="拖动换位，或按上下方向键移动"
              onPointerDown={event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.stopPropagation();
                pointerStart.current = { x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragged(id);
              }}
              onPointerUp={event => {
                const start = pointerStart.current;
                pointerStart.current = null;
                setDragged(null);
                if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
                let target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-panel-stack]");
                while (target && target.dataset.panelStack !== storageKey) target = target.parentElement?.closest<HTMLElement>("[data-panel-stack]");
                if (target?.dataset.panelId) move(id, target.dataset.panelId);
              }}
              onPointerCancel={() => { pointerStart.current = null; setDragged(null); }}
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
      </div>;
    })}
  </div>;
}
