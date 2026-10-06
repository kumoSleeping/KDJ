import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from "react";
import type { Track } from "../../types";
import { beatGridMarkers, waveformBeatGridOrigin } from "../../lib/performanceCues";
import { getLiveDeckClock, runtimePlayer, subscribeLivePlaybackClock } from "../../lib/unifiedPlayer";
import { projectedNativeWaveformPosition } from "../../lib/waveformMotion";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";
import { StaticWaveformCanvas } from "./StaticWaveformCanvas";
import { useStaticPlaybackWaveform } from "./useStaticPlaybackWaveform";
import "./ManagerWaveform.css";

import { WaveformTileCache } from "../../lib/waveformTileCache";
import { WaveformRailMotion } from "../../lib/waveformRailMotion";
import { SeekTransitionOverlay } from "../../lib/seekTransition";

const SECONDS = 6;
function clockPosition(deck: 0 | 1, trackId: number, total: number, fallback = 0) {
  const live = getLiveDeckClock(deck);
  if (live?.trackId === trackId) return projectedNativeWaveformPosition(live.currentTime,
    live.clientPresentationTimeMs, performance.now(), live.playing || live.scratchHeld ? live.audibleRate : 0,
    total, live.loopStart, live.loopLength);
  const state = runtimePlayer().state().decks[deck];
  return state.trackId === trackId ? Math.max(0, Math.min(total, state.currentTime)) : fallback;
}
const TileBeats = memo(function TileBeats({ track, start, end, total }:
  { track: Track; start: number; end: number; total: number }) {
  const markers = useMemo(() => beatGridMarkers(total, track.bpm,
    waveformBeatGridOrigin(track, true), Math.max(0, start), Math.min(total, end), null), [track, start, end, total]);
  return <span className="kd-wave-beat-grid" aria-hidden="true">{markers.map(marker =>
    <i key={marker.positionSec} data-bar={marker.beat === 1 || undefined}
      style={{ left: `${(marker.positionSec - start) / SECONDS * 100}%` }}>
      {marker.beat === 1 ? <span>{marker.bar}</span> : null}
    </i>)}</span>;
});

/** Three immutable six-second tiles, one clock and one transform. No rolling PCM requests. */
export function ManagerWaveform(props: { track: Track; deck: 0 | 1; duration: number;
  amplitudeScale: number; playing: boolean; onLoadingChange(loading: boolean): void }) {
  // A seamless seek swaps physical decks, not the song or its waveform assets.
  return <ScrollingWaveform key={props.track.id} {...props} />;
}
function ScrollingWaveform({ track, deck, duration, amplitudeScale, playing, onLoadingChange }:
  Parameters<typeof ManagerWaveform>[0]) {
  const total = Math.max(0, duration || track.duration || 0);
  const { detail, loading, error } = useStaticPlaybackWaveform(track, total);
  const tileCache = useMemo(() => new WaveformTileCache<HTMLCanvasElement>(8), [detail]);
  const [tile, setTile] = useState(() => Math.floor(clockPosition(deck, track.id, total) / SECONDS));
  const hostRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const motion = useRef(new WaveformRailMotion());
  const transition = useRef(new SeekTransitionOverlay());
  useEffect(() => () => transition.current.clear(), []);
  const wakeRef = useRef<() => void>(() => {});
  const committedStart = useRef((tile - 1) * SECONDS);
  const requestedTile = useRef(tile);
  const positionRef = useRef(clockPosition(deck, track.id, total));
  const gesture = useRef<{ id: number; x: number; left: number; width: number; position: number; moved: boolean } | null>(null);
  const preview = useRef<number | null>(null);
  const pendingSeek = useRef<{ position: number; expires: number; revision: number | undefined } | null>(null);
  const lastRevision = useRef<number | null>(null);
  const syncRail = useCallback((position: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const live = getLiveDeckClock(deck);
    const owned = live?.trackId === track.id;
    motion.current.sync(rail, position, committedStart.current, SECONDS, total,
      !gesture.current && preview.current === null && !pendingSeek.current && owned && (live.playing || live.scratchHeld) ? live.audibleRate : 0,
      owned ? live.discontinuityRevision : 0, owned ? live.loopStart : null, owned ? live.loopLength : null,
      owned && live.scratchHeld);
  }, [deck, track.id, total]);
  const clamp = (position: number) => Math.max(0, Math.min(total, position));
  useEffect(() => onLoadingChange(loading), [loading, onLoadingChange]);
  const seek = (position: number, isPreview = false, scrubbing = false) => {
    window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, {
      detail: { trackId: track.id, position, preview: isPreview, scrubbing, forceCommit: !isPreview },
    }));
  };
  useLayoutEffect(() => {
    committedStart.current = (tile - 1) * SECONDS;
    // Publish new tiles and rebase their running animation in the same layout commit.
    // Stopping here and restarting in the next rAF exposed a stationary frame every six seconds.
    syncRail(positionRef.current);
    wakeRef.current();
  }, [tile, syncRail]);
  useEffect(() => {
    let frame = 0, timer = 0, intersects = true;
    let lastClockKey = "";
    const railMotion = motion.current;
    const update = () => {
      frame = 0;
      if (document.hidden || !intersects) return;
      const live = getLiveDeckClock(deck);
      const clockKey = live ? `${live.trackId}:${live.currentTime}:${live.clientPresentationTimeMs}:${live.audibleRate}:${live.playing}:${live.scratchHeld}:${live.discontinuityRevision}:${live.loopStart}:${live.loopLength}` : "";
      const projected = clockPosition(deck, track.id, total, positionRef.current);
      // A maintenance timer is not a fresh DAC sample. In a bridge stall keep the baked
      // rail moving instead of repeatedly snapping to the projection's 250 ms safety cap.
      const authority = clockKey && clockKey === lastClockKey && typeof railRef.current?.animate === "function"
        ? railMotion.position(positionRef.current) : projected;
      lastClockKey = clockKey;
      const pending = pendingSeek.current;
      if (pending && (performance.now() >= pending.expires ||
        (live?.trackId === track.id && live.discontinuityRevision !== pending.revision) || Math.abs(authority - pending.position) < .1)) pendingSeek.current = null;
      const position = preview.current ?? pendingSeek.current?.position ?? authority;
      const distance = position - railMotion.position(positionRef.current);
      const revision = live?.trackId === track.id ? live.discontinuityRevision : null;
      const landed = revision !== null && lastRevision.current !== null && revision !== lastRevision.current;
      if (revision !== null) lastRevision.current = revision;
      // Transition only real seek requests/landings, never delayed ordinary clock packets.
      if ((pending || landed) && !gesture.current && preview.current === null && !live?.scratchHeld && Math.abs(distance) > .25
        && (pending || !live?.loopLength) && hostRef.current && railRef.current) {
        transition.current.waveform(hostRef.current, railRef.current, distance);
      }
      positionRef.current = position;
      const nextTile = Math.floor(position / SECONDS);
      if (nextTile !== requestedTile.current) { requestedTile.current = nextTile; setTile(nextTile); }
      // A far seek must not move the old tiles offscreen before React installs
      // the destination tiles. The layout effect publishes their pixels + position together.
      if (railRef.current && nextTile === Math.round(committedStart.current / SECONDS) + 1) {
        syncRail(position);
      }
      hostRef.current?.setAttribute("aria-valuenow", position.toFixed(3));
      if (gesture.current || pendingSeek.current || (live?.trackId === track.id ? live.playing || live.scratchHeld : playing)) {
        if (gesture.current || live?.scratchHeld || typeof railRef.current?.animate !== "function") {
          frame = requestAnimationFrame(update);
        } else {
          // Only maintain tile coverage/clock alignment here. The compositor owns every frame.
          timer = window.setTimeout(() => { timer = 0; wake(); }, 100);
        }
      }
    };
    const wake = () => {
      window.clearTimeout(timer); timer = 0;
      if (!frame) frame = requestAnimationFrame(update);
    };
    wakeRef.current = wake;
    const visibility = () => {
      cancelAnimationFrame(frame); frame = 0; window.clearTimeout(timer); timer = 0;
      railMotion.stop();
      if (!document.hidden && intersects) wake();
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      intersects = entries[0]?.isIntersecting ?? true; visibility();
    }) : null;
    if (hostRef.current) observer?.observe(hostRef.current);
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<SeekDetail>).detail;
      if (detail.trackId !== track.id || !Number.isFinite(detail.position)) return;
      const position = Math.max(0, Math.min(total, detail.position));
      // Every seek surface uses this request, not just gestures on this rail.
      // Start the visual handoff now instead of waiting for the audio landing.
      // This is only a presentation target; the device clock still owns playback.
      if (detail.preview) {
        pendingSeek.current = null;
        preview.current = detail.scrubbing === false ? null : position;
        transition.current.clear();
      } else {
        preview.current = null;
        pendingSeek.current = { position, expires: performance.now() + 1500,
          revision: getLiveDeckClock(deck)?.discontinuityRevision };
      }
      wake();
    };
    const unsubscribe = subscribeLivePlaybackClock(wake);
    window.addEventListener(SEEK_EVENT, onSeek, true);
    document.addEventListener("visibilitychange", visibility);
    wake();
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); railMotion.stop(); wakeRef.current = () => {};
      unsubscribe(); observer?.disconnect();
      window.removeEventListener(SEEK_EVENT, onSeek, true); document.removeEventListener("visibilitychange", visibility); };
  }, [deck, track.id, total, playing, syncRail]);
  useEffect(() => () => {
    if (gesture.current) window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, {
      detail: { trackId: track.id, position: gesture.current.position, preview: true, scrubbing: false },
    }));
  }, [track.id]);
  const finish = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    const position = cancelled ? drag.position : drag.moved
      ? clamp(drag.position - (event.clientX - drag.x) / drag.width * SECONDS)
      : clamp(drag.position + ((event.clientX - drag.left) / drag.width - .5) * SECONDS);
    gesture.current = null; preview.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    seek(position, cancelled, false);
  };
  const keySeek = (event: KeyboardEvent<HTMLDivElement>) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -SECONDS, PageDown: SECONDS };
    const next = event.key === "Home" ? 0 : event.key === "End" ? total :
      event.key in offsets ? positionRef.current + offsets[event.key] * (event.shiftKey ? .1 : 1) : null;
    if (next === null || total <= 0) return;
    event.preventDefault(); event.stopPropagation(); seek(clamp(next));
  };
  return <div className="kd-manager-scroll-wave" title={error || undefined}>
    <div ref={hostRef} className="kd-manager-focus-wave kd-manager-wave-window" role="slider" tabIndex={0}
      aria-label="当前歌曲六秒滚动波形" aria-valuemin={0} aria-valuemax={total}
      onPointerDown={event => {
        if (event.button !== 0 || total <= 0 || gesture.current) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const position = motion.current.position(positionRef.current);
        gesture.current = { id: event.pointerId, x: event.clientX, left: rect.left, width: rect.width, position, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        preview.current = position; seek(position, true, true);
      }}
      onPointerMove={event => {
        const drag = gesture.current;
        if (!drag || drag.id !== event.pointerId) return;
        if (Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
        if (drag.moved) preview.current = clamp(drag.position - (event.clientX - drag.x) / drag.width * SECONDS);
      }}
      onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
      onLostPointerCapture={event => finish(event, true)} onKeyDown={keySeek}>
      <div ref={railRef} className="kd-static-wave-rail">
        {[tile - 1, tile, tile + 1].map(index => <div key={index} className="kd-static-wave-tile">
          <div className="kd-static-wave-pixels" style={{ transform: `scaleY(${Math.max(0, Math.min(1, amplitudeScale))})` }}>
            <StaticWaveformCanvas cache={tileCache} wave={detail} start={index * SECONDS} end={(index + 1) * SECONDS}
              warmAhead={index === tile + 1} />
          </div>
          <TileBeats track={track} start={index * SECONDS} end={(index + 1) * SECONDS} total={total} />
        </div>)}
      </div>
    </div>
    <i className="kd-manager-wave-needle" aria-hidden="true" />
  </div>;
}
