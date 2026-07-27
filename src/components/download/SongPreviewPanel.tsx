import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Music2, Pause, Play } from "lucide-react";
import { api } from "../../lib/api";
import { announceAudioFocus } from "../../lib/audioFocus";
import { formatDuration } from "../../lib/format";
import type { SongPreviewRequest } from "../../lib/songPreview";
import { InlineNotice } from "../common";

/**
 * 在线试听没有曲库分析出来的真实频谱数据，因此用标题稳定生成一组中性波形柱，
 * 只承担“可点击时间轴”的视觉职责；播放进度、时长和跳转都来自真实 audio。
 * 不把媒体接进 AudioContext：部分平台直链没有 CORS，强接会让声音变成静音。
 */
function previewBars(seed: string, count = 72): number[] {
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.codePointAt(0) ?? 0;
    state = Math.imul(state, 16777619);
  }
  return Array.from({ length: count }, (_, index) => {
    state = Math.imul(state ^ (state >>> 13), 1597334677);
    const random = ((state >>> 0) % 1000) / 1000;
    const envelope = 0.55 + Math.sin((index / Math.max(1, count - 1)) * Math.PI) * 0.35;
    return 0.18 + random * 0.72 * envelope;
  });
}

export function SongPreviewPanel({ request }: { request: SongPreviewRequest }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(
    () => previewBars(`${request.title}\u0000${request.artist}`),
    [request.title, request.artist],
  );
  const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;

  useEffect(() => {
    let alive = true;
    setUrl("");
    setError("");
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    void api
      .songPreview(request.source)
      .then(({ url: next }) => {
        if (alive) setUrl(next);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, [request]);

  // URL 是异步解析回来的，仅写 autoPlay 在部分 WebView 中不会重新触发播放。
  // 等这一轮 render 把 <audio> 真正挂进 DOM，再显式 play，并把拒绝原因留在面板里。
  useEffect(() => {
    if (!url) return;
    const frame = requestAnimationFrame(() => {
      const audio = audioRef.current;
      if (!audio) return;
      announceAudioFocus("song");
      void audio.play().catch((reason: unknown) => {
        setPlaying(false);
        setError(`播放失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [url]);

  return (
    <section className="kd-song-preview">
      <div className="kd-toolbar" data-slim="true">
        <Music2 size={14} />
        <strong className="kd-truncate" title={request.title}>
          {request.title}
        </strong>
        <span className="kd-muted kd-truncate">{request.artist || "未知艺人"}</span>
      </div>

      <div className="kd-song-preview-body">
        {url ? (
          <>
            <audio
              ref={audioRef}
              hidden
              autoPlay
              preload="auto"
              src={url}
              onPlay={() => {
                announceAudioFocus("song");
                setPlaying(true);
              }}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) =>
                setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
              }
              onEnded={() => setPlaying(false)}
              onError={(event) => {
                const media = event.currentTarget.error;
                const detail = media?.message || `媒体错误 ${media?.code ?? "未知"}`;
                setPlaying(false);
                setError(`播放失败：${detail}`);
              }}
            />
            <div className="kd-song-preview-player">
              <button
                type="button"
                className="kd-song-preview-go"
                aria-label={playing ? "暂停试听" : "播放试听"}
                onClick={() => {
                  const audio = audioRef.current;
                  if (!audio) return;
                  if (audio.paused) {
                    void audio.play().catch((reason: unknown) =>
                      setError(
                        `播放失败：${reason instanceof Error ? reason.message : String(reason)}`,
                      ),
                    );
                  }
                  else audio.pause();
                }}
              >
                {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
              </button>
              <div
                className="kd-song-preview-wave"
                role="slider"
                aria-label="试听进度"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={position}
                onClick={(event) => {
                  const audio = audioRef.current;
                  if (!audio || duration <= 0) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
                  setPosition(audio.currentTime);
                }}
              >
                <span className="kd-song-preview-bars" aria-hidden="true">
                  {bars.map((height, index) => (
                    <i key={index} style={{ height: `${Math.round(height * 100)}%` }} />
                  ))}
                </span>
                <span className="kd-song-preview-played" style={{ width: `${ratio * 100}%` }} />
                <span className="kd-song-preview-head" style={{ left: `${ratio * 100}%` }} />
              </div>
              <span className="kd-song-preview-time">
                {formatDuration(position)} / {formatDuration(duration)}
              </span>
            </div>
          </>
        ) : error ? null : (
          <LoaderCircle className="kd-spin" size={17} />
        )}
        <InlineNotice text={error} />
      </div>
    </section>
  );
}
