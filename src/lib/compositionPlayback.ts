import { useEffect, useState } from "react";
import { getLatestPlayerSync, getLocalVideoClock, MEDIA_SYNC_EVENT, type MediaSyncDetail } from "./mediaSync";
import { getPlayerSession, subscribePlayerSession } from "./playerSession";
import { getPlayingTrack, subscribePlayingTrack } from "./playingTrack";
import { getLiveDeckClock, getLiveForegroundDeck, runtimePlayer, subscribeLivePlaybackClock } from "./unifiedPlayer";
import { liveWaveformPlaybackRate, projectedNativeWaveformPosition } from "./waveformMotion";

export interface CompositionSegment {
  source_start_ms: number;
  source_end_ms: number | null;
}

/** All time and duration values here are seconds, in the loaded source's coordinates. */
export interface CompositionClock {
  trackId: number | null;
  ready: boolean;
  currentTime: number;
  duration: number;
  playing: boolean;
  rate: number;
  error: string;
  sourceId: number | null;
  discontinuityRevision: number;
  loopGeneration: number;
  loopWrapCount: number;
  fresh?: boolean;
}

export function getCompositionClock(): CompositionClock {
  const player = runtimePlayer();
  const native = player.state();
  const session = getPlayerSession();
  const trackId = getPlayingTrack()?.id ?? session.trackId;
  const sync = trackId === null ? null : getLatestPlayerSync(trackId);
  const nativeClock = player.kind !== "browser-preview";
  const foreground = getLiveForegroundDeck();
  const candidate = player.kind === "desktop-native" ? getLiveDeckClock(foreground) : null;
  const live = trackId !== null && candidate?.trackId === trackId ? candidate : null;
  const now = performance.now();
  // Do not apply a pre-seek callback after the full snapshot has acknowledged the landing.
  // No visual anchor is retained: new source/discontinuity/loop samples replace it immediately.
  const deck = native.decks[foreground];
  const videoClock = trackId !== null ? getLocalVideoClock(trackId) : null;
  const liveCurrent = !live || (
    Number.isFinite(live.clientPresentationTimeMs)
    && Math.abs(now - live.clientPresentationTimeMs) <= 250
    && (deck.trackId !== trackId || live.discontinuityRevision >= deck.discontinuityRevision)
  );
  const ready = player.kind === "desktop-native" ? videoClock !== null : trackId !== null && liveCurrent && (nativeClock
    ? native.trackId === trackId && !native.buffering && !["idle", "loading", "error"].includes(native.status)
    : session.trackId === trackId && !["idle", "resolving", "loading", "buffering", "error"].includes(session.status));
  const rate = live
    ? liveWaveformPlaybackRate(live.targetRate, live.audibleRate, live.scratchHeld)
    : nativeClock ? native.rate : sync?.rate ?? 1;
  const currentTime = videoClock?.position ?? (live
    ? projectedNativeWaveformPosition(
      live.currentTime, live.clientPresentationTimeMs, now, rate,
      native.duration, live.loopStart, live.loopLength,
    )
    : nativeClock ? native.currentTime : sync?.position ?? session.position);
  return {
    trackId,
    ready,
    fresh: videoClock?.fresh,
    currentTime: ready ? currentTime : 0,
    duration: ready ? (nativeClock ? native.duration : session.duration) : 0,
    playing: ready && (live ? live.playing || Math.abs(rate) > 0.02 : nativeClock ? native.playing : session.playing),
    rate,
    error: (native.trackId === trackId ? native.error : "") || (session.trackId === trackId ? session.error : ""),
    sourceId: live?.sourceId ?? null,
    discontinuityRevision: live?.discontinuityRevision ?? (deck.trackId === trackId ? deck.discontinuityRevision : 0),
    loopGeneration: live?.loopGeneration ?? 0,
    loopWrapCount: live?.loopWrapCount ?? 0,
  };
}

/** Read at click time: never capture a cached render or a different loaded track. */
export function getCompositionPosition(trackId: number): number | null {
  const clock = getCompositionClock();
  return clock.ready && clock.fresh !== false && clock.trackId === trackId && Number.isFinite(clock.currentTime)
    ? Math.max(0, Math.round(clock.currentTime * 1000)) : null;
}

/** Read-only subscriptions; this hook never loads, seeks, or advances a player. */
export function useCompositionClock(): CompositionClock {
  const [clock, setClock] = useState(getCompositionClock);
  useEffect(() => {
    const update = () => {
      const next = getCompositionClock();
      setClock((previous) => Object.keys(next).every((key) =>
        previous[key as keyof CompositionClock] === next[key as keyof CompositionClock]) ? previous : next);
    };
    const onSync = (event: Event) => {
      if ((event as CustomEvent<MediaSyncDetail>).detail?.owner === "player") update();
    };
    const unsubscribeRuntime = runtimePlayer().subscribe(update);
    const unsubscribeLive = subscribeLivePlaybackClock(update);
    const unsubscribeSession = subscribePlayerSession(update);
    const unsubscribeTrack = subscribePlayingTrack(update);
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    update();
    return () => {
      unsubscribeRuntime(); unsubscribeLive(); unsubscribeSession(); unsubscribeTrack();
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
    };
  }, []);
  return clock;
}
