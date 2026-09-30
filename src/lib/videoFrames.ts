import { captureDiagnostic, mediaDiagnostic, observeMediaDiagnostics } from "./diagnostics";

const timeoutReports = new WeakMap<HTMLVideoElement, number>();

export interface PresentedVideoFrame {
  mediaTime: number;
  displayTime: number;
  interval: number;
  gapMs: number;
}

/** Continuous presentation feedback; currentTime alone can advance during a stall. */
export function observeVideoFrames(video: HTMLVideoElement, observe: (frame: PresentedVideoFrame) => void): () => void {
  observeMediaDiagnostics(video);
  if (typeof video.requestVideoFrameCallback !== "function") return () => undefined;
  let callback: number | undefined;
  let previous: PresentedVideoFrame | undefined;
  let stopped = false;
  const frame: VideoFrameRequestCallback = (_now, metadata) => {
    if (stopped) return;
    const delta = previous ? metadata.mediaTime - previous.mediaTime : 0;
    const next: PresentedVideoFrame = {mediaTime: metadata.mediaTime, displayTime: metadata.expectedDisplayTime,
      interval: delta > 0.005 && delta < 0.1 ? delta : previous?.interval ?? 1 / 30,
      gapMs: previous ? Math.max(0, metadata.expectedDisplayTime - previous.displayTime) : 0};
    previous = next; observe(next);
    callback = video.requestVideoFrameCallback(frame);
  };
  callback = video.requestVideoFrameCallback(frame);
  return () => { stopped = true; if (callback !== undefined) video.cancelVideoFrameCallback(callback); };
}

/** Observe compositor frames, not the media cursor (which jumps before decoding finishes). */
export function waitForVideoFrames(
  video: HTMLVideoElement,
  target: number,
  moving: boolean,
  signal: AbortSignal,
  timeoutMs = 900,
): Promise<boolean> {
  observeMediaDiagnostics(video);
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    let callback: number | undefined;
    let settled = false;
    let previous: number | null = null;
    let consecutive = 0;
    let received = 0, accepted = 0, firstTime: number | null = null, lastTime: number | null = null;
    const started = performance.now();
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      signal.removeEventListener("abort", aborted);
      video.removeEventListener("error", failed);
      resolve(ready && !signal.aborted);
    };
    const aborted = () => finish(false);
    const failed = () => finish(false);
    const timer = window.setTimeout(() => {
      finish(false);
      // Preserve the failed decoder's evidence before its caller retries the seek.
      // Log only on timeout, at most once per five seconds per element; never URLs.
      const now = performance.now();
      if (now - (timeoutReports.get(video) ?? -Infinity) < 5000) return;
      timeoutReports.set(video, now);
      try {
        let opacity = 1, hidden = false;
        for (let element: HTMLElement | null = video; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          opacity *= Number(style.opacity);
          hidden ||= style.display === "none" || style.visibility !== "visible";
        }
        captureDiagnostic("playback", "video.frame-timeout", "Video frame confirmation timed out",
          `target=${target} moving=${moving} elapsed_ms=${now - started} callbacks=${received} accepted=${accepted} first_media_time=${firstTime} last_media_time=${lastTime} visibility=${document.visibilityState} opacity=${opacity} hidden=${hidden}\n${mediaDiagnostic(video)}`, "warn");
      } catch { /* Diagnostic inspection must not affect decoder recovery. */ }
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    video.addEventListener("error", failed, { once: true });
    // Older shells retain the existing seeked/play-promise path. Never fabricate a frame on
    // shells that do provide compositor callbacks but have not delivered one.
    if (typeof video.requestVideoFrameCallback !== "function") { finish(true); return; }
    const frame: VideoFrameRequestCallback = (_now, metadata) => {
      callback = undefined;
      const time = metadata.mediaTime;
      received++; firstTime ??= time; lastTime = time;
      const elapsed = (performance.now() - started) / 1000;
      const atTarget = Number.isFinite(time) && time >= target - 0.1
        && time <= target + elapsed * video.playbackRate + 0.1;
      if (!video.seeking && video.readyState >= 2 && atTarget) {
        accepted++;
        if (!moving) { finish(true); return; }
        consecutive = previous !== null && time > previous ? consecutive + 1 : 1;
        previous = time;
        if (consecutive >= 3 && !video.paused) { finish(true); return; }
      } else {
        consecutive = 0;
        previous = null;
      }
      callback = video.requestVideoFrameCallback(frame);
    };
    callback = video.requestVideoFrameCallback(frame);
  });
}
