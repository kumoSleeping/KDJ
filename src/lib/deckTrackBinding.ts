import type { Track } from "../types";

export type DeckTrackPair = readonly [Track | null, Track | null];

/**
 * Bind display metadata to physical Deck identity. Source kind is deliberately irrelevant: a row
 * exists only when its Track id is installed on that exact side. This makes stale retained or
 * async provider data unable to address another Deck's controls.
 */
export function bindTracksToPhysicalDecks(
  physicalTrackIds: readonly [number | null, number | null],
  preferredBySide: DeckTrackPair,
  candidates: readonly (Track | null | undefined)[],
): [Track | null, Track | null] {
  const trackFor = (side: 0 | 1): Track | null => {
    const trackId = physicalTrackIds[side];
    if (trackId === null) return null;
    const ordered = [preferredBySide[side], ...candidates, preferredBySide[1 - side]];
    return ordered.find((track) => track?.id === trackId) ?? null;
  };
  return [trackFor(0), trackFor(1)];
}
