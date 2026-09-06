import { finishApiActivity } from "./activityLog";

/** Bounded snapshots distinguish decoded video from an advancing audio-only clock. */
export function observeVideoPreview(
  video: HTMLVideoElement,
  source: { platform: "bilibili" | "youtube"; bvid: string; page: number },
  isCurrent: () => boolean,
): () => void {
  const started = performance.now();
  const seen = new Set<string>();
  const record = (event: string) => {
    if (!isCurrent() || seen.has(event)) return;
    seen.add(event);
    const style = getComputedStyle(video);
    const rect = video.getBoundingClientRect();
    const quality = video.getVideoPlaybackQuality?.();
    finishApiActivity({
      category: "network", action: "视频预览诊断", target: `${source.platform}.com`,
      // Activity details are capped at 320 characters; retain the source and all key states.
      detail: [
        `${source.bvid} P${source.page + 1} ${event}`,
        `t=${video.currentTime.toFixed(2)}`,
        `ready=${video.readyState} net=${video.networkState}`,
        `paused=${Number(video.paused)} seek=${Number(video.seeking)}`,
        `video=${video.videoWidth}x${video.videoHeight}`,
        `frames=${quality?.totalVideoFrames ?? "?"} dropped=${quality?.droppedVideoFrames ?? "?"}`,
        `active=${video.dataset.active ?? "false"} display=${style.display} opacity=${style.opacity}`,
        `box=${Math.round(rect.width)}x${Math.round(rect.height)}`,
        `${document.visibilityState} error=${video.error?.code ?? 0}`,
      ].join("; "),
    }, { status: 0, durationMs: performance.now() - started, ok: !video.error,
      error: video.error ? `媒体错误 ${video.error.code}` : undefined });
  };
  const events = ["loadedmetadata", "loadeddata", "playing", "error", "stalled", "seeked"];
  const listener = (event: Event) => record(event.type);
  for (const event of events) video.addEventListener(event, listener);
  const timers = [5_000, 30_000].map(ms => window.setTimeout(() => record(`after-${ms / 1000}s`), ms));
  const frame = video.requestVideoFrameCallback?.(() => record("first-presented-frame"));
  return () => {
    timers.forEach(timer => window.clearTimeout(timer));
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    for (const event of events) video.removeEventListener(event, listener);
  };
}
