import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FloatingVideoControls, FloatingVideoScrub } from "../player/FloatingVideoControls";
import { api } from "../../lib/api";
import {
  AUDIO_FOCUS_EVENT,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import {
  broadcastMediaSync,
  getLatestPlayerSync,
  getLocalVideoClock,
  subscribeLocalVideoClock,
  usesLocalVideoDeviceClock,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import {
  VideoPlaybackEngine,
  applyLocalVideoClock,
  VideoSeekEchoGuard,
  VideoTransportEchoGuard,
} from "../../lib/videoPlaybackEngine";
import { useLocalVideoSwap } from "../../lib/useLocalVideoSwap";
import { ensureProjectLive, useKdjvLive } from "../../lib/kdjvPlay";
import { isProjectTrack } from "../../lib/format";
import { KdjvLivePicture } from "../player/KdjvLivePicture";
import { KdjvMpvPicture } from "../player/KdjvMpvPicture";
import { PanelErrorBoundary } from "../RootErrorBoundary";
import { playTrack } from "./TrackTable";
import {
  MpvVideoController,
  SeekHold,
  nativeSlotBounds,
  trackNativeSlot,
  useMpvAvailable,
  webVideoOff,
  type MpvBounds,
  type MpvClock,
} from "../../lib/mpvPlayer";
import { tracePlayback } from "../../lib/playbackTrace";
import { useAppStore } from "../../stores/appStore";
import type { Track } from "../../types";

const VIDEO_SWAP_SLOTS = [0, 1] as const;

function mpvClock(trackId: number): MpvClock | null {
  const clock = getLocalVideoClock(trackId);
  return clock ? { position: clock.position, rate: clock.rate, playing: clock.playing } : null;
}

export function LocalVideoPlayer({ track, hidden = false }: { track: Track; hidden?: boolean }) {
  const desiredPlayingRef = useRef(false);
  // 程序化 play/pause 会异步冒泡同名事件；挡住它们的 transport 回传。
  // seeked 另用按元素+落点匹配的 guard，不能用这把总闸，否则刚起播时用户点
  // 原生进度条也会一起被吞掉。
  const suppressSyncRef = useRef(false);
  const suppressGenerationRef = useRef(0);
  const suppressTokensRef = useRef(new Set<number>());
  const userSeekTimerRef = useRef(0);
  const synchronizerRef = useRef<VideoPlaybackEngine | null>(null);
  const videoSeekEchoGuardRef = useRef<VideoSeekEchoGuard | null>(null);
  const videoTransportEchoGuardRef = useRef<VideoTransportEchoGuard | null>(null);
  if (!synchronizerRef.current) synchronizerRef.current = new VideoPlaybackEngine();
  if (!videoSeekEchoGuardRef.current) videoSeekEchoGuardRef.current = new VideoSeekEchoGuard();
  if (!videoTransportEchoGuardRef.current) {
    videoTransportEchoGuardRef.current = new VideoTransportEchoGuard();
  }
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(track.duration ?? 0);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const fullscreenPending = useRef(false);
  const scrubPosition = useRef<number | null>(null);
  const setVideoFullscreen = async (next: boolean) => {
    if (fullscreenPending.current) return;
    fullscreenPending.current = true;
    try {
      await getCurrentWindow().setFullscreen(next);
      fullscreenRef.current = next;
      setFullscreen(next);
    } catch (reason) { setError(String(reason)); }
    finally { fullscreenPending.current = false; }
  };
  useEffect(() => {
    let alive = true;
    let unlistenResize: (() => void) | undefined;
    void getCurrentWindow().onResized(() => {
      if (!fullscreenRef.current || fullscreenPending.current) return;
      void getCurrentWindow().isFullscreen().then(value => {
        if (alive && !value) { fullscreenRef.current = false; setFullscreen(false); }
      }).catch(() => {});
    }).then(stop => { if (alive) unlistenResize = stop; else stop(); }).catch(() => {});
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !fullscreenRef.current || event.defaultPrevented) return;
      event.preventDefault();
      void setVideoFullscreen(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      alive = false;
      unlistenResize?.();
      window.removeEventListener("keydown", escape);
      if (fullscreenRef.current) void getCurrentWindow().setFullscreen(false).catch(() => {});
    };
  }, []);
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(track.duration ?? 0);
    scrubPosition.current = null;
  }, [track.id]);
  // A project playing from its sound is drawn live (KdjvLivePicture): there is no file to load,
  // and these elements neither prepare its seeks nor follow its clock.
  const live = useKdjvLive(state => state.live[track.id]);
  // A project is never loaded as a video, also before its live picture is there (ensureProjectLive).
  const project = isProjectTrack(track.format);
  // The picture plays in mpv's native view when the build carries libmpv (mpvPlayer.ts); the
  // WebView elements below stay for builds without it, the web setting and a file mpv refuses.
  const mpvReady = useMpvAvailable();
  const videoPlayer = useAppStore(state => state.settings?.video_player ?? "mpv");
  const [mpvRefused, setMpvRefused] = useState<number | null>(null);
  // macOS: always mpv, no WebView fallback (webVideoOff); a refused file shows its error.
  const useMpv = (webVideoOff() || (mpvReady && videoPlayer === "mpv" && mpvRefused !== track.id))
    && !hidden && !live && !project && usesLocalVideoDeviceClock();
  // A project's live picture drawn by mpv (KdjvMpvPicture) needs the same outside controls.
  const liveNative = Boolean(live) && !hidden && webVideoOff();
  const nativeChrome = useMpv || liveNative;
  const mpvSlotRef = useRef<HTMLDivElement | null>(null);
  const mpvRef = useRef<MpvVideoController | null>(null);
  const seekHold = useRef(new SeekHold());
  const [overlay, setOverlay] = useState<(MpvBounds & { shown: boolean }) | null>(null);
  const localSwap = useLocalVideoSwap({
    enabled: !hidden && !live && !project && !useMpv,
    trackId: hidden || live || project || useMpv ? null : track.id,
    desiredPlayingRef,
    getRate: () => getLocalVideoClock(track.id)?.rate ?? getLatestPlayerSync(track.id)?.rate ?? 1,
    onActivate: (video) => {
      setPlaying(!video.paused);
      if (scrubPosition.current === null) setPosition(video.currentTime);
      if (Number.isFinite(video.duration)) setDuration(video.duration);
      const clock = getLocalVideoClock(track.id);
      if (clock) synchronizerRef.current?.adoptClock(video, clock);
      else synchronizerRef.current?.reset();
    },
    transportEchoGuard: videoTransportEchoGuardRef.current,
  });
  const activeVideo = localSwap.activeVideo;

  const withSuppressed = (run: () => void, holdMs = 0) => {
    const generation = ++suppressGenerationRef.current;
    suppressTokensRef.current.add(generation);
    suppressSyncRef.current = true;
    run();
    const video = activeVideo();
    const release = () => {
      video?.removeEventListener("seeked", release);
      // target 上的原生媒体 listener 先于 React 委托事件执行；延后一拍再松 transport
      // 闸门，保证同一次程序化操作的 play/pause 尾沿不会回传。seeked 的来源由上面
      // 按元素和目标位置匹配的 guard 单独判断，不再依赖这把总闸。
      queueMicrotask(() => {
        suppressTokensRef.current.delete(generation);
        suppressSyncRef.current = suppressTokensRef.current.size > 0;
      });
    };
    if (holdMs > 0) {
      video?.addEventListener("seeked", release, { once: true });
      window.setTimeout(release, holdMs);
    } else {
      release();
    }
  };

  const alignVideo = (video: HTMLVideoElement, position: number) => {
    videoSeekEchoGuardRef.current?.mark(video, position);
    video.currentTime = position;
  };

  useEffect(
    () => {
      synchronizerRef.current?.reset(activeVideo());
      videoSeekEchoGuardRef.current?.clear();
      return () => {
        window.clearTimeout(userSeekTimerRef.current);
        synchronizerRef.current?.reset(activeVideo());
        videoSeekEchoGuardRef.current?.clear();
      };
    },
    [track.id],
  );

  useEffect(
    () => () => {
      synchronizerRef.current?.dispose();
      videoSeekEchoGuardRef.current?.clear();
      videoTransportEchoGuardRef.current?.clear();
    },
    [],
  );

  useEffect(() => {
    if (live) { localSwap.unload(); setDuration(live.duration); return; }
    if (project) { localSwap.unload(); ensureProjectLive(track.id); return; }
    if (useMpv) { localSwap.unload(); return; }
    localSwap.load(`local:${track.id}`, api.videoUrl(track.id));
  }, [localSwap.load, localSwap.unload, track.id, live, project, useMpv]);

  // mpv: one native view on the slot, following the song's clock; kept on the slot while the
  // panel scrolls or resizes, hidden while any of it is out of sight.
  useEffect(() => {
    const slot = mpvSlotRef.current;
    if (!useMpv || !slot) return;
    const trackId = track.id;
    const first = nativeSlotBounds(slot);
    const controller = new MpvVideoController({
      url: api.videoUrl(trackId),
      follow: true,
      bounds: first.bounds,
      volume: 0,
      start: mpvClock(trackId)?.position ?? getLatestPlayerSync(trackId)?.position ?? 0,
      paused: true,
      onStatus: status => {
        if (scrubPosition.current === null && seekHold.current.accept(status.position)) setPosition(status.position);
        if (status.duration > 0) setDuration(status.duration);
        setPlaying(status.playing);
      },
      onError: reason => {
        tracePlayback("mpv-fallback", { track: trackId, error: reason.message });
        setError(`视频无法播放：${reason.message}`);
        setMpvRefused(trackId);
      },
    });
    mpvRef.current = controller;
    void controller.done.then(() => controller.follow(mpvClock(trackId))).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(`视频无法播放：${reason instanceof Error ? reason.message : String(reason)}`);
      setMpvRefused(trackId);
    });
    // The overlay of controls follows the slot in its own effect below.
    const stop = trackNativeSlot(slot, (bounds, visible, state) => {
      // Covered or out of sight: at once. Scrolled: after the overlay's veil has faded in.
      void controller.setBounds(bounds, visible, undefined, state === "covered" || state === "out").catch(() => undefined);
    });
    return () => {
      stop();
      controller.dispose();
      if (mpvRef.current === controller) mpvRef.current = null;
    };
  }, [useMpv, track.id]);

  // mpv's picture (the file's, or a project's clips) shows through a hole in #root: the controls
  // draw over it from outside #root, on the slot's rectangle, and go with the picture.
  useEffect(() => {
    const slot = mpvSlotRef.current;
    if (!nativeChrome || !slot) return;
    // While it scrolls the overlay stays, veiled; covered or out of sight it goes (it would lie
    // over what covers the slot).
    const stop = trackNativeSlot(slot, (bounds, visible, state) =>
      setOverlay(visible || state === "moving" ? { ...bounds, shown: visible } : null));
    return () => { stop(); setOverlay(null); };
  }, [nativeChrome, track.id]);

  useEffect(() => {
    if (!useMpv) return;
    const apply = () => {
      if (scrubPosition.current === null) mpvRef.current?.follow(mpvClock(track.id));
    };
    const unsubscribe = subscribeLocalVideoClock(track.id, apply);
    apply();
    return unsubscribe;
  }, [useMpv, track.id]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "song" || owner === "preview") activeVideo()?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    if (hidden || live || project || useMpv || !usesLocalVideoDeviceClock()) return;
    const apply = () => {
      const video = activeVideo();
      if (!video || localSwap.isHoldingPosition()) return;
      const clock = getLocalVideoClock(track.id);
      if (clock) desiredPlayingRef.current = clock.playing;
      applyLocalVideoClock(video, clock, synchronizerRef.current!, videoSeekEchoGuardRef.current!, videoTransportEchoGuardRef.current!,
        () => localSwap.correctClock(synchronizerRef.current!));
    };
    const unsubscribe = subscribeLocalVideoClock(track.id, apply);
    const video = activeVideo();
    video?.addEventListener("loadeddata", apply);
    video?.addEventListener("seeked", apply);
    apply();
    return () => { unsubscribe(); video?.removeEventListener("loadeddata", apply); video?.removeEventListener("seeked", apply); };
  }, [track.id, hidden, Boolean(live), project, localSwap.activeSlot, useMpv]);

  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== track.id) return;
      // Native transport intent/pinned UI positions are not decoded audio positions. The DAC
      // subscription owns video alignment and transport, including post-seek catch-up.
      if (usesLocalVideoDeviceClock()) return;
      const video = activeVideo();
      if (!video) return;
      const synchronizer = synchronizerRef.current;
      const rate = detail.rate ?? 1;
      if (detail.action === "play") {
        desiredPlayingRef.current = true;
        const target = detail.position;
        if (synchronizer && Number.isFinite(target)) {
          synchronizer.sync(
            video,
            target as number,
            "explicit",
            rate,
            (element, position) => {
              withSuppressed(() => {
                alignVideo(element, position);
              }, 800);
            },
          );
        } else {
          synchronizer?.setBaseRate(video, rate);
        }
        withSuppressed(() => {
          void video.play().catch(() => undefined);
        }, 200);
      } else if (detail.action === "pause") {
        desiredPlayingRef.current = false;
        synchronizer?.setBaseRate(video, rate);
        withSuppressed(() => {
          video.pause();
        }, 100);
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (!Number.isFinite(target) || !synchronizer) return;
        synchronizer.sync(
          video,
          target,
          detail.action === "seek" ? "explicit" : "heartbeat",
          rate,
          (element, position) => {
            withSuppressed(() => {
              alignVideo(element, position);
            }, 800);
          },
        );
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [track.id]);

  // 详情面板常常是在播放器已经开始之后才挂上来的。接上缓存的播放器状态，
  // 让视频从当前音频位置开始静音播放，而不是因为 preload=none 停在封面上。
  // 这里只在面板挂载时做一次，不会因为每个 position 事件重新 load 视频。
  useEffect(() => {
    if (usesLocalVideoDeviceClock()) return;
    const video = activeVideo();
    const state = getLatestPlayerSync(track.id);
    if (!video || !state) return;
    const position = state.position;
    const startAt = Number.isFinite(position) ? Math.max(0, position as number) : 0;
    const rate = state.rate ?? 1;
    if (state.action === "play") {
      desiredPlayingRef.current = true;
      const start = () => {
        const current = getLatestPlayerSync(track.id);
        if (!current) return;
        desiredPlayingRef.current = current.action === "play";
        withSuppressed(() => {
          synchronizerRef.current?.sync(video, current.position ?? 0, "explicit", current.rate ?? 1, alignVideo);
          if (desiredPlayingRef.current) void video.play().catch(() => undefined);
          else video.pause();
        }, 800);
      };
      video.addEventListener("loadedmetadata", start, { once: true });
      video.load();
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) start();
      return () => video.removeEventListener("loadedmetadata", start);
    }
    desiredPlayingRef.current = false;
    if (Number.isFinite(position)) {
      withSuppressed(() => {
        synchronizerRef.current?.sync(video, startAt, "explicit", rate, alignVideo);
      }, 800);
    }
  }, [track.id]);

  const seek = (at: number) => {
    const position = Math.max(0, Math.min(duration, at));
    seekHold.current.set(position);
    setPosition(position);
    broadcastMediaSync({ owner: "local-video", action: "seek", trackId: track.id, position });
  };
  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    scrubPosition.current = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
    setPosition(scrubPosition.current);
    // mpv shows the dragged spot at once; the song seeks on release and the picture follows it.
    mpvRef.current?.follow({ position: scrubPosition.current, rate: 0, playing: false });
  };
  const finishScrub = () => {
    const at = scrubPosition.current;
    scrubPosition.current = null;
    if (at !== null) seek(at);
  };

  const controls = <>
          <FloatingVideoControls title={track.title || track.filename} showTitle={false} playing={playing}
            position={position} duration={duration} fullscreen={fullscreen}
            onToggle={() => {
              if (playing) broadcastMediaSync({ owner: "local-video", action: "pause", trackId: track.id });
              else {
                playTrack(track);
                broadcastMediaSync({ owner: "local-video", action: "play", trackId: track.id });
              }
            }} onFullscreen={() => void setVideoFullscreen(!fullscreen)} />
          <FloatingVideoScrub position={position} duration={duration}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); scrub(event);
            }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event); }}
            onPointerUp={event => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              scrub(event); finishScrub(); event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { scrubPosition.current = null; }}
            onLostPointerCapture={() => { scrubPosition.current = null; }}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              seek(event.key === "Home" ? 0 : event.key === "End" ? duration : position + (event.key === "ArrowRight" ? 5 : -5));
            }} />
  </>;

  return (
    <div
      className="kd-local-video"
      aria-hidden={hidden}
      style={
        hidden
          ? {
              position: "fixed",
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
              overflow: "hidden",
            }
          : undefined
      }
    >
      <div className="kd-preview-frame kd-pip-float" data-fullscreen={fullscreen || undefined}
        data-native-player={nativeChrome || undefined}
        // Keep the viewport stable while switching sources; native frames are contain-fitted.
        style={{ "--kd-preview-ratio": 16 / 9, aspectRatio: fullscreen ? "auto" : "16 / 9" } as CSSProperties}>
        {nativeChrome && <div ref={mpvSlotRef} className="kd-pip-native-slot" aria-hidden="true" />}
        {VIDEO_SWAP_SLOTS.map((slot) => (
          <video
            key={slot}
            ref={localSwap.bindVideo(slot)}
            className="kd-local-video-swap"
            data-active={localSwap.activeSlot === slot ? "true" : undefined}
            controls={false}
            crossOrigin="anonymous"
            muted
            playsInline
            preload={hidden ? "none" : "auto"}
            poster={api.coverUrl(track.id, track.modified_at)}
            onTimeUpdate={event => {
              if (localSwap.isActiveVideo(event.currentTarget) && scrubPosition.current === null) setPosition(event.currentTarget.currentTime);
            }}
            onDurationChange={event => {
              if (localSwap.isActiveVideo(event.currentTarget) && Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration);
            }}
            onPlay={(event) => {
              if (localSwap.isActiveVideo(event.currentTarget)) setPlaying(true);
              if (videoTransportEchoGuardRef.current?.consume(event.currentTarget, "play")) return;
              if (!localSwap.isActiveVideo(event.currentTarget)) return;
              setError("");
              // 后台实例只跟时钟，不回传、不抢播入口，避免双实例互拽。
              if (hidden || suppressSyncRef.current) return;
              desiredPlayingRef.current = true;
              // 视频控件是本地视频的播放入口；让播放器加载同一曲目的音轨，
              // 之后由播放器时钟持续校正视频，避免两条媒体各自漂移。
              playTrack(track);
              broadcastMediaSync({ owner: "local-video", action: "play", trackId: track.id });
            }}
            onPause={(event) => {
              if (localSwap.isActiveVideo(event.currentTarget)) setPlaying(false);
              if (videoTransportEchoGuardRef.current?.consume(event.currentTarget, "pause")) return;
              if (!localSwap.isActiveVideo(event.currentTarget)) return;
              if (hidden || suppressSyncRef.current) return;
              desiredPlayingRef.current = false;
              broadcastMediaSync({ owner: "local-video", action: "pause", trackId: track.id });
            }}
            onSeeked={(event) => {
              if (!localSwap.isActiveVideo(event.currentTarget)) return;
              if (hidden) return;
              const position = event.currentTarget.currentTime;
              if (videoSeekEchoGuardRef.current?.consume(event.currentTarget, position)) return;
              // 原生视频控件快速拖动会连续落地多个 seeked。双 Deck 若逐个接手，前一个
              // 目标刚起音就被后一个目标再起一次，形成约 0.1 秒间隔的“哒哒”声。
              window.clearTimeout(userSeekTimerRef.current);
              userSeekTimerRef.current = window.setTimeout(() => {
                broadcastMediaSync({
                  owner: "local-video",
                  action: "seek",
                  trackId: track.id,
                  position,
                });
              }, 80);
            }}
            onError={(event) => {
              if (localSwap.isActiveVideo(event.currentTarget)) {
                setError("这个视频容器或编码暂不受系统 WebView 支持");
              }
            }}
          />
        ))}
        {live && !hidden && (
          <PanelErrorBoundary name="工程画面" turn={track.id}>
            {webVideoOff()
              ? <KdjvMpvPicture trackId={track.id} project={live} onTransport={transport => {
                  if (scrubPosition.current === null) setPosition(transport.position);
                  setPlaying(transport.playing);
                }} />
              : <KdjvLivePicture trackId={track.id} project={live} onTransport={transport => {
                  if (scrubPosition.current === null) setPosition(transport.position);
                  setPlaying(transport.playing);
                }} />}
          </PanelErrorBoundary>
        )}
        {!hidden && !nativeChrome && controls}
      </div>
      {error && !hidden && <p className="kd-djp-note">{error}</p>}
      {/* mpv's picture shows through a hole in #root, which would cut controls inside it away:
          they draw over the picture from outside #root, on the slot's rectangle. */}
      {nativeChrome && overlay && createPortal(
        <div className="kd-pip-float kd-native-overlay" data-native-player="true" data-fullscreen={fullscreen || undefined}
          style={{ left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height }}>
          <div className="kd-native-veil" aria-hidden="true" data-shown={overlay.shown ? "true" : undefined} />
          {controls}
        </div>,
        document.body,
      )}
    </div>
  );
}
