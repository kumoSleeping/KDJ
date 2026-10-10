import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  lyricExtraLabel,
  lyricExtraTitle,
  useLyricsPrefs,
  type LyricsExtra,
} from "../../lib/lyricsPrefs";
import { LyricsSourcePicker } from "./LyricsSourcePicker";
import { activeLrcIndex, startedLrcIndex, type LrcLine } from "../../lib/lrc";
import {
  LYRICS_FOLLOWING,
  LYRICS_GLIDE_EASE,
  LYRICS_GLIDE_MS,
  LYRICS_JUMP_MS,
  LYRICS_STAGGER_MS,
  centredScrollTop,
  followAfterScroll,
  followAfterSeek,
  followAfterTouch,
  followResumesIn,
  followSettled,
  followedLine,
  followsNow,
  glideKind,
  planGlide,
  type LyricsLayout,
} from "../../lib/lyricsGlide";
import { prefersReducedMotion } from "../../lib/motion";
import {
  getLatestPlayerSync,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";
import { useLyricsStore } from "../../stores/lyricsStore";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { isVideoTrack } from "../../lib/format";
import { streamMeta } from "../../lib/streamTrack";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { useLyricsTurn, type LyricsTurnView } from "./useLyricsTurn";
import "./LyricsView.css";
import { Panel } from "../common";
import { AsyncPanelBody } from "../common/AsyncPanelBody";
import type { Track } from "../../types";

/** The line being sung and the line sung last, as indexes into `lines` (-1: none yet). */
interface LyricClock { active: number; started: number }

const clockAt = (lines: LrcLine[], position: number): LyricClock =>
  ({ active: activeLrcIndex(lines, position), started: startedLrcIndex(lines, position) });

/** For this long after a song starts, the position the player last reported may still be the
 *  previous song's (the bar announces the new song before its media has been reset). */
const STALE_POSITION_MS = 2_000;

/**
 * Where the player is among the lines of `trackId`. The player reports its position many times
 * a second; the view is drawn again only when that crosses into another line. `songSince` is
 * when the song started, when the view knows (performance.now(); 0 otherwise): a view that comes
 * up right after it starts at the song's beginning and waits for the first report.
 */
function usePlayerLyricClock(trackId: number | null, lines: LrcLine[], songSince = 0): LyricClock {
  const remembered = () => trackId == null || (songSince > 0 && performance.now() - songSince < STALE_POSITION_MS)
    ? 0 : getLatestPlayerSync(trackId)?.position ?? 0;
  const [clock, setClock] = useState(() => clockAt(lines, remembered()));
  useEffect(() => {
    const at = (position: number) => {
      const next = clockAt(lines, position);
      setClock(previous => previous.active === next.active && previous.started === next.started ? previous : next);
    };
    at(remembered());
    if (trackId == null) return;
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player") return;
      if (detail.trackId != null && detail.trackId !== trackId) return;
      // Where the song is, or was sent: a play or pause carries the media's time too, which is
      // the previous song's while the new one loads.
      if ((detail.action === "position" || detail.action === "seek") && typeof detail.position === "number") at(detail.position);
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
    // `songSince` only matters when the view comes up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, lines]);
  return clock;
}

function seekToLyric(trackId: number, position: number): void {
  window.dispatchEvent(
    new CustomEvent<SeekDetail>(SEEK_EVENT, {
      detail: { trackId, position },
    }),
  );
}

function alignedText(
  lines: { time: number; text: string }[],
  time: number,
): string | undefined {
  return lines.find((item) => Math.abs(item.time - time) < 0.05)?.text;
}

/** 偏好层对本首歌不可用时，显示上退回原词。 */
function effectiveExtra(
  preferred: LyricsExtra,
  hasMeaning: boolean,
  hasRomaji: boolean,
): LyricsExtra {
  if (preferred === "meaning" && hasMeaning) return "meaning";
  if (preferred === "romaji" && hasRomaji) return "romaji";
  return "off";
}

interface LyricsDetailProps {
  track: Track;
  /** The side column reserves a loading rectangle and collapses unavailable content. */
  reserveEmpty?: boolean;
  /** Keep the caption row, and with it the host's close action, while there are no lyrics. */
  visibleHeader?: boolean;
  /** An existing non-audio transport can supply its own clock and seek route. */
  transport?: { position: number; seek(position: number): void };
}

const isVideo = (track: Track) => isVideoTrack(track.format) || streamMeta(track)?.kind === "video";

/** The lyrics of one song as a panel: the song's detail, a video's side column. */
export function LyricsDetailPanel(props: LyricsDetailProps) {
  return <LyricsPanel {...props} />;
}

/**
 * The lyrics of the playing song, in a panel that stays where it is across songs (the drawer,
 * the side column, a phone's sheet). When the song changes its content turns over: the old
 * lyrics leave, and the next song's come out once they are ready (useLyricsTurn).
 */
export function PlayingLyricsPanel({ track, visibleHeader = false }: { track: Track | null; visibleHeader?: boolean }) {
  const turn = useLyricsTurn(track);
  // No song and nothing on its way out: there is no panel, as before.
  if (!track && !turn.track) return null;
  return <LyricsPanel track={turn.track} turn={turn} reserveEmpty visibleHeader={visibleHeader} />;
}

function LyricsPanel({ track, transport, reserveEmpty = false, visibleHeader = false, turn }: Omit<LyricsDetailProps, "track"> & {
  /** Null while a turning panel waits for the next song's lyrics: it then holds nothing. */
  track: Track | null;
  turn?: LyricsTurnView;
}) {
  const [actionsHost, setActionsHost] = useState<HTMLSpanElement | null>(null);
  const entry = useLyricsStore(state => state.get(track?.id));
  const prefsEpoch = useLyricsPrefs(state => state.prefsEpoch);
  useEffect(() => { if (track) void useLyricsStore.getState().ensure(track, {cacheOnly:true}); }, [track?.id, prefsEpoch]);
  const video = !!track && isVideo(track);
  const ready = !!track && !video && hasVisibleLyrics(entry.lines);
  const state = ready ? "ready" : !track || (!video && (entry.status === "idle" || entry.status === "loading")) ? "loading" : "empty";
  if (!reserveEmpty && !ready) return null;
  return (
    <Panel heading="歌词" visibleHeader={visibleHeader} actionsHost={actionsHost} padded={false} dense className="kd-detail-lyrics-panel">
      <AsyncPanelBody kind="lyrics" state={state}>
        {ready && track && <LyricsView key={turn?.key} track={track} transport={transport} actionsRef={setActionsHost} turn={turn} />}
      </AsyncPanelBody>
    </Panel>
  );
}

/** The glide's clock for the stylesheet: the emphasis of a line keeps time with its move. */
const LYRICS_CLOCK = {
  "--kd-lyrics-glide": `${LYRICS_GLIDE_MS}ms`,
  "--kd-lyrics-glide-ease": LYRICS_GLIDE_EASE,
  "--kd-lyrics-stagger": `${LYRICS_STAGGER_MS}ms`,
} as CSSProperties;

/** A line on its way to its resting place: the animation and where it set off from, in px. */
interface LineGlide { animation: Animation; from: number }

/**
 * Keeps the line being sung on the centre line of the scrolling column `list` (see
 * lib/lyricsGlide.ts for the motion and the rules). `followed` is that line's index; `layoutKey`
 * changes whenever the lines themselves do (another layer, other lyrics). Returns what the
 * column needs to know about the listener's own input.
 */
function useLyricsFollow(followed: number, layoutKey: unknown) {
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useRef<LyricsLayout | null>(null);
  const follow = useRef(LYRICS_FOLLOWING);
  /** Where this view last put the column: a scroll event anywhere else is the listener's. */
  const placedAt = useRef(0);
  const glides = useRef(new Map<number, LineGlide>());
  const resume = useRef<number | null>(null);
  const line = useRef(followed);
  line.current = followed;

  const stopGlides = useCallback(() => {
    for (const glide of glides.current.values()) glide.animation.cancel();
    glides.current.clear();
  }, []);

  /** Measured once per layout: nothing is read while the column moves. */
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const viewport = list.clientHeight;
    // The room above the first line and below the last, so that either can reach the centre.
    const half = `${Math.round(viewport / 2)}px`;
    if (list.style.getPropertyValue("--kd-lyrics-half") !== half) list.style.setProperty("--kd-lyrics-half", half);
    const tops: number[] = [], heights: number[] = [];
    for (const node of list.children as HTMLCollectionOf<HTMLElement>) {
      tops.push(node.offsetTop);
      heights.push(node.offsetHeight);
    }
    layout.current = { tops, heights, viewport, maxScroll: Math.max(0, list.scrollHeight - viewport) };
  }, []);

  /** Put line `index` on the centre line: gliding there, or at once (`glide: false`). */
  const moveTo = useCallback((index: number, glide: boolean) => {
    const list = listRef.current, plan = layout.current;
    if (!list || !plan) return;
    const to = centredScrollTop(plan, index);
    if (to === null) return;
    const from = list.scrollTop;
    const kind = glide && !prefersReducedMotion() && typeof list.animate === "function"
      ? glideKind(to - from, plan.viewport) : "none";
    const moves = kind === "none" ? [] : planGlide(plan, from, to, index, at => {
      const running = glides.current.get(at);
      const progress = running?.animation.effect?.getComputedTiming().progress;
      return running && typeof progress === "number" ? running.from * (1 - progress) : 0;
    });
    stopGlides();
    list.scrollTop = to;
    placedAt.current = list.scrollTop;
    for (const move of moves) {
      const node = list.children[move.index] as HTMLElement | undefined;
      if (!node) continue;
      const animation = node.animate(
        [{ transform: `translateY(${move.from.toFixed(1)}px)` }, { transform: "translateY(0px)" }],
        kind === "jump"
          ? { duration: LYRICS_JUMP_MS, easing: "cubic-bezier(0.22, 0.9, 0.26, 1)", fill: "backwards" }
          : { duration: LYRICS_GLIDE_MS, delay: move.delay, easing: LYRICS_GLIDE_EASE, fill: "backwards" },
      );
      glides.current.set(move.index, { animation, from: move.from });
      animation.onfinish = () => { if (glides.current.get(move.index)?.animation === animation) glides.current.delete(move.index); };
    }
    // A jump is not ridden out: the column is simply somewhere else, and comes into view there.
    if (kind === "jump") list.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: LYRICS_JUMP_MS, easing: "ease-out" });
  }, [stopGlides]);

  /** Follow again when a pause or the wait for a seek is over, without waiting for a new line. */
  const awaitResume = useCallback(() => {
    if (resume.current !== null) window.clearTimeout(resume.current);
    resume.current = null;
    const wait = followResumesIn(follow.current, line.current, performance.now());
    if (wait === null) return;
    resume.current = window.setTimeout(() => {
      resume.current = null;
      const now = performance.now();
      follow.current = followSettled(follow.current, line.current, now);
      if (followsNow(follow.current, line.current, now)) moveTo(line.current, true);
      else awaitResume();
    }, wait + 8);
  }, [moveTo]);

  // The layout: measured when the lines change and when the column is resized (the drawer
  // growing, the window). The sung line is put back on the centre line without a ride.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const settle = () => {
      measure();
      if (followsNow(follow.current, line.current, performance.now())) moveTo(line.current, false);
    };
    settle();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(settle);
    resized.observe(list);
    return () => resized.disconnect();
  }, [layoutKey, measure, moveTo]);

  // Another line: the column glides to it, unless the listener is holding it.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    const now = performance.now();
    follow.current = followSettled(follow.current, followed, now);
    if (followsNow(follow.current, followed, now)) moveTo(followed, true);
    awaitResume();
  }, [followed, moveTo, awaitResume]);

  useEffect(() => () => {
    if (resume.current !== null) window.clearTimeout(resume.current);
    stopGlides();
  }, [stopGlides]);

  const scrolledByHand = () => {
    follow.current = followAfterScroll(follow.current, performance.now());
    awaitResume();
  };
  return {
    listRef,
    /** What the column itself listens to. A scroll that is not where the view put it is the
     *  listener's: the scroll bar, the keyboard, a finger still coasting. */
    listProps: {
      onWheel: scrolledByHand,
      onTouchStart: () => { follow.current = followAfterTouch(follow.current, true, performance.now()); },
      onTouchEnd: () => { follow.current = followAfterTouch(follow.current, false, performance.now()); awaitResume(); },
      onTouchCancel: () => { follow.current = followAfterTouch(follow.current, false, performance.now()); awaitResume(); },
      onScroll: () => {
        const list = listRef.current;
        if (!list || Math.abs(list.scrollTop - placedAt.current) <= 2) return;
        placedAt.current = list.scrollTop;
        scrolledByHand();
      },
    },
    /** A line was clicked: the column goes there once the player has. */
    seekTo(index: number) {
      follow.current = followAfterSeek(follow.current, index, performance.now());
      awaitResume();
    },
  };
}

function LyricsView({ track, transport, actionsRef, turn }: LyricsDetailProps & {
  actionsRef(node: HTMLSpanElement | null): void;
  /** The view's part in a change of song, in a panel that follows the playing song. */
  turn?: LyricsTurnView;
}) {
  const trackId = track.id;
  const playingTrack = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const activeTrack = playingTrack?.id === trackId;
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(trackId),
    () => useLyricsStore.getState().get(trackId),
  );
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const prefsEpoch = useLyricsPrefs((state) => state.prefsEpoch);
  const cycleLyricExtra = useLyricsPrefs((state) => state.cycleLyricExtra);
  const lines = entry.lines ?? [];
  const playerClock = usePlayerLyricClock(transport ? null : trackId, lines, turn?.songSince);
  const { active, started } = transport ? clockAt(lines, transport.position) : playerClock;

  const translated = entry.translated ?? [];
  const romaji = entry.romaji ?? [];
  const hasMeaning = translated.some((line) => line.text.trim());
  const hasRomaji = romaji.some((line) => line.text.trim());
  const layer = effectiveExtra(lyricExtra, hasMeaning, hasRomaji);
  const canCycle = hasMeaning || hasRomaji;
  const follow = useLyricsFollow(followedLine(active, started), `${lines.length}:${layer}:${entry.meta?.platform ?? ""}:${entry.meta?.key ?? ""}`);

  useEffect(() => {
    void useLyricsStore.getState().ensure(track, { cacheOnly: true });
  }, [trackId, prefsEpoch]);

  return (
    <div className="kd-lyrics" style={turn ? { ...LYRICS_CLOCK, ...turn.style } : LYRICS_CLOCK}
      data-has-content={lines.length > 0 || !!entry.error || entry.status === "error" ? "true" : undefined}
      // Lyrics on their way out are a picture: they take no click and are not read out.
      data-turn={turn?.leaving ? turn.phase : undefined} data-arrive={turn?.arriving || undefined}
      inert={turn?.leaving || undefined} aria-hidden={turn?.leaving || undefined}>
      <div className="kd-lyrics-embedded-tools">
        <LyricsSourcePicker platform={entry.meta?.platform} disabled={!activeTrack && !transport} matching={!!entry.inflight} onSelect={platform => void useLyricsStore.getState().ensure(track, { platform })} />
        {canCycle ? <button type="button" className="kd-lyrics-layer" title={lyricExtraTitle(layer)} aria-label={lyricExtraTitle(layer)} onClick={() => cycleLyricExtra(hasMeaning, hasRomaji)}>{lyricExtraLabel(layer)}</button> : null}
        <span className="kd-lyrics-panel-actions" ref={actionsRef} />
      </div>
      <div className="kd-lyrics-stage">
        {entry.error || entry.status === "error" ? <p className="kd-lyrics-empty" role="alert">{entry.error || "歌词暂时不可用"}</p> : null}
        <div ref={follow.listRef} className="kd-lyrics-scroll" aria-live="polite" {...follow.listProps}>
          {lines.map((line, index) => {
            const context = active >= 0 ? active : started;
            const distance = context < 0 ? index + 1 : Math.abs(index - context);
            const past = active >= 0 ? index < active : started >= 0 && index <= started;
            const roma =
              layer === "romaji" ? alignedText(romaji, line.time) : undefined;
            const trans =
              layer === "meaning" ? alignedText(translated, line.time) : undefined;
            return (
              <button
                key={`${line.time}-${index}`}
                type="button"
                className="kd-lyrics-line"
                data-active={index === active ? "true" : undefined}
                data-past={past ? "true" : undefined}
                data-dist={String(Math.min(distance, 4))}
                title={activeTrack || transport ? `跳到 ${formatStamp(line.time)}` : undefined}
                disabled={!activeTrack && !transport}
                onClick={() => {
                  if (!activeTrack && !transport) return;
                  follow.seekTo(index);
                  if (transport) transport.seek(line.time);
                  else seekToLyric(track.id, line.time);
                }}
              >
                {/* The glide moves the line; its emphasis grows on what is inside, so the two
                    never write the same transform. */}
                <span className="kd-lyrics-line-body">
                  {/* Written twice, in the sung weight and in the waiting one: the two fade
                      into each other, and the line keeps the width of the heavier. */}
                  <span className="kd-lyrics-line-text">
                    <span className="kd-lyrics-line-sung">{line.text}</span>
                    <span className="kd-lyrics-line-waiting" aria-hidden="true">{line.text}</span>
                  </span>
                  {roma ? <span className="kd-lyrics-line-roma">{roma}</span> : null}
                  {trans ? <span className="kd-lyrics-line-trans">{trans}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
