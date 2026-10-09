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
 * the others wait beside it, smaller and quieter. With no tabs it is a plain title.
 */
export function TitleTabs<T extends string>({ label, title, tabs, value, onChange, panelId, caption, children }: {
  /** Names the group for assistive technology. */
  label: string;
  /** Shown when there are no tabs. */
  title?: string;
  tabs?: readonly TitleTab<T>[];
  value?: T;
  onChange?(id: T): void;
  /** Element the tabs switch. */
  panelId?: string;
  /** One short line under the title. */
  caption?: ReactNode;
  /** Actions at the right end of the row. */
  children?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs?.length || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = tabs.findIndex(tab => tab.id === value);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = tabs[(next + tabs.length) % tabs.length];
    onChange?.(target.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus({ preventScroll: true });
  };
  return <header className="kd-title-tabs">
    <div className="kd-title-tabs-text">
      {tabs?.length ? <div ref={list} className="kd-title-tabs-list" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-tab={tab.id}
          aria-selected={tab.id === value} aria-controls={panelId} aria-label={tab.title} title={tab.title}
          tabIndex={tab.id === value ? 0 : -1} onClick={() => onChange?.(tab.id)}>
          <span>{tab.label}</span>
        </button>)}
      </div> : <h2 className="kd-title-tabs-title">{title ?? label}</h2>}
      {caption ? <div className="kd-title-tabs-caption">{caption}</div> : null}
    </div>
    {children ? <div className="kd-title-tabs-tools">{children}</div> : null}
  </header>;
}
