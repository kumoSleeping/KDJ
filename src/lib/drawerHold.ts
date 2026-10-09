import { useRef } from "react";
import { create } from "zustand";

/** A hold nobody released is dropped after this long, so the drawer can never stay frozen. */
export const DRAWER_HOLD_LIMIT_MS = 1500;

interface DrawerHoldState {
  holds: readonly { key: number; app: string }[];
  /** The app the drawer must keep showing: the one held most recently, or null. */
  heldApp: string | null;
}

let nextKey = 0;

/**
 * Motion that is aimed at a drawer app (a download parcel in flight) holds the drawer on that
 * app until it lands. Whatever is asked of the drawer in the meantime — another app, closing —
 * is kept as usual and shown once the last hold is released: the latest request wins.
 */
export const useDrawerHold = create<DrawerHoldState>(() => ({ holds: [], heldApp: null }));

/**
 * Holds the drawer on `app`. Returns the release function; calling it more than once is
 * harmless. The hold releases itself after `limitMs`.
 */
export function holdDrawer(app: string, limitMs = DRAWER_HOLD_LIMIT_MS): () => void {
  const key = ++nextKey;
  const holds = [...useDrawerHold.getState().holds, { key, app }];
  useDrawerHold.setState({ holds, heldApp: app });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const left = useDrawerHold.getState().holds.filter(hold => hold.key !== key);
    useDrawerHold.setState({ holds: left, heldApp: left.at(-1)?.app ?? null });
  };
  timer = setTimeout(release, limitMs);
  return release;
}

/** Drops every hold at once: an app that refuses to be covered keeps the drawer. */
export function releaseDrawerHolds(): void {
  if (useDrawerHold.getState().holds.length) useDrawerHold.setState({ holds: [], heldApp: null });
}

/**
 * Which app the drawer shows. A held app stays in front while it is open, and also after it was
 * closed during the hold as long as it had been shown (`kept`); otherwise the app asked for last.
 */
export function heldDrawerFront(requested: string | null, held: string | null, open: readonly string[], kept: string | null): string | null {
  if (held && (open.includes(held) || kept === held)) return held;
  return requested;
}

/**
 * The description of the app the drawer shows, with holds applied. `requested` is the app asked
 * for last. An app that is closed while held keeps its last description until the release, so
 * the sheet stays where the parcel is aimed.
 */
export function useHeldDrawer<Spec extends { id: string }>(apps: readonly Spec[], requested: string | null): Spec | null {
  const held = useDrawerHold(state => state.heldApp);
  const kept = useRef<Spec | null>(null);
  const live = held ? apps.find(app => app.id === held) : undefined;
  if (!held) kept.current = null;
  else if (live) kept.current = live;
  else if (kept.current?.id !== held) kept.current = null;
  const front = heldDrawerFront(requested, held, apps.map(app => app.id), kept.current?.id ?? null);
  return apps.find(app => app.id === front) ?? (front !== null && front === kept.current?.id ? kept.current : null);
}
