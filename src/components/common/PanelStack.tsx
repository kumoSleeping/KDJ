import { Children, Fragment, isValidElement, useState, type ReactNode } from "react";
import { Check, List } from "lucide-react";
import { createPortal } from "react-dom";
import { PanelCollapseContext, PanelDockedContext } from "./panelCollapse";
import { ContextMenu } from "./ContextMenu";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import "./PanelStack.css";

type PanelInfo = { label: string; icon: ReactNode };
export interface PanelStackProps {
  storageKey: string;
  /** Each direct child has a stable key; panels render in the order given. */
  children: ReactNode;
  index?: {
    /** Listed in this order, whether the panel is a child here or mounted by another stack. */
    panels: Record<string, PanelInfo>;
    target?: HTMLElement | null;
    triggerClassName?: string;
    hideTrigger?: boolean;
    /** Visibility owned outside this stack, including panels mounted elsewhere. */
    controls?: Record<string, { visible: boolean; setVisible(visible: boolean): void }>;
    /** Extra settings listed under a visible panel. */
    options?: Record<string, ReactNode>;
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

/** Fixed panel slots: the layout is the application's; people only show or hide a panel. */
export function PanelStack({ storageKey, children, collapse, index }: PanelStackProps) {
  const [hiddenIds, setHiddenIds] = useState(() => load(`${storageKey}-hidden`));
  const [menu, setMenu] = useState<{ x: number; y: number; top: number; anchor: HTMLElement } | null>(null);
  const idOf = (child: { key: string | null }) => String(child.key ?? "").replace(/^\.\$/, "");
  const slots = Children.toArray(children).filter(isValidElement);
  const hidden = (id: string) => index?.controls?.[id] ? !index.controls[id].visible
    : (collapse?.hiddenIds ?? hiddenIds).includes(id);
  const menuIds = index ? Object.keys(index.panels).filter(id => index.controls?.[id] || slots.some(child => idOf(child) === id)) : [];
  const toggleVisible = (id: string) => {
    if (index?.controls?.[id]) index.controls[id].setVisible(hidden(id));
    else if (collapse) collapse.setVisible(id, hidden(id));
    else {
      // Keep ids this build does not show: another build may still own them.
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
  return <div className="kd-panel-stack" data-single-visible={slots.filter(child => !hidden(idOf(child))).length === 1 || undefined}>
    {index?.target ? createPortal(toggle, index.target) : toggle}
    {menu && index && <ContextMenu x={menu.x} y={menu.y} anchorTop={menu.top} anchorElement={menu.anchor} toggleAnchor label="板块索引" onClose={() => setMenu(null)}>
      {menuIds.map(id => {
        const panel = index.panels[id], options = !hidden(id) && index.options?.[id];
        return <Fragment key={id}>
          <button type="button" role="menuitemcheckbox" aria-checked={!hidden(id)} className="kd-panel-index-item"
            onClick={() => { toggleVisible(id); if (!options) setMenu(null); }}>
            {panel.icon}<span>{panel.label}</span>{!hidden(id) && <Check size={13} />}
          </button>
          {options && <div role="group" aria-label={`${panel.label}选项`} className="kd-panel-index-options">{options}</div>}
        </Fragment>;
      })}
    </ContextMenu>}
    {!index && collapse?.restoreTarget && createPortal(slots.map(child => {
      const id = idOf(child), panel = collapse.panels[id];
      return panel && hidden(id) ? <button key={id} type="button" className="kd-aside-head-close"
        aria-label={`展开 ${panel.label} 面板`} title={`展开 ${panel.label} 面板`}
        onClick={() => collapse.setVisible(id, true)}>{panel.icon}</button> : null;
    }), collapse.restoreTarget)}
    {slots.map(child => {
      const id = idOf(child), panel = index?.panels[id] ?? collapse?.panels[id];
      return <div key={id} className="kd-panel-slot" data-panel-stack={storageKey} data-panel-id={id} hidden={hidden(id)}>
        <PanelCollapseContext.Provider value={collapse && panel ? { label: panel.label, collapse: () => collapse.setVisible(id, false) } : null}>
          <PanelDockedContext.Provider value>{child}</PanelDockedContext.Provider>
        </PanelCollapseContext.Provider>
      </div>;
    })}
  </div>;
}
