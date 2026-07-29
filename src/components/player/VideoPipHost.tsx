/**
 * 网络 / 本地视频预览宿主。
 *
 * - network：自带声音，抢 preview 焦点
 * - local：静音小窗，画面跟主播放条音轨时钟走（和 LocalVideoPlayer 同一套）
 *
 * panel：网络→右栏 VideoPreview；本地→曲库详情（宿主停）
 * float：本组件出画；系统画中画由此处手动打开，或切走应用时自动打开
 *
 * 呈现由 session/active/mode 的 effect 驱动，而不是只在事件回调里 play 一次——
 * 否则 setSession 后首帧小窗还没挂上、或 MEDIA_SYNC 的 play 早于监听挂载时，
 * 本地视频会出现「有声音、没小窗」。
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, PictureInPicture2, Play, X } from "lucide-react";
import { api } from "../../lib/api";
import {
  AUDIO_FOCUS_EVENT,
  announceAudioFocus,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import { formatDuration } from "../../lib/format";
import {
  APPLY_VIDEO_MODE_EVENT,
  LOCAL_VIDEO_EVENT,
  VIDEO_PIP_SEEK_EVENT,
  VIDEO_PIP_TOGGLE_EVENT,
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

const FLOAT_MIN_W = 240;
const FLOAT_MAX_W = 720;
const FLOAT_DEFAULT_W = 352;

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function floatHeight(width: number): number {
  return (width * 9) / 16;
}

function clampFloatBox(
  x: number,
  y: number,
  w: number,
): { x: number; y: number; w: number } {
  const width = Math.min(FLOAT_MAX_W, Math.max(FLOAT_MIN_W, w));
  const height = floatHeight(width);
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxY = Math.max(8, window.innerHeight - height - 8);
  return {
    w: width,
    x: Math.min(maxX, Math.max(8, x)),
    y: Math.min(maxY, Math.max(8, y)),
  };
}

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
    ? `net:${session.bvid}#${session.page}`
    : `local:${session.trackId}`;
}

function mediaUrl(session: VideoPipSession): string {
  return session.source === "network"
    ? api.videoPreviewUrl(session.bvid, session.page)
    : api.videoUrl(session.trackId);
}

/** panel 档的旁路 UI（右栏 / 曲库详情），与宿主 <video> 启停分开。 */
function applyPanelChrome(session: VideoPipSession, mode: VideoPreviewMode): void {
  // 网络视频右栏预览面板暂时关闭：panel 档也退回浮动小窗，细项改在下载队列里配。
  if (mode === "panel" && session.source === "network") {
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const compatRetryKeyRef = useRef<string | null>(null);
  const desiredPlayingRef = useRef(false);
  const pendingScrubRef = useRef<number | null>(null);
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
  const [size, setSize] = useState({ w: FLOAT_DEFAULT_W });
  const [pos, setPos] = useState(() => defaultFloatPos(FLOAT_DEFAULT_W));

  const hostActive = Boolean(session && active && mode === "float");
  // 进了系统画中画就藏自研小窗，避免底下还留一块空壳
  const showFloating = Boolean(hostActive && !systemPip);
  const isLocal = session?.source === "local";
  const key = session ? sessionKey(session) : "";

  const stopHost = () => {
    const video = videoRef.current;
    void exitSystemPip(video);
    if (!video) return;
    video.pause();
    if (video.src) {
      video.removeAttribute("src");
      video.load();
    }
    loadedKeyRef.current = null;
    compatRetryKeyRef.current = null;
    desiredPlayingRef.current = false;
    useVideoPip.getState().setPlaying(false);
  };

  const ensureHostPlaying = (next: VideoPipSession) => {
    const video = videoRef.current;
    if (!video) return;
    const nextKey = sessionKey(next);
    const shouldPlay =
      desiredPlayingRef.current || next.source === "network" || next.autoPlay;
    desiredPlayingRef.current = shouldPlay;
    useVideoPip.getState().setError("");
    video.muted = next.source === "local";
    if (loadedKeyRef.current !== nextKey) {
      compatRetryKeyRef.current = null;
      video.src = mediaUrl(next);
      video.load();
      loadedKeyRef.current = nextKey;
    }
    if (!shouldPlay) {
      video.pause();
      useVideoPip.getState().setPlaying(false);
      return;
    }
    if (next.source === "network") announceAudioFocus("preview");
    void video.play().catch((reason: unknown) => {
      if (!desiredPlayingRef.current) return;
      const unsupported =
        (reason instanceof DOMException && reason.name === "NotSupportedError") ||
        video.error?.code === 4; // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      if (next.source === "local" && unsupported && compatRetryKeyRef.current !== nextKey) {
        compatRetryKeyRef.current = nextKey;
        loadedKeyRef.current = `${nextKey}:compat`;
        useVideoPip.getState().setError("正在转换为系统播放器兼容格式…");
        video.src = api.videoUrl(next.trackId, true);
        video.load();
        void video
          .play()
          .then(() => {
            if (!desiredPlayingRef.current) {
              video.pause();
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
      desiredPlayingRef.current = true;
      pip.setSession({
        source: "network",
        bvid: detail.bvid,
        page: detail.page,
        title: detail.title,
        author: detail.author,
        cover: detail.cover?.trim() || undefined,
      });
      applyPanelChrome(
        {
          source: "network",
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
      applyPanelChrome(pip.session, detail.mode);
      // host 启停由 [session, active, mode] effect 接手
    };
    window.addEventListener(APPLY_VIDEO_MODE_EVENT, onApply);
    return () => window.removeEventListener(APPLY_VIDEO_MODE_EVENT, onApply);
  }, []);

  // 核心：session 就绪且浮动档 → 装载并播放；否则拆掉宿主。
  // 系统画中画不走 mode，由小窗按钮 / 切走应用另行 requestPictureInPicture。
  // rAF：等 data-floating / .kd-pip-float 那帧样式落地，避免在 1×1 idle shell 里 play 后被 WebKit 丢掉。
  useEffect(() => {
    if (!session || !active || mode !== "float") {
      stopHost();
      return;
    }
    // 窗口尺寸可能在首次挂载后变了，出小窗时把位置夹回可视区
    setPos((prev) => {
      const height = (size.w * 9) / 16;
      const maxX = Math.max(8, window.innerWidth - size.w - 8);
      const maxY = Math.max(8, window.innerHeight - height - 8);
      return {
        x: Math.min(maxX, Math.max(8, prev.x)),
        y: Math.min(maxY, Math.max(8, prev.y)),
      };
    });
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
  }, [key, active, mode]);

  // 切走应用（窗口失焦 / 页面隐藏）时，默认把正在播的浮动预览送进系统画中画
  useEffect(() => {
    let hideTimer = 0;
    const maybeAutoPip = () => {
      const pip = useVideoPip.getState();
      if (!pip.active || pip.mode !== "float" || pip.systemPip || !pip.playing) return;
      const video = videoRef.current;
      if (!video || video.paused || !canSystemPip(video)) return;
      void enterSystemPip(video);
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
  }, []);

  useEffect(() => {
    const onSeek = (event: Event) => {
      const at = (event as CustomEvent<VideoPipSeekDetail>).detail?.position;
      const video = videoRef.current;
      if (!video || !Number.isFinite(at)) return;
      video.currentTime = Math.max(0, at as number);
      useVideoPip.getState().setPosition(video.currentTime);
    };
    const onToggle = () => {
      const video = videoRef.current;
      const current = useVideoPip.getState().session;
      if (!video || !current || !useVideoPip.getState().active) return;
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
      const video = videoRef.current;
      if (!video) return;
      if (detail.action === "play") {
        desiredPlayingRef.current = true;
        const target = detail.position;
        if (Number.isFinite(target) && Math.abs(video.currentTime - (target as number)) > 0.35) {
          video.currentTime = Math.max(0, target as number);
        }
        void video.play().catch(() => undefined);
      } else if (detail.action === "pause") {
        desiredPlayingRef.current = false;
        video.pause();
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (!Number.isFinite(target)) return;
        if (Math.abs(video.currentTime - target) > 0.35) {
          video.currentTime = Math.max(0, target);
        }
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
      const video = videoRef.current;
      if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) boot();
      else {
        video?.addEventListener("loadedmetadata", boot, { once: true });
        // 源可能还没被 presentation effect 装上，下一帧再试
        bootFrame = requestAnimationFrame(boot);
      }
    }
    return () => {
      window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
      if (boot) videoRef.current?.removeEventListener("loadedmetadata", boot);
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
      videoRef.current?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => useVideoPip.getState().setSystemPip(true);
    const onLeave = () => useVideoPip.getState().setSystemPip(false);
    const onWebKitPresentation = () => {
      const webkit = video as WebKitPipVideo;
      useVideoPip
        .getState()
        .setSystemPip(webkit.webkitPresentationMode === "picture-in-picture");
    };
    const onPlay = () => {
      const pip = useVideoPip.getState();
      if (pip.session?.source === "network") announceAudioFocus("preview");
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
    const onPause = () => {
      const pip = useVideoPip.getState();
      pip.setPlaying(false);
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
          (document.visibilityState === "hidden" || !document.hasFocus())) {
        void enterSystemPip(video).then(() => {
          if (desiredPlayingRef.current && video.paused) {
            void video.play().catch(() => undefined);
          }
        });
      }
    };
    const onTime = () => useVideoPip.getState().setPosition(video.currentTime);
    const onMeta = () =>
      useVideoPip
        .getState()
        .setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onEnded = () => useVideoPip.getState().setPlaying(false);
    const onError = () => {
      useVideoPip.getState().setPlaying(false);
      useVideoPip.getState().setError("视频预览加载失败");
    };
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKitPresentation);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKitPresentation);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, []);

  const close = () => {
    stopHost();
    useVideoPip.getState().clear();
    if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
  };

  const toggle = () => {
    window.dispatchEvent(new Event(VIDEO_PIP_TOGGLE_EVENT));
  };

  const seekTo = (at: number, syncPlayer = true) => {
    const video = videoRef.current;
    const current = useVideoPip.getState().session;
    if (!video || !current || !Number.isFinite(at)) return;
    const next = Math.max(0, duration > 0 ? Math.min(duration, at) : at);
    video.currentTime = next;
    useVideoPip.getState().setPosition(next);
    if (current.source === "local" && syncPlayer) {
      // 小窗是静音跟时钟：提交拖动时拽主条音轨，画面预览阶段不反复重建 Deck。
      broadcastMediaSync({
        owner: "local-video",
        action: "seek",
        trackId: current.trackId,
        position: next,
      });
    }
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
    if (event.button !== 0) return;
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
      originX: pos.x,
      originY: pos.y,
    };
    node.setPointerCapture(event.pointerId);
  };

  const onDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (resize && resize.pointerId === event.pointerId) {
      const dx = event.clientX - resize.startX;
      const dy = event.clientY - resize.startY;
      const startH = floatHeight(resize.startW);
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
      const clampedW = Math.min(FLOAT_MAX_W, Math.max(FLOAT_MIN_W, nextW));
      if (edge === "w" || edge === "nw" || edge === "sw") {
        nextX = resize.originX + (resize.startW - clampedW);
      }
      if (edge === "n" || edge === "ne" || edge === "nw") {
        nextY = resize.originY + (startH - floatHeight(clampedW));
      }
      const box = clampFloatBox(nextX, nextY, clampedW);
      setSize({ w: box.w });
      setPos({ x: box.x, y: box.y });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const box = clampFloatBox(drag.originX + dx, drag.originY + dy, size.w);
    setPos({ x: box.x, y: box.y });
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
    if (event.button !== 0) return;
    const node = floatRef.current;
    if (!node) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startW: size.w,
      originX: pos.x,
      originY: pos.y,
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
        style={
          showFloating
            ? { left: pos.x, top: pos.y, width: size.w }
            : undefined
        }
        onPointerDown={showFloating ? onDragPointerDown : undefined}
        onPointerMove={showFloating ? onDragPointerMove : undefined}
        onPointerUp={showFloating ? onDragPointerUp : undefined}
        onPointerCancel={showFloating ? onDragPointerUp : undefined}
      >
        <div className="kd-pip-float-stage">
          <video ref={videoRef} className="kd-pip-video" playsInline preload="auto" muted={isLocal} />
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
                {canSystemPip() && (
                  <button
                    type="button"
                    aria-label="系统画中画"
                    title="系统画中画（切走应用时也会自动打开）"
                    onClick={(event) => {
                      event.stopPropagation();
                      const video = videoRef.current;
                      if (video) void enterSystemPip(video);
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
          {showFloating && (
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
            RESIZE_EDGES.map((edge) => (
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
