import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { usePointerTrackDrop } from "../../lib/pointerTrackDrop";
import { activeTrackDragIds, isTrackDrag, readTrackDragIds } from "../../lib/trackDrag";
import type { TitleDrop } from "./drawerSchema";
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
export function TitleTabs<T extends string>({ label, title, tabs, value, onChange, panelId, drop, children }: {
  /** Names the group for assistive technology. */
  label: string;
  /** Shown when there are no tabs. */
  title?: string;
  tabs?: readonly TitleTab<T>[];
  value?: T;
  onChange?(id: T): void;
  /** Element the tabs switch. */
  panelId?: string;
  /** What the row takes when something is dragged onto it (drawerSchema.ts `titleDrop`). */
  drop?: TitleDrop;
  /** Actions at the right end of the row. */
  children?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  // More page words than the row has room for: the row is carried so that the page in view
  // stands in the middle, and what lies beyond an edge fades out there. Choosing a word to the
  // right brings the ones after it into reach.
  const [carry, setCarry] = useState({ x: 0, left: false, right: false });
  useEffect(() => {
    const frame = view.current, row = list.current;
    if (!frame || !row) return;
    const place = () => {
      const room = frame.clientWidth, full = row.offsetWidth;
      const word = row.querySelector<HTMLElement>('[aria-selected="true"]');
      const next = !word || full <= room ? { x: 0, left: false, right: false } : (() => {
        const middle = word.offsetLeft + word.offsetWidth / 2;
        const x = Math.round(Math.min(Math.max(middle - room / 2, 0), full - room));
        return { x, left: x > 0, right: x < full - room };
      })();
      setCarry(now => now.x === next.x && now.left === next.left && now.right === next.right ? now : next);
    };
    place();
    // The word in view grows while the switch plays: place the row again once it has.
    const settle = window.setTimeout(place, 340);
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    watch?.observe(frame);
    // The words change size as the switch plays, and with them the row.
    watch?.observe(row);
    return () => { window.clearTimeout(settle); watch?.disconnect(); };
  }, [value, tabs]);
  const pick = (id: T) => { if (id !== value) onChange?.(id); };
  // Something taken by the row is over it: the row is lit and names what a drop does.
  const [hot, setHot] = useState(false);
  const row = useRef<HTMLElement>(null);
  usePointerTrackDrop(row, drop ? {
    over: () => { setHot(true); return drop.label; },
    leave: () => setHot(false),
    drop: ids => { setHot(false); drop.drop(ids); },
  } : null);
  const takes = (event: DragEvent<HTMLElement>) => Boolean(drop) && isTrackDrag(event);
  const dropped = (event: DragEvent<HTMLElement>) => {
    const ids = readTrackDragIds(event.dataTransfer);
    drop?.drop(ids.length ? ids : [...activeTrackDragIds()]);
  };
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
  return <header ref={row} className="kd-title-tabs" data-drop={hot || undefined} title={hot ? drop?.label : undefined}
    onDragOver={drop ? event => { if (!takes(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setHot(true); } : undefined}
    onDragLeave={drop ? event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHot(false); } : undefined}
    onDrop={drop ? event => { if (!takes(event)) return; event.preventDefault(); setHot(false); dropped(event); } : undefined}>
    <div ref={view} className="kd-title-tabs-text"
      data-fade={carry.left && carry.right ? "both" : carry.left ? "left" : carry.right ? "right" : undefined}>
      {tabs?.length ? <div ref={list} className="kd-title-tabs-list" role="tablist" aria-label={label} onKeyDown={move}
        style={{ "--kd-tabs-carry": `${-carry.x}px` } as CSSProperties}>
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
