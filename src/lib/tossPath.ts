/**
 * The geometry and timing of a download parcel's flight, and when the download it stands for
 * is handed to the queue. No DOM here, so it can be tested.
 */

export interface TossPoint { x: number; y: number }

/** The sheet of the drawer takes this long to come down (Drawer.css, kd-drawer-down). */
export const SHEET_DOWN_MS = 520;
/** The block at the source turns into the parcel before it leaves. */
export const TOSS_LIFT_MS = 180;
/** A dropped item is already in the hand: the parcel only pops up. */
export const TOSS_POP_MS = 90;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * How far above the higher of its two ends the parcel rises. A throw across the window rises
 * more than a hop from a drop point; neither leaves the top of the window.
 */
export function tossRise(from: TossPoint, to: TossPoint, hop: boolean): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const wanted = hop ? clamp(distance * 0.35, 18, 56) : clamp(distance * 0.16, 28, 90);
  return Math.max(8, Math.min(wanted, Math.min(from.y, to.y) - 6));
}

/**
 * Points of a ballistic flight from `from` to `to`, relative to `from`, at equal steps of time:
 * the horizontal speed is constant and the vertical one changes under constant gravity, so the
 * points lie on a parabola whose top is `rise` above the higher end.
 */
export function tossArc(from: TossPoint, to: TossPoint, rise: number, steps = 24): TossPoint[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  // The top is `top` above the start. With y(u) = dy·u − 4h·u(1 − u) that fixes h.
  const top = rise + Math.max(0, -dy);
  const h = (dy + 2 * top + 2 * Math.sqrt(top * (top + dy))) / 4;
  return Array.from({ length: steps + 1 }, (_, index) => {
    const u = index / steps;
    return { x: dx * u, y: dy * u - 4 * h * u * (1 - u) };
  });
}

/**
 * How long the parcel is in the air. It lands a moment after the sheet has settled when the
 * sheet is still coming down (`sheetLeftMs` from the start of the flight), and a longer way
 * takes a little longer.
 */
export function tossFlightMs(distance: number, sheetLeftMs: number, hop: boolean): number {
  const own = hop ? clamp(240 + distance * 0.3, 260, 420) : clamp(360 + distance * 0.22, 420, 600);
  return Math.round(clamp(Math.max(own, sheetLeftMs > 0 ? sheetLeftMs + 60 : 0), own, 700));
}

/* ------------------------------------------------------------------------------------------ */
/* Handing the download over                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The download is handed to the queue this long before the parcel touches down, so that its row
 * is in the list when the parcel arrives and takes the landing highlight — not while the parcel
 * is still on its way.
 */
export const TOSS_HANDOVER_LEAD_MS = 130;
/**
 * Whatever becomes of the flight (animations that never start in a hidden window, a parcel that
 * finds nowhere to land), the download is handed over at the latest this long after the toss
 * began. Longer than the longest flight's own moment, shorter than the drawer's hold.
 */
export const TOSS_HANDOVER_LIMIT_MS = 900;

/** From the start of the flight to the moment the download is handed over. */
export function tossHandoverAt(flightMs: number): number {
  return Math.max(0, flightMs - TOSS_HANDOVER_LEAD_MS);
}

export interface TossHandover {
  /** Resolves when the download is to be handed to the queue. Always resolves, and only once. */
  readonly ready: Promise<void>;
  /** Hands over now. Harmless when it already happened. */
  deliver(): void;
  /** Hands over in `ms` from now instead of at the limit. */
  within(ms: number): void;
  delivered(): boolean;
}

const waiting = new Set<() => void>();

/**
 * One download waiting for its parcel. It is handed over when `deliver` is called, when the
 * time given to `within` has passed, or after `limitMs` — whichever comes first.
 */
export function tossHandover(limitMs = TOSS_HANDOVER_LIMIT_MS): TossHandover {
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deliver = () => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    waiting.delete(deliver);
    resolve();
  };
  const within = (ms: number) => {
    if (done) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(deliver, Math.max(0, ms));
  };
  waiting.add(deliver);
  within(limitMs);
  return { ready, deliver, within, delivered: () => done };
}

/**
 * Hands over every download that is still waiting for its parcel. For the moments when timers
 * stop being reliable or the page is about to go: the window was hidden, or is being closed.
 */
export function flushTossHandovers(): void {
  for (const deliver of [...waiting]) deliver();
}

/** How many downloads are waiting for their parcels. */
export function waitingTossHandovers(): number {
  return waiting.size;
}
