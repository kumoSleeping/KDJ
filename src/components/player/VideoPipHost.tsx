/**
 * 网络 / 本地视频预览宿主。
 *
 * - network：自带声音，抢 preview 焦点
 * - local：静音小窗，画面跟主播放条音轨时钟走（和 LocalVideoPlayer 同一套）
 *
 * panel：网络→右栏 VideoPreview；本地→曲库详情（浮窗宿主暂停保源）
 * float：本组件出画；系统画中画由此处手动打开，或切走应用时自动打开
 *
 * 呈现由 session/active/有效模式的 effect 驱动，而不是只在事件回调里 play 一次——
 * 否则 setSession 后首帧小窗还没挂上、或 MEDIA_SYNC 的 play 早于监听挂载时，
 * 本地视频会出现「有声音、没小窗」。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, Pause, PictureInPicture2, Play, X } from "lucide-react";
import { api } from "../../lib/api";
import { BilibiliEmbedController } from "../../lib/bilibiliEmbed";
import { getBridge } from "../../lib/bridge";
import {
  AUDIO_FOCUS_EVENT,
  announceAudioFocus,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import { formatDuration } from "../../lib/format";
import { previewGain, useCrossfade } from "../../lib/crossfade";
import { useMasterVolume } from "../../lib/masterVolume";
import {
  LocalVideoSynchronizer,
  VideoSeekEchoGuard,
  VideoTransportEchoGuard,
} from "../../lib/localVideoSync";
import { useLocalVideoSwap } from "../../lib/useLocalVideoSwap";
import {
  YoutubeEmbedController,
  type YoutubeEmbedBounds,
} from "../../lib/youtubeEmbed";
import {
  attachYoutubeVideoPreview,
  type YoutubeVideoPreviewController,
} from "../../lib/youtubeVideoPreview";
import {
  clampVideoFloatBox,
  clampVideoFloatWidth,
  videoFloatHeight,
} from "../../lib/videoFloatBox";
import {
  APPLY_VIDEO_MODE_EVENT,
  LOCAL_VIDEO_EVENT,
  VIDEO_PIP_SEEK_EVENT,
  VIDEO_PIP_TOGGLE_EVENT,
  videoPipHostLifecycle,
  useVideoPip,
  type ApplyVideoModeDetail,
  type LocalVideoRequest,
  type VideoPipSeekDetail,
  type VideoPreviewMode,
  type VideoPipSession,
} from "../../lib/videoPip";
import {
  broadcastMediaSync,
  getLatestPlayerSync,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { useAppStore } from "../../stores/appStore";
import {
  VIDEO_PREVIEW_EVENT,
  type VideoPreviewRequest,
} from "../download/VideoPreview";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";

const FLOAT_DEFAULT_W = 352;
const YOUTUBE_MIN_W = 360;
const YOUTUBE_HEADER_H = 28;
const YOUTUBE_RESIZE_FOOTER_H = 8;
const YOUTUBE_EXTRA_H = YOUTUBE_HEADER_H + YOUTUBE_RESIZE_FOOTER_H;
const NETWORK_VIDEO_START_TIMEOUT_MS = 15_000;
const NETWORK_VIDEO_STALL_TIMEOUT_MS = 12_000;

function currentNetworkVolume(): number {
  const { coplay, x } = useCrossfade.getState();
  return useMasterVolume.getState().volume * previewGain(coplay, x);
}

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

type WebKitPresentationMode = "inline" | "picture-in-picture" | "fullscreen";
type WebKitPipVideo = HTMLVideoElement & {
  webkitPresentationMode?: WebKitPresentationMode;
  webkitSupportsPresentationMode?: (mode: WebKitPresentationMode) => boolean;
  webkitSetPresentationMode?: (mode: WebKitPresentationMode) => void;
};

/** WKWebView/Safari 主要实现 webkitPresentationMode；Chromium/WebView2 用标准 PiP。 */
function supportsWebKitPip(video: HTMLVideoElement | null): video is WebKitPipVideo {
  if (!video) return false;
  const webkit = video as WebKitPipVideo;
  return Boolean(
    webkit.webkitSetPresentationMode &&
      webkit.webkitSupportsPresentationMode?.("picture-in-picture"),
  );
}

function canSystemPip(video: HTMLVideoElement | null = null): boolean {
  const webkitApi =
    supportsWebKitPip(video) ||
    (typeof HTMLVideoElement !== "undefined" &&
      "webkitSetPresentationMode" in HTMLVideoElement.prototype);
  const standardApi =
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled &&
    typeof HTMLVideoElement !== "undefined" &&
    "requestPictureInPicture" in HTMLVideoElement.prototype;
  return webkitApi || standardApi;
}

async function enterSystemPip(video: HTMLVideoElement): Promise<boolean> {
  // macOS/iOS 的 WKWebView 即使暴露标准方法也可能以 NotSupportedError 拒绝；
  // 原生 WebKit presentation mode 才是这里可靠的系统级小窗入口。
  if (supportsWebKitPip(video)) {
    try {
      video.webkitSetPresentationMode?.("picture-in-picture");
      const entered = video.webkitPresentationMode === "picture-in-picture";
      useVideoPip.getState().setSystemPip(entered);
      if (entered) return true;
    } catch {
      // 再试标准 API；不同 WebKit/系统版本实现不一致。
    }
  }
  if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== "function") {
    useVideoPip.getState().setSystemPip(false);
    return false;
  }
  try {
    if (document.pictureInPictureElement !== video) await video.requestPictureInPicture();
    useVideoPip.getState().setSystemPip(true);
    return true;
  } catch {
    useVideoPip.getState().setSystemPip(false);
    return false;
  }
}

async function exitSystemPip(video: HTMLVideoElement | null): Promise<void> {
  if (supportsWebKitPip(video) && video.webkitPresentationMode === "picture-in-picture") {
    try {
      video.webkitSetPresentationMode?.("inline");
    } catch {
      /* ignore */
    }
  }
  if (video && document.pictureInPictureElement === video) {
    try {
      await document.exitPictureInPicture();
    } catch {
      /* ignore */
    }
  }
  useVideoPip.getState().setSystemPip(false);
}

function defaultFloatPos(width: number): { x: number; y: number } {
  const margin = 16;
  const playerH = 60;
  const height = (width * 9) / 16;
  return {
    x: Math.max(margin, window.innerWidth - width - margin),
    y: Math.max(margin, window.innerHeight - playerH - margin - height - 8),
  };
}

function sessionKey(session: VideoPipSession): string {
  return session.source === "network"
    ? `net:${session.platform}:${session.bvid}#${session.page}`
    : `local:${session.trackId}`;
}

function hasLoadedSessionSource(
  loadedKey: string | null,
  nextKey: string,
  session: VideoPipSession,
): boolean {
  if (loadedKey === nextKey) return true;
  return session.source === "local" && loadedKey === `${nextKey}:compat`;
}

type YoutubeNetworkSession = Extract<VideoPipSession, { source: "network" }> & {
  platform: "youtube";
};

function isYoutubeSession(
  session: VideoPipSession | null | undefined,
): session is YoutubeNetworkSession {
  return session?.source === "network" && session.platform === "youtube";
}

function usesPlatformPlayer(session: VideoPipSession | null | undefined): boolean {
  if (session?.source !== "network") return false;
  const settings = useAppStore.getState().settings;
  try {
    const bridge = getBridge();
    if (session.platform === "youtube") {
      return (settings?.youtube_preview_player ?? "kdj") === "platform" &&
        Boolean(bridge.youtubeEmbed);
    }
    return (settings?.bilibili_preview_player ?? "kdj") === "platform" &&
      Boolean(bridge.bilibiliEmbed);
  } catch {
    return false;
  }
}

interface PlatformEmbedController {
  readonly done: Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(position: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setBounds(bounds: YoutubeEmbedBounds): Promise<void>;
  dispose(): void;
}

interface PlatformEmbedStatus {
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  position: number;
  duration: number;
}

function clampHostFloatBox(
  box: { x: number; y: number; w: number },
  viewportWidth: number,
  viewportHeight: number,
  session: VideoPipSession | null | undefined,
) {
  return clampVideoFloatBox(
    usesPlatformPlayer(session) ? { ...box, w: Math.max(YOUTUBE_MIN_W, box.w) } : box,
    viewportWidth,
    Math.max(1, viewportHeight - (usesPlatformPlayer(session) ? YOUTUBE_EXTRA_H : 0)),
  );
}

function youtubeBounds(node: HTMLElement | null): YoutubeEmbedBounds | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 160 || rect.height < 90) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function mediaUrl(session: VideoPipSession): string {
  return session.source === "network"
    ? api.videoPreviewUrl(session.platform, session.bvid, session.page)
    : api.videoUrl(session.trackId);
}

/** panel 档的旁路 UI（右栏 / 曲库详情），与宿主 <video> 启停分开。 */
function applyPanelChrome(session: VideoPipSession, mode: VideoPreviewMode): void {
  // 在线搜索结果的双击预览固定走浮动小窗；底栏模式只属于本地视频。
  if (session.source === "network") {
    if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
    return;
  }
  if (mode === "panel") {
    if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
    // 钉住曲目详情右栏（见 Workspace DETAIL_EVENT），别只清 overlay 却不展开
    window.dispatchEvent(new Event("kd:show-detail"));
    return;
  }
  if (useAppStore.getState().showPreview) {
    useAppStore.getState().dismissOverlay();
  }
}

export function VideoPipHost() {
  const floatRef = useRef<HTMLDivElement | null>(null);
  const youtubeEmbedSlotRef = useRef<HTMLDivElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const youtubeEmbedRef = useRef<PlatformEmbedController | null>(null);
  const youtubePreviewRef = useRef<YoutubeVideoPreviewController | null>(null);
  const youtubeReadyKeyRef = useRef<string | null>(null);
  const youtubeAutoPlayKeyRef = useRef<string | null>(null);
  const compatRetryKeyRef = useRef<string | null>(null);
  const platformFallbackSessionKeyRef = useRef<string | null>(null);
  const desiredPlayingRef = useRef(false);
  const pendingScrubRef = useRef<number | null>(null);
  const nativeVideoSeekTimerRef = useRef(0);
  const networkVideoWatchdogRef = useRef(0);
  const networkRetryRef = useRef({ key: "", count: 0 });
  const focusedPreviewKeyRef = useRef<string | null>(null);
  const localSynchronizerRef = useRef<LocalVideoSynchronizer | null>(null);
  const videoSeekEchoGuardRef = useRef<VideoSeekEchoGuard | null>(null);
  const videoTransportEchoGuardRef = useRef<VideoTransportEchoGuard | null>(null);
  if (!localSynchronizerRef.current) {
    localSynchronizerRef.current = new LocalVideoSynchronizer();
  }
  if (!videoSeekEchoGuardRef.current) {
    videoSeekEchoGuardRef.current = new VideoSeekEchoGuard();
  }
  if (!videoTransportEchoGuardRef.current) {
    videoTransportEchoGuardRef.current = new VideoTransportEchoGuard();
  }
  const fullscreenRef = useRef(false);
  const fullscreenTransitionRef = useRef(false);
  const fullscreenRequestRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    edge: ResizeEdge;
    startX: number;
    startY: number;
    startW: number;
    originX: number;
    originY: number;
  } | null>(null);

  const mode = useVideoPip((state) => state.mode);
  const active = useVideoPip((state) => state.active);
  const systemPip = useVideoPip((state) => state.systemPip);
  const playing = useVideoPip((state) => state.playing);
  const position = useVideoPip((state) => state.position);
  const duration = useVideoPip((state) => state.duration);
  const error = useVideoPip((state) => state.error);
  const session = useVideoPip((state) => state.session);
  const masterVolume = useMasterVolume((state) => state.volume);
  const coplay = useCrossfade((state) => state.coplay);
  const fadeX = useCrossfade((state) => state.x);
  const networkVolume = masterVolume * previewGain(coplay, fadeX);
  const onlinePlayerPreference = useAppStore((state) => {
    if (session?.source !== "network") return "kdj";
    return session.platform === "youtube"
      ? (state.settings?.youtube_preview_player ?? "kdj")
      : (state.settings?.bilibili_preview_player ?? "kdj");
  });
  const [platformFallbackSessionKey, setPlatformFallbackSessionKey] = useState<string | null>(null);
  const [floatBox, setFloatBox] = useState(() => ({
    ...defaultFloatPos(FLOAT_DEFAULT_W),
    w: FLOAT_DEFAULT_W,
  }));
  const [videoFullscreen, setVideoFullscreen] = useState(false);

  const applyVideoFullscreen = useCallback(async (next: boolean): Promise<void> => {
    const previous = fullscreenRef.current;
    if (previous === next) return;
    const request = ++fullscreenRequestRef.current;
    fullscreenRef.current = next;
    // 进入前先让视频铺满窗口；退出时则等原生窗口离开全屏后再还原浮窗，
    // 避免 macOS 动画过程中突然露出一块小视频。
    if (next) setVideoFullscreen(true);
    fullscreenTransitionRef.current = true;
    try {
      await getCurrentWindow().setFullscreen(next);
      if (fullscreenRequestRef.current === request && !next) {
        setVideoFullscreen(false);
      }
    } catch {
      if (fullscreenRequestRef.current === request) {
        fullscreenRef.current = previous;
        setVideoFullscreen(previous);
      }
    } finally {
      if (fullscreenRequestRef.current === request) {
        fullscreenTransitionRef.current = false;
      }
    }
  }, []);

  // 网络搜索结果始终浮动预览；保存的 panel/float 偏好只决定本地视频呈现。
  const hostLifecycle = videoPipHostLifecycle(session, active, mode);
  const hostActive = hostLifecycle === "present";
  // 进了系统画中画就藏自研小窗，避免底下还留一块空壳
  const showFloating = Boolean(hostActive && !systemPip);
  const isLocal = session?.source === "local";
  const shouldUsePlatformPlayer = (candidate: VideoPipSession | null | undefined): boolean =>
    usesPlatformPlayer(candidate) &&
    Boolean(candidate && platformFallbackSessionKeyRef.current !== sessionKey(candidate));
  const isPlatformPlayer =
    usesPlatformPlayer(session) &&
    Boolean(session && platformFallbackSessionKey !== sessionKey(session));
  const key = session
    ? `${sessionKey(session)}:${onlinePlayerPreference}:${isPlatformPlayer ? "platform" : "kdj"}`
    : "";
  const localSwap = useLocalVideoSwap({
    // WebKit PiP is bound to the concrete source <video>. While it is open, keep that element
    // stable and use the single-video seek fallback instead of swapping it out from underneath PiP.
    enabled: Boolean(isLocal && hostActive && !systemPip),
    trackId: session?.source === "local" ? session.trackId : null,
    desiredPlayingRef,
    getRate: () => {
      const current = useVideoPip.getState().session;
      return current?.source === "local" ? (getLatestPlayerSync(current.trackId)?.rate ?? 1) : 1;
    },
    onActivate: (video, target) => {
      localSynchronizerRef.current?.reset(video);
      useVideoPip.getState().setPosition(target);
    },
    transportEchoGuard: videoTransportEchoGuardRef.current,
  });

  // A dev HMR update can briefly pair a new frontend with an older Tauri command set. The same
  // fallback also covers an official embed that is unavailable for one particular video. Keep the
  // user's persisted preference intact and retry the preferred player for the next session.
  useEffect(() => {
    platformFallbackSessionKeyRef.current = null;
    setPlatformFallbackSessionKey(null);
  }, [session ? sessionKey(session) : "", onlinePlayerPreference]);
  const activeVideo = localSwap.activeVideo;

  const commitPreviewAudioFocus = (sessionKeyValue: string) => {
    if (focusedPreviewKeyRef.current === sessionKeyValue) return;
    focusedPreviewKeyRef.current = sessionKeyValue;
    announceAudioFocus("preview");
  };

  const clearPreviewAudioFocus = () => {
    focusedPreviewKeyRef.current = null;
  };

  useEffect(() => {
    if (session?.source !== "network") return;
    for (const video of localSwap.videoRefs.current) {
      if (video) video.volume = networkVolume;
    }
    void youtubeEmbedRef.current?.setVolume(networkVolume).catch(() => undefined);
  }, [networkVolume, session?.source, localSwap.videoRefs]);

  const systemPipTarget = useCallback(() => {
    const source = activeVideo();
    const webkitEnvironment =
      typeof HTMLVideoElement !== "undefined" &&
      "webkitSetPresentationMode" in HTMLVideoElement.prototype;
    // The current macOS WKWebView exposes MediaStream PiP but renders it as a black square.
    // Prefer the real source element there; the dual-video presenter is disabled while PiP is open.
    if (isLocal && source && webkitEnvironment) return source;
    const composite = pipVideoRef.current;
    if (isLocal && composite?.srcObject && canSystemPip(composite)) return composite;
    return source;
  }, [activeVideo, isLocal]);

  // A stable canvas-backed video remains bound to macOS PiP while the two source videos swap.
  // Safari 18+ supports MediaStream PiP; older WebKit falls back to the active source element.
  useEffect(() => {
    const canvas = pipCanvasRef.current;
    const output = pipVideoRef.current;
    if (!isLocal || !hostActive || !canvas || !output || typeof canvas.captureStream !== "function") {
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    canvas.width = 1280;
    canvas.height = 720;
    const stream = canvas.captureStream(30);
    output.srcObject = stream;
    output.muted = true;
    output.controls = true;
    void output.play().catch(() => undefined);
    let disposed = false;
    let frame = 0;
    const draw = () => {
      if (disposed) return;
      const source = activeVideo();
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (source && source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && source.videoWidth > 0) {
        try {
          const scale = Math.min(canvas.width / source.videoWidth, canvas.height / source.videoHeight);
          const width = source.videoWidth * scale;
          const height = source.videoHeight * scale;
          context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        } catch {
          // A server/CORS regression must not turn PiP black; dropping srcObject makes the entry
          // path fall back to the active source video and preserves the existing feature.
          disposed = true;
          for (const track of stream.getTracks()) track.stop();
          output.srcObject = null;
          return;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      void exitSystemPip(output);
      for (const track of stream.getTracks()) track.stop();
      output.pause();
      output.srcObject = null;
    };
  }, [activeVideo, hostActive, isLocal]);

  // 浮窗可以放到当前视口所能容纳的最大 16:9 尺寸；应用窗口缩小时再自动收回。
  // 同一个 resize 事件也用于识别用户从 macOS 原生全屏手势 / Esc 退出的情况。
  useEffect(() => {
    let syncFrame = 0;
    const onWindowResize = () => {
      setFloatBox((previous) =>
        clampHostFloatBox(
          previous,
          window.innerWidth,
          window.innerHeight,
          useVideoPip.getState().session,
        ),
      );
      if (!fullscreenRef.current || fullscreenTransitionRef.current) return;
      cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        void getCurrentWindow()
          .isFullscreen()
          .then((nativeFullscreen) => {
            if (nativeFullscreen || !fullscreenRef.current || fullscreenTransitionRef.current) {
              return;
            }
            fullscreenRef.current = false;
            setVideoFullscreen(false);
            setFloatBox((previous) =>
              clampHostFloatBox(
                previous,
                window.innerWidth,
                window.innerHeight,
                useVideoPip.getState().session,
              ),
            );
          })
          .catch(() => undefined);
      });
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      cancelAnimationFrame(syncFrame);
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !fullscreenRef.current) return;
      event.preventDefault();
      void applyVideoFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyVideoFullscreen]);

  useEffect(() => {
    if ((hostActive && !systemPip) || !fullscreenRef.current) return;
    void applyVideoFullscreen(false);
  }, [applyVideoFullscreen, hostActive, systemPip]);

  useEffect(
    () => () => {
      if (fullscreenRef.current) void getCurrentWindow().setFullscreen(false);
      youtubeEmbedRef.current?.dispose();
      youtubeEmbedRef.current = null;
      void youtubePreviewRef.current?.dispose();
      youtubePreviewRef.current = null;
      youtubeReadyKeyRef.current = null;
      youtubeAutoPlayKeyRef.current = null;
      localSynchronizerRef.current?.dispose();
      videoSeekEchoGuardRef.current?.clear();
      videoTransportEchoGuardRef.current?.clear();
      window.clearTimeout(nativeVideoSeekTimerRef.current);
      window.clearTimeout(networkVideoWatchdogRef.current);
      for (const video of localSwap.videoRefs.current) {
        if (!video) continue;
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      focusedPreviewKeyRef.current = null;
    },
    [],
  );

  const pauseHostVideos = () => {
    for (const item of localSwap.videoRefs.current) {
      if (!item || item.paused) continue;
      videoTransportEchoGuardRef.current?.mark(item, "pause");
      item.pause();
    }
  };

  const stopHost = () => {
    youtubeEmbedRef.current?.dispose();
    youtubeEmbedRef.current = null;
    void youtubePreviewRef.current?.dispose();
    youtubePreviewRef.current = null;
    youtubeReadyKeyRef.current = null;
    youtubeAutoPlayKeyRef.current = null;
    window.clearTimeout(nativeVideoSeekTimerRef.current);
    window.clearTimeout(networkVideoWatchdogRef.current);
    networkVideoWatchdogRef.current = 0;
    clearPreviewAudioFocus();
    videoSeekEchoGuardRef.current?.clear();
    const video = activeVideo();
    localSynchronizerRef.current?.reset(video);
    void exitSystemPip(systemPipTarget());
    localSwap.cancelPending();
    pauseHostVideos();
    for (const item of localSwap.videoRefs.current) {
      if (!item) continue;
      if (item.src) {
        item.removeAttribute("src");
        item.load();
      }
    }
    loadedKeyRef.current = null;
    compatRetryKeyRef.current = null;
    desiredPlayingRef.current = false;
    useVideoPip.getState().setPlaying(false);
  };

  const failNetworkHost = (video: HTMLVideoElement, message: string) => {
    const pip = useVideoPip.getState();
    const current = pip.session;
    if (current?.source !== "network" || activeVideo() !== video) return;
    const currentKey = `${sessionKey(current)}:kdj`;
    const retry = networkRetryRef.current;
    if (retry.key !== currentKey) {
      retry.key = currentKey;
      retry.count = 0;
    }
    // B站代理会在读流失败时把当前 CDN 移到队尾。重新建立同一个 loopback URL
    // 就会命中下一个 backupUrl；最多自动重试两次，避免坏网络下无限循环。
    if (current.platform === "bilibili" && retry.count < 2) {
      retry.count += 1;
      window.clearTimeout(networkVideoWatchdogRef.current);
      networkVideoWatchdogRef.current = 0;
      clearPreviewAudioFocus();
      video.pause();
      video.removeAttribute("src");
      video.load();
      loadedKeyRef.current = currentKey;
      pip.setPlaying(false);
      pip.setError("正在切换 B站备用线路…");
      window.setTimeout(() => {
        if (
          !desiredPlayingRef.current ||
          useVideoPip.getState().session !== current ||
          activeVideo() !== video
        ) {
          return;
        }
        video.volume = currentNetworkVolume();
        video.src = mediaUrl(current);
        video.load();
        armNetworkVideoWatchdog(
          video,
          currentKey,
          NETWORK_VIDEO_START_TIMEOUT_MS,
          "B站备用线路启动超时",
        );
        void video.play().catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          failNetworkHost(
            video,
            `B站备用线路播放失败：${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
      }, 0);
      return;
    }
    stopHost();
    const latest = useVideoPip.getState();
    latest.setError(message);
    latest.setFailed(true);
  };

  const armNetworkVideoWatchdog = (
    video: HTMLVideoElement,
    sessionKeyValue: string,
    timeoutMs: number,
    message: string,
  ) => {
    window.clearTimeout(networkVideoWatchdogRef.current);
    networkVideoWatchdogRef.current = window.setTimeout(() => {
      networkVideoWatchdogRef.current = 0;
      if (
        desiredPlayingRef.current &&
        loadedKeyRef.current === sessionKeyValue &&
        activeVideo() === video
      ) {
        failNetworkHost(video, message);
      }
    }, timeoutMs);
  };

  const suspendLocalHost = (next: Extract<VideoPipSession, { source: "local" }>) => {
    const nextKey = `${sessionKey(next)}:kdj`;
    // A panel-first session has no local source to retain. A source left by another session must
    // still be torn down; only the exact local session receives the non-destructive suspension.
    if (!hasLoadedSessionSource(loadedKeyRef.current, nextKey, next)) {
      networkRetryRef.current = { key: nextKey, count: 0 };
      stopHost();
      return;
    }
    window.clearTimeout(nativeVideoSeekTimerRef.current);
    videoSeekEchoGuardRef.current?.clear();
    localSwap.cancelPending();
    localSynchronizerRef.current?.reset(activeVideo());
    const latest = getLatestPlayerSync(next.trackId);
    if (latest) desiredPlayingRef.current = latest.action === "play";
    pauseHostVideos();
    void exitSystemPip(systemPipTarget());
    useVideoPip.getState().setPlaying(false);
  };

  const ensureHostPlaying = (next: VideoPipSession) => {
    const nextKey = `${sessionKey(next)}:${shouldUsePlatformPlayer(next) ? "platform" : "kdj"}`;
    const latestLocalSync =
      next.source === "local" ? getLatestPlayerSync(next.trackId) : null;
    const shouldPlay = latestLocalSync
      ? latestLocalSync.action === "play"
      : desiredPlayingRef.current || next.source === "network" || next.autoPlay;
    desiredPlayingRef.current = shouldPlay;
    useVideoPip.getState().setError("");
    if (next.source === "network" && shouldUsePlatformPlayer(next)) {
      if (loadedKeyRef.current !== nextKey) {
        youtubeEmbedRef.current?.dispose();
        youtubeEmbedRef.current = null;
        void youtubePreviewRef.current?.dispose();
        youtubePreviewRef.current = null;
        youtubeReadyKeyRef.current = null;
        youtubeAutoPlayKeyRef.current = null;
        localSwap.cancelPending();
        for (const item of localSwap.videoRefs.current) {
          if (!item) continue;
          item.pause();
          if (item.src) {
            item.removeAttribute("src");
            item.load();
          }
        }
        const bounds = youtubeBounds(youtubeEmbedSlotRef.current);
        if (!bounds) {
          useVideoPip.getState().setError("平台播放窗口尚未就绪");
          return;
        }
        let controller: PlatformEmbedController;
        const fallbackToKdjPlayer = () => {
          if (
            youtubeEmbedRef.current !== controller ||
            loadedKeyRef.current !== nextKey
          ) {
            return;
          }
          controller.dispose();
          youtubeEmbedRef.current = null;
          youtubeReadyKeyRef.current = null;
          youtubeAutoPlayKeyRef.current = null;
          loadedKeyRef.current = null;
          useVideoPip.getState().setPlaying(false);
          useVideoPip.getState().setError("");
          const fallbackKey = sessionKey(next);
          platformFallbackSessionKeyRef.current = fallbackKey;
          setPlatformFallbackSessionKey(fallbackKey);
        };
        const callbacks = {
          bounds,
          onStatus: (status: PlatformEmbedStatus) => {
            if (
              youtubeEmbedRef.current !== controller ||
              loadedKeyRef.current !== nextKey
            ) {
              return;
            }
            const pip = useVideoPip.getState();
            pip.setPosition(status.position);
            pip.setDuration(status.duration);
            pip.setPlaying(status.playing || status.buffering);
            if (status.playing) {
              commitPreviewAudioFocus(nextKey);
            } else if (!status.buffering) {
              clearPreviewAudioFocus();
            }
            if (status.ended) desiredPlayingRef.current = false;
          },
          onError: (reason: Error) => {
            if (youtubeEmbedRef.current !== controller) return;
            void reason;
            fallbackToKdjPlayer();
          },
        };
        controller = isYoutubeSession(next)
          ? new YoutubeEmbedController({
              videoId: next.bvid,
              muted: import.meta.env.DEV && import.meta.env.VITE_KDJ_YOUTUBE_E2E === "1",
              volume: currentNetworkVolume(),
              ...callbacks,
            })
          : new BilibiliEmbedController({
              bvid: next.bvid,
              page: next.page,
              muted: false,
              volume: currentNetworkVolume(),
              ...callbacks,
            });
        youtubeEmbedRef.current = controller;
        loadedKeyRef.current = nextKey;
        void controller.done
          .then(() => {
            if (
              youtubeEmbedRef.current !== controller ||
              loadedKeyRef.current !== nextKey
            ) {
              return;
            }
            youtubeReadyKeyRef.current = nextKey;
            if (
              desiredPlayingRef.current &&
              youtubeAutoPlayKeyRef.current !== nextKey
            ) {
              youtubeAutoPlayKeyRef.current = nextKey;
              void controller.play().catch((reason: unknown) => {
                if (youtubeEmbedRef.current !== controller) return;
                useVideoPip.getState().setPlaying(false);
                useVideoPip
                  .getState()
                  .setError(reason instanceof Error ? reason.message : String(reason));
              });
            }
          })
          .catch((reason: unknown) => {
            if (youtubeEmbedRef.current !== controller) return;
            if (reason instanceof DOMException && reason.name === "AbortError") return;
            fallbackToKdjPlayer();
          });
        return;
      }
      const controller = youtubeEmbedRef.current;
      if (!controller || youtubeReadyKeyRef.current !== nextKey) return;
      if (!shouldPlay) {
        clearPreviewAudioFocus();
        void controller.pause().catch(() => undefined);
        useVideoPip.getState().setPlaying(false);
        return;
      }
      if (youtubeAutoPlayKeyRef.current !== nextKey) {
        youtubeAutoPlayKeyRef.current = nextKey;
        void controller.play().catch((reason: unknown) => {
          useVideoPip.getState().setPlaying(false);
          useVideoPip
            .getState()
            .setError(reason instanceof Error ? reason.message : String(reason));
        });
      }
      return;
    }
    let video = activeVideo();
    if (!video) return;
    video.muted = next.source === "local";
    if (next.source === "network") video.volume = currentNetworkVolume();
    if (!hasLoadedSessionSource(loadedKeyRef.current, nextKey, next)) {
      localSynchronizerRef.current?.reset(video);
      compatRetryKeyRef.current = null;
      youtubeEmbedRef.current?.dispose();
      youtubeEmbedRef.current = null;
      void youtubePreviewRef.current?.dispose();
      youtubePreviewRef.current = null;
      youtubeReadyKeyRef.current = null;
      youtubeAutoPlayKeyRef.current = null;
      if (next.source === "local") {
        localSwap.load(nextKey, mediaUrl(next));
      } else {
        localSwap.cancelPending();
        const standby = localSwap.standbyVideo();
        standby?.pause();
        standby?.removeAttribute("src");
        standby?.load();
        if (isYoutubeSession(next)) {
          const controller = attachYoutubeVideoPreview(video, {
            platform: "youtube",
            bvid: next.bvid,
            page: next.page,
          });
          youtubePreviewRef.current = controller;
          loadedKeyRef.current = nextKey;
          const playingVideo = video;
          void controller.done
            .then(() => {
              if (
                youtubePreviewRef.current !== controller ||
                loadedKeyRef.current !== nextKey ||
                !desiredPlayingRef.current
              ) {
                return;
              }
              armNetworkVideoWatchdog(
                playingVideo,
                nextKey,
                NETWORK_VIDEO_START_TIMEOUT_MS,
                "视频预览启动超时，已停止加载",
              );
              void playingVideo.play().catch((reason: unknown) => {
                if (youtubePreviewRef.current !== controller) return;
                failNetworkHost(
                  playingVideo,
                  `视频预览启动失败：${reason instanceof Error ? reason.message : String(reason)}`,
                );
              });
            })
            .catch((reason: unknown) => {
              if (youtubePreviewRef.current !== controller) return;
              if (reason instanceof DOMException && reason.name === "AbortError") return;
              failNetworkHost(
                playingVideo,
                `视频预览加载失败：${reason instanceof Error ? reason.message : String(reason)}`,
              );
            });
          return;
        }
        video.src = mediaUrl(next);
        video.load();
      }
      loadedKeyRef.current = nextKey;
      video = activeVideo();
      if (!video) return;
    }
    if (
      next.source === "local" &&
      latestLocalSync &&
      Number.isFinite(latestLocalSync.position) &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA
    ) {
      localSynchronizerRef.current?.sync(
        video,
        Math.max(0, latestLocalSync.position as number),
        "explicit",
        latestLocalSync.rate ?? 1,
        (element, target) => {
          videoSeekEchoGuardRef.current?.mark(element, target);
          element.currentTime = target;
        },
      );
    }
    if (!shouldPlay) {
      video.pause();
      useVideoPip.getState().setPlaying(false);
      return;
    }
    const playingVideo = video;
    if (next.source === "network") {
      armNetworkVideoWatchdog(
        playingVideo,
        nextKey,
        NETWORK_VIDEO_START_TIMEOUT_MS,
        "视频预览启动超时，已停止加载",
      );
    }
    void playingVideo.play().catch((reason: unknown) => {
      if (!desiredPlayingRef.current) return;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      const unsupported =
        (reason instanceof DOMException && reason.name === "NotSupportedError") ||
        playingVideo.error?.code === 4; // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      if (next.source === "local" && unsupported && compatRetryKeyRef.current !== nextKey) {
        compatRetryKeyRef.current = nextKey;
        loadedKeyRef.current = `${nextKey}:compat`;
        useVideoPip.getState().setError("正在转换为系统播放器兼容格式…");
        localSwap.load(`${nextKey}:compat`, api.videoUrl(next.trackId, true));
        video = activeVideo();
        if (!video) return;
        const compatVideo = video;
        void compatVideo
          .play()
          .then(() => {
            if (!desiredPlayingRef.current) {
              compatVideo.pause();
              return;
            }
            useVideoPip.getState().setError("");
          })
          .catch((compatReason: unknown) => {
            if (!desiredPlayingRef.current) return;
            useVideoPip.getState().setPlaying(false);
            useVideoPip
              .getState()
              .setError(
                `这个视频无法转换为兼容格式：${compatReason instanceof Error ? compatReason.message : String(compatReason)}`,
              );
          });
        return;
      }
      if (next.source === "network") {
        failNetworkHost(
          playingVideo,
          `视频预览启动失败：${reason instanceof Error ? reason.message : String(reason)}`,
        );
        return;
      }
      useVideoPip.getState().setPlaying(false);
      useVideoPip
        .getState()
        .setError(
          unsupported
            ? "系统播放器不支持这个视频容器或编码"
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
    });
  };

  // 事件只负责写入 session；真正装 src / 出小窗交给下面的 effect，
  // 保证发生在 float DOM 提交之后。
  useEffect(() => {
    const onNetwork = (event: Event) => {
      const detail = (event as CustomEvent<VideoPreviewRequest>).detail;
      if (!detail?.bvid) return;
      const pip = useVideoPip.getState();
      networkRetryRef.current = { key: "", count: 0 };
      desiredPlayingRef.current = true;
      pip.setSession({
        source: "network",
        platform: detail.platform ?? "bilibili",
        bvid: detail.bvid,
        page: detail.page,
        title: detail.title,
        author: detail.author,
        cover: detail.cover?.trim() || undefined,
      });
      applyPanelChrome(
        {
          source: "network",
          platform: detail.platform ?? "bilibili",
          bvid: detail.bvid,
          page: detail.page,
          title: detail.title,
          author: detail.author,
          cover: detail.cover?.trim() || undefined,
        },
        pip.mode,
      );
    };
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<LocalVideoRequest>).detail;
      const track = detail?.track;
      if (!track || !Number.isFinite(track.id) || track.id <= 0) return;
      const pip = useVideoPip.getState();
      desiredPlayingRef.current = detail.autoPlay !== false;
      const next: VideoPipSession = {
        source: "local",
        trackId: track.id,
        title: track.title || track.filename,
        author: track.artist || "",
        autoPlay: detail.autoPlay !== false,
      };
      pip.setSession(next);
      applyPanelChrome(next, pip.mode);
    };
    window.addEventListener(VIDEO_PREVIEW_EVENT, onNetwork);
    window.addEventListener(LOCAL_VIDEO_EVENT, onLocal);
    return () => {
      window.removeEventListener(VIDEO_PREVIEW_EVENT, onNetwork);
      window.removeEventListener(LOCAL_VIDEO_EVENT, onLocal);
    };
  }, []);

  useEffect(() => {
    const onApply = (event: Event) => {
      const detail = (event as CustomEvent<ApplyVideoModeDetail>).detail;
      if (!detail?.mode) return;
      const pip = useVideoPip.getState();
      if (!pip.session || !pip.active) {
        if (detail.mode !== "panel" && useAppStore.getState().showPreview) {
          useAppStore.getState().dismissOverlay();
        }
        return;
      }
      // 网络预览不响应本地视频模式切换，避免点一下底栏按钮把正在看的 B 站小窗关掉。
      if (pip.session.source === "network") return;
      applyPanelChrome(pip.session, detail.mode);
      // host 启停由 session/active/mode 生命周期 effect 接手
    };
    window.addEventListener(APPLY_VIDEO_MODE_EVENT, onApply);
    return () => window.removeEventListener(APPLY_VIDEO_MODE_EVENT, onApply);
  }, []);

  // 核心：浮动模式装载并播放；本地详情模式只暂停保源；会话关闭才拆掉宿主。
  // 不能在每次模式开关时 remove src + load：WebKit 会不断中止同一资源的解码，
  // 最后一次 play 即使仍有音频时钟，也可能没有任何可提交的画面而留下黑窗。
  // 系统画中画不走 mode，由小窗按钮 / 切走应用另行 requestPictureInPicture。
  // rAF：等 data-floating / .kd-pip-float 那帧样式落地，避免在 1×1 idle shell 里 play 后被 WebKit 丢掉。
  useEffect(() => {
    if (hostLifecycle === "stop" || !session) {
      stopHost();
      return;
    }
    if (hostLifecycle === "suspend-local" && session.source === "local") {
      suspendLocalHost(session);
      return;
    }
    // 窗口尺寸可能在首次挂载后变了，出小窗时把尺寸和位置一起夹回可视区。
    setFloatBox((previous) =>
      clampHostFloatBox(previous, window.innerWidth, window.innerHeight, session),
    );
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      ensureHostPlaying(session);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hostLifecycle]);

  // The official player is a sibling native WKWebView, not a remote iframe inside the privileged
  // React renderer. Keep its one allowed rectangle aligned with the black slot while the KDJ
  // window is dragged, resized, or switched between videos.
  useEffect(() => {
    if (!isPlatformPlayer || !showFloating) return;
    const controller = youtubeEmbedRef.current;
    if (!controller) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const bounds = youtubeBounds(youtubeEmbedSlotRef.current);
      if (!cancelled && bounds) {
        void controller.setBounds(bounds).catch((reason: unknown) => {
          if (cancelled || youtubeEmbedRef.current !== controller) return;
          useVideoPip
            .getState()
            .setError(reason instanceof Error ? reason.message : String(reason));
        });
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [floatBox.w, floatBox.x, floatBox.y, isPlatformPlayer, showFloating, videoFullscreen]);

  // 切走应用（窗口失焦 / 页面隐藏）时，默认把正在播的浮动预览送进系统画中画
  useEffect(() => {
    let hideTimer = 0;
    const maybeAutoPip = () => {
      const pip = useVideoPip.getState();
      if (shouldUsePlatformPlayer(pip.session)) return;
      const floats = pip.session?.source === "network" || pip.mode === "float";
      if (
        !pip.active ||
        !floats ||
        pip.systemPip ||
        !pip.playing ||
        fullscreenRef.current
      ) {
        return;
      }
      const video = activeVideo();
      const target = systemPipTarget();
      if (!video || video.paused || !target || !canSystemPip(target)) return;
      void enterSystemPip(target);
    };
    const scheduleAutoPip = () => {
      window.clearTimeout(hideTimer);
      // 失焦回调仍处在这次用户交互附近，先同步尝试，避免延迟后 WebKit 已经暂停
      // 或丢掉 user activation；短 timer 只负责兜底尚未完成的可见性切换。
      maybeAutoPip();
      hideTimer = window.setTimeout(() => {
        if (document.visibilityState === "hidden" || !document.hasFocus()) maybeAutoPip();
      }, 80);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") scheduleAutoPip();
      else window.clearTimeout(hideTimer);
    };
    const onBlur = () => scheduleAutoPip();
    const onFocus = () => window.clearTimeout(hideTimer);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeVideo, systemPipTarget]);

  useEffect(() => {
    const onSeek = (event: Event) => {
      const at = (event as CustomEvent<VideoPipSeekDetail>).detail?.position;
      const current = useVideoPip.getState().session;
      if (!current || !Number.isFinite(at)) return;
      if (shouldUsePlatformPlayer(current)) {
        const target = Math.max(0, at as number);
        useVideoPip.getState().setPosition(target);
        void youtubeEmbedRef.current?.seek(target).catch((reason: unknown) => {
          useVideoPip
            .getState()
            .setError(reason instanceof Error ? reason.message : String(reason));
        });
        return;
      }
      const video = activeVideo();
      if (!video) return;
      if (current?.source === "local") {
        window.dispatchEvent(
          new CustomEvent<SeekDetail>(SEEK_EVENT, {
            detail: {
              trackId: current.trackId,
              position: Math.max(0, at as number),
              forceCommit: true,
            },
          }),
        );
        return;
      }
      video.currentTime = Math.max(0, at as number);
      useVideoPip.getState().setPosition(video.currentTime);
    };
    const onToggle = () => {
      const current = useVideoPip.getState().session;
      const pip = useVideoPip.getState();
      if (!current || !pip.active) return;
      if (current.source === "network" && pip.failed) {
        networkRetryRef.current = { key: "", count: 0 };
        desiredPlayingRef.current = true;
        pip.setFailed(false);
        pip.setError("");
        ensureHostPlaying(current);
        return;
      }
      if (shouldUsePlatformPlayer(current)) {
        const controller = youtubeEmbedRef.current;
        if (!controller) return;
        if (pip.playing) {
          desiredPlayingRef.current = false;
          clearPreviewAudioFocus();
          pip.setPlaying(false);
          void controller.pause().catch((reason: unknown) => {
            pip.setError(reason instanceof Error ? reason.message : String(reason));
          });
        } else {
          desiredPlayingRef.current = true;
          void controller.play().catch((reason: unknown) => {
            pip.setPlaying(false);
            pip.setError(reason instanceof Error ? reason.message : String(reason));
          });
        }
        return;
      }
      const video = activeVideo();
      if (!video) return;
      if (video.paused) {
        desiredPlayingRef.current = true;
        if (current.source === "local") {
          broadcastMediaSync({
            owner: "local-video",
            action: "play",
            trackId: current.trackId,
            position: video.currentTime,
          });
        }
        ensureHostPlaying(current);
      } else {
        desiredPlayingRef.current = false;
        video.pause();
        if (current.source === "local") {
          broadcastMediaSync({
            owner: "local-video",
            action: "pause",
            trackId: current.trackId,
            position: video.currentTime,
          });
        }
      }
    };
    window.addEventListener(VIDEO_PIP_SEEK_EVENT, onSeek);
    window.addEventListener(VIDEO_PIP_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(VIDEO_PIP_SEEK_EVENT, onSeek);
      window.removeEventListener(VIDEO_PIP_TOGGLE_EVENT, onToggle);
    };
  }, []);

  // 本地小窗：跟主播放条时钟（监听常挂，不依赖 hostActive，避免错过起播那一帧）
  useEffect(() => {
    if (!isLocal || !session || session.source !== "local") return;
    const trackId = session.trackId;
    const applySync = (detail: MediaSyncDetail) => {
      if (detail.owner !== "player" || detail.trackId !== trackId) return;
      if (detail.action === "play") desiredPlayingRef.current = true;
      if (detail.action === "pause") desiredPlayingRef.current = false;
      const pip = useVideoPip.getState();
      const presenting =
        pip.active &&
        pip.mode === "float" &&
        pip.session?.source === "local" &&
        pip.session.trackId === trackId;
      // The detail panel owns presentation in panel mode. Retain this element's decoded source,
      // but keep it paused so repeated mode toggles do not churn WebKit or run a hidden decoder.
      if (!presenting) return;
      const video = activeVideo();
      if (!video) return;
      const synchronizer = localSynchronizerRef.current;
      const rate = detail.rate ?? 1;
      const alignVideo = (element: HTMLVideoElement, position: number) => {
        videoSeekEchoGuardRef.current?.mark(element, position);
        element.currentTime = position;
      };
      if (detail.action === "play") {
        const target = detail.position;
        if (synchronizer && Number.isFinite(target)) {
          synchronizer.sync(video, target as number, "explicit", rate, alignVideo);
        } else {
          synchronizer?.setBaseRate(video, rate);
        }
        void video.play().catch(() => undefined);
        if (useVideoPip.getState().systemPip && pipVideoRef.current?.srcObject) {
          void pipVideoRef.current.play().catch(() => undefined);
        }
      } else if (detail.action === "pause") {
        synchronizer?.setBaseRate(video, rate);
        video.pause();
        if (useVideoPip.getState().systemPip && pipVideoRef.current?.srcObject) {
          pipVideoRef.current.pause();
        }
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (!Number.isFinite(target) || !synchronizer) return;
        synchronizer.sync(
          video,
          target,
          detail.action === "seek" ? "explicit" : "heartbeat",
          rate,
          alignVideo,
        );
        // position 只校时，绝不能改变走带状态。播放器软停期间仍可能再发出
        // 一两个 timeupdate；若在这里看到 paused 就 play，会把刚暂停的小窗拉起，
        // onPlay 又反向通知 PlayerBar 播放，最终表现成视频怎样都暂停不了。
      }
    };
    const onSync = (event: Event) => {
      applySync((event as CustomEvent<MediaSyncDetail>).detail);
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    // PlayerBar 的 play 广播往往早于本监听挂上（兄弟节点 effect 顺序），
    // 和 LocalVideoPlayer 一样接一次缓存时钟。
    const latest = getLatestPlayerSync(trackId);
    let bootFrame = 0;
    let boot: (() => void) | null = null;
    if (latest) {
      // metadata 可能在用户已经按下暂停后才到。执行时重新读取状态，不能把挂载
      // 当刻捕获的旧 play 重新应用，否则慢加载的视频同样会“暂停后自己播放”。
      boot = () => {
        const current = getLatestPlayerSync(trackId);
        if (current) applySync(current);
      };
      const video = activeVideo();
      if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) boot();
      else {
        video?.addEventListener("loadedmetadata", boot, { once: true });
        // 源可能还没被 presentation effect 装上，下一帧再试
        bootFrame = requestAnimationFrame(boot);
      }
    }
    return () => {
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
      if (boot) activeVideo()?.removeEventListener("loadedmetadata", boot);
      if (bootFrame) cancelAnimationFrame(bootFrame);
    };
  }, [isLocal, session]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "preview") return;
      // 本地小窗静音跟时钟，主播放条开声不该把它掐掉
      if (useVideoPip.getState().session?.source === "local") return;
      desiredPlayingRef.current = false;
      if (shouldUsePlatformPlayer(useVideoPip.getState().session)) {
        void youtubeEmbedRef.current?.pause().catch(() => undefined);
        useVideoPip.getState().setPlaying(false);
        return;
      }
      activeVideo()?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    if (isPlatformPlayer) return;
    const video = activeVideo();
    if (!video) return;
    const stillActive = () => localSwap.isActiveVideo(video);
    const onEnter = () => {
      if (stillActive()) useVideoPip.getState().setSystemPip(true);
    };
    const onLeave = () => {
      if (stillActive()) useVideoPip.getState().setSystemPip(false);
    };
    const onWebKitPresentation = () => {
      if (!stillActive()) return;
      const webkit = video as WebKitPipVideo;
      useVideoPip
        .getState()
        .setSystemPip(webkit.webkitPresentationMode === "picture-in-picture");
    };
    const onPlay = () => {
      const programmatic = videoTransportEchoGuardRef.current?.consume(video, "play") ?? false;
      if (!stillActive()) return;
      const pip = useVideoPip.getState();
      if (programmatic) {
        pip.setPlaying(true);
        return;
      }
      // 普通 play 多数来自 PlayerBar 同步或首次装载，不得反向再控制播放器。
      // 只有系统 PiP 原生控件的动作没有我们的 click 入口，需要在这里回传。
      if (pip.systemPip && !desiredPlayingRef.current) {
        desiredPlayingRef.current = true;
        if (pip.session?.source === "local") {
          broadcastMediaSync({
            owner: "local-video",
            action: "play",
            trackId: pip.session.trackId,
            position: video.currentTime,
          });
        }
      }
      pip.setPlaying(true);
    };
    const onPlaying = () => {
      if (!stillActive()) return;
      const pip = useVideoPip.getState();
      if (pip.session?.source !== "network") return;
      pip.setError("");
      const activeKey = loadedKeyRef.current;
      if (!activeKey) return;
      commitPreviewAudioFocus(activeKey);
      armNetworkVideoWatchdog(
        video,
        activeKey,
        NETWORK_VIDEO_STALL_TIMEOUT_MS,
        "视频预览长时间没有输出，已停止加载",
      );
    };
    const onPause = () => {
      const programmatic = videoTransportEchoGuardRef.current?.consume(video, "pause") ?? false;
      if (!stillActive()) return;
      const pip = useVideoPip.getState();
      pip.setPlaying(false);
      if (pip.session?.source === "network") {
        window.clearTimeout(networkVideoWatchdogRef.current);
        networkVideoWatchdogRef.current = 0;
        clearPreviewAudioFocus();
      }
      if (programmatic) return;
      if (pip.systemPip) {
        // 系统小窗里的暂停来自原生控件；尊重它，不做后台自动恢复。
        const wasDesired = desiredPlayingRef.current;
        desiredPlayingRef.current = false;
        if (pip.session?.source === "local" && wasDesired) {
          broadcastMediaSync({
            owner: "local-video",
            action: "pause",
            trackId: pip.session.trackId,
            position: video.currentTime,
          });
        }
        return;
      }
      // WKWebView 在应用失焦时偶尔主动 pause。走带意图仍是播放时立即转系统
      // 小窗并恢复；backgroundThrottling=disabled 负责不支持 PiP 平台的时钟降级。
      if (desiredPlayingRef.current &&
          !fullscreenRef.current &&
          (document.visibilityState === "hidden" || !document.hasFocus())) {
        void enterSystemPip(video).then(() => {
          if (desiredPlayingRef.current && video.paused) {
            void video.play().catch(() => undefined);
          }
        });
      }
    };
    const onTime = () => {
      if (stillActive() && !localSwap.isHoldingPosition()) {
        const pip = useVideoPip.getState();
        pip.setPosition(video.currentTime);
        const activeKey = loadedKeyRef.current;
        if (
          pip.session?.source === "network" &&
          desiredPlayingRef.current &&
          activeKey
        ) {
          armNetworkVideoWatchdog(
            video,
            activeKey,
            NETWORK_VIDEO_STALL_TIMEOUT_MS,
            "视频预览长时间没有输出，已停止加载",
          );
        }
      }
    };
    const onWaiting = () => {
      const pip = useVideoPip.getState();
      const activeKey = loadedKeyRef.current;
      if (
        stillActive() &&
        pip.session?.source === "network" &&
        desiredPlayingRef.current &&
        activeKey
      ) {
        armNetworkVideoWatchdog(
          video,
          activeKey,
          NETWORK_VIDEO_STALL_TIMEOUT_MS,
          "视频预览缓冲超时，已停止加载",
        );
      }
    };
    const onSeeked = () => {
      if (!stillActive()) return;
      if (videoSeekEchoGuardRef.current?.consume(video, video.currentTime)) return;
      const pip = useVideoPip.getState();
      if (!pip.systemPip || pip.session?.source !== "local") return;

      // The macOS PiP timeline changes the source <video> directly. Forward its final landing to
      // the audible player; otherwise only the muted picture moves and the main waveform/audio
      // immediately continue on their old clock.
      const trackId = pip.session.trackId;
      window.clearTimeout(nativeVideoSeekTimerRef.current);
      nativeVideoSeekTimerRef.current = window.setTimeout(() => {
        const latest = useVideoPip.getState();
        if (
          !latest.systemPip ||
          latest.session?.source !== "local" ||
          latest.session.trackId !== trackId ||
          activeVideo() !== video
        ) {
          return;
        }
        broadcastMediaSync({
          owner: "local-video",
          action: "seek",
          trackId,
          position: video.currentTime,
        });
      }, 80);
    };
    const onMeta = () => {
      if (stillActive()) {
        useVideoPip
          .getState()
          .setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      }
    };
    const onEnded = () => {
      if (!stillActive()) return;
      window.clearTimeout(networkVideoWatchdogRef.current);
      networkVideoWatchdogRef.current = 0;
      clearPreviewAudioFocus();
      useVideoPip.getState().setPlaying(false);
    };
    const onError = () => {
      if (!stillActive()) return;
      if (useVideoPip.getState().session?.source === "network") {
        failNetworkHost(video, "视频预览加载失败，已停止网络请求");
        return;
      }
      useVideoPip.getState().setPlaying(false);
      useVideoPip.getState().setError("视频预览加载失败");
    };
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKitPresentation);
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKitPresentation);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [activeVideo, isPlatformPlayer, localSwap.activeSlot, localSwap.isActiveVideo]);

  useEffect(() => {
    const output = pipVideoRef.current;
    if (!output) return;
    const onEnter = () => useVideoPip.getState().setSystemPip(true);
    const onLeave = () => useVideoPip.getState().setSystemPip(false);
    const onWebKitPresentation = () => {
      const webkit = output as WebKitPipVideo;
      useVideoPip
        .getState()
        .setSystemPip(webkit.webkitPresentationMode === "picture-in-picture");
    };
    const onPlay = () => {
      const pip = useVideoPip.getState();
      if (!pip.systemPip || pip.session?.source !== "local" || desiredPlayingRef.current) return;
      const source = activeVideo();
      desiredPlayingRef.current = true;
      if (source) void source.play().catch(() => undefined);
      broadcastMediaSync({
        owner: "local-video",
        action: "play",
        trackId: pip.session.trackId,
        position: source?.currentTime ?? pip.position,
      });
    };
    const onPause = () => {
      const pip = useVideoPip.getState();
      if (!pip.systemPip || pip.session?.source !== "local" || !desiredPlayingRef.current) return;
      const source = activeVideo();
      desiredPlayingRef.current = false;
      source?.pause();
      broadcastMediaSync({
        owner: "local-video",
        action: "pause",
        trackId: pip.session.trackId,
        position: source?.currentTime ?? pip.position,
      });
    };
    output.addEventListener("enterpictureinpicture", onEnter);
    output.addEventListener("leavepictureinpicture", onLeave);
    output.addEventListener("webkitpresentationmodechanged", onWebKitPresentation);
    output.addEventListener("play", onPlay);
    output.addEventListener("pause", onPause);
    return () => {
      output.removeEventListener("enterpictureinpicture", onEnter);
      output.removeEventListener("leavepictureinpicture", onLeave);
      output.removeEventListener("webkitpresentationmodechanged", onWebKitPresentation);
      output.removeEventListener("play", onPlay);
      output.removeEventListener("pause", onPause);
    };
  }, [activeVideo]);

  const close = () => {
    if (fullscreenRef.current) void applyVideoFullscreen(false);
    stopHost();
    useVideoPip.getState().clear();
    if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
  };

  const toggle = () => {
    window.dispatchEvent(new Event(VIDEO_PIP_TOGGLE_EVENT));
  };

  const seekTo = (at: number, syncPlayer = true) => {
    const current = useVideoPip.getState().session;
    if (!current || !Number.isFinite(at)) return;
    const next = Math.max(0, duration > 0 ? Math.min(duration, at) : at);
    if (shouldUsePlatformPlayer(current)) {
      useVideoPip.getState().setPosition(next);
      if (syncPlayer) {
        void youtubeEmbedRef.current?.seek(next).catch((reason: unknown) => {
          useVideoPip
            .getState()
            .setError(reason instanceof Error ? reason.message : String(reason));
        });
      }
      return;
    }
    const video = activeVideo();
    if (!video) return;
    if (current.source === "local") {
      useVideoPip.getState().setPosition(next);
      window.dispatchEvent(
        new CustomEvent<SeekDetail>(SEEK_EVENT, {
          detail: {
            trackId: current.trackId,
            position: next,
            preview: !syncPlayer,
            scrubbing: !syncPlayer,
            forceCommit: syncPlayer,
          },
        }),
      );
      return;
    } else {
      video.currentTime = next;
    }
    useVideoPip.getState().setPosition(next);
  };

  const scrubFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (duration <= 0) return;
    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const at = ratio * duration;
    pendingScrubRef.current = at;
    // 每个 pointermove 只预览画面。若每一步都让双 Deck 做无缝 seek，相邻目标
    // 会在约 0.1 秒的交接窗里反复起音，听起来就是“哒哒”两下。
    seekTo(at, false);
  };

  const onDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || videoFullscreen) return;
    if (
      (event.target as HTMLElement).closest(
        "button, a, input, .kd-pip-resize, .kd-pip-float-scrub",
      )
    ) {
      return;
    }
    const node = floatRef.current;
    if (!node) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: floatBox.x,
      originY: floatBox.y,
    };
    node.setPointerCapture(event.pointerId);
  };

  const onDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (resize && resize.pointerId === event.pointerId) {
      const dx = event.clientX - resize.startX;
      const dy = event.clientY - resize.startY;
      const startH = videoFloatHeight(resize.startW);
      const edge = resize.edge;
      // 宽高锁 16:9：横边按 dx 改宽，竖边按 dy 换算成宽，角取变化更大的一侧
      let nextW = resize.startW;
      if (edge === "e" || edge === "ne" || edge === "se") nextW = resize.startW + dx;
      if (edge === "w" || edge === "nw" || edge === "sw") nextW = resize.startW - dx;
      if (edge === "s" || edge === "n") {
        nextW = ((edge === "s" ? startH + dy : startH - dy) * 16) / 9;
      } else if (edge === "se" || edge === "sw") {
        const fromH = ((startH + dy) * 16) / 9;
        if (Math.abs(fromH - resize.startW) > Math.abs(nextW - resize.startW)) nextW = fromH;
      } else if (edge === "ne" || edge === "nw") {
        const fromH = ((startH - dy) * 16) / 9;
        if (Math.abs(fromH - resize.startW) > Math.abs(nextW - resize.startW)) nextW = fromH;
      }

      let nextX = resize.originX;
      let nextY = resize.originY;
      const clampedW = clampVideoFloatWidth(
        isPlatformPlayer ? Math.max(YOUTUBE_MIN_W, nextW) : nextW,
        window.innerWidth,
        Math.max(1, window.innerHeight - (isPlatformPlayer ? YOUTUBE_EXTRA_H : 0)),
      );
      if (edge === "w" || edge === "nw" || edge === "sw") {
        nextX = resize.originX + (resize.startW - clampedW);
      }
      if (edge === "n" || edge === "ne" || edge === "nw") {
        nextY = resize.originY + (startH - videoFloatHeight(clampedW));
      }
      setFloatBox(
        clampHostFloatBox(
          { x: nextX, y: nextY, w: clampedW },
          window.innerWidth,
          window.innerHeight,
          session,
        ),
      );
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setFloatBox(
      clampHostFloatBox(
        { x: drag.originX + dx, y: drag.originY + dy, w: floatBox.w },
        window.innerWidth,
        window.innerHeight,
        session,
      ),
    );
  };

  const onDragPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    try {
      floatRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onResizePointerDown = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || videoFullscreen) return;
    const node = floatRef.current;
    if (!node) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startW: floatBox.w,
      originX: floatBox.x,
      originY: floatBox.y,
    };
    node.setPointerCapture(event.pointerId);
  };

  const title = session?.title || "视频预览";

  return (
    <div
      className="kd-pip-host"
      data-floating={showFloating ? "true" : undefined}
      data-idle={!hostActive ? "true" : undefined}
    >
      <div
        ref={showFloating ? floatRef : undefined}
        className={showFloating ? "kd-pip-float" : "kd-pip-shell"}
        data-fullscreen={showFloating && videoFullscreen ? "true" : undefined}
        data-platform-player={showFloating && isPlatformPlayer ? "true" : undefined}
        style={
          showFloating
            ? {
                left: floatBox.x,
                top: floatBox.y,
                width: floatBox.w,
                ...(isPlatformPlayer && !videoFullscreen
                  ? { height: videoFloatHeight(floatBox.w) + YOUTUBE_EXTRA_H }
                  : {}),
              }
            : undefined
        }
        onPointerDown={showFloating ? onDragPointerDown : undefined}
        onPointerMove={showFloating ? onDragPointerMove : undefined}
        onPointerUp={showFloating ? onDragPointerUp : undefined}
        onPointerCancel={showFloating ? onDragPointerUp : undefined}
      >
        <div className="kd-pip-float-stage">
          {isPlatformPlayer && (
            <div
              ref={youtubeEmbedSlotRef}
              className="kd-pip-platform-native-slot"
              aria-hidden="true"
            />
          )}
          <video
            ref={localSwap.bindVideo(0)}
            className="kd-pip-video"
            data-swap-slot="true"
            data-active={localSwap.activeSlot === 0 ? "true" : undefined}
            crossOrigin="anonymous"
            playsInline
            preload={isLocal ? "auto" : "metadata"}
            muted={isLocal}
          />
          <video
            ref={localSwap.bindVideo(1)}
            className="kd-pip-video"
            data-swap-slot="true"
            data-active={localSwap.activeSlot === 1 ? "true" : undefined}
            crossOrigin="anonymous"
            playsInline
            preload={isLocal ? "auto" : "none"}
            muted
          />
          <canvas ref={pipCanvasRef} className="kd-pip-compositor" aria-hidden="true" />
          <video
            ref={pipVideoRef}
            className="kd-pip-compositor"
            controls
            muted
            playsInline
            aria-hidden="true"
          />
          {showFloating && (
            <div className="kd-pip-float-chrome" title={title}>
              <div className="kd-pip-float-top">
                <span className="kd-truncate">{title}</span>
                <button
                  type="button"
                  className="kd-pip-float-x"
                  aria-label="关闭预览"
                  onClick={(event) => {
                    event.stopPropagation();
                    close();
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="kd-pip-float-bottom">
                <button
                  type="button"
                  aria-label={playing ? "暂停" : "播放"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle();
                  }}
                >
                  {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
                </button>
                <span className="kd-mono">
                  {formatDuration(position)} / {formatDuration(duration)}
                </span>
                <button
                  type="button"
                  aria-label={videoFullscreen ? "退出全屏" : "全屏播放"}
                  aria-pressed={videoFullscreen}
                  title={videoFullscreen ? "退出全屏（Esc）" : "全屏播放"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void applyVideoFullscreen(!videoFullscreen);
                  }}
                >
                  {videoFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
                {!isPlatformPlayer && canSystemPip() && (
                  <button
                    type="button"
                    aria-label="系统画中画"
                    title="系统画中画（切走应用时也会自动打开）"
                  onClick={(event) => {
                    event.stopPropagation();
                      const video = systemPipTarget();
                      if (!video) return;
                      void (async () => {
                        if (fullscreenRef.current) await applyVideoFullscreen(false);
                        await enterSystemPip(video);
                      })();
                    }}
                  >
                    <PictureInPicture2 size={13} />
                  </button>
                )}
              </div>
              {error && <div className="kd-pip-float-error">{error}</div>}
            </div>
          )}
          {/* 进度条独立于 chrome：不悬停也看得见、可拖；本地会同步拽主条音轨 */}
          {showFloating && !isPlatformPlayer && (
            <div
              className="kd-pip-float-scrub"
              role="slider"
              aria-label="视频进度"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={position}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                scrubFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                event.stopPropagation();
                scrubFromPointer(event);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                const at = pendingScrubRef.current;
                pendingScrubRef.current = null;
                if (at !== null) seekTo(at, true);
              }}
              onPointerCancel={() => {
                pendingScrubRef.current = null;
                const current = useVideoPip.getState().session;
                const video = activeVideo();
                if (current?.source === "local" && video) {
                  window.dispatchEvent(
                    new CustomEvent<SeekDetail>(SEEK_EVENT, {
                      detail: {
                        trackId: current.trackId,
                        position: video.currentTime,
                        preview: true,
                        scrubbing: false,
                      },
                    }),
                  );
                }
              }}
            >
              <span
                className="kd-pip-float-scrub-fill"
                style={{
                  width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%`,
                }}
              />
            </div>
          )}
          {showFloating &&
            RESIZE_EDGES.filter((edge) => !isPlatformPlayer || edge === "se").map((edge) => (
              <span
                key={edge}
                className="kd-pip-resize"
                data-edge={edge}
                aria-hidden="true"
                onPointerDown={onResizePointerDown(edge)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
