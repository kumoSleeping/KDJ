/**
 * How the lyric column follows the song (LyricsView).
 *
 * The column is an ordinary scrolling element, so a wheel, a finger and the keyboard move it as
 * they move anything else. When the sung line changes, the scroll position is set at once to
 * where that line rests on the centre line, and the lines glide there from where they were: each
 * line is moved back by the distance the column just jumped and released to zero. A glide is one
 * compositor animation per line on screen, started once: nothing is measured or written while it
 * runs. The lines below the sung one set off a few ms after it, one after the other, so the
 * column arrives like something soft rather than a block.
 *
 * A change that comes while the lines are still on their way does not queue: each line starts
 * again from where it has got to. A change that is far away (a seek) is not ridden out: the
 * column jumps and the lines settle over a short distance.
 *
 * This file is the arithmetic and the rules for following; the view owns the elements.
 */

/** One glide: a little shorter than a large surface arriving (`--kd-motion-in`, 460 ms). */
export const LYRICS_GLIDE_MS = 420;
/** Arrives a touch past the centre line and settles, about 2% of the way travelled. */
export const LYRICS_GLIDE_EASE = "cubic-bezier(0.3, 1.18, 0.4, 1)";
/** Each line the column leaves behind starts this much after the one before it. */
export const LYRICS_STAGGER_MS = 28;
/** Lines further below start with this one, so a long column arrives as fast as a short one. */
export const LYRICS_STAGGER_LINES = 4;
/** A jump: how far the lines still travel, and for how long. */
export const LYRICS_JUMP_TRAVEL = 28;
export const LYRICS_JUMP_MS = 240;
/** After the listener's own scroll the column waits this long before it follows again. */
export const LYRICS_FOLLOW_PAUSE_MS = 3_000;
/** After a click on a line the column waits this long, at most, for the seek to land there. */
export const LYRICS_SEEK_WAIT_MS = 900;

/** Where each line lies in the column, measured once per layout. */
export interface LyricsLayout {
  tops: readonly number[];
  heights: readonly number[];
  /** The visible height of the column. */
  viewport: number;
  /** The furthest the column scrolls. */
  maxScroll: number;
}

/**
 * The scroll position at which line `index` rests on the centre line. Before the first line
 * (-1) the column is at its top, where that line waits on the centre line.
 */
export function centredScrollTop(layout: LyricsLayout, index: number): number | null {
  if (index < 0) return layout.tops.length ? 0 : null;
  const top = layout.tops[index], height = layout.heights[index];
  if (top === undefined || height === undefined) return null;
  return Math.round(Math.max(0, Math.min(layout.maxScroll, top - (layout.viewport - height) / 2)));
}

/** The line the column keeps on the centre line: the one being sung, or between two lines the
 *  one sung last. -1 before the first line. */
export function followedLine(active: number, started: number): number {
  return active >= 0 ? active : started;
}

/**
 * How a change of `distance` px is shown: not at all, as a glide, or — further than the column
 * is tall — as a jump.
 */
export function glideKind(distance: number, viewport: number): "none" | "glide" | "jump" {
  const far = Math.abs(distance);
  if (far < 1) return "none";
  return far > Math.max(viewport, 1) ? "jump" : "glide";
}

/**
 * How long line `index` waits before it sets off after the line `followed`. The lines the
 * column leaves behind trail it: those below when it moves up (`distance` > 0, the usual way),
 * those above when it moves back down. The other side leads, so no line runs into the next.
 */
export function glideDelay(index: number, followed: number, distance: number): number {
  const behind = distance >= 0 ? index - followed : followed - index;
  return Math.max(0, Math.min(LYRICS_STAGGER_LINES, behind)) * LYRICS_STAGGER_MS;
}

export interface LineGlide {
  index: number;
  /** Where the line starts, in px from its resting place. */
  from: number;
  delay: number;
}

/**
 * The lines that move when the column goes from scroll position `from` to `to`, and where each
 * starts. `left(index)` is how far a line still is from its resting place because of a glide
 * that has not ended (0 when it is at rest). Only lines that are on screen before or after the
 * change take part; the others are simply where they belong.
 */
export function planGlide(layout: LyricsLayout, from: number, to: number, followed: number, left: (index: number) => number): LineGlide[] {
  const distance = to - from;
  const kind = glideKind(distance, layout.viewport);
  if (kind === "none") return [];
  // A margin of a few lines: one that is just outside may be carried in by the overshoot.
  const margin = 96;
  const first = Math.min(from, to) - margin, last = Math.max(from, to) + layout.viewport + margin;
  const plan: LineGlide[] = [];
  for (let index = 0; index < layout.tops.length; index += 1) {
    const top = layout.tops[index]!, bottom = top + layout.heights[index]!;
    if (kind === "jump") {
      // Only what the jump lands on moves, over a short way in the direction of the jump.
      if (bottom < to - margin || top > to + layout.viewport + margin) continue;
      plan.push({ index, from: Math.sign(distance) * LYRICS_JUMP_TRAVEL, delay: 0 });
      continue;
    }
    if (bottom < first || top > last) continue;
    const start = distance + left(index);
    if (Math.abs(start) >= 0.5) plan.push({ index, from: start, delay: glideDelay(index, followed, distance) });
  }
  return plan;
}

/**
 * What keeps the column from following the song for now. The listener's own scroll (a wheel, a
 * finger, the scroll bar, the keyboard) pauses it; a click on a line holds it until the seek has
 * landed on that line, so the column does not first return to the line that was being sung.
 */
export interface LyricsFollow {
  /** A finger is on the column. */
  touching: boolean;
  /** The listener scrolled: follow again at this time (performance.now()), 0 = not paused. */
  pausedUntil: number;
  /** A line was clicked: its index, and when to stop waiting for the player to get there. */
  seek: { index: number; until: number } | null;
}

export const LYRICS_FOLLOWING: LyricsFollow = { touching: false, pausedUntil: 0, seek: null };

/** The listener moved the column by hand. */
export function followAfterScroll(state: LyricsFollow, now: number): LyricsFollow {
  return { ...state, pausedUntil: now + LYRICS_FOLLOW_PAUSE_MS };
}

/** A finger went down on the column, or left it: the pause counts from when it leaves. */
export function followAfterTouch(state: LyricsFollow, touching: boolean, now: number): LyricsFollow {
  return touching ? { ...state, touching } : { ...state, touching, pausedUntil: now + LYRICS_FOLLOW_PAUSE_MS };
}

/** A line was clicked: the listener chose where to be, so a pause from scrolling is over. */
export function followAfterSeek(state: LyricsFollow, index: number, now: number): LyricsFollow {
  return { ...state, pausedUntil: 0, seek: { index, until: now + LYRICS_SEEK_WAIT_MS } };
}

/** Whether the column may move to `followed` now. */
export function followsNow(state: LyricsFollow, followed: number, now: number): boolean {
  if (state.touching || now < state.pausedUntil) return false;
  return !state.seek || state.seek.index === followed || now >= state.seek.until;
}

/**
 * When to ask `followsNow` again without a change of line, in ms from `now`: the end of a pause
 * or of the wait for a seek. Null while nothing is pending (or a finger is still down: its
 * lifting asks).
 */
export function followResumesIn(state: LyricsFollow, followed: number, now: number): number | null {
  if (state.touching) return null;
  const seekUntil = state.seek && state.seek.index !== followed ? state.seek.until : 0;
  const until = Math.max(state.pausedUntil, seekUntil);
  return until > now ? until - now : null;
}

/** The wait for a seek ends when the player has got to the clicked line or the time is up. */
export function followSettled(state: LyricsFollow, followed: number, now: number): LyricsFollow {
  if (!state.seek) return state;
  return state.seek.index === followed || now >= state.seek.until ? { ...state, seek: null } : state;
}
