/** Observe compositor frames, not the media cursor (which jumps before decoding finishes). */
export function waitForVideoFrames(
  video: HTMLVideoElement,
  target: number,
  moving: boolean,
  signal: AbortSignal,
  timeoutMs = 900,
): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    let callback: number | undefined;
    let settled = false;
    let previous: number | null = null;
    let consecutive = 0;
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
    const timer = window.setTimeout(failed, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    video.addEventListener("error", failed, { once: true });
    // Older shells retain the existing seeked/play-promise path. Never fabricate a frame on
    // shells that do provide compositor callbacks but have not delivered one.
    if (typeof video.requestVideoFrameCallback !== "function") { finish(true); return; }
    const frame: VideoFrameRequestCallback = (_now, metadata) => {
      callback = undefined;
      const time = metadata.mediaTime;
      const elapsed = (performance.now() - started) / 1000;
      const atTarget = Number.isFinite(time) && time >= target - 0.1
        && time <= target + elapsed * video.playbackRate + 0.1;
      if (!video.seeking && video.readyState >= 2 && atTarget) {
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
