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
import { playTrack } from "./TrackTable";
import type { Track } from "../../types";

/** 累计漂移超过这个才纠偏。太紧会每几百毫秒 seek 一次，画面就一卡一卡。 */
const DRIFT_SEC = 0.4;
/** 两次纠偏最短间隔，避免 seek 落地还没稳又被下一次 position 推开。 */
const CORRECT_MIN_MS = 500;

export function LocalVideoPlayer({ track, hidden = false }: { track: Track; hidden?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 程序化 seek/play/pause 会异步冒泡 seeked/play/pause；挡住回传，
  // 否则视频会把纠偏当作用户拖动，反过来拽音频时钟，形成卡顿环。
  const suppressSyncRef = useRef(false);
  const suppressGenerationRef = useRef(0);
  const lastCorrectAtRef = useRef(0);
  const userSeekTimerRef = useRef(0);
  const [error, setError] = useState("");

  const withSuppressed = (run: () => void, holdMs = 0) => {
    const generation = ++suppressGenerationRef.current;
    suppressSyncRef.current = true;
    run();
    const video = videoRef.current;
    const release = () => {
      video?.removeEventListener("seeked", release);
      // target 上的原生 seeked listener 先于 React 的委托 onSeeked 执行。这里若
      // 同步清 ref，React 随后会把程序化纠偏误认成用户 seek，再命令音频跳一次；
      // 那个第二次起音正好晚一个视频 seek 落地时间，听起来就是约 0.1 秒的“哒哒”。
      queueMicrotask(() => {
        if (suppressGenerationRef.current === generation) suppressSyncRef.current = false;
      });
    };
    if (holdMs > 0) {
      video?.addEventListener("seeked", release, { once: true });
      window.setTimeout(release, holdMs);
    } else {
      release();
    }
  };

  useEffect(
    () => () => {
      window.clearTimeout(userSeekTimerRef.current);
    },
    [track.id],
  );

  useEffect(() => {
    const onFocus = (event: Event) => {
      const owner = (event as CustomEvent<AudioFocusDetail>).detail.owner;
      if (owner === "song" || owner === "preview") videoRef.current?.pause();
    };
    window.addEventListener(AUDIO_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(AUDIO_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    const onMediaSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player" || detail.trackId !== track.id) return;
      const video = videoRef.current;
      if (!video) return;
      if (detail.action === "play") {
        withSuppressed(() => {
          void video.play().catch(() => undefined);
        }, 200);
      } else if (detail.action === "pause") {
        withSuppressed(() => {
          video.pause();
        }, 100);
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (!Number.isFinite(target)) return;
        const drift = Math.abs(video.currentTime - target);
        // 用户显式 seek：立刻跟上；position 心跳：只在双方都在播且明显漂移时纠偏。
        // 视频已暂停时跟着音频心跳 seek，只会把静止画面拽得一卡一卡。
        if (detail.action === "position") {
          if (video.paused) return;
          if (drift <= DRIFT_SEC) return;
          const now = performance.now();
          if (now - lastCorrectAtRef.current < CORRECT_MIN_MS) return;
          lastCorrectAtRef.current = now;
        } else if (drift <= 0.05) {
          return;
        }
        withSuppressed(() => {
          video.currentTime = Math.max(0, target);
        }, 500);
      }
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onMediaSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onMediaSync);
  }, [track.id]);

  // 详情面板常常是在播放器已经开始之后才挂上来的。接上缓存的播放器状态，
  // 让视频从当前音频位置开始静音播放，而不是因为 preload=none 停在封面上。
  // 这里只在面板挂载时做一次，不会因为每个 position 事件重新 load 视频。
  useEffect(() => {
    const video = videoRef.current;
    const state = getLatestPlayerSync(track.id);
    if (!video || !state) return;
    const position = state.position;
    const startAt = Number.isFinite(position) ? Math.max(0, position as number) : 0;
    if (state.action === "play") {
      const start = () => {
        withSuppressed(() => {
          video.currentTime = startAt;
          void video.play().catch(() => undefined);
        }, 500);
      };
      video.addEventListener("loadedmetadata", start, { once: true });
      video.load();
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) start();
      return () => video.removeEventListener("loadedmetadata", start);
    }
    if (Number.isFinite(position)) {
      withSuppressed(() => {
        video.currentTime = startAt;
      }, 500);
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
        <video
          ref={videoRef}
          controls={!hidden}
          muted
          playsInline
          preload={hidden ? "none" : "metadata"}
          poster={api.coverUrl(track.id, track.modified_at)}
          src={api.videoUrl(track.id)}
          onPlay={() => {
            setError("");
            // 后台实例只跟时钟，不回传、不抢播入口，避免双实例互拽。
            if (hidden || suppressSyncRef.current) return;
            // 视频控件是本地视频的播放入口；让播放器加载同一曲目的音轨，
            // 之后由播放器时钟持续校正视频，避免两条媒体各自漂移。
            playTrack(track);
            broadcastMediaSync({ owner: "local-video", action: "play", trackId: track.id });
          }}
          onPause={() => {
            if (hidden || suppressSyncRef.current) return;
            broadcastMediaSync({ owner: "local-video", action: "pause", trackId: track.id });
          }}
          onSeeked={(event) => {
            if (suppressSyncRef.current || hidden) return;
            const position = event.currentTarget.currentTime;
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
          onError={() => setError("这个视频容器或编码暂不受系统 WebView 支持")}
        />
      </div>
      {error && !hidden && <p className="kd-djp-note">{error}</p>}
    </div>
  );
}
