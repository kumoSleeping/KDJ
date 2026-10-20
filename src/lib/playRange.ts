/**
 * The part of the playing song the listener marked: Shift + drag on the player's waveform
 * (Waveform.tsx). While it is set, playing stays inside it — at its end the player goes back to
 * its start (PlayerBar), and the video follows through the shared seek path. It is also what a
 * song dragged into Agent Mode carries as its time ("1:23–1:41").
 *
 * It belongs to one song: playing another, Esc, or a plain click on the waveform outside it lets
 * it go.
 */
import { create } from "zustand";

export interface PlayRange {
  trackId: number;
  /** Seconds. */
  start: number;
  end: number;
}

/** Shorter than this is a click, not a range. */
export const MIN_RANGE_SECONDS = 0.25;

interface PlayRangeStore {
  range: PlayRange | null;
  set(range: PlayRange | null): void;
}

export const usePlayRange = create<PlayRangeStore>(set => ({
  range: null,
  set(range) {
    set({ range: range && range.end - range.start >= MIN_RANGE_SECONDS ? range : null });
  },
}));

export function playRangeOf(trackId: number): PlayRange | null {
  const range = usePlayRange.getState().range;
  return range && range.trackId === trackId ? range : null;
}

export function clearPlayRange(): void {
  if (usePlayRange.getState().range) usePlayRange.getState().set(null);
}

/** Where playing goes next: back to the start when it has reached the end, else nowhere. */
export function rangeWrap(range: PlayRange | null, trackId: number, position: number): number | null {
  if (!range || range.trackId !== trackId) return null;
  return position >= range.end ? range.start : null;
}

/** A seek that leaves the range lets it go; one inside keeps it. */
export function seekLeavesRange(range: PlayRange | null, trackId: number, position: number): boolean {
  if (!range || range.trackId !== trackId) return false;
  return position < range.start - 0.05 || position > range.end + 0.05;
}
