/**
 * How the player bar's waveform follows a change of song.
 *
 * The picture is a mirrored pair of halves around a centre line. While a song has nothing to draw
 * only that line shows ("line"); its bars grow out of the line once ("in") and stay ("shown"). When
 * another song takes over, the picture of the old one closes back into the line ("out") before the
 * new one grows. Every step runs on the song-change clock in songSwapMotion.ts.
 */
import { SONG_SWAP_IN_MS, SONG_SWAP_OUT_MS } from "./songSwapMotion";

export type WaveformSongPhase = "line" | "in" | "shown" | "out";

export interface WaveformSongMotion {
  phase: WaveformSongPhase;
  /** The song whose picture is on screen. While "out" runs that is still the one leaving. */
  trackId: number;
  /** "out" and "in": when the running step is over. */
  endsAt: number;
  /** The earliest moment the next picture may grow: a change of song holds it for the exit time. */
  enterAt: number;
  /** "out": the song last asked for, so one more skip can be told from one more render. */
  next: number;
}

export interface WaveformSongMotionInput {
  /** The song the waveform is asked to show now. */
  trackId: number;
  /** That song has at least one column to draw. */
  ready: boolean;
  now: number;
  /** The viewer asked for less motion: no step animates, the picture simply follows the song. */
  reduced: boolean;
}

/** A freshly mounted waveform is the line; it grows as soon as its song can be drawn. */
export function mountedWaveformSongMotion(trackId: number): WaveformSongMotion {
  return { phase: "line", trackId, endsAt: 0, enterAt: 0, next: trackId };
}

/**
 * The state for this moment. Returns the same object when nothing changed, and is stable when
 * called again with the same input, so it can run on every render.
 *
 * Skips do not queue: a collapse that is running finishes once, and whatever song is asked for at
 * that point is the one that follows. Refinements of a song that is already shown never restart
 * its growth, because only the first drawable data of a song leaves the line.
 */
export function advanceWaveformSongMotion(
  state: WaveformSongMotion,
  { trackId, ready, now, reduced }: WaveformSongMotionInput,
): WaveformSongMotion {
  if (reduced) {
    const phase: WaveformSongPhase = ready ? "shown" : "line";
    return state.phase === phase && state.trackId === trackId
      ? state
      : { phase, trackId, endsAt: 0, enterAt: 0, next: trackId };
  }
  let current = state;
  if (current.phase === "out") {
    if (current.next !== trackId) {
      // One more skip while the old picture is closing. Everything else that belongs to the song
      // starts leaving again, so the newest song's entrance waits for that exit as well.
      current = { ...current, next: trackId, enterAt: now + SONG_SWAP_OUT_MS };
    }
    if (now < current.endsAt) return current;
    current = { phase: "line", trackId, endsAt: 0, enterAt: current.enterAt, next: trackId };
  } else if (current.phase === "line") {
    if (current.trackId !== trackId) {
      // Nothing of the old song is on screen here, but its other surfaces still take the exit
      // time to leave; the new picture arrives with theirs.
      current = { phase: "line", trackId, endsAt: 0, enterAt: now + SONG_SWAP_OUT_MS, next: trackId };
    }
  } else {
    if (current.trackId !== trackId || !ready) {
      return {
        phase: "out",
        trackId: current.trackId,
        endsAt: now + SONG_SWAP_OUT_MS,
        enterAt: now + SONG_SWAP_OUT_MS,
        next: trackId,
      };
    }
    if (current.phase === "in" && now >= current.endsAt) return { ...current, phase: "shown" };
    return current;
  }
  if (ready && now >= current.enterAt) {
    return { phase: "in", trackId, endsAt: now + SONG_SWAP_IN_MS, enterAt: current.enterAt, next: trackId };
  }
  return current;
}

/**
 * Time the collapse from the first frame that can show it. The change of song is noticed while
 * rendering, and starting a song can keep the main thread busy long enough that the picture
 * would otherwise be replaced before it was ever seen closing.
 */
export function startWaveformSongCollapse(state: WaveformSongMotion, now: number): WaveformSongMotion {
  if (state.phase !== "out" || now + SONG_SWAP_OUT_MS <= state.endsAt) return state;
  return { ...state, endsAt: now + SONG_SWAP_OUT_MS };
}

/**
 * When the state has to be looked at again without any new input, or null when only a new song
 * or new data can move it.
 */
export function waveformSongMotionWakeAt(state: WaveformSongMotion, ready: boolean): number | null {
  if (state.phase === "out" || state.phase === "in") return state.endsAt;
  if (state.phase === "line" && ready) return state.enterAt;
  return null;
}
