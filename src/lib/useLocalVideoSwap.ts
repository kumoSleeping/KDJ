import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  registerLocalVideoSeekPresenter,
  type PreparedLocalVideoSeek,
} from "./localVideoSeekBridge";
import { waitForVideoFrames } from "./videoFrames";
import { VideoTransportEchoGuard, type VideoPlaybackEngine } from "./videoPlaybackEngine";
import { captureLocalVideoSeekFence, getLocalVideoClock, localVideoSeekHasLanded, usesLocalVideoDeviceClock, type LocalVideoSeekFence } from "./mediaSync";

const PREVIEW_DEBOUNCE_MS = 90;
const DECODE_TIMEOUT_MS = 1_500;
const FRAME_CONFIRM_TIMEOUT_MS = 300;
const TARGET_EPSILON_SEC = 0.004;

type Slot = 0 | 1;

interface PendingPreparation {
  generation: number;
  target: number;
  promise: Promise<PreparedLocalVideoSeek | null>;
}

export interface LocalVideoSwapOptions {
  enabled: boolean;
  trackId: number | null;
  desiredPlayingRef: MutableRefObject<boolean>;
  getRate(): number;
  onActivate?(video: HTMLVideoElement, target: number): void;
  /** Exact event provenance for programmatic play/pause on a newly activated slot. */
  transportEchoGuard?: VideoTransportEchoGuard;
}

function waitForEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "seeked" | "pause",
  timeoutMs: number,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isCurrent()) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onError);
      resolve(value && isCurrent());
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onError, { once: true });
  });
}

async function pauseAndSettle(
  video: HTMLVideoElement,
  timeoutMs: number,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isCurrent()) return false;
  if (video.paused) return isCurrent();
  const settled = waitForEvent(video, "pause", timeoutMs, isCurrent, signal);
  video.pause();
  return settled;
}

async function waitForDecodedTargetFrame(
  video: HTMLVideoElement,
  target: number,
  isCurrent: () => boolean,
  signal: AbortSignal,
  keepPlaying: boolean,
): Promise<boolean> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    if (!(await waitForEvent(video, "loadedmetadata", DECODE_TIMEOUT_MS, isCurrent, signal))) return false;
  }
  if (!isCurrent()) return false;

  // Drain the previous owner's pause before starting this decoder. A queued pause event must
  // never cross activation and become a user transport command.
  if (!(await pauseAndSettle(video, FRAME_CONFIRM_TIMEOUT_MS, isCurrent, signal))) return false;
  if (Math.abs(video.currentTime - target) > TARGET_EPSILON_SEC || video.readyState < 2) {
    video.currentTime = target;
    if (video.seeking) {
      if (!(await waitForEvent(video, "seeked", DECODE_TIMEOUT_MS, isCurrent, signal))) return false;
    }
  }
  if (!isCurrent() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;

  // Subscribe BEFORE play: the first frame can arrive before the play promise resolves.
  // A moving handoff needs continuous frames, and must stay running through activation.
  const frames = waitForVideoFrames(video, target, keepPlaying, signal);
  let playTimer = 0;
  const played = new Promise<boolean>(resolve => {
    const finish = (ok: boolean) => {
      window.clearTimeout(playTimer);
      signal.removeEventListener("abort", abort);
      resolve(ok);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    playTimer = window.setTimeout(() => finish(false), 900);
    void video.play().then(() => finish(true), () => finish(false));
  });
  const [confirmed, playing] = await Promise.all([frames, played]);
  if (!isCurrent()) return false;
  if (!confirmed || !playing) { video.pause(); return false; }
  if (keepPlaying) return true;
  // A drag preview / paused transport keeps only its decoded frame, without running an idle
  // second decoder. Settle the pause while the element is still owned by the standby slot.
  return pauseAndSettle(video, FRAME_CONFIRM_TIMEOUT_MS, isCurrent, signal);
}

/**
 * Owns two muted video elements for one visible local-video surface.
 *
 * The active element keeps moving while the standby seeks and decodes. The caller gets a prepared
 * handle and activates it after the Rust audio seek lands and the standby starts presenting.
 */
export function useLocalVideoSwap(options: LocalVideoSwapOptions) {
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const activeSlotRef = useRef<Slot>(0);
  const [activeSlot, setActiveSlot] = useState<Slot>(0);
  const sourceKeyRef = useRef("");
  const sourceUrlRef = useRef("");
  const generationRef = useRef(0);
  const preparationAbortRef = useRef<AbortController | null>(null);
  const holdingPositionRef = useRef(false);
  const committedSeekRef = useRef(false);
  const seekFenceRef = useRef<LocalVideoSeekFence | null>(null);
  const previewTimerRef = useRef(0);
  const pendingRef = useRef<PendingPreparation | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeVideo = useCallback(
    () => videoRefs.current[activeSlotRef.current],
    [],
  );
  const standbyVideo = useCallback(
    () => videoRefs.current[activeSlotRef.current === 0 ? 1 : 0],
    [],
  );
  const isActiveVideo = useCallback(
    (video: HTMLVideoElement) => activeVideo() === video,
    [activeVideo],
  );
  const bindVideo = useCallback((slot: Slot) => (video: HTMLVideoElement | null) => {
    videoRefs.current[slot] = video;
  }, []);

  const cancelPending = useCallback(() => {
    generationRef.current += 1;
    preparationAbortRef.current?.abort();
    preparationAbortRef.current = null;
    standbyVideo()?.pause();
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = 0;
    pendingRef.current = null;
    holdingPositionRef.current = false;
    committedSeekRef.current = false;
    seekFenceRef.current = null;
  }, [standbyVideo]);

  const load = useCallback(
    (sourceKey: string, sourceUrl: string) => {
      const alreadyLoaded = videoRefs.current.every((video) => !video || Boolean(video.src));
      if (
        sourceKeyRef.current === sourceKey &&
        sourceUrlRef.current === sourceUrl &&
        alreadyLoaded
      ) {
        return;
      }
      cancelPending();
      sourceKeyRef.current = sourceKey;
      sourceUrlRef.current = sourceUrl;
      activeSlotRef.current = 0;
      setActiveSlot(0);
      for (const video of videoRefs.current) {
        if (!video) continue;
        video.pause();
        video.muted = true;
        video.crossOrigin = "anonymous";
        video.src = sourceUrl;
        video.load();
      }
    },
    [cancelPending],
  );

  const prepare = useCallback(
    (target: number): Promise<PreparedLocalVideoSeek | null> => {
      const normalized = Math.max(0, target);
      const existing = pendingRef.current;
      if (existing && Math.abs(existing.target - normalized) <= TARGET_EPSILON_SEC) {
        return existing.promise;
      }
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = 0;
      const generation = ++generationRef.current;
      preparationAbortRef.current?.abort();
      const abort = new AbortController();
      preparationAbortRef.current = abort;
      const video = standbyVideo();
      const sourceUrl = sourceUrlRef.current;
      if (!optionsRef.current.enabled || !video || !sourceUrl) return Promise.resolve(null);
      holdingPositionRef.current = true;
      const isCurrent = () => generationRef.current === generation && !abort.signal.aborted && optionsRef.current.enabled;
      if (!video.src) {
        video.crossOrigin = "anonymous";
        video.src = sourceUrl;
        video.load();
      }
      video.muted = true;
      const rate = optionsRef.current.getRate();
      if (Number.isFinite(rate) && rate > 0 && Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
      const trackId = optionsRef.current.trackId;
      const clock = trackId === null ? null : getLocalVideoClock(trackId);
      const fence = seekFenceRef.current;
      const decodeTarget = fence && localVideoSeekHasLanded(fence, clock) ? clock!.position : normalized;
      // Only a committed transport keeps the standby moving. Hover/drag previews remain paused.
      const keepPlaying = committedSeekRef.current && (clock
        ? clock.playing && clock.rate > 0 : optionsRef.current.desiredPlayingRef.current);
      const promise = waitForDecodedTargetFrame(video, decodeTarget, isCurrent, abort.signal, keepPlaying).then((ready) => {
        if (!ready || !isCurrent()) {
          if (pendingRef.current?.generation === generation) pendingRef.current = null;
          if (generationRef.current === generation) holdingPositionRef.current = false;
          return null;
        }
        let available = true;
        const prepared: PreparedLocalVideoSeek = {
          target: normalized,
          activate: () => {
            if (!available || !isCurrent()) return false;
            const trackId = optionsRef.current.trackId;
            const clock = trackId === null ? null : getLocalVideoClock(trackId);
            if (usesLocalVideoDeviceClock() && (!clock
              || (seekFenceRef.current && !localVideoSeekHasLanded(seekFenceRef.current, clock)))) {
              cancelPending(); return false;
            }
            available = false;
            pendingRef.current = null;
            holdingPositionRef.current = false;
            committedSeekRef.current = false;
            seekFenceRef.current = null;
            const old = activeVideo();
            const nextSlot: Slot = activeSlotRef.current === 0 ? 1 : 0;
            const shouldPlay = clock ? clock.playing && clock.rate > 0 : optionsRef.current.desiredPlayingRef.current;
            const rate = clock?.rate ?? optionsRef.current.getRate();
            if (Number.isFinite(rate) && rate > 0 && Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
            activeSlotRef.current = nextSlot;
            setActiveSlot(nextSlot);
            if (shouldPlay && video.paused) {
              const guard = optionsRef.current.transportEchoGuard;
              const token = guard?.mark(video, "play");
              void video.play().then(
                () => {
                  // `play` is dispatched before the play promise settles. If no surface observed
                  // it (for example while React was swapping listeners), do not leave a stale tag
                  // that could swallow a later genuine user action.
                  if (token !== undefined) guard?.cancel(token);
                },
                () => {
                  if (token !== undefined) guard?.cancel(token);
                },
              );
            } else if (!shouldPlay && !video.paused) {
              const guard = optionsRef.current.transportEchoGuard;
              guard?.mark(video, "pause");
              video.pause();
            }
            // Change ownership before pausing the old slot so its pause event cannot be mistaken
            // for a user/system transport command.
            old?.pause();
            optionsRef.current.onActivate?.(video, clock?.position ?? normalized);
            return true;
          },
          cancel: () => {
            available = false;
            if (isCurrent()) cancelPending();
          },
        };
        return prepared;
      });
      pendingRef.current = { generation, target: normalized, promise };
      return promise;
    },
    [activeVideo, cancelPending, standbyVideo],
  );

  const preview = useCallback(
    (target: number) => {
      holdingPositionRef.current = true;
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = 0;
        void prepare(target);
      }, PREVIEW_DEBOUNCE_MS);
    },
    [prepare],
  );

  const correctClock = useCallback((synchronizer: VideoPlaybackEngine) => {
    const old = activeVideo(), next = standbyVideo(), generation = generationRef.current;
    if (!old || !next || holdingPositionRef.current || pendingRef.current || !optionsRef.current.enabled) return;
    const isCurrent = () => generationRef.current === generation && optionsRef.current.enabled
      && activeVideo() === old && !holdingPositionRef.current && !pendingRef.current;
    void synchronizer.alignStandby(old, next, isCurrent, () => {
      if (!isCurrent()) return false;
      activeSlotRef.current = activeSlotRef.current === 0 ? 1 : 0;
      setActiveSlot(activeSlotRef.current);
      old.pause();
      optionsRef.current.onActivate?.(next, next.currentTime);
      return true;
    });
  }, [activeVideo, standbyVideo]);

  const hold = useCallback(() => {
    // A new transport owns a new handle even when it repeats a preview target. Otherwise an old
    // coordinator's prepared.cancel() can invalidate the handle shared by the newer request.
    cancelPending();
    holdingPositionRef.current = true;
    committedSeekRef.current = true;
    const trackId = optionsRef.current.trackId;
    seekFenceRef.current = trackId !== null && usesLocalVideoDeviceClock() ? captureLocalVideoSeekFence(trackId) : null;
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = 0;
  }, [cancelPending]);

  useEffect(() => {
    const { enabled, trackId } = optionsRef.current;
    if (!enabled || trackId === null) return;
    const unregister = registerLocalVideoSeekPresenter(trackId, {
      preview,
      hold,
      prepare,
      cancel: cancelPending,
    });
    return () => { unregister(); cancelPending(); };
  }, [cancelPending, hold, options.enabled, options.trackId, prepare, preview]);

  useEffect(
    () => () => {
      cancelPending();
      for (const video of videoRefs.current) {
        video?.pause();
      }
      optionsRef.current.transportEchoGuard?.clear();
    },
    [cancelPending],
  );

  return {
    videoRefs,
    bindVideo,
    activeSlot,
    activeVideo,
    standbyVideo,
    isActiveVideo,
    isHoldingPosition: () => holdingPositionRef.current,
    load,
    cancelPending,
    correctClock,
    prepare,
    preview,
  };
}
