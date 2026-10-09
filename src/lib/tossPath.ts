/** The geometry and timing of a download parcel's flight. No DOM here, so it can be tested. */

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
