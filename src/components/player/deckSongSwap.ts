import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { prefersReducedSeekMotion } from "../../lib/seekTransition";
import {
  SONG_SWAP_IN_EASE,
  SONG_SWAP_IN_MS,
  SONG_SWAP_OUT_EASE,
  SONG_SWAP_OUT_MS,
  setSongSurfacePresent,
} from "../../lib/songSwapMotion";

/** What a deck card needs from its view to follow a song change. */
export interface DeckSwapView {
  key: string;
  cover: string;
}

/**
 * `out`: the old song is being swiped away. `back`: a song that was still arriving when the next
 * change came goes back the way it came. `in`: the new song is arriving.
 */
export type DeckSwapPhase = "out" | "back" | "in";

export interface DeckSongSwap<V extends DeckSwapView> {
  /** The view the card displays: the previous song until its exit is over. */
  view: V | null;
  phase: DeckSwapPhase | null;
  /** The song `view` belongs to; an element keyed by it is replaced only when the song is. */
  song: string | null;
  /** The clock for DeckSongSwap.css, to be set on the card. */
  style: CSSProperties;
}

const DECK_SWAP_CLOCK = {
  "--kd-swap-out": `${SONG_SWAP_OUT_MS}ms`,
  "--kd-swap-in": `${SONG_SWAP_IN_MS}ms`,
  "--kd-swap-out-ease": SONG_SWAP_OUT_EASE,
  "--kd-swap-in-ease": SONG_SWAP_IN_EASE,
} as CSSProperties;

/**
 * Which song a view is about. The same track shown through the video window or as one side of
 * a transition carries another view key, and is not a change of song.
 */
export function deckSongKey(view: DeckSwapView | null): string | null {
  return view ? view.key.replace(/^(?:library|stream|local):/, "track:") : null;
}

/**
 * The deck card's part in the song change (see songSwapMotion.ts). When the song of `view`
 * changes, the card keeps showing the previous song for the exit, then shows the latest one and
 * lets it arrive. Changes that come during the exit do not queue: the wait starts over and the
 * newest song is the one that arrives, as for 曲目信息 and the floating window. A change that
 * comes while a song is still arriving sends that song back from where it has got to. A first
 * song, no song and reduced motion change at once.
 *
 * While it shows a song the card is a present surface of that song, so the entrances of the
 * other surfaces wait for its exit.
 */
export function useDeckSongSwap<V extends DeckSwapView>(view: V | null, surface: string): DeckSongSwap<V> {
  const song = deckSongKey(view);
  const [shownSong, setShownSong] = useState(song);
  const [arrival, setArrival] = useState({ count: 0, on: false });
  // How far an entrance had come, in ms, when the next change turned it around.
  const [turnedAt, setTurnedAt] = useState<number | null>(null);
  const arrivedAt = useRef(0);
  const leaving = useRef(false);
  const changed = shownSong !== song;
  const swiping = changed && shownSong !== null && song !== null && !prefersReducedSeekMotion();
  // The freshest view of the song on display: its title or cover may still be updated.
  const held = useRef(view);
  if (!changed) held.current = view;
  const arrive = () => {
    arrivedAt.current = performance.now();
    setArrival(previous => ({ count: previous.count + 1, on: true }));
    setTurnedAt(null);
  };

  // Before the first paint of a change: a song that is still on its way in is not flashed to
  // full view just to be swiped away (once it has all but settled the swipe starts from there
  // anyway), and a song that returns before its exit is over arrives again instead of popping
  // back.
  useLayoutEffect(() => {
    if (swiping) {
      leaving.current = true;
      const arrivedFor = performance.now() - arrivedAt.current;
      // The way back takes as long as the way in did so far, and has to fit into the exit.
      if (arrival.on && arrivedFor < SONG_SWAP_OUT_MS) setTurnedAt(Math.max(0, arrivedFor));
    } else if (leaving.current) {
      leaving.current = false;
      if (song !== null && !changed) arrive();
      else setTurnedAt(null);
    }
    // Only the start and the end of an exit are decided here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swiping]);

  useEffect(() => {
    if (!changed) return;
    if (!swiping) {
      setShownSong(song);
      return;
    }
    const timer = window.setTimeout(() => {
      leaving.current = false;
      setShownSong(song);
      arrive();
    }, SONG_SWAP_OUT_MS);
    return () => window.clearTimeout(timer);
    // `song` restarts the wait for a newer song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, swiping, song]);

  useEffect(() => {
    if (!arrival.on) return;
    const timer = window.setTimeout(() => setArrival(previous => ({ ...previous, on: false })), SONG_SWAP_IN_MS + 40);
    return () => window.clearTimeout(timer);
  }, [arrival.count, arrival.on]);

  // The cover of the next song is fetched while the old record leaves, so the new record can
  // arrive with its label instead of receiving it halfway in.
  const preloaded = useRef<HTMLImageElement | null>(null);
  const nextCover = swiping ? view?.cover ?? "" : "";
  useEffect(() => {
    if (!nextCover || typeof Image !== "function") return;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.src = nextCover;
    preloaded.current = image;
  }, [nextCover]);

  const shown = swiping ? held.current : view;
  const present = shown !== null;
  useEffect(() => {
    if (!present || prefersReducedSeekMotion()) return;
    let alive = true;
    // After this commit's effects have run: a card that appears together with a song is not
    // something that song's other surfaces have to wait for.
    queueMicrotask(() => { if (alive) setSongSurfacePresent(surface, true); });
    return () => {
      alive = false;
      setSongSurfacePresent(surface, false);
    };
  }, [surface, present]);

  const back = swiping && turnedAt !== null;
  return {
    view: shown,
    phase: swiping ? (back ? "back" : "out") : arrival.on ? "in" : null,
    song: swiping ? shownSong : song,
    // Played backwards from the moment it was turned around, the entrance retraces itself.
    style: back
      ? { ...DECK_SWAP_CLOCK, "--kd-swap-rewind": `${Math.round(turnedAt - SONG_SWAP_IN_MS)}ms` } as CSSProperties
      : DECK_SWAP_CLOCK,
  };
}
