import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isVideoTrack } from "../../lib/format";
import { useLyricsPrefs } from "../../lib/lyricsPrefs";
import {
  advanceLyricsTurn,
  lyricsLeaving,
  lyricsTurnAt,
  lyricsTurnDeadline,
  turnLyricsTo,
  type LyricsTurnPhase,
} from "../../lib/lyricsTurn";
import { hasVisibleLyrics, lyricsSettled } from "../../lib/lyricsVisibility";
import { prefersReducedMotion } from "../../lib/motion";
import {
  SONG_SWAP_IN_EASE,
  SONG_SWAP_IN_MS,
  SONG_SWAP_OUT_EASE,
  SONG_SWAP_OUT_MS,
  setSongSurfacePresent,
} from "../../lib/songSwapMotion";
import { streamMeta } from "../../lib/streamTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

/** What the lyrics view carries for its part in the song change. */
export interface LyricsTurnView {
  /** The song whose lyrics the panel holds now: the previous one until its exit is over, and
   *  none while the next one's are waited for. */
  track: Track | null;
  /** Changes with every turn, so lyrics that come out are a view of their own. */
  key: string;
  phase: LyricsTurnPhase;
  /** The lyrics are a picture on its way out. */
  leaving: boolean;
  /** These lyrics came by a turn and come out with its gesture; a panel's first simply appear. */
  arriving: boolean;
  /** When the song of `track` started, as far as the panel saw it (performance.now()); 0 for
   *  the song it opened on. */
  songSince: number;
  /** The clock for the stylesheet (LyricsView.css). */
  style: CSSProperties;
}

const TURN_CLOCK = {
  "--kd-swap-out": `${SONG_SWAP_OUT_MS}ms`,
  "--kd-swap-in": `${SONG_SWAP_IN_MS}ms`,
  "--kd-swap-out-ease": SONG_SWAP_OUT_EASE,
  "--kd-swap-in-ease": SONG_SWAP_IN_EASE,
} as CSSProperties;

const isVideo = (track: Track) => isVideoTrack(track.format) || streamMeta(track)?.kind === "video";

/**
 * Drives the turn of a lyrics panel that shows the playing song (lib/lyricsTurn.ts): which
 * song's lyrics it holds, and whether they are leaving. The lyrics of the song that left stay in
 * the lyrics store, so the view that leaves is the real one with its own data, made inert.
 *
 * While it holds lyrics the panel is a present surface of the song (songSwapMotion.ts), so the
 * entrances of the other surfaces wait for its exit as it waits for theirs.
 */
export function useLyricsTurn(track: Track | null, surface = "lyrics"): LyricsTurnView {
  const song = track?.id ?? null;
  const [stored, setTurn] = useState(() => lyricsTurnAt(song));
  let turn = stored;
  // Decided while rendering: the new song's lyrics are never drawn in the old ones' place.
  if (turn.wanted !== song) {
    turn = turnLyricsTo(turn, song, performance.now(), !prefersReducedMotion());
    setTurn(turn);
  }
  // The records of the songs in play: the one that leaves is no longer the playing track.
  const records = useRef(new Map<number, Track>());
  if (track) records.current.set(track.id, track);
  for (const id of records.current.keys()) if (id !== turn.shown && id !== turn.wanted) records.current.delete(id);
  const shown = turn.shown === null ? null : turn.shown === song ? track : records.current.get(turn.shown) ?? null;

  const ready = useLyricsStore(state => !track || isVideo(track) || lyricsSettled(state.get(track.id)));
  const visible = useLyricsStore(state => !!shown && !isVideo(shown) && hasVisibleLyrics(state.get(shown.id).lines));
  const known = useRef({ ready, visible });
  known.current = { ready, visible };
  // What the disk has for the next song is asked for at the change itself: the view that would
  // ask is not there while the old lyrics leave.
  const prefsEpoch = useLyricsPrefs(state => state.prefsEpoch);
  useEffect(() => {
    if (track) void useLyricsStore.getState().ensure(track, { cacheOnly: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, prefsEpoch]);

  useEffect(() => {
    const advance = () => setTurn(before => advanceLyricsTurn(before, performance.now(), known.current.ready, known.current.visible));
    advance();
    const deadline = lyricsTurnDeadline(stored);
    if (deadline === null) return;
    const timer = window.setTimeout(advance, Math.max(0, deadline - performance.now()) + 4);
    return () => window.clearTimeout(timer);
  }, [stored, ready, visible]);

  const present = turn.shown !== null && (visible || lyricsLeaving(turn.phase));
  useEffect(() => {
    if (!present || prefersReducedMotion()) return;
    let alive = true;
    // After this commit's effects: lyrics that appear together with a song are not something
    // that song's other surfaces have to wait for.
    queueMicrotask(() => { if (alive) setSongSurfacePresent(surface, true); });
    return () => {
      alive = false;
      setSongSurfacePresent(surface, false);
    };
  }, [surface, present]);

  return {
    track: shown,
    key: `${turn.shown}:${turn.turns}`,
    phase: turn.phase,
    leaving: lyricsLeaving(turn.phase),
    arriving: turn.turns > 0,
    songSince: turn.phase === "rest" ? turn.since : 0,
    // Played backwards from the moment it was turned around, the entrance retraces itself.
    style: turn.phase === "back" && turn.turnedAt !== null
      ? { ...TURN_CLOCK, "--kd-swap-rewind": `${Math.round(turn.turnedAt - SONG_SWAP_IN_MS)}ms` } as CSSProperties
      : TURN_CLOCK,
  };
}
