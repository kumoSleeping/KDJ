/**
 * One clock for everything that leaves and comes back when the song changes.
 *
 * 曲目信息, the floating video, the deck card of the player bar and the lyrics all belong to
 * the playing song. On a change each one that is on screen leaves first, and the new ones arrive together
 * afterwards: a surface that has nothing to take away still waits out the others' exit instead
 * of arriving alone.
 */
export const SONG_SWAP_OUT_MS = 360;
export const SONG_SWAP_IN_MS = 460;
export const SONG_SWAP_OUT_EASE = "cubic-bezier(0.55, 0, 0.8, 0.35)";
export const SONG_SWAP_IN_EASE = "cubic-bezier(0.22, 0.9, 0.26, 1)";

const present = new Set<string>();

/**
 * A surface reports while it is on screen, its exit included: it stops being present when the
 * exit has finished, not when it starts. A surface that does not move (reduced motion) does not
 * report.
 */
export function setSongSurfacePresent(id: string, on: boolean): void {
  if (on) present.add(id);
  else present.delete(id);
}

/**
 * How long an entrance for the new song waits: the exit time when anything has to leave first,
 * nothing otherwise. The deck card is present whenever the bar shows a song, so going from one
 * song to another always waits out the exit; a first song, with nothing on screen before it,
 * does not. Read it at the moment of the change.
 */
export function songSwapEntranceDelay(): number {
  return present.size > 0 ? SONG_SWAP_OUT_MS : 0;
}
