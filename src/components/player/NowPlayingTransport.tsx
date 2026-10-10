import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { usesLocalLibraryRecord } from "../../lib/playbackTrackSource";
import {
  getPlayerSession,
  getPlayerSessionState,
  requestPlayerCommand,
  subscribePlayerSession,
} from "../../lib/playerSession";
import { trackPointerSession } from "../../lib/pointerSession";
import {
  cachedReleaseOverviewWaveform,
  loadReleaseOverviewById,
  subscribeReleaseOverviewWaveform,
} from "../../lib/waveformCache";
import type { Track } from "../../types";
import {
  MINI_WAVE_BARS,
  MINI_WAVE_HEIGHT,
  MINI_WAVE_PITCH,
  miniWaveformLevels,
  miniWaveformPath,
  seekFraction,
} from "./miniWaveform";

/** The arrow keys on the progress line, in seconds; Shift takes the larger step. */
const SEEK_STEP = 5;
const SEEK_STEP_LARGE = 15;
/** A report this close to where a seek was sent is its answer, in seconds. */
const SEEK_LANDED_S = 1.5;
/** How long the line waits for that answer before it shows the player's position again. */
const SEEK_WAIT_MS = 700;

/** The song's overview as the path of the mini waveform, once it is in the shared cache. */
function useMiniWaveform(track: Track): string | null {
  const [wave, setWave] = useState(() => cachedReleaseOverviewWaveform(track.id));
  useEffect(() => {
    const read = () => setWave(cachedReleaseOverviewWaveform(track.id));
    read();
    const unsubscribe = subscribeReleaseOverviewWaveform(track.id, read);
    // The bar's own waveform asks for it too; with the bar away this is the only reader. An
    // online song's waveform grows with its media and is not asked for here.
    if (!cachedReleaseOverviewWaveform(track.id) && usesLocalLibraryRecord(track)) {
      void loadReleaseOverviewById(track.id, "visible").catch(() => undefined);
    }
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);
  return useMemo(() => {
    // An overview of a part of the song is not the song's shape.
    if (!wave || wave.source_start !== undefined || wave.source_end !== undefined) return null;
    const levels = miniWaveformLevels(wave.amp, MINI_WAVE_BARS);
    return levels ? miniWaveformPath(levels) : null;
  }, [wave]);
}

/**
 * The progress of the playing song as a line that can be clicked or dragged: the mini waveform
 * when the song has one, a plain rounded line otherwise, with the time played before it and the
 * time left after it. The position is written straight into the elements from the player
 * session, so the clock re-renders nothing.
 */
function NowPlayingSeek({ track }: { track: Track }) {
  const path = useMiniWaveform(track);
  const line = useRef<HTMLDivElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  const remaining = useRef<HTMLSpanElement>(null);
  /** The place under the pointer while the line is dragged, 0..1, until the player has taken it. */
  const scrub = useRef<number | null>(null);
  const abandon = useRef<(() => void) | null>(null);
  /** The seek that was sent when the line was let go: where to, and how long to wait for it. */
  const sought = useRef<{ position: number; until: number } | null>(null);
  const live = useRef({ track });
  live.current = { track };

  const total = () => {
    const session = getPlayerSession();
    return (session.trackId === live.current.track.id ? session.duration : 0) || live.current.track.duration || 0;
  };
  /** The last position the player reported for this song. */
  const heard = useRef(0);
  const paint = () => {
    const session = getPlayerSession();
    // A bubble that is rolling down with the song before keeps that song's last position.
    if (session.trackId === live.current.track.id) heard.current = session.position;
    const length = total();
    const fraction = scrub.current ?? (length > 0 ? Math.min(1, Math.max(0, heard.current / length)) : 0);
    const at = fraction * length;
    const node = line.current;
    if (node) {
      node.style.setProperty("--kd-now-seek", fraction.toFixed(4));
      const now = String(Math.round(at));
      if (node.getAttribute("aria-valuenow") !== now) {
        node.setAttribute("aria-valuemax", String(Math.round(length)));
        node.setAttribute("aria-valuenow", now);
        node.setAttribute("aria-valuetext", `${formatDuration(at)} / ${formatDuration(length)}`);
      }
    }
    const played = length > 0 ? formatDuration(at) : "--:--";
    const left = length > 0 ? `−${formatDuration(Math.max(0, length - at))}` : "−−:−−";
    if (elapsed.current && elapsed.current.textContent !== played) elapsed.current.textContent = played;
    if (remaining.current && remaining.current.textContent !== left) remaining.current.textContent = left;
  };
  const painter = useRef(paint);
  painter.current = paint;
  useLayoutEffect(() => {
    painter.current();
    return subscribePlayerSession(() => {
      // The line stays where it was let go until the player reports from there: a tick of the
      // clock that was already on its way would show the old place for a frame.
      const seek = sought.current;
      if (seek && (Math.abs(getPlayerSession().position - seek.position) < SEEK_LANDED_S || performance.now() > seek.until)) {
        sought.current = null;
        scrub.current = null;
      }
      painter.current();
    });
  }, [track.id]);
  useEffect(() => () => abandon.current?.(), []);

  /** Ask the player to go there. False when there is nothing to seek in. */
  const seekTo = (position: number): boolean => {
    const length = total();
    if (getPlayerSession().trackId !== live.current.track.id || length <= 0) return false;
    const target = Math.min(length, Math.max(0, position));
    const seek = { position: target, until: performance.now() + SEEK_WAIT_MS };
    sought.current = seek;
    requestPlayerCommand({ type: "seek", position: target });
    // A paused player that never reports from there says nothing more: the wait ends by itself.
    window.setTimeout(() => {
      if (sought.current !== seek) return;
      sought.current = null;
      scrub.current = null;
      painter.current();
    }, SEEK_WAIT_MS);
    return true;
  };

  return <div className="kd-now-seek">
    <span ref={elapsed} className="kd-now-time" aria-hidden="true" />
    <div ref={line} className="kd-now-line" role="slider" tabIndex={0} aria-label="播放进度" aria-valuemin={0}
      data-wave={path ? "true" : undefined}
      onPointerDown={event => {
        if (event.button !== 0 || total() <= 0) return;
        event.preventDefault();
        const node = event.currentTarget;
        // Measured once, when the drag starts.
        const box = node.getBoundingClientRect();
        const follow = (clientX: number) => {
          scrub.current = seekFraction(clientX, box.left, box.width);
          painter.current();
        };
        const row = node.parentElement;
        row?.setAttribute("data-scrubbing", "true");
        sought.current = null;
        follow(event.clientX);
        abandon.current?.();
        abandon.current = trackPointerSession(event.pointerId, {
          move: moved => follow(moved.clientX),
          end: released => {
            abandon.current = null;
            row?.removeAttribute("data-scrubbing");
            // One seek, where the pointer was let go; a gesture that was cancelled seeks nowhere.
            if (!released || scrub.current === null || !seekTo(scrub.current * total())) scrub.current = null;
            painter.current();
          },
        });
      }}
      onKeyDown={event => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (!step && event.key !== "Home") return;
        // The line's own keys: the window's arrow-key mapping does not see them.
        event.preventDefault();
        if (getPlayerSession().trackId !== live.current.track.id) return;
        seekTo(step ? getPlayerSession().position + step * (event.shiftKey ? SEEK_STEP_LARGE : SEEK_STEP) : 0);
      }}>
      {path ? <>
        <MiniWave path={path} />
        <MiniWave path={path} played />
      </> : <span className="kd-now-rail" aria-hidden="true"><i /></span>}
    </div>
    <span ref={remaining} className="kd-now-time" aria-hidden="true" />
  </div>;
}

/** One layer of the mini waveform: the whole song muted, and over it the played part in ink. */
function MiniWave({ path, played }: { path: string; played?: boolean }) {
  return <svg className="kd-now-wave" data-played={played ? "true" : undefined} aria-hidden="true"
    viewBox={`0 0 ${MINI_WAVE_BARS * MINI_WAVE_PITCH} ${MINI_WAVE_HEIGHT}`} preserveAspectRatio="none">
    <path d={path} />
  </svg>;
}

/**
 * The mini transport of the playing song's bubble: previous, play / pause, next and the
 * progress line. The keys send the same commands the lyrics and detail panels send
 * (requestPlayerCommand): the player bar alone carries them out, whether it is on screen or put
 * away.
 */
export function NowPlayingTransport({ track }: { track: Track }) {
  const session = useSyncExternalStore(subscribePlayerSession, getPlayerSessionState, getPlayerSessionState);
  const current = session.trackId === track.id;
  const playing = current && session.playing;
  const loading = current && (session.status === "resolving" || session.status === "loading" || session.status === "buffering");
  return <div className="kd-now-transport">
    <div className="kd-now-keys">
      <button type="button" className="kd-now-key" aria-label="上一首" title="上一首"
        onClick={() => requestPlayerCommand({ type: "previous" })}>
        <SkipBack size={13} fill="currentColor" aria-hidden="true" />
      </button>
      <button type="button" className="kd-now-key kd-now-go" data-playing={playing ? "true" : undefined}
        aria-label={loading ? "加载中" : playing ? "暂停" : "播放"} aria-busy={loading || undefined}
        title="播放 / 暂停（空格）" onClick={() => requestPlayerCommand({ type: "toggle" })}>
        {loading ? <LoaderCircle size={13} className="kd-spin" aria-hidden="true" />
          : playing ? <Pause size={12} fill="currentColor" aria-hidden="true" />
            : <Play size={12} fill="currentColor" aria-hidden="true" />}
      </button>
      <button type="button" className="kd-now-key" aria-label="下一首" title="下一首"
        onClick={() => requestPlayerCommand({ type: "next" })}>
        <SkipForward size={13} fill="currentColor" aria-hidden="true" />
      </button>
    </div>
    <NowPlayingSeek key={track.id} track={track} />
  </div>;
}
