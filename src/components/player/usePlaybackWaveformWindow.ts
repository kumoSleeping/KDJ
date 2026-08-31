import { useEffect, useRef, useState } from "react";
import {
  createPlaybackWaveformAtlas,
  playbackWaveformContiguousAtlasWindow,
  playbackWaveformRequestCenter,
  playbackWaveformRequestIsUrgent,
  playbackWaveformShouldLoadFullDetail,
  requestPlaybackWaveformWindow,
  stabilizePlaybackWaveformWindow,
  supportsPlaybackWaveformWindow,
  type PlaybackWaveformAtlas,
} from "../../lib/playbackWaveform";
import {
  cachedWaveform,
  isPlaybackDeferredWaveformError,
  loadWaveform,
} from "../../lib/waveformCache";
import {
  getLiveDeckClock,
  runtimePlayer,
  subscribeLivePlaybackClock,
} from "../../lib/unifiedPlayer";
import {
  detailWaveformBuckets,
  managerWaveformRequestSeconds,
  waveformCoversViewport,
  waveformSourceRange,
  waveformWindowFromFullDetail,
} from "../../lib/waveformViewport";
import type { Waveform } from "../../types";

interface OwnedWindow {
  owner: number;
  waveform: Waveform | null;
}

// Keep the first bounded decode wide enough to survive transport publication jitter, but do not
// renew as soon as that outer runway starts moving. Decoupling these margins retains the same cold
// first paint while avoiding a fresh FFT for nearly every observer publication.
const REQUEST_MARGIN_SECONDS = 1.25;
const RENEWAL_MARGIN_SECONDS = 0.5;
const FULL_DETAIL_WINDOW_SECONDS = 12;
const FULL_DETAIL_FALLBACK_DELAY_MS = 2_000;
const FULL_DETAIL_RETRY_MS = 5_000;
const FULL_DETAIL_IDLE_TIMEOUT_MS = 2_000;
const COVERAGE_CHECK_MS = 250;
const CACHE_RETRY_MS = 50;
const UNCHANGED_WINDOW_RETRY_MS = 250;
const ERROR_RETRY_MS = 300;

function currentDeckPosition(deck: 0 | 1, trackId: number): number {
  const live = getLiveDeckClock(deck);
  if (live?.trackId === trackId && Number.isFinite(live.currentTime)) {
    return live.currentTime;
  }
  const state = runtimePlayer().state().decks[deck];
  return state.trackId === trackId && Number.isFinite(state.currentTime)
    ? state.currentTime
    : 0;
}

/**
 * Keep one bounded native waveform ahead of the six-second Manager viewport.
 *
 * Playback time is read imperatively from the callback-correlated clock. It must never be a React
 * dependency: the old hook received a 10 Hz `position` prop, re-rendered the whole detail panel,
 * and repeatedly reconciled a large canvas even though its source window changed only every few
 * seconds. This hook wakes at most four times a second and publishes React state only when native
 * PCM has produced a genuinely new window.
 */
export function usePlaybackWaveformWindow({
  trackId,
  deck,
  duration,
  viewportSeconds,
  enabled,
}: {
  trackId: number;
  deck: 0 | 1;
  duration: number;
  viewportSeconds: number;
  enabled: boolean;
}): Waveform | null {
  const [state, setState] = useState<OwnedWindow>({
    owner: trackId,
    waveform: null,
  });
  const stateRef = useRef(state);
  const ownerRef = useRef(trackId);
  const atlasRef = useRef<{ owner: number; atlas: PlaybackWaveformAtlas }>({
    owner: trackId,
    atlas: createPlaybackWaveformAtlas(trackId),
  });
  stateRef.current = state;
  ownerRef.current = trackId;
  const waveform = state.owner === trackId ? state.waveform : null;

  useEffect(() => {
    const cleared = { owner: trackId, waveform: null };
    atlasRef.current = {
      owner: trackId,
      atlas: createPlaybackWaveformAtlas(trackId),
    };
    stateRef.current = cleared;
    setState(cleared);
  }, [trackId]);

  useEffect(() => {
    if (!enabled || trackId < 0 || !Number.isFinite(duration) || duration <= 0)
      return;
    const buckets = detailWaveformBuckets(duration);
    if (cachedWaveform(trackId, buckets)) return;
    let alive = true;
    let timer: number | null = null;
    let idleRequest: number | null = null;
    const schedule = (delayMs: number) => {
      if (!alive) return;
      timer = window.setTimeout(queueWarm, delayMs);
    };
    const warm = () => {
      idleRequest = null;
      timer = null;
      const visibleWindowReady = stateRef.current.owner === trackId
        && stateRef.current.waveform !== null;
      // Once bounded PCM is visible, whole-song detail is only a seek accelerator and can wait for
      // a parked Deck. Before first paint it is the compatibility/failure fallback: blocking it on
      // `playing` leaves unsupported online/native sources blank for the entire song.
      if (!playbackWaveformShouldLoadFullDetail(
        visibleWindowReady,
        trackId,
        getLiveDeckClock(deck),
      )) {
        schedule(FULL_DETAIL_RETRY_MS);
        return;
      }
      void loadWaveform(trackId, buckets, true).catch((reason: unknown) => {
        if (!alive || !isPlaybackDeferredWaveformError(reason)) return;
        schedule(FULL_DETAIL_RETRY_MS);
      });
    };
    const queueWarm = () => {
      timer = null;
      if (!alive) return;
      if (typeof window.requestIdleCallback === "function") {
        idleRequest = window.requestIdleCallback(warm, {
          timeout: FULL_DETAIL_IDLE_TIMEOUT_MS,
        });
      } else {
        warm();
      }
    };
    // Give the bounded native lane a short uncontested first-paint window. If it has not published
    // by the deadline, full detail becomes a required fallback and may run during playback.
    schedule(supportsPlaybackWaveformWindow() ? FULL_DETAIL_FALLBACK_DELAY_MS : 0);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      if (idleRequest !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleRequest);
      }
    };
  }, [deck, duration, enabled, trackId]);

  useEffect(() => {
    if (!enabled) return;
    const nativeWindowSupported = supportsPlaybackWaveformWindow();
    let alive = true;
    let timer: number | null = null;
    let promise: Promise<Waveform | null> | null = null;
    let lastCheckMs = -Infinity;
    const initialClock = getLiveDeckClock(deck);
    let lastDiscontinuityRevision =
      initialClock?.trackId === trackId
        ? initialClock.discontinuityRevision
        : null;
    let initialPaintPending =
      stateRef.current.owner !== trackId || stateRef.current.waveform === null;
    let pendingDiscontinuityRevision: number | null = null;
    let urgentAnchor: { position: number; audibleRate: number } | null = null;

    const requestSeconds = managerWaveformRequestSeconds(
      viewportSeconds,
      REQUEST_MARGIN_SECONDS,
    );
    const atlasForTrack = (): PlaybackWaveformAtlas => {
      if (atlasRef.current.owner !== trackId) {
        atlasRef.current = {
          owner: trackId,
          atlas: createPlaybackWaveformAtlas(trackId),
        };
      }
      return atlasRef.current.atlas;
    };
    const cachedDetail = (): Waveform | null => {
      if (trackId < 0 || !Number.isFinite(duration) || duration <= 0)
        return null;
      return cachedWaveform(trackId, detailWaveformBuckets(duration));
    };
    const cachedWindowAt = (position: number): Waveform | null => {
      const full = cachedDetail();
      if (!full) return null;
      const futureBias = Math.max(
        0,
        (FULL_DETAIL_WINDOW_SECONDS - requestSeconds) * 0.5,
      );
      const cachedWindow = waveformWindowFromFullDetail(
        full,
        position + futureBias,
        FULL_DETAIL_WINDOW_SECONDS,
      );
      if (!cachedWindow) return null;
      // A completed full-song asset is another producer, not a new visual authority. Merge it
      // through the same first-write-wins atlas as native rolling PCM: it may fill unvisited
      // history/future columns, but the pixels already shown during this session stay bit-exact.
      const atlas = atlasForTrack();
      const stable = stabilizePlaybackWaveformWindow(atlas, cachedWindow);
      return (
        playbackWaveformContiguousAtlasWindow(
          atlas,
          position + futureBias,
          FULL_DETAIL_WINDOW_SECONDS,
          position,
          viewportSeconds,
        ) ?? stable
      );
    };
    const atlasWindowAt = (position: number): Waveform | null => {
      const futureBias = Math.max(
        0,
        (FULL_DETAIL_WINDOW_SECONDS - requestSeconds) * 0.5,
      );
      return playbackWaveformContiguousAtlasWindow(
        atlasForTrack(),
        position + futureBias,
        FULL_DETAIL_WINDOW_SECONDS,
        position,
        viewportSeconds,
      );
    };
    const publishWindow = (next: Waveform) => {
      const owned = { owner: trackId, waveform: next };
      stateRef.current = owned;
      setState(owned);
    };
    const completePendingUrgency = () => {
      initialPaintPending = false;
      urgentAnchor = null;
      const live = getLiveDeckClock(deck);
      if (
        pendingDiscontinuityRevision !== null &&
        live?.trackId === trackId &&
        live.discontinuityRevision === pendingDiscontinuityRevision
      ) {
        pendingDiscontinuityRevision = null;
      }
    };

    const schedule = (delayMs: number) => {
      if (!alive) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(check, Math.max(0, delayMs));
    };

    const check = () => {
      timer = null;
      if (!alive || ownerRef.current !== trackId) return;
      lastCheckMs = performance.now();
      const position = currentDeckPosition(deck, trackId);
      const current =
        stateRef.current.owner === trackId ? stateRef.current.waveform : null;
      if (
        waveformCoversViewport(
          current,
          trackId,
          position,
          viewportSeconds,
          RENEWAL_MARGIN_SECONDS,
        )
      ) {
        // A small seek/loop can remain completely inside the current immutable window. In that
        // case the landing is already painted and must not turn a later routine renewal urgent.
        completePendingUrgency();
        schedule(COVERAGE_CHECK_MS);
        return;
      }
      const cachedWindow = cachedWindowAt(position);
      if (cachedWindow) {
        publishWindow(cachedWindow);
        completePendingUrgency();
        schedule(COVERAGE_CHECK_MS);
        return;
      }
      // A sparse session atlas cannot complete an unplayed online interval, but it can repaint a
      // previously visited position synchronously while native random access refreshes the margin.
      // Prefer it even when an old window overlaps by a few seconds: leaving that one-sided
      // overlap visible is the exact "broken road" first paint that a seek must never expose.
      let visible = current;
      const atlasWindow = atlasWindowAt(position);
      if (
        atlasWindow &&
        waveformCoversViewport(atlasWindow, trackId, position, viewportSeconds)
      ) {
        publishWindow(atlasWindow);
        visible = atlasWindow;
      }
      if (waveformCoversViewport(visible, trackId, position, viewportSeconds)) {
        // The exact visible interval is already complete. Retaining this window while its outer
        // margin renews is essential: unmounting the canvas here produced the visible
        // disappear/reappear flash and discarded the last stable pixels for no useful reason.
        completePendingUrgency();
      }
      if (!nativeWindowSupported) {
        // Keep observing the full-detail cache even when this WebView/backend cannot provide the
        // bounded native IPC command. Returning from the effect here used to warm the fallback in
        // one effect while permanently preventing the other effect from publishing it.
        schedule(COVERAGE_CHECK_MS);
        return;
      }
      if (promise) {
        // A seek can land while the previous cache probe/FFT is returning. Recheck on the fast
        // miss cadence so the final landing retargets native random access without inheriting the
        // ordinary quarter-second coverage interval.
        schedule(CACHE_RETRY_MS);
        return;
      }

      const urgent = playbackWaveformRequestIsUrgent(
        Boolean(visible),
        initialPaintPending,
        pendingDiscontinuityRevision !== null,
      );
      if (urgent && urgentAnchor === null) {
        const live = getLiveDeckClock(deck);
        urgentAnchor = {
          position,
          audibleRate:
            live?.trackId === trackId && live.playing ? live.audibleRate : 0,
        };
      }
      const activeRequestSeconds =
        urgent && trackId >= 0
          ? Math.max(requestSeconds, FULL_DETAIL_WINDOW_SECONDS)
          : requestSeconds;
      const requestPosition =
        urgent && trackId >= 0 && urgentAnchor
          ? playbackWaveformRequestCenter(
              urgentAnchor.position,
              duration,
              viewportSeconds,
              activeRequestSeconds,
              urgentAnchor.audibleRate,
            )
          : (urgentAnchor?.position ?? position);
      promise = requestPlaybackWaveformWindow(
        trackId,
        requestPosition,
        activeRequestSeconds,
        urgent,
      );
      const request = promise;
      void request
        .then((next) => {
          if (!alive || ownerRef.current !== trackId) return;
          if (!next) {
            schedule(CACHE_RETRY_MS);
            return;
          }
          // The blocking analysis can finish after a seek or a fast loop wrap. First paint must
          // own both the played and unplayed sides of the visible six-second interval; accepting
          // a future-only response makes the rail look severed when history arrives later.
          const latestPosition = currentDeckPosition(deck, trackId);
          const cachedWindow = cachedWindowAt(latestPosition);
          if (cachedWindow) {
            publishWindow(cachedWindow);
            completePendingUrgency();
            schedule(COVERAGE_CHECK_MS);
            return;
          }
          if (
            !waveformCoversViewport(
              next,
              trackId,
              latestPosition,
              viewportSeconds,
            )
          ) {
            schedule(CACHE_RETRY_MS);
            return;
          }
          const previous =
            stateRef.current.owner === trackId
              ? stateRef.current.waveform
              : null;
          if (previous) {
            const [previousStart, previousEnd] = waveformSourceRange(previous);
            const [nextStart, nextEnd] = waveformSourceRange(next);
            if (
              previous.amp.length === next.amp.length &&
              Math.abs(previousStart - nextStart) < 1e-3 &&
              Math.abs(previousEnd - nextEnd) < 1e-3
            ) {
              // A coarse transport publication can legitimately lag one poll. Do not redraw or
              // renormalize an identical source range; retain its approved pixels and wait for
              // the transport observer's next one-second publication. A quarter-second retry is
              // still bounded, but cannot sleep past the renewal margin and expose an empty edge.
              completePendingUrgency();
              schedule(UNCHANGED_WINDOW_RETRY_MS);
              return;
            }
          }
          // Native owns only a rolling PCM window and may normalise a later overlap differently.
          // The session atlas is anchored to whole-track time: existing cells are read back
          // verbatim, and this response can only fill columns that have never been published.
          const stable = stabilizePlaybackWaveformWindow(atlasForTrack(), next);
          publishWindow(atlasWindowAt(latestPosition) ?? stable);
          completePendingUrgency();
          schedule(COVERAGE_CHECK_MS);
        })
        .catch(() => {
          // Visualization is subordinate to audio. Keep the last valid bitmap and retry quietly;
          // a transient cache miss must never clear pixels or surface as a playback error.
          if (alive && ownerRef.current === trackId) schedule(ERROR_RETRY_MS);
        })
        .finally(() => {
          if (promise === request) promise = null;
        });
    };

    const unsubscribe = subscribeLivePlaybackClock(() => {
      const live = getLiveDeckClock(deck);
      const discontinuityRevision =
        live?.trackId === trackId ? live.discontinuityRevision : null;
      if (
        discontinuityRevision !== null &&
        discontinuityRevision !== lastDiscontinuityRevision
      ) {
        lastDiscontinuityRevision = discontinuityRevision;
        pendingDiscontinuityRevision = discontinuityRevision;
        urgentAnchor = null;
        // A real seek/loop landing must not sit behind the ordinary 250ms coverage poll. Cancel
        // its pending timer and inspect memory/session/native coverage on this clock edge.
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        schedule(0);
        return;
      }
      lastDiscontinuityRevision = discontinuityRevision;
      const position = currentDeckPosition(deck, trackId);
      const current =
        stateRef.current.owner === trackId ? stateRef.current.waveform : null;
      // Once the full detail master exists, a seek is a memory slice and should not inherit the
      // normal 250 ms native-poll throttle.
      if (
        cachedDetail() &&
        !waveformCoversViewport(
          current,
          trackId,
          position,
          viewportSeconds,
          RENEWAL_MARGIN_SECONDS,
        )
      ) {
        if (timer === null) schedule(0);
        return;
      }
      if (
        performance.now() - lastCheckMs >= COVERAGE_CHECK_MS &&
        timer === null
      )
        schedule(0);
    });
    schedule(0);
    return () => {
      alive = false;
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [deck, duration, enabled, trackId, viewportSeconds]);

  return waveform;
}
