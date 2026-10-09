import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./RightDock.css";

export interface DockApp {
  id: string;
  label: string;
  node: ReactNode;
}

/** The exit slide; a closed app stays mounted this long. */
const LEAVE_MS = 300;

/**
 * Keeps the order in which the right column's apps were opened. The last one is in front.
 * `raised` names an app that was asked for again while already open.
 */
export function useDockOrder(ids: readonly string[], raised: { id: string | null; token: number }): string[] {
  const order = useRef<string[]>([]);
  const seen = useRef(raised.token);
  let next = [...order.current.filter(id => ids.includes(id)), ...ids.filter(id => !order.current.includes(id))];
  if (seen.current !== raised.token) {
    seen.current = raised.token;
    if (raised.id && next.includes(raised.id)) next = [...next.filter(id => id !== raised.id), raised.id];
  }
  if (next.length !== order.current.length || next.some((id, index) => id !== order.current[index])) order.current = next;
  return order.current;
}

/**
 * The right column. Everything that occupies it (lyrics, downloads and exports, settings, a
 * preview) is an equal app: the one opened last covers the others, and closing it shows the one
 * beneath. Apps slide in from the window's edge and back out; covered apps stay mounted, so
 * their scroll position and state are there when they return.
 */
export function RightDock({ apps, order, onOccupiedChange }: {
  apps: DockApp[];
  order: readonly string[];
  /** The column must stay open while a closed app is still sliding out. */
  onOccupiedChange?(occupied: boolean): void;
}) {
  const sorted = [...apps].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  const frontId = sorted.at(-1)?.id ?? null;
  const [exiting, setExiting] = useState<DockApp[]>([]);
  const last = useRef<{ apps: Map<string, DockApp>; frontId: string | null }>({ apps: new Map(), frontId: null });
  const timers = useRef(new Set<number>());
  const ids = apps.map(app => app.id).join("|");
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { apps: new Map(apps.map(app => [app.id, app])), frontId };
    // Only the app that was in front leaves visibly; a covered one is simply gone.
    const gone = before.frontId !== null && !apps.some(app => app.id === before.frontId)
      ? before.apps.get(before.frontId) : undefined;
    setExiting(list => {
      const kept = list.filter(app => !apps.some(open => open.id === app.id));
      return gone ? [...kept.filter(app => app.id !== gone.id), gone] : kept.length === list.length ? list : kept;
    });
    if (!gone) return;
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setExiting(list => list.filter(app => app !== gone));
    }, LEAVE_MS);
    timers.current.add(timer);
    // `ids` stands for the set of open apps; their nodes change on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);
  // An exiting entry keeps the last node it had; an open one always renders the current node.
  last.current.apps = new Map(apps.map(app => [app.id, app]));
  const occupied = apps.length + exiting.length > 0;
  useEffect(() => onOccupiedChange?.(occupied), [occupied, onOccupiedChange]);
  return <div className="kd-dock">
    {sorted.map(app => <section key={app.id} className="kd-dock-app" aria-label={app.label}
      data-app={app.id} data-covered={app.id === frontId ? undefined : "true"} inert={app.id !== frontId}>
      {app.node}
    </section>)}
    {exiting.map(app => <section key={app.id} className="kd-dock-app" aria-hidden="true" data-app={app.id}
      data-leaving="true" inert>
      {app.node}
    </section>)}
  </div>;
}
