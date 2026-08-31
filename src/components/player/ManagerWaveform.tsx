import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  beatGridMarkers,
  waveformBeatGridOrigin,
} from "../../lib/performanceCues";
import {
  getLiveDeckClock,
  runtimePlayer,
  subscribeLivePlaybackClock,
  type LiveDeckClock,
} from "../../lib/unifiedPlayer";
import {
  correctedLiveWaveformRate,
  liveWaveformAnimationTimeMs,
  liveWaveformLoopAnimationTimeMs,
  liveWaveformPhaseError,
  liveWaveformPlaybackRate,
  projectedNativeWaveformPosition,
  shouldPauseLiveWaveformClock,
  updateWaveformMotionClock,
  waveformMotionClockPosition,
  type WaveformMotionClock,
} from "../../lib/waveformMotion";
import {
  beatMarkerRangePercent,
  managerWaveformRasterGeometry,
  managerWaveformViewportSeconds,
  shouldWriteWaveformTransform,
  waveformSourceRange,
} from "../../lib/waveformViewport";
import type { Track } from "../../types";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";
import { drawWaveformCanvas } from "../library/WaveformCanvas";
import { usePlaybackWaveformWindow } from "./usePlaybackWaveformWindow";

const VIEWPORT_SECONDS = managerWaveformViewportSeconds(1);

interface ManagerMotionState {
  clock: WaveformMotionClock | null;
  sourceId: number | null;
  loopGeneration: number | null;
  scratchHeld: boolean;
}

interface ManagerWaveformGeometry {
  deck: 0 | 1;
  trackId: number;
  duration: number;
  start: number;
  end: number;
  span: number;
  sourceStart: number;
  sourceEnd: number;
}

interface ManagerCompositorAnimation {
  animation: Animation;
  trackId: number;
  start: number;
  end: number;
  span: number;
  loopStart: number | null;
  loopLength: number | null;
  sourceId: number | null;
  loopGeneration: number | null;
  loopWrapCount: number | null;
  discontinuityRevision: number | null;
  scratchHeld: boolean;
}

interface ManagerCompositorLoop {
  start: number;
  length: number;
}

interface ManagerRetainedLanding {
  trackId: number;
  position: number;
  sourceId: number | null;
  loopGeneration: number | null;
  discontinuityRevision: number | null;
}

function managerCompositorLoop(
  live: LiveDeckClock | null,
  geometry: ManagerWaveformGeometry,
  position: number,
): ManagerCompositorLoop | null {
  if (
    !live
    || live.trackId !== geometry.trackId
    || typeof live.loopStart !== "number"
    || typeof live.loopLength !== "number"
    || !Number.isFinite(live.loopStart)
    || !Number.isFinite(live.loopLength)
    || live.loopLength <= 0
  ) return null;
  const start = Math.max(0, Math.min(geometry.duration, live.loopStart));
  const end = Math.min(geometry.duration, start + live.loopLength);
  if (end <= start || position < start || position >= end) return null;
  const viewportHalf = VIEWPORT_SECONDS * 0.5;
  const requiredStart = Math.max(0, start - viewportHalf);
  const requiredEnd = Math.min(geometry.duration, end + viewportHalf);
  // Infinite compositor motion is valid only when one immutable bitmap contains the visible
  // interval at both sides of the wrap. Larger loops retain a one-shot effect and land once on the
  // native wrap publication while the rolling PCM window renews around loop-in.
  if (
    geometry.sourceStart > requiredStart + 1.0e-6
    || geometry.sourceEnd + 1.0e-6 < requiredEnd
  ) return null;
  return { start, length: end - start };
}

function managerAnimationTimeMs(
  owner: ManagerCompositorAnimation,
  position: number,
): number | null {
  return owner.loopStart !== null && owner.loopLength !== null
    ? liveWaveformLoopAnimationTimeMs(position, owner.loopStart, owner.loopLength)
    : liveWaveformAnimationTimeMs(position - owner.start, owner.span);
}

function managerAnimationVisualPosition(owner: ManagerCompositorAnimation): number | null {
  const currentTime = owner.animation.currentTime;
  if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) return null;
  const seconds = Math.max(0, currentTime) / 1_000;
  return owner.loopStart !== null && owner.loopLength !== null
    ? owner.loopStart + (seconds % owner.loopLength)
    : owner.start + seconds;
}

function managerVisualRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  if (Math.abs(rate) >= 0.001) return rate;
  return rate < 0 ? -0.001 : 0.001;
}

function landManagerAnimation(
  owner: ManagerCompositorAnimation,
  position: number,
  rate: number,
  running: boolean,
): boolean {
  const sourceTimeMs = managerAnimationTimeMs(owner, position);
  if (sourceTimeMs === null) return false;
  const visualRate = managerVisualRate(rate);
  owner.animation.pause();
  owner.animation.playbackRate = visualRate;
  owner.animation.currentTime = sourceTimeMs;
  if (running && Math.abs(rate) > 0.02) {
    owner.animation.play();
    const rawTimelineTime = document.timeline?.currentTime;
    if (typeof rawTimelineTime === "number") {
      // Align local source milliseconds with this compositor timeline immediately. Without this
      // startTime assignment WebKit can defer play() to its next main-thread sampling turn.
      owner.animation.startTime = rawTimelineTime - sourceTimeMs / visualRate;
    }
  }
  return true;
}

function createManagerCompositorAnimation(
  rail: HTMLDivElement,
  geometry: ManagerWaveformGeometry,
  position: number,
  rate: number,
  running: boolean,
  live: LiveDeckClock | null,
): ManagerCompositorAnimation | null {
  if (typeof rail.animate !== "function" || geometry.span <= 0) return null;
  const loop = managerCompositorLoop(live, geometry, position);
  const effectStart = loop?.start ?? geometry.start;
  const effectEnd = loop ? loop.start + loop.length : geometry.end;
  const effectSpan = effectEnd - effectStart;
  if (!(effectSpan > 0)) return null;
  const fromPercent = ((effectStart - geometry.start) / geometry.span) * 100;
  const toPercent = ((effectEnd - geometry.start) / geometry.span) * 100;
  const animation = rail.animate(
    [
      { transform: `translate3d(${-fromPercent}%, 0, 0)` },
      { transform: `translate3d(${-toPercent}%, 0, 0)` },
    ],
    {
      duration: effectSpan * 1_000,
      easing: "linear",
      fill: "both",
      iterations: loop ? Infinity : 1,
    },
  );
  const owner: ManagerCompositorAnimation = {
    animation,
    trackId: geometry.trackId,
    start: geometry.start,
    end: geometry.end,
    span: geometry.span,
    loopStart: loop?.start ?? null,
    loopLength: loop?.length ?? null,
    sourceId: live?.sourceId ?? null,
    loopGeneration: live?.loopGeneration ?? null,
    loopWrapCount: live?.loopWrapCount ?? null,
    discontinuityRevision: live?.discontinuityRevision ?? null,
    scratchHeld: live?.scratchHeld ?? false,
  };
  if (!landManagerAnimation(owner, position, rate, running)) {
    animation.cancel();
    return null;
  }
  return owner;
}

function sourcePosition(
  deck: 0 | 1,
  trackId: number,
  duration: number,
  now: number,
  motion?: ManagerMotionState,
): number {
  const live = getLiveDeckClock(deck);
  if (live?.trackId === trackId) {
    const rate = liveWaveformPlaybackRate(
      live.targetRate,
      live.audibleRate,
      live.scratchHeld,
    );
    const authority = projectedNativeWaveformPosition(
      live.currentTime,
      live.clientPresentationTimeMs,
      now,
      rate,
      duration,
      live.loopStart,
      live.loopLength,
    );
    if (!motion) return authority;

    const sourceChanged = motion.sourceId !== live.sourceId
      || motion.loopGeneration !== live.loopGeneration;
    const scratchEdge = !sourceChanged && motion.scratchHeld !== live.scratchHeld;
    if (sourceChanged) motion.clock = null;
    motion.sourceId = live.sourceId;
    motion.loopGeneration = live.loopGeneration;
    motion.scratchHeld = live.scratchHeld;
    motion.clock = updateWaveformMotionClock(
      motion.clock,
      {
        trackId,
        position: authority,
        duration,
        rate,
        // During a seek handoff `playing` can briefly be false while callback-tagged PCM is still
        // moving. Audible rate remains the visual authority across that edge.
        playing: live.playing || live.scratchHeld || Math.abs(rate) > 0.02,
        // Grab/release lands exactly once. Later platter samples update velocity without writing
        // every small decoder-clock correction back into the visible rail.
        discrete: scratchEdge,
        motionRevision: live.discontinuityRevision,
        loopStart: live.loopStart,
        loopLength: live.loopLength,
      },
      now,
    );
    return waveformMotionClockPosition(motion.clock, now);
  }
  if (motion) {
    motion.clock = null;
    motion.sourceId = null;
    motion.loopGeneration = null;
    motion.scratchHeld = false;
  }
  const fallback = runtimePlayer().state().decks[deck];
  return fallback.trackId === trackId && Number.isFinite(fallback.currentTime)
    ? fallback.currentTime
    : 0;
}

function ManagerBeatGrid({
  track,
  duration,
  start,
  end,
}: {
  track: Track;
  duration: number;
  start: number;
  end: number;
}) {
  const markers = useMemo(
    () => beatGridMarkers(
      duration,
      track.bpm,
      waveformBeatGridOrigin(track, true),
      start,
      end,
      null,
    ),
    [duration, end, start, track],
  );
  if (markers.length === 0) return null;
  return (
    <span className="kd-wave-beat-grid" aria-hidden="true">
      {markers.map((marker) => (
        <i
          key={`${marker.positionSec}:${marker.beat}`}
          data-beat={marker.beat}
          data-bar={marker.beat === 1 ? "true" : undefined}
          style={{
            left: `${beatMarkerRangePercent(marker.positionSec, start, end)}%`,
          } as CSSProperties}
        >
          {marker.beat === 1 ? <span>{marker.bar}</span> : null}
        </i>
      ))}
    </span>
  );
}

/**
 * Six-second Manager rail with three deliberately separate owners:
 *
 * - React owns the rare source-window/resize commits.
 * - Canvas owns immutable waveform pixels and is never redrawn for playback time.
 * - Web Animations owns steady display-synchronised motion on the compositor thread.
 * - The native DAC clock subscriber changes phase only for real transport edges or bounded drift.
 *
 * Keeping those lanes separate is what prevents a waveform from stalling the surrounding detail
 * panel, and prevents a late 10 Hz player snapshot from making the rail appear to stop and jump.
 */
export function ManagerWaveform({
  track,
  deck,
  duration,
  amplitudeScale,
  playing,
  onLoadingChange,
}: {
  track: Track;
  deck: 0 | 1;
  duration: number;
  amplitudeScale: number;
  playing: boolean;
  onLoadingChange(loading: boolean): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const lastTransformRef = useRef(Number.NaN);
  const geometryRef = useRef<ManagerWaveformGeometry | null>(null);
  const compositorAnimationRef = useRef<ManagerCompositorAnimation | null>(null);
  const retainedLandingRef = useRef<ManagerRetainedLanding | null>(null);
  const motionRef = useRef<ManagerMotionState>({
    clock: null,
    sourceId: null,
    loopGeneration: null,
    scratchHeld: false,
  });
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  const total = Math.max(0, duration || track.duration || 0);
  const playbackWaveform = usePlaybackWaveformWindow({
    trackId: track.id,
    deck,
    duration: total,
    viewportSeconds: VIEWPORT_SECONDS,
    enabled: true,
  });
  // This rail is a time-bounded detail view. A whole-track overview (including the progressive
  // online preview) has different geometry and colour normalisation, so stretching it into this
  // six-second window is never a valid fallback: it visibly changes shape and colour when the
  // real detail asset arrives. Wait for the correctly owned native window instead.
  const waveform = playbackWaveform;
  const waveformReady = waveform !== null;
  useEffect(() => {
    onLoadingChange(!waveformReady);
  }, [onLoadingChange, waveformReady]);
  const initialPosition = sourcePosition(deck, track.id, total, performance.now());
  const [boundedStart, boundedEnd] = waveform ? waveformSourceRange(waveform) : [0, 0];
  const raster = managerWaveformRasterGeometry(
    boundedStart,
    boundedEnd,
    size.width,
    size.dpr,
    VIEWPORT_SECONDS,
  );
  const bakeStart = raster.backingWidth > 0 ? raster.startSec : boundedStart;
  const bakeEnd = raster.backingWidth > 0 ? raster.endSec : boundedEnd;
  const bakeSpan = Math.max(1e-6, bakeEnd - bakeStart);
  const widthScale = bakeSpan / VIEWPORT_SECONDS;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sync = () => {
      const rect = host.getBoundingClientRect();
      const next = {
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        dpr: Math.max(1, window.devicePixelRatio || 1),
      };
      setSize((current) =>
        Math.abs(current.width - next.width) < 0.25
          && Math.abs(current.height - next.height) < 0.25
          && Math.abs(current.dpr - next.dpr) < 1.0e-6
          ? current
          : next,
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    // WebKit fires window resize when a Tauri window crosses displays with a different DPR. The
    // host CSS box can remain unchanged, so ResizeObserver alone would retain the old raster.
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [waveformReady]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const rail = railRef.current;
    // Publish geometry only at the DOM commit boundary. A concurrent React render may be
    // restarted; letting the native-clock subscriber observe its uncommitted source range would
    // move the old bitmap with the new origin and recreate a one-frame flash.
    compositorAnimationRef.current?.animation.cancel();
    compositorAnimationRef.current = null;
    geometryRef.current = null;
    if (
      !canvas
      || !rail
      || !waveform
      || size.width <= 0
      || size.height <= 0
      || raster.backingWidth <= 0
      || bakeSpan <= 0
    ) {
      lastTransformRef.current = Number.NaN;
      return;
    }
    rail.style.visibility = "visible";
    drawWaveformCanvas(
      canvas,
      waveform,
      raster.cssWidth,
      Math.max(1, size.height),
      waveform.known,
      bakeStart,
      bakeEnd,
      "performance-detail",
      amplitudeScale,
    );
    const geometry: ManagerWaveformGeometry = {
      deck,
      trackId: track.id,
      duration: total,
      start: bakeStart,
      end: bakeEnd,
      span: bakeSpan,
      sourceStart: boundedStart,
      sourceEnd: boundedEnd,
    };
    geometryRef.current = geometry;
    // A replacement window changes both pixels and their source-time origin. Land its transform
    // in the same layout phase as the canvas redraw. Its destination lattice is anchored to
    // absolute track time, so overlapping pixels retain identical aggregation at every renewal.
    const authority = sourcePosition(
      deck,
      track.id,
      total,
      performance.now(),
      motionRef.current,
    );
    const live = getLiveDeckClock(deck);
    const retained = retainedLandingRef.current;
    retainedLandingRef.current = null;
    const position = retained
      && retained.trackId === track.id
      && retained.sourceId === (live?.sourceId ?? null)
      && retained.loopGeneration === (live?.loopGeneration ?? null)
      && retained.discontinuityRevision === (live?.discontinuityRevision ?? null)
      && retained.position >= bakeStart
      && retained.position <= bakeEnd
        ? retained.position
        : authority;
    const rate = live?.trackId === track.id
      ? liveWaveformPlaybackRate(live.targetRate, live.audibleRate, live.scratchHeld)
      : playing ? 1 : 0;
    const running = live?.trackId === track.id
      ? live.playing || live.scratchHeld || Math.abs(rate) > 0.02
      : playing;
    const owner = createManagerCompositorAnimation(
      rail,
      geometry,
      position,
      rate,
      running,
      live?.trackId === track.id ? live : null,
    );
    if (owner) {
      compositorAnimationRef.current = owner;
      lastTransformRef.current = Number.NaN;
    } else {
      const percent = ((position - bakeStart) / bakeSpan) * 100;
      if (Number.isFinite(percent)) {
        rail.style.transform = `translate3d(${-percent}%, 0, 0)`;
        lastTransformRef.current = percent;
      }
    }
    return () => {
      if (owner && compositorAnimationRef.current === owner) {
        const position = managerAnimationVisualPosition(owner);
        if (position !== null) {
          retainedLandingRef.current = {
            trackId: owner.trackId,
            position,
            sourceId: owner.sourceId,
            loopGeneration: owner.loopGeneration,
            discontinuityRevision: owner.discontinuityRevision,
          };
        }
        owner.animation.cancel();
        compositorAnimationRef.current = null;
      }
    };
  }, [
    amplitudeScale,
    bakeEnd,
    bakeSpan,
    bakeStart,
    boundedEnd,
    boundedStart,
    deck,
    playing,
    raster.backingWidth,
    raster.cssWidth,
    size.height,
    total,
    track.id,
    waveform,
  ]);

  useEffect(() => {
    if (typeof Element !== "undefined" && typeof Element.prototype.animate === "function") {
      return subscribeLivePlaybackClock(() => {
        const rail = railRef.current;
        const geometry = geometryRef.current;
        const live = getLiveDeckClock(deck);
        if (!rail || !geometry || !live || live.trackId !== track.id) return;
        const now = performance.now();
        const rate = liveWaveformPlaybackRate(
          live.targetRate,
          live.audibleRate,
          live.scratchHeld,
        );
        const authority = projectedNativeWaveformPosition(
          live.currentTime,
          live.clientPresentationTimeMs,
          now,
          rate,
          geometry.duration,
          live.loopStart,
          live.loopLength,
        );
        const desiredLoop = managerCompositorLoop(live, geometry, authority);
        let owner = compositorAnimationRef.current;
        const loopChanged = !owner
          || owner.loopStart !== (desiredLoop?.start ?? null)
          || owner.loopLength !== (desiredLoop?.length ?? null)
          || owner.loopGeneration !== live.loopGeneration;
        if (loopChanged) {
          owner?.animation.cancel();
          owner = createManagerCompositorAnimation(
            rail,
            geometry,
            authority,
            rate,
            live.playing || live.scratchHeld || Math.abs(rate) > 0.02,
            live,
          );
          compositorAnimationRef.current = owner;
          if (!owner) {
            rail.style.visibility = "hidden";
            return;
          }
        }
        if (!owner) return;

        const sourceChanged = owner.sourceId !== live.sourceId;
        const discontinuity = owner.discontinuityRevision !== live.discontinuityRevision;
        const scratchEdge = owner.scratchHeld !== live.scratchHeld;
        const uncoveredLoopWrap = owner.loopStart === null
          && owner.loopWrapCount !== live.loopWrapCount;
        const running = live.playing || live.scratchHeld || Math.abs(rate) > 0.02;
        let landed = false;
        if (
          sourceChanged
          || discontinuity
          || scratchEdge
          || uncoveredLoopWrap
          || owner.animation.playState === "finished"
        ) {
          landed = landManagerAnimation(owner, authority, rate, running);
        }
        if (managerAnimationTimeMs(owner, authority) === null) {
          owner.animation.pause();
          rail.style.visibility = "hidden";
          owner.sourceId = live.sourceId;
          owner.loopWrapCount = live.loopWrapCount;
          owner.discontinuityRevision = live.discontinuityRevision;
          owner.scratchHeld = live.scratchHeld;
          return;
        }
        rail.style.visibility = "visible";

        if (shouldPauseLiveWaveformClock(
          live.playing,
          live.scratchHeld,
          true,
          discontinuity,
          rate,
        )) {
          if (owner.animation.playState !== "paused" || discontinuity) {
            landManagerAnimation(owner, authority, rate, false);
          }
        } else {
          let visualRate = managerVisualRate(rate);
          if (!landed && !live.scratchHeld) {
            const visualPosition = managerAnimationVisualPosition(owner);
            if (visualPosition !== null) {
              const phaseError = liveWaveformPhaseError(
                authority,
                visualPosition,
                owner.loopLength,
              );
              if (Math.abs(phaseError) > 0.08) {
                landed = landManagerAnimation(owner, authority, rate, running);
              } else {
                visualRate = correctedLiveWaveformRate(visualRate, phaseError);
              }
            }
          }
          if (!landed && Math.abs(owner.animation.playbackRate - visualRate) > 1.0e-6) {
            owner.animation.updatePlaybackRate(visualRate);
          }
          if (owner.animation.playState === "paused") owner.animation.play();
        }
        owner.sourceId = live.sourceId;
        owner.loopGeneration = live.loopGeneration;
        owner.loopWrapCount = live.loopWrapCount;
        owner.discontinuityRevision = live.discontinuityRevision;
        owner.scratchHeld = live.scratchHeld;
      });
    }

    // Compatibility path for older WebViews. Supported Tauri WebKit/WebView2 builds never enter
    // it, so the normal detail rail has no JavaScript work scheduled at display refresh rate.
    let frame = 0;
    const animate = (now: number) => {
      const rail = railRef.current;
      const geometry = geometryRef.current;
      if (rail && geometry) {
        const position = sourcePosition(
          geometry.deck,
          geometry.trackId,
          geometry.duration,
          now,
          motionRef.current,
        );
        const percent = ((position - geometry.start) / geometry.span) * 100;
        if (shouldWriteWaveformTransform(lastTransformRef.current, percent)) {
          rail.style.transform = `translate3d(${-percent}%, 0, 0)`;
          lastTransformRef.current = percent;
        }
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [deck, track.id]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    pointerStartRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (
      !start
      || start.id !== event.pointerId
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
      || total <= 0
    ) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const current = sourcePosition(deck, track.id, total, performance.now());
    const position = Math.max(0, Math.min(total, current + (ratio - 0.5) * VIEWPORT_SECONDS));
    window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, {
      detail: { trackId: track.id, position, forceCommit: true },
    }));
  };

  // Keep the native request alive while the toggle itself communicates loading. The complete
  // rail mounts only after the first correctly owned detail window is available.
  if (!waveform) return null;

  return (
    <div
      className="kd-manager-scroll-wave"
      data-playing={playing || undefined}
      aria-label="当前歌曲滚动波形"
    >
      <div
        ref={hostRef}
        className="kd-manager-focus-wave kd-manager-wave-window"
        role="slider"
        aria-label="当前歌曲六秒滚动波形"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.max(0, Math.min(total, initialPosition))}
        tabIndex={0}
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={() => { pointerStartRef.current = null; }}
      >
        <div
          ref={railRef}
          className="kd-manager-wave-rail"
          style={{
            width: raster.cssWidth > 0
              ? `${raster.cssWidth}px`
              : `${widthScale * 100}%`,
          }}
        >
          <canvas ref={canvasRef} aria-hidden="true" />
          <ManagerBeatGrid
            track={track}
            duration={total}
            start={bakeStart}
            end={bakeEnd}
          />
        </div>
      </div>
      <i className="kd-manager-wave-needle" aria-hidden="true" />
    </div>
  );
}
