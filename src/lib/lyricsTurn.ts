/**
 * The lyrics' part in the song change (see songSwapMotion.ts): the panel stays where it is and
 * its content turns over. The lyrics of the old song leave first, on the clock every surface of
 * the playing song leaves by, and the next song's come out once they are ready: fetched and
 * parsed, or known to be missing. A slow provider is not waited for beyond a cap; the panel then
 * goes on as it would have, and the lyrics come out when they arrive.
 *
 * Changes that come before the new lyrics are out do not queue: the wait starts over and the
 * newest song is the one that arrives, as for the deck card and the song's bubble. A change that
 * comes while lyrics are still coming out sends them back from where they have got to.
 *
 * This file is the sequence as plain functions of time; useLyricsTurn drives it.
 */
import { SONG_SWAP_OUT_MS } from "./songSwapMotion";

/** How long the panel waits, once the old lyrics have left, for the next song's to be ready. */
export const LYRICS_READY_CAP_MS = 900;

/**
 * `rest`: the lyrics of `shown` are in the panel. `out`: they are leaving. `back`: they were
 * still coming out when the next change came and go back the way they came. `wait`: they have
 * left and the next song's are not ready yet; the panel holds nothing.
 */
export type LyricsTurnPhase = "rest" | "out" | "back" | "wait";

export interface LyricsTurn<Song> {
  /** The song whose lyrics are in the panel; null while it holds nothing. */
  shown: Song | null;
  /** The song the panel is turning to; `shown` at rest. */
  wanted: Song | null;
  phase: LyricsTurnPhase;
  /** When the song last changed, in ms; 0 for the song a panel opened on. */
  since: number;
  /** When the lyrics of `shown` came into view; null while it has none to show. */
  revealedAt: number | null;
  /** `back`: how far the entrance had come when it was turned around, in ms. */
  turnedAt: number | null;
  /** How many times the content has turned: the first lyrics of a panel simply appear. */
  turns: number;
}

/** A panel that opens on `song`. */
export function lyricsTurnAt<Song>(song: Song | null): LyricsTurn<Song> {
  return { shown: song, wanted: song, phase: "rest", since: 0, revealedAt: null, turnedAt: null, turns: 0 };
}

/**
 * The playing song is now `song`. `moves` is false under reduced motion: the content then
 * changes at once, as it does when there is nothing to take away or nothing to bring.
 */
export function turnLyricsTo<Song>(turn: LyricsTurn<Song>, song: Song | null, now: number, moves: boolean): LyricsTurn<Song> {
  if (song === turn.wanted) return turn;
  if (turn.phase !== "rest") return { ...turn, wanted: song, since: now };
  if (!moves || turn.shown === null || song === null) return { ...lyricsTurnAt(song), since: now, turns: turn.turns };
  // Lyrics that are still on their way in are not flashed to full view just to be sent away:
  // they go back from where they are, if that fits into the exit.
  const arrivedFor = turn.revealedAt === null ? null : now - turn.revealedAt;
  const back = turn.turns > 0 && arrivedFor !== null && arrivedFor < SONG_SWAP_OUT_MS;
  return { ...turn, wanted: song, phase: back ? "back" : "out", since: now, turnedAt: back ? Math.max(0, arrivedFor) : null };
}

/**
 * Time has passed, or what is known about the lyrics has changed. `ready`: the lyrics of
 * `wanted` are fetched or known to be missing. `visible`: `shown` has lyrics on screen.
 */
export function advanceLyricsTurn<Song>(turn: LyricsTurn<Song>, now: number, ready: boolean, visible: boolean): LyricsTurn<Song> {
  if (turn.phase === "rest") {
    if (visible === (turn.revealedAt !== null)) return turn;
    return { ...turn, revealedAt: visible ? now : null };
  }
  const left = now >= turn.since + SONG_SWAP_OUT_MS;
  if (!left) return turn;
  if (turn.wanted === null) return { ...lyricsTurnAt<Song>(null), turns: turn.turns };
  if (ready || now >= turn.since + SONG_SWAP_OUT_MS + LYRICS_READY_CAP_MS) {
    // Whether the new lyrics are in view is found out in the next pass, at rest.
    return { shown: turn.wanted, wanted: turn.wanted, phase: "rest", since: turn.since, revealedAt: null, turnedAt: null, turns: turn.turns + 1 };
  }
  return turn.phase === "wait" ? turn : { ...turn, shown: null, phase: "wait", revealedAt: null, turnedAt: null };
}

/** When `advanceLyricsTurn` has to be asked again whatever happens, in ms; null at rest. */
export function lyricsTurnDeadline<Song>(turn: LyricsTurn<Song>): number | null {
  if (turn.phase === "rest") return null;
  return turn.since + SONG_SWAP_OUT_MS + (turn.phase === "wait" ? LYRICS_READY_CAP_MS : 0);
}

/** The old lyrics are on their way out: they are a picture, not something to click. */
export const lyricsLeaving = (phase: LyricsTurnPhase): boolean => phase === "out" || phase === "back";
