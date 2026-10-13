/**
 * The geometry and timing of a download parcel's flight, and when the download it stands for
 * is handed to the queue. No DOM here, so it can be tested.
 */

export interface TossPoint { x: number; y: number }

/** The drawer's panel takes this long to slide in (Drawer.css, kd-drawer-in). */
export const SHEET_DOWN_MS = 400;
/** A panel that replaces another waits this long for it to leave first (Drawer.css, kd-drawer-out). */
export const SHEET_SWAP_MS = 260;
/** The block at the source turns into the parcel before it leaves. */
export const TOSS_LIFT_MS = 180;
/** A dropped item is already in the hand: the parcel only pops up. */
export const TOSS_POP_MS = 90;
/** Keep momentum on departure and ease into the queue, without a gravity-driven rush. */
export const TOSS_FLIGHT_EASING = "cubic-bezier(0.25, 0.45, 0.45, 1)";

/**
 * A batch gathers before it is thrown: the covers of its rows that are on screen come together
 * at the source and stack, and the parcel comes up out of the stack. This takes the place of
 * the lift, so the throw itself, the handover and the drawer's hold are what they are for one
 * item. It is short on purpose: the download is still handed over within TOSS_HANDOVER_LIMIT_MS.
 */
export const TOSS_GATHER_MS = 320;
/** At most this many covers travel; the rest of the batch is the number on the parcel. */
export const TOSS_GATHER_MAX = 6;
/** One cover's way to the stack, and the moment by which the last one is there. */
const GATHER_TRAVEL_MS = 200;
const GATHER_STACKED_MS = 250;
/** Covers leave at most this far apart, the one nearest the stack first. */
const GATHER_STEP_MS = 16;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** One cover of a gathering batch: when it leaves, how long it travels and where it rests in the stack. */
export interface TossGatherTile {
  delay: number;
  duration: number;
  /** Its place in the stack, from the stack's centre, and its tilt there in degrees. */
  x: number;
  y: number;
  turn: number;
}

/**
 * The plan for `tiles` covers (TOSS_GATHER_MAX at most), in the order they leave. They come to
 * rest as a small fan — a few pixels apart, each tilted a little more than its neighbour — and
 * every one is in the stack by the time the parcel comes up over it.
 */
export function tossGatherPlan(tiles: number): TossGatherTile[] {
  const count = clamp(Math.floor(tiles), 0, TOSS_GATHER_MAX);
  const step = count > 1 ? Math.min(GATHER_STEP_MS, (GATHER_STACKED_MS - GATHER_TRAVEL_MS) / (count - 1)) : 0;
  return Array.from({ length: count }, (_, index) => {
    const fromMiddle = index - (count - 1) / 2;
    return {
      delay: Math.round(index * step),
      duration: GATHER_TRAVEL_MS,
      x: fromMiddle * 5,
      y: Math.abs(fromMiddle) * 1.5,
      turn: fromMiddle * 7,
    };
  });
}

/** Which `wanted` of `available` things take part, spread evenly over them (first and last included). */
export function tossGatherPick(available: number, wanted = TOSS_GATHER_MAX): number[] {
  const count = Math.max(0, Math.floor(available));
  if (count <= wanted) return Array.from({ length: count }, (_, index) => index);
  return Array.from({ length: wanted }, (_, index) => Math.round(index * (count - 1) / (wanted - 1)));
}

/**
 * How far above the higher of its two ends the parcel rises. A throw across the window rises
 * more than a hop from a drop point; neither leaves the top of the window.
 */
export function tossRise(from: TossPoint, to: TossPoint, hop: boolean): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const wanted = hop ? clamp(distance * 0.16, 12, 30) : clamp(distance * 0.085, 18, 52);
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
