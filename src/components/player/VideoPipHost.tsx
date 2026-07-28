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
import type { Track } from "../../types";

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

function canSystemPip(): boolean {
  return typeof document !== "undefined" && document.pictureInPictureEnabled;
}

async function enterSystemPip(video: HTMLVideoElement): Promise<boolean> {
  if (!canSystemPip()) return false;
  try {
    if (document.pictureInPictureElement !== video) {
      await video.requestPictureInPicture();
    }
    useVideoPip.getState().setSystemPip(true);
    return true;
  } catch {
    useVideoPip.getState().setSystemPip(false);
    return false;
  }
}

async function exitSystemPip(video: HTMLVideoElement | null): Promise<void> {
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
  if (mode === "panel") {
    if (session.source === "network") {
      useAppStore.getState().openPreviewPanel();
    } else {
      if (useAppStore.getState().showPreview) useAppStore.getState().dismissOverlay();
      // 钉住曲目详情右栏（见 Workspace DETAIL_EVENT），别只清 overlay 却不展开
      window.dispatchEvent(new Event("kd:show-detail"));
    }
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
    useVideoPip.getState().setPlaying(false);
  };

  const ensureHostPlaying = (next: VideoPipSession) => {
    const video = videoRef.current;
    if (!video) return;
    const nextKey = sessionKey(next);
    const needLoad = loadedKeyRef.current !== nextKey;
    useVideoPip.getState().setError("");
    video.muted = next.source === "local";
    if (needLoad) {
      video.src = mediaUrl(next);
      video.load();
      loadedKeyRef.current = nextKey;
    }
    if (next.source === "network") announceAudioFocus("preview");
    void video
      .play()
      .then(() => useVideoPip.getState().setPlaying(true))
      .catch((reason: unknown) => {
        useVideoPip
          .getState()
          .setError(reason instanceof Error ? reason.message : String(reason));
        useVideoPip.getState().setPlaying(false);
      });
  };

  // 事件只负责写入 session；真正装 src / 出小窗交给下面的 effect，
  // 保证发生在 float DOM 提交之后。
  useEffect(() => {
    const onNetwork = (event: Event) => {
      const detail = (event as CustomEvent<VideoPreviewRequest>).detail;
      if (!detail?.bvid) return;
      const pip = useVideoPip.getState();
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
      const track = (event as CustomEvent<Track>).detail;
      if (!track || !Number.isFinite(track.id) || track.id <= 0) return;
      const pip = useVideoPip.getState();
      const next: VideoPipSession = {
        source: "local",
        trackId: track.id,
        title: track.title || track.filename,
        author: track.artist || "",
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
      if (!canSystemPip()) return;
      const pip = useVideoPip.getState();
      if (!pip.active || pip.mode !== "float" || pip.systemPip || !pip.playing) return;
      const video = videoRef.current;
      if (!video || video.paused) return;
      void enterSystemPip(video);
    };
    const scheduleAutoPip = () => {
      window.clearTimeout(hideTimer);
      // 短延迟：点标题栏 / 菜单时的瞬时失焦别误触
      hideTimer = window.setTimeout(() => {
        if (document.visibilityState === "hidden" || !document.hasFocus()) {
          maybeAutoPip();
        }
      }, 280);
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
      if (!video || !useVideoPip.getState().active) return;
      if (video.paused) {
        if (useVideoPip.getState().session?.source === "network") {
          announceAudioFocus("preview");
        }
        void video.play().catch(() => undefined);
      } else {
        video.pause();
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
        const target = detail.position;
        if (Number.isFinite(target) && Math.abs(video.currentTime - (target as number)) > 0.35) {
          video.currentTime = Math.max(0, target as number);
        }
        void video.play().catch(() => undefined);
      } else if (detail.action === "pause") {
        video.pause();
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (!Number.isFinite(target)) return;
        if (Math.abs(video.currentTime - target) > 0.35) {
          video.currentTime = Math.max(0, target);
        }
        // 主条在播而小窗因错过 play 事件停住时，靠 position 心跳拉起来
        if (detail.action === "position" && video.paused) {
          void video.play().catch(() => undefined);
        }
      }
    };
    const onSync = (event: Event) => {
      applySync((event as CustomEvent<MediaSyncDetail>).detail);
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    // PlayerBar 的 play 广播往往早于本监听挂上（兄弟节点 effect 顺序），
    // 和 LocalVideoPlayer 一样接一次缓存时钟。
    const latest = getLatestPlayerSync(trackId);
    if (latest) {
      const boot = () => applySync(latest);
      const video = videoRef.current;
      if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) boot();
      else {
        video?.addEventListener("loadedmetadata", boot, { once: true });
        // 源可能还没被 presentation effect 装上，下一帧再试
        requestAnimationFrame(boot);
      }
    }
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
  }, [isLocal, session]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "preview") return;
      // 本地小窗静音跟时钟，主播放条开声不该把它掐掉
      if (useVideoPip.getState().session?.source === "local") return;
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
    const onPlay = () => {
      if (useVideoPip.getState().session?.source === "network") {
        announceAudioFocus("preview");
      }
      useVideoPip.getState().setPlaying(true);
    };
    const onPause = () => useVideoPip.getState().setPlaying(false);
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
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
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
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (!isLocal) announceAudioFocus("preview");
      void video.play().catch((reason: unknown) => {
        useVideoPip
          .getState()
          .setError(reason instanceof Error ? reason.message : String(reason));
      });
    } else {
      video.pause();
    }
  };

  const seekTo = (at: number) => {
    const video = videoRef.current;
    const current = useVideoPip.getState().session;
    if (!video || !current || !Number.isFinite(at)) return;
    const next = Math.max(0, duration > 0 ? Math.min(duration, at) : at);
    video.currentTime = next;
    useVideoPip.getState().setPosition(next);
    if (current.source === "local") {
      // 小窗是静音跟时钟：拖进度要拽主条音轨，不然画面跳了声音还在旧位置
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
    seekTo(ratio * duration);
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
