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

export function LocalVideoPlayer({ track, hidden = false }: { track: Track; hidden?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const suppressSyncEventRef = useRef(false);
  const [error, setError] = useState("");

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
        suppressSyncEventRef.current = true;
        void video.play().catch(() => undefined).finally(() => {
          suppressSyncEventRef.current = false;
        });
      } else if (detail.action === "pause") {
        suppressSyncEventRef.current = true;
        video.pause();
        suppressSyncEventRef.current = false;
      } else if (detail.action === "seek" || detail.action === "position") {
        const target = detail.position ?? 0;
        if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.12) {
          suppressSyncEventRef.current = true;
          video.currentTime = Math.max(0, target);
          suppressSyncEventRef.current = false;
        }
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
        video.currentTime = startAt;
        suppressSyncEventRef.current = true;
        void video.play().catch(() => undefined).finally(() => {
          suppressSyncEventRef.current = false;
        });
      };
      video.addEventListener("loadedmetadata", start, { once: true });
      video.load();
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) start();
      return () => video.removeEventListener("loadedmetadata", start);
    }
    if (Number.isFinite(position)) video.currentTime = startAt;
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
          // 正在播放的视频在播放器里有一个不可见的后台实例，详情面板只需接上
          // 已经跑着的时钟；非播放时仍不主动读取大视频文件。
          preload={hidden ? "auto" : "none"}
          poster={api.coverUrl(track.id, track.modified_at)}
          src={api.videoUrl(track.id)}
          onPlay={() => {
            setError("");
            // 视频控件是本地视频的播放入口；让播放器加载同一曲目的音轨，
            // 之后由播放器时钟持续校正视频，避免两条媒体各自漂移。
            if (!suppressSyncEventRef.current) playTrack(track);
            if (!suppressSyncEventRef.current) {
              broadcastMediaSync({ owner: "local-video", action: "play", trackId: track.id });
            }
          }}
          onPause={() => {
            if (!suppressSyncEventRef.current) {
              broadcastMediaSync({ owner: "local-video", action: "pause", trackId: track.id });
            }
          }}
          onSeeked={(event) => {
            if (!suppressSyncEventRef.current) {
              broadcastMediaSync({
                owner: "local-video",
                action: "seek",
                trackId: track.id,
                position: event.currentTarget.currentTime,
              });
            }
          }}
          onError={() => setError("这个视频容器或编码暂不受系统 WebView 支持")}
        />
      </div>
      {error && <p className="kd-djp-note">{error}</p>}
    </div>
  );
}
