/**
 * What changed between two orders of the same list, for a reorder that is shown as a movement
 * (the sidebar's playlists after one was opened, see components/library/sidebarMotion.ts).
 * No DOM here, so it can be tested.
 */

export interface ReorderMoves {
  /**
   * How many places each moved item went up (positive) or down (negative). Items that kept
   * their place are not listed, nor are items only one of the orders has.
   */
  places: Map<string, number>;
  /** The item that travelled: the one that went up the furthest; null when nothing went up. */
  lead: string | null;
}

export function reorderMoves(before: readonly string[], after: readonly string[]): ReorderMoves {
  // An item that came or went shifts everyone behind it without anyone having been moved:
  // places are counted among the items both orders have.
  const inBefore = new Set(before);
  const inAfter = new Set(after);
  const was = new Map<string, number>();
  before.filter(key => inAfter.has(key)).forEach((key, index) => { if (!was.has(key)) was.set(key, index); });
  const places = new Map<string, number>();
  let lead: string | null = null;
  let furthest = 0;
  after.filter(key => inBefore.has(key)).forEach((key, index) => {
    const moved = (was.get(key) ?? index) - index;
    if (moved === 0 || places.has(key)) return;
    places.set(key, moved);
    if (moved > furthest) {
      furthest = moved;
      lead = key;
    }
  });
  return { places, lead };
}
