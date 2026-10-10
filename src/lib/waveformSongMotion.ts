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

/* ---------------------------------------------------------------------------------------------
 * A picture that arrives in pieces.
 *
 * A streamed song's waveform is decoded as its media is cached, so the picture grows along the
 * song. The first drawable data leaves the line by the single growth above. Every later piece is
 * a push: the stretch of the song it newly covers grows out of the centre line from its near end
 * to its far end, while what was already shown stays as it is. The canvas work is in
 * WaveformCanvas.ts (drawWaveformPushFrame); here is only which stretch is new and how far along
 * its push each part of it is.
 * ------------------------------------------------------------------------------------------- */

/** How long one push takes from its first bar starting to its last bar standing. */
export const WAVEFORM_PUSH_MS = 280;
/** The part of that time the front needs to travel from the near end of a stretch to its far end. */
const PUSH_TRAVEL = 0.45;
/** More pushes than this at once and the oldest are simply finished. */
export const WAVEFORM_PUSH_LIMIT = 6;

/** A stretch of the song, as fractions of its length: from `from` up to, not including, `to`. */
export interface WaveformStretch {
  from: number;
  to: number;
}

/** A stretch that is growing in since `startedAt`. */
export interface WaveformPush extends WaveformStretch {
  startedAt: number;
}

/** Which columns of a picture are drawn: a mask per column, or "all" for a whole waveform. */
export type WaveformCoverage = ArrayLike<boolean | number> | "all";

const covered = (coverage: WaveformCoverage, at: number): boolean =>
  coverage === "all" || Boolean(coverage[Math.min(coverage.length - 1, Math.floor(at * coverage.length))]);

/**
 * The stretches `next` covers that `previous` did not, in song order. `previous` is what the
 * picture on screen was painted from; null when nothing of this song has been painted, and then
 * nothing is new in this sense: a picture that arrives whole grows once, as a whole.
 *
 * The two masks may differ in length; they are compared by place in the song. `columns` is how
 * finely to look when `next` is a whole waveform. A stretch shorter than `minimum` (a fraction of
 * the song) is not worth a motion and is left out: the bucket the playhead has just passed is a
 * fraction of a pixel wide.
 */
export function newWaveformStretches(
  previous: WaveformCoverage | null,
  next: WaveformCoverage,
  columns = 0,
  minimum = 0,
): WaveformStretch[] {
  if (previous === null || previous === "all") return [];
  const count = next === "all" ? Math.max(columns, previous.length) : next.length;
  if (count <= 0 || previous.length <= 0) return [];
  const stretches: WaveformStretch[] = [];
  let start = -1;
  for (let column = 0; column <= count; column += 1) {
    // The middle of the column decides, so masks of different lengths meet at the same place.
    const at = (column + 0.5) / count;
    const fresh = column < count && covered(next, at) && !covered(previous, at);
    if (fresh && start < 0) start = column;
    if (!fresh && start >= 0) {
      const stretch = { from: start / count, to: column / count };
      if (stretch.to - stretch.from >= minimum) stretches.push(stretch);
      start = -1;
    }
  }
  return stretches;
}

/** The push of `push` has run its whole time. */
export const waveformPushOver = (push: WaveformPush, now: number): boolean =>
  now >= push.startedAt + WAVEFORM_PUSH_MS;

/**
 * The pushes running at `now` once `stretches` have started theirs: finished ones are dropped,
 * each new stretch starts now with its own clock (increments that arrive faster than a push
 * takes overlap in time, never in place), and beyond WAVEFORM_PUSH_LIMIT the oldest are dropped,
 * which shows them finished.
 */
export function addWaveformPushes(
  running: readonly WaveformPush[],
  stretches: readonly WaveformStretch[],
  now: number,
): WaveformPush[] {
  const next = running.filter((push) => !waveformPushOver(push, now));
  for (const stretch of stretches) next.push({ ...stretch, startedAt: now });
  return next.slice(Math.max(0, next.length - WAVEFORM_PUSH_LIMIT));
}

/**
 * How tall the bars at `at` (a fraction of the song inside `push`) stand at `now`, 0..1 of their
 * height. A front travels from the near end of the stretch to its far end; each bar starts when
 * the front reaches it and rises fast, then settles.
 */
export function waveformPushLevel(push: WaveformPush, at: number, now: number): number {
  const length = push.to - push.from;
  const along = length > 0 ? Math.min(1, Math.max(0, (at - push.from) / length)) : 0;
  const travel = WAVEFORM_PUSH_MS * PUSH_TRAVEL;
  const rise = WAVEFORM_PUSH_MS - travel;
  const progress = Math.min(1, Math.max(0, (now - push.startedAt - along * travel) / rise));
  return 1 - Math.pow(1 - progress, 3);
}
