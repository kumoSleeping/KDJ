import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  AUDIO_FOCUS_EVENT,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import {
  broadcastMediaSync,
  getLatestPlayerSync,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import {
  LocalVideoSynchronizer,
  VideoSeekEchoGuard,
  VideoTransportEchoGuard,
} from "../../lib/localVideoSync";
import { useLocalVideoSwap } from "../../lib/useLocalVideoSwap";
import { playTrack } from "./TrackTable";
import type { Track } from "../../types";

const VIDEO_SWAP_SLOTS = [0, 1] as const;

export function LocalVideoPlayer({ track, hidden = false }: { track: Track; hidden?: boolean }) {
  const desiredPlayingRef = useRef(false);
  // 程序化 play/pause 会异步冒泡同名事件；挡住它们的 transport 回传。
  // seeked 另用按元素+落点匹配的 guard，不能用这把总闸，否则刚起播时用户点
  // 原生进度条也会一起被吞掉。
  const suppressSyncRef = useRef(false);
  const suppressGenerationRef = useRef(0);
  const suppressTokensRef = useRef(new Set<number>());
  const userSeekTimerRef = useRef(0);
  const synchronizerRef = useRef<LocalVideoSynchronizer | null>(null);
  const videoSeekEchoGuardRef = useRef<VideoSeekEchoGuard | null>(null);
  const videoTransportEchoGuardRef = useRef<VideoTransportEchoGuard | null>(null);
  if (!synchronizerRef.current) synchronizerRef.current = new LocalVideoSynchronizer();
  if (!videoSeekEchoGuardRef.current) videoSeekEchoGuardRef.current = new VideoSeekEchoGuard();
  if (!videoTransportEchoGuardRef.current) {
    videoTransportEchoGuardRef.current = new VideoTransportEchoGuard();
  }
  const [error, setError] = useState("");
  const localSwap = useLocalVideoSwap({
    enabled: !hidden,
    trackId: hidden ? null : track.id,
    desiredPlayingRef,
    getRate: () => getLatestPlayerSync(track.id)?.rate ?? 1,
    onActivate: (video) => synchronizerRef.current?.reset(video),
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
    localSwap.load(`local:${track.id}`, api.videoUrl(track.id));
  }, [localSwap.load, track.id]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "song" || owner === "preview") activeVideo()?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== track.id) return;
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
    const video = activeVideo();
    const state = getLatestPlayerSync(track.id);
    if (!video || !state) return;
    const position = state.position;
    const startAt = Number.isFinite(position) ? Math.max(0, position as number) : 0;
    const rate = state.rate ?? 1;
    if (state.action === "play") {
      desiredPlayingRef.current = true;
      const start = () => {
        withSuppressed(() => {
          synchronizerRef.current?.sync(video, startAt, "explicit", rate, alignVideo);
          void video.play().catch(() => undefined);
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
      <div className="kd-preview-frame">
        {VIDEO_SWAP_SLOTS.map((slot) => (
          <video
            key={slot}
            ref={localSwap.bindVideo(slot)}
            className="kd-local-video-swap"
            data-active={localSwap.activeSlot === slot ? "true" : undefined}
            controls={!hidden && localSwap.activeSlot === slot}
            crossOrigin="anonymous"
            muted
            playsInline
            preload={hidden ? "none" : "auto"}
            poster={api.coverUrl(track.id, track.modified_at)}
            onPlay={(event) => {
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
      </div>
      {error && !hidden && <p className="kd-djp-note">{error}</p>}
    </div>
  );
}
