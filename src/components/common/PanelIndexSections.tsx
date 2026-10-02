import { useRef, useState, type ReactNode } from "react";
import { Check, GripVertical, PanelRightClose, PanelRightOpen } from "lucide-react";
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
}

/** Moving the index moves the existing portal host, not a second panel instance. */
export function PanelIndexSections({ items, onToggle, sidebar }: {
  items: PanelIndexEntry[];
  onToggle(id: string): void;
  sidebar?: { open: boolean; toggle(): void };
}) {
  const placements = usePanelDock(state => state.placements);
  const viewport = usePanelViewport();
  const topOnly = viewport.narrow || viewport.compact;
  const arrange = usePanelDock(state => state.arrange);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<{ side: PanelDockSide; before?: string } | null>(null);
  const placement = (item: PanelIndexEntry) => placements[item.dockId] ?? placements[item.legacyDockId ?? ""];
  const keys = Object.keys(placements);
  const group = (side: PanelDockSide) => items.filter(item => (topOnly ? "top" : placement(item)?.side ?? item.side) === side)
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
  return <div ref={root} className="kd-panel-index-sections">
    {(topOnly ? ["top"] as const : ["top", "right"] as const).map(side => <div key={side} role="group"
      aria-label={side === "top" ? "顶部分区" : "侧边分区"} data-index-section={side}
      className="kd-panel-index-section" data-drop-end={target?.side === side && !target.before || undefined}>
      <div className="kd-panel-index-section-title"><span>{side === "top" ? "顶部分区" : "侧边分区"}</span>
        {side === "right" && sidebar && <button type="button" className="kd-panel-sidebar-toggle"
          aria-label={sidebar.open ? "一键收起侧栏" : "展开侧栏"} title={sidebar.open ? "一键收起侧栏" : "展开侧栏"}
          onClick={sidebar.toggle}>{sidebar.open ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button>}
      </div>
      {group(side).map(item => <div key={item.id} className="kd-panel-index-row" data-index-item={item.id}
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
        <button type="button" role="menuitemcheckbox" aria-checked={item.visible} className="kd-panel-index-item"
          onClick={() => onToggle(item.id)}>{item.icon}<span>{item.label}</span>{item.visible && <Check size={13} />}</button>
      </div>)}
    </div>)}
  </div>;
}
