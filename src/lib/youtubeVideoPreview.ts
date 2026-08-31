import { api } from "./api";

const HLS_MIME = "application/vnd.apple.mpegurl";
const PREPARATION_CACHE_TTL_MS = 2 * 60 * 1_000;
const PREPARATION_CACHE_MAX_ENTRIES = 6;
const PLAYABLE_TIMEOUT_MS = 30_000;

export interface YoutubeVideoPreviewInput {
  platform: "youtube";
  bvid: string;
  page: number;
}

export interface YoutubeVideoPreviewController {
  /** Resolves once WebKit's native HLS pipeline has enough H.264/AAC media to play. */
  done: Promise<void>;
  dispose(): Promise<void>;
}

interface CachedPreparation {
  createdAt: number;
  promise: Promise<string>;
}

const preparationCache = new Map<string, CachedPreparation>();

function abortError(): DOMException {
  return new DOMException("YouTube preview stopped", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function preparationKey(input: YoutubeVideoPreviewInput): string {
  return `${input.platform}:${input.bvid}#${input.page}`;
}

function preparedHls(input: YoutubeVideoPreviewInput): Promise<string> {
  const now = Date.now();
  for (const [key, entry] of preparationCache) {
    if (now - entry.createdAt > PREPARATION_CACHE_TTL_MS) preparationCache.delete(key);
  }
  const key = preparationKey(input);
  const cached = preparationCache.get(key);
  if (cached) {
    preparationCache.delete(key);
    preparationCache.set(key, cached);
    return cached.promise;
  }

  // This is the only ordinary YouTube playback path: formal GVS proof, a local opaque HLS
  // capability, and one fixed muxed H.264/AAC variant in WebKit's native pipeline. There is no
  // client fallback or automatic rendition change.
  const promise = api.prepareYoutubeVideoPreview(input.bvid);
  const entry: CachedPreparation = { createdAt: now, promise };
  preparationCache.set(key, entry);
  // Keep a rejected preparation for the same short lease. Pointer prewarm and the subsequent
  // double-click are one playback attempt: deleting the rejection here would silently turn the
  // double-click into an automatic second request and hide a first-attempt failure.
  void promise.catch(() => undefined);
  while (preparationCache.size > PREPARATION_CACHE_MAX_ENTRIES) {
    const oldest = preparationCache.keys().next().value as string | undefined;
    if (!oldest) break;
    preparationCache.delete(oldest);
  }
  return promise;
}

function nativeHlsSupported(video: HTMLVideoElement): boolean {
  return typeof video.canPlayType === "function" && video.canPlayType(HLS_MIME) !== "";
}

function mediaError(video: HTMLVideoElement): Error {
  const code = video.error?.code;
  return new Error(code
    ? `YouTube HLS 播放器加载失败（媒体错误 ${code}）`
    : "YouTube HLS 播放器加载失败");
}

function waitForPlayable(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(mediaError(video));
    const onAbort = () => finish(abortError());
    const timer = window.setTimeout(
      () => finish(new Error("YouTube HLS 在 30 秒内未达到可播放状态")),
      PLAYABLE_TIMEOUT_MS,
    );
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Pointer-down preparation overlaps the BotGuard/Player handshake with the double click. */
export async function prewarmYoutubeVideoPreview(input: YoutubeVideoPreviewInput): Promise<void> {
  await preparedHls(input);
}

/** Test/logout hook: invalidate short-lived local HLS capabilities held by the frontend. */
export function clearYoutubeVideoPreviewCache(): void {
  preparationCache.clear();
}

/** Attach the single supported native-HLS YouTube path to an ordinary video element. */
export function attachYoutubeVideoPreview(
  video: HTMLVideoElement,
  input: YoutubeVideoPreviewInput,
): YoutubeVideoPreviewController {
  if (!nativeHlsSupported(video)) {
    return {
      done: Promise.reject(new Error("当前系统 WebView 不支持 YouTube 原生 HLS 播放")),
      async dispose() {},
    };
  }

  const abort = new AbortController();
  let assignedUrl: string | null = null;
  let releasePromise: Promise<void> | null = null;
  const playbackUrl = (async () => {
    const preparedUrl = await preparedHls(input);
    throwIfAborted(abort.signal);
    const url = await api.startYoutubeVideoPlayback(preparedUrl);
    assignedUrl = url;
    return url;
  })();

  const clearMedia = () => {
    if (assignedUrl && (video.src === assignedUrl || video.currentSrc === assignedUrl)) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  };

  const release = (): Promise<void> => {
    abort.abort();
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      // Detach WebKit first so its native HLS loader cannot enqueue another speculative segment
      // while the loopback session is being revoked. The backend cancellation still follows in
      // the same disposal operation and remains the owner of every upstream transfer.
      clearMedia();
      let url: string;
      try {
        url = await playbackUrl;
      } catch {
        clearMedia();
        return;
      }
      // `playbackUrl` may have resolved after the first synchronous clear above.
      clearMedia();
      try {
        // Each attachment gets its own cancellation token, while the expensive prepared proof
        // remains reusable in the cache.
        await api.revokeYoutubeVideoPlayback(url);
      } catch {
        console.error("YouTube HLS 播放会话清理失败");
      } finally {
        clearMedia();
      }
    })();
    return releasePromise;
  };

  const done = (async () => {
    const url = await playbackUrl;
    throwIfAborted(abort.signal);
    video.preload = "auto";
    video.src = url;
    video.load();
    try {
      await waitForPlayable(video, abort.signal);
    } catch (error) {
      await release();
      throw error;
    }
  })();

  return {
    done,
    dispose: release,
  };
}
