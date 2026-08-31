import type { UnifiedPlayerState } from "./unifiedPlayer";

export interface ManagerDeckView {
  trackId: number;
  duration: number;
  playing: boolean;
  desiredPlaying: boolean;
  rate: number;
  pitchSemitones: number;
}

export interface ManagerControlView {
  owner: number;
  side: 0 | 1 | null;
  deck: ManagerDeckView | null;
}

function deckSideForTrack(state: UnifiedPlayerState, trackId: number): 0 | 1 | null {
  const active = state.decks.findIndex(
    (deck) => deck.trackId === trackId && (deck.playing || deck.desiredPlaying),
  );
  if (active === 0 || active === 1) return active;
  if (state.trackId !== trackId) return null;
  const installed = state.decks.findIndex((deck) => deck.trackId === trackId);
  return installed === 0 || installed === 1 ? installed : null;
}

export function managerControlView(
  state: UnifiedPlayerState,
  trackId: number,
): ManagerControlView {
  const side = deckSideForTrack(state, trackId);
  if (side === null) return { owner: trackId, side: null, deck: null };
  const deck = state.decks[side];
  return {
    owner: trackId,
    side,
    deck: {
      trackId: deck.trackId ?? trackId,
      duration: deck.duration,
      playing: deck.playing,
      desiredPlaying: deck.desiredPlaying,
      rate: deck.rate,
      pitchSemitones: deck.pitchSemitones,
    },
  };
}

/**
 * A Manager seek prepares the new position on the shadow Deck and then swaps physical sides.
 * The song-level owner remains authoritative throughout, but one intermediate snapshot may have
 * retired the old Deck before the new Deck metadata is visible. Keep the last valid binding for
 * that one-song handoff instead of unmounting and remounting the whole Control panel.
 */
export function reconcileManagerControlView(
  current: ManagerControlView,
  state: UnifiedPlayerState,
  trackId: number,
): ManagerControlView {
  const selected = managerControlView(state, trackId);
  if (selected.deck) return selected;
  const transientHandoff = state.status === "loading" || state.buffering || state.transitioning;
  if (
    transientHandoff &&
    state.trackId === trackId &&
    current.owner === trackId &&
    current.side !== null &&
    current.deck?.trackId === trackId
  ) {
    return current;
  }
  return selected;
}

export function sameManagerControlView(
  left: ManagerControlView,
  right: ManagerControlView,
): boolean {
  if (left.owner !== right.owner || left.side !== right.side) return false;
  if (!left.deck || !right.deck) return left.deck === right.deck;
  return left.deck.trackId === right.deck.trackId
    && left.deck.duration === right.deck.duration
    && left.deck.playing === right.deck.playing
    && left.deck.desiredPlaying === right.deck.desiredPlaying
    && left.deck.rate === right.deck.rate
    && left.deck.pitchSemitones === right.deck.pitchSemitones;
}
