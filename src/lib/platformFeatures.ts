/** Product capabilities, not codec guesses. Keep mobile omissions out of actions and jobs. */
export function mediaProductionAvailable(platform = currentPlatform()): boolean {
  return platform !== "android" && platform !== "ios";
}

/**
 * Exporting a song's visualizer as a video; its picture and configuration are on every platform.
 * Android encodes with the WebView's hardware H.264 and the system's AAC (MediaCodec), no FFmpeg.
 */
export function visualizerExportAvailable(platform = currentPlatform()): boolean {
  return mediaProductionAvailable(platform) || platform === "android";
}

/**
 * What a live visualizer picture may cost. A phone keeps it at 30 frames a second on a smaller
 * backing store, also full screen: the picture is drawn on the page's main thread and heats it.
 */
/** Widths are of the backing store: `maxWidth` for a picture inside a panel, `fullscreenWidth` for a floating or full-screen one. */
export function visualizerPreviewBudget(platform = currentPlatform()): { fps: number; fullscreenFps: number; maxWidth: number; fullscreenWidth: number; pixelRatio: number } {
  return mediaProductionAvailable(platform)
    ? { fps: 30, fullscreenFps: 60, maxWidth: 960, fullscreenWidth: 1440, pixelRatio: 2 }
    : { fps: 30, fullscreenFps: 30, maxWidth: 720, fullscreenWidth: 960, pixelRatio: 1.5 };
}

export function androidPlatform(): boolean {
  return typeof window !== "undefined" && window.kdj?.platform === "android";
}

function currentPlatform(): string | undefined {
  return typeof window === "undefined" ? "browser" : window.kdj?.platform;
}
