import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  AUDIO_FOCUS_EVENT,
  type AudioFocusDetail,
} from "../../lib/audioFocus";
import { broadcastMediaSync, MEDIA_SYNC_EVENT, type MediaSyncDetail } from "../../lib/mediaSync";
import { playTrack } from "./TrackTable";
import type { Track } from "../../types";

export function LocalVideoPlayer({ track }: { track: Track }) {
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

  return (
    <div className="kd-local-video">
      <div className="kd-preview-frame">
        <video
          ref={videoRef}
          controls
          muted
          playsInline
          preload="metadata"
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
