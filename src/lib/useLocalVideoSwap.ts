import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  registerLocalVideoSeekPresenter,
  type PreparedLocalVideoSeek,
} from "./localVideoSeekBridge";

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
}

function waitForEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "seeked",
  timeoutMs: number,
  isCurrent: () => boolean,
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
      resolve(value && isCurrent());
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function waitForDecodedTargetFrame(
  video: HTMLVideoElement,
  target: number,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    if (!(await waitForEvent(video, "loadedmetadata", DECODE_TIMEOUT_MS, isCurrent))) return false;
  }
  if (!isCurrent()) return false;

  video.pause();
  if (Math.abs(video.currentTime - target) > TARGET_EPSILON_SEC || video.readyState < 2) {
    video.currentTime = target;
    if (video.seeking) {
      if (!(await waitForEvent(video, "seeked", DECODE_TIMEOUT_MS, isCurrent))) return false;
    }
  }
  if (!isCurrent() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;

  // WKWebView may leave a paused, transparent standby at HAVE_CURRENT_DATA without actually
  // submitting its target frame to the compositor. A muted play pulse forces that decode; the
  // first rVFC immediately pauses it again before the slot becomes visible.
  try {
    await Promise.race([
      video.play(),
      new Promise<void>((resolve) => window.setTimeout(resolve, FRAME_CONFIRM_TIMEOUT_MS)),
    ]);
  } catch {
    // Some older WebKit builds reject background play. `seeked` remains a valid fallback signal.
  }
  if (!isCurrent()) {
    video.pause();
    return false;
  }
  if (typeof video.requestVideoFrameCallback !== "function") {
    video.pause();
    return true;
  }
  const confirmed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value && isCurrent());
    };
    const timer = window.setTimeout(() => finish(true), FRAME_CONFIRM_TIMEOUT_MS);
    video.requestVideoFrameCallback(() => finish(true));
  });
  video.pause();
  return confirmed;
}

/**
 * Owns two muted video elements for one visible local-video surface.
 *
 * The active element keeps moving while the standby seeks and decodes. The caller gets a prepared
 * handle and activates it in the same task that commits the Rust audio seek.
 */
export function useLocalVideoSwap(options: LocalVideoSwapOptions) {
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const activeSlotRef = useRef<Slot>(0);
  const [activeSlot, setActiveSlot] = useState<Slot>(0);
  const sourceKeyRef = useRef("");
  const sourceUrlRef = useRef("");
  const generationRef = useRef(0);
  const holdingPositionRef = useRef(false);
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
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = 0;
    pendingRef.current = null;
    holdingPositionRef.current = false;
  }, []);

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
      const video = standbyVideo();
      const sourceUrl = sourceUrlRef.current;
      if (!optionsRef.current.enabled || !video || !sourceUrl) return Promise.resolve(null);
      holdingPositionRef.current = true;
      const isCurrent = () => generationRef.current === generation && optionsRef.current.enabled;
      if (!video.src) {
        video.crossOrigin = "anonymous";
        video.src = sourceUrl;
        video.load();
      }
      video.muted = true;
      const rate = optionsRef.current.getRate();
      if (Number.isFinite(rate) && rate > 0) video.playbackRate = rate;

      const promise = waitForDecodedTargetFrame(video, normalized, isCurrent).then((ready) => {
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
            available = false;
            pendingRef.current = null;
            holdingPositionRef.current = false;
            const old = activeVideo();
            const nextSlot: Slot = activeSlotRef.current === 0 ? 1 : 0;
            const shouldPlay = optionsRef.current.desiredPlayingRef.current;
            activeSlotRef.current = nextSlot;
            setActiveSlot(nextSlot);
            if (shouldPlay) void video.play().catch(() => undefined);
            else video.pause();
            // Change ownership before pausing the old slot so its pause event cannot be mistaken
            // for a user/system transport command.
            old?.pause();
            optionsRef.current.onActivate?.(video, normalized);
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

  const hold = useCallback(() => {
    holdingPositionRef.current = true;
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = 0;
  }, []);

  useEffect(() => {
    const { enabled, trackId } = optionsRef.current;
    if (!enabled || trackId === null) return;
    return registerLocalVideoSeekPresenter(trackId, {
      preview,
      hold,
      prepare,
      cancel: cancelPending,
    });
  }, [cancelPending, hold, options.enabled, options.trackId, prepare, preview]);

  useEffect(
    () => () => {
      cancelPending();
      for (const video of videoRefs.current) {
        video?.pause();
      }
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
    prepare,
    preview,
  };
}
