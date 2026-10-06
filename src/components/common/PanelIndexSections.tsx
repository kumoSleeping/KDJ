import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { canPlacePanel, usePanelDock, type PanelDockSide } from "./panelDock";
import { usePanelViewport } from "../../lib/panelViewport";

export interface PanelIndexEntry {
  id: string;
  dockId: string;
  legacyDockId?: string;
  side: PanelDockSide;
  label: string;
  icon: ReactNode;
  visible: boolean;
  options?: ReactNode;
}

/** Moving the index moves the existing portal host, not a second panel instance. */
export function PanelIndexSections({ items, onToggle, onAction }: {
  items: PanelIndexEntry[];
  onToggle(id: string): void;
  onAction?(): void;
}) {
  const placements = usePanelDock(state => state.placements);
  const viewport = usePanelViewport();
  const arrange = usePanelDock(state => state.arrange);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const optionsId = useId();
  const hasOptions = items.some(item => Boolean(item.options));
  const [target, setTarget] = useState<{ side: PanelDockSide; before?: string } | null>(null);
  const placement = (item: PanelIndexEntry) => placements[item.dockId] ?? placements[item.legacyDockId ?? ""];
  const keys = Object.keys(placements);
  // The index shows configured destinations, not temporary responsive placement.
  const group = (side: PanelDockSide) => items.filter(item => (placement(item)?.side ?? item.side) === side)
    .sort((a, b) => {
      const rank = (item: PanelIndexEntry) => placement(item)
        ? keys.indexOf(placements[item.dockId] ? item.dockId : item.legacyDockId!) : -1;
      return rank(a) - rank(b);
    });
  const move = (id: string, side: PanelDockSide, before?: string) => {
    const item = items.find(entry => entry.id === id);
    if (!item || before === id || (item.visible && !canPlacePanel(item.dockId, side))) return;
    const destination = group(side).filter(entry => entry.id !== id);
    const at = destination.findIndex(entry => entry.id === before);
    destination.splice(at < 0 ? destination.length : at, 0, item);
    arrange(destination.map(entry => entry.dockId), side);
  };
  const hit = (x: number, y: number) => {
    for (const section of root.current?.querySelectorAll<HTMLElement>("[data-index-section]") ?? []) {
      const box = section.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      const before = Array.from(section.querySelectorAll<HTMLElement>("[data-index-item]"))
        .find(row => { const rect = row.getBoundingClientRect(); return y < rect.top + rect.height / 2; })?.dataset.indexItem;
      return { side: section.dataset.indexSection as PanelDockSide, before };
    }
    return null;
  };
  const cancel = () => { gesture.current = null; setDragged(null); setTarget(null); };
  return <div ref={root} className="kd-panel-index-sections" data-has-options={hasOptions || undefined}>
    {(["top", "right"] as const).map(side => <div key={side} role="group"
      aria-label={side === "top" ? "顶部分区" : "侧边分区"} data-index-section={side}
      className="kd-panel-index-section" data-drop-end={target?.side === side && !target.before || undefined}>
      <div className="kd-panel-index-section-title"><span>{side === "top" ? "顶部分区" : "侧边分区"}</span>
      </div>
      {group(side).map(item => <Fragment key={item.id}><div className="kd-panel-index-row" data-index-item={item.id}
        data-dragged={dragged === item.id || undefined}
        data-drop-before={target?.side === side && target.before === item.id && dragged !== item.id || undefined}>
        <button type="button" className="kd-panel-reorder-handle" aria-label={`移动${item.label}板块`}
          hidden={viewport.compact} title="拖动调整分区和顺序；Alt + 方向键移动"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            gesture.current = { id: item.id, x: event.clientX, y: event.clientY, active: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const start = gesture.current;
            if (!start) return;
            if (!start.active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
            start.active = true;
            setDragged(start.id);
            setTarget(hit(event.clientX, event.clientY));
          }}
          onPointerUp={event => {
            const start = gesture.current;
            const destination = hit(event.clientX, event.clientY);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            cancel();
            if (start?.active && destination) move(start.id, destination.side, destination.before);
          }}
          onPointerCancel={cancel} onLostPointerCapture={cancel}
          onKeyDown={event => {
            if (!event.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              move(item.id, side === "top" ? "right" : "top");
            } else {
              const entries = group(side), at = entries.findIndex(entry => entry.id === item.id);
              if (event.key === "ArrowUp" && at > 0) move(item.id, side, entries[at - 1].id);
              if (event.key === "ArrowDown" && at < entries.length - 1) move(item.id, side, entries[at + 2]?.id);
            }
            requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-index-item="${item.id}"] > button`)?.focus({ preventScroll: true }));
          }}><GripVertical size={12} /></button>
        {hasOptions && <span className="kd-panel-index-disclosure">
          {item.visible && item.options && <button type="button" className="kd-folder-caret kd-panel-index-expand"
            aria-label={`${expanded === item.id ? "收起" : "展开"}${item.label}选项`}
            aria-expanded={expanded === item.id} aria-controls={`${optionsId}-${item.id}`}
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            {expanded === item.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>}
        </span>}
        <button type="button" role="menuitemcheckbox" aria-checked={item.visible} className="kd-panel-index-item"
          onClick={() => {
            if (item.visible && expanded === item.id) setExpanded(null);
            onToggle(item.id);
          }}>{item.icon}<span>{item.label}</span>{item.visible && <Check size={13} />}</button>
      </div>
      {item.visible && item.options && expanded === item.id && <div
        id={`${optionsId}-${item.id}`} role="group" aria-label={`${item.label}选项`}
        className="kd-panel-index-row kd-panel-index-options"
        onClick={event => {
          if (event.target instanceof Element && event.target.closest('button[role="menuitem"]:not(:disabled)')) onAction?.();
        }}>{item.options}</div>}
      </Fragment>)}
    </div>)}
  </div>;
}
