import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "./EditorChrome.css";

/** Divider between command groups of one toolbar row. */
export function EditorSeparator() {
  return <i className="kd-editor-sep" aria-hidden="true" />;
}

/** Section switch shared by the editors. Selection changes ink only. */
export function EditorTabs<T extends string>({ label, tabs, value, onChange, panelId, children }: {
  label: string; tabs: readonly { id: T; label: string }[]; value: T; onChange(id: T): void;
  /** Element the tabs switch, for assistive technology. */
  panelId?: string;
  /** Actions that belong to the row but are not sections. */
  children?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex(tab => tab.id === value);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    const target = tabs[(next + tabs.length) % tabs.length];
    onChange(target.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus({ preventScroll: true });
  };
  return <div className="kd-editor-tabs">
    <div ref={list} role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-tab={tab.id} aria-selected={tab.id === value}
        aria-controls={panelId} tabIndex={tab.id === value ? 0 : -1} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
    </div>
    {children}
  </div>;
}

/** Position readout that accepts a typed position. Typing never fights the running clock. */
export function TimecodeField({ label, value, format, parse, onCommit, suffix }: {
  label: string; value: number; format(value: number): string; parse(text: string): number | null;
  onCommit(value: number): void; suffix?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Leaving the field untouched must not seek back to where the clock was on focus.
  const edited = useRef(false);
  const editing = draft !== null;
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const commit = () => {
    const next = draft !== null && edited.current ? parse(draft) : null;
    edited.current = false;
    setDraft(null);
    if (next !== null) onCommit(next);
  };
  return <span className="kd-editor-timecode">
    <input ref={input} type="text" inputMode="decimal" spellCheck={false} autoComplete="off" aria-label={label} title={label}
      value={draft ?? format(value)} size={9}
      onFocus={() => { edited.current = false; setDraft(format(value)); }}
      onChange={event => { edited.current = true; setDraft(event.target.value); }}
      onBlur={commit}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { event.preventDefault(); edited.current = false; event.currentTarget.blur(); }
      }} />
    {suffix}
  </span>;
}
