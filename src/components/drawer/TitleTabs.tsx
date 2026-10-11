import { useRef, type KeyboardEvent, type ReactNode } from "react";
import "./TitleTabs.css";

export interface TitleTab<T extends string = string> {
  id: T;
  label: string;
  /** The full name, for the tooltip and assistive technology. */
  title?: string;
}

/**
 * A title made of the pages it switches between: the page in view is written at title size,
 * the others wait beside it, smaller and quieter. With no tabs it is a plain title. Nothing
 * else is written on the title's line: the title row names the app, not what it is about.
 */
export function TitleTabs<T extends string>({ label, title, tabs, value, onChange, panelId, children }: {
  /** Names the group for assistive technology. */
  label: string;
  /** Shown when there are no tabs. */
  title?: string;
  tabs?: readonly TitleTab<T>[];
  value?: T;
  onChange?(id: T): void;
  /** Element the tabs switch. */
  panelId?: string;
  /** Actions at the right end of the row. */
  children?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const pick = (id: T) => { if (id !== value) onChange?.(id); };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs?.length || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = tabs.findIndex(tab => tab.id === value);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = tabs[(next + tabs.length) % tabs.length];
    pick(target.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus({ preventScroll: true });
  };
  return <header className="kd-title-tabs">
    <div className="kd-title-tabs-text">
      {tabs?.length ? <div ref={list} className="kd-title-tabs-list" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-tab={tab.id}
          aria-selected={tab.id === value} aria-controls={panelId} aria-label={tab.title} title={tab.title}
          tabIndex={tab.id === value ? 0 : -1}
          // A page word answers the press itself, not its release; a finger, the keyboard and
          // assistive technology arrive as a click.
          onPointerDown={event => { if (event.button === 0 && event.pointerType !== "touch") pick(tab.id); }}
          onClick={() => pick(tab.id)}>
          <span>{tab.label}</span>
        </button>)}
      </div> : <h2 className="kd-title-tabs-title">{title ?? label}</h2>}
    </div>
    {children ? <div className="kd-title-tabs-tools">{children}</div> : null}
  </header>;
}
