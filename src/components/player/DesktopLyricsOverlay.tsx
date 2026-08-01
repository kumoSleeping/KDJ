import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { activeLrcIndex, lineFillProgress } from "../../lib/lrc";
import { effectiveLyricExtra } from "../../lib/lyricsOverlay";
import { paintCss, strokeCss } from "../../lib/lyricsColor";
import {
  accentPaint,
  dimPaint,
  resolvedSecondaryPaint,
  strokePaint,
  useLyricsPrefs,
} from "../../lib/lyricsPrefs";
import { readPublishedStreamTrack } from "../../lib/streamTrack";
import { runtimePlayer, type UnifiedPlayerState } from "../../lib/unifiedPlayer";
import { ensureLyrics, useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

const MIN_SQUEEZE = 0.62;

function alignedText(
  lines: { time: number; text: string }[],
  time: number,
): string | undefined {
  return lines.find((line) => Math.abs(line.time - time) < 0.05)?.text;
}

/**
 * 播放状态事件大约 100ms 一拍；悬浮歌词逐字推进用墙钟把进度补到一帧一更。
 */
function useSmoothPlaybackTime(playback: UnifiedPlayerState): number {
  const [time, setTime] = useState(playback.currentTime);
  const anchorRef = useRef({
    media: playback.currentTime,
    wall: performance.now(),
    rate: playback.rate,
  });

  useEffect(() => {
    anchorRef.current = {
      media: playback.currentTime,
      wall: performance.now(),
      rate: playback.rate > 0 ? playback.rate : 1,
    };
    setTime(playback.currentTime);
  }, [playback.currentTime, playback.rate, playback.trackId, playback.playing]);

  useEffect(() => {
    if (!playback.playing) return;
    let frame = 0;
    const tick = () => {
      const anchor = anchorRef.current;
      setTime(anchor.media + ((performance.now() - anchor.wall) / 1000) * anchor.rate);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playback.playing, playback.trackId]);

  return playback.playing ? time : playback.currentTime;
}

function overflowShift(textWidth: number, available: number, fill: number): number {
  const overflow = textWidth - available;
  if (overflow <= 0) return (available - textWidth) / 2;
  return -Math.min(overflow, overflow * fill);
}

function useKaraokeLayout(
  text: string,
  fill: number,
  fontScale: number,
  viewportRef: RefObject<HTMLDivElement | null>,
  measureRef: RefObject<HTMLSpanElement | null>,
) {
  const [layout, setLayout] = useState({ squeeze: 1, shift: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const measure = measureRef.current;
    if (!viewport || !measure) return;

    const recompute = () => {
      const available = viewport.clientWidth;
      if (available <= 0) return;
      const natural = measure.getBoundingClientRect().width;
      const squeeze =
        natural <= available || natural <= 0 ? 1 : Math.max(MIN_SQUEEZE, available / natural);
      const textWidth = natural * squeeze;
      const shift = overflowShift(textWidth, available, fill);
      setLayout((prev) =>
        Math.abs(prev.squeeze - squeeze) < 0.001 && Math.abs(prev.shift - shift) < 0.25
          ? prev
          : { squeeze, shift },
      );
    };

    recompute();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recompute);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [text, fill, fontScale, viewportRef, measureRef]);

  return layout;
}

function DesktopLyricsLine({
  text,
  fill,
  role,
  fontScale,
}: {
  text: string;
  fill: number;
  role: "primary" | "secondary";
  fontScale: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const layout = useKaraokeLayout(text, fill, fontScale, viewportRef, measureRef);
  const safeFill = Math.min(1, Math.max(0, fill));

  return (
    <div
      ref={viewportRef}
      className={`kd-desktop-lyrics-${role}`}
      style={
        {
          "--kd-desktop-lyrics-fill": safeFill,
          "--kd-desktop-lyrics-line-squeeze": layout.squeeze,
        } as CSSProperties
      }
    >
      <span ref={measureRef} className="kd-desktop-lyrics-measure" aria-hidden="true">
        {text}
      </span>
      <div
        className="kd-desktop-lyrics-line-track"
        style={{ transform: `translateX(${layout.shift}px)` }}
      >
        <span className="kd-desktop-lyrics-dim">{text}</span>
        <span className="kd-desktop-lyrics-lit" aria-hidden="true">
          {text}
        </span>
      </div>
    </div>
  );
}

export function DesktopLyricsOverlay() {
  const player = runtimePlayer();
  const [playback, setPlayback] = useState<UnifiedPlayerState>(() => player.state());
  const [track, setTrack] = useState<Track | null>(null);
  const [trackError, setTrackError] = useState("");
  const prefs = useLyricsPrefs();
  const lyricExtra = prefs.lyricExtra;
  const prefsEpoch = prefs.prefsEpoch;
  const locked = prefs.desktopLocked;
  const fontScale = prefs.desktopFontScale;
  const opacity = prefs.desktopOpacity;
  const setDesktopCoordinates = useLyricsPrefs((state) => state.setDesktopCoordinates);
  const smoothTime = useSmoothPlaybackTime(playback);
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(playback.trackId),
    () => useLyricsStore.getState().get(playback.trackId),
  );

  useEffect(() => {
    const sync = () => useLyricsPrefs.getState().syncFromStorage();
    window.addEventListener("storage", sync);
    let unlistenPrefs: UnlistenFn | null = null;
    let unlistenStream: UnlistenFn | null = null;
    void listen("lyrics-prefs-changed", sync).then((dispose) => {
      unlistenPrefs = dispose;
    });
    void listen("stream-track-changed", () => {
      const id = runtimePlayer().state().trackId;
      if (id != null && id < 0) {
        const published = readPublishedStreamTrack(id);
        if (published) {
          setTrack(published);
          void ensureLyrics(published);
        }
      }
    }).then((dispose) => {
      unlistenStream = dispose;
    });
    // 打开时再读一次，避免主窗先写入、本窗后挂上监听的竞态。
    sync();
    return () => {
      window.removeEventListener("storage", sync);
      unlistenPrefs?.();
      unlistenStream?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let timer: number | null = null;
    let latest: { x: number; y: number } | null = null;
    void listen<{ x: number; y: number }>("desktop-lyrics-moved", (event) => {
      latest = event.payload;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (latest) setDesktopCoordinates(latest.x, latest.y);
      }, 220);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [setDesktopCoordinates]);

  useEffect(() => {
    let alive = true;
    const unsubscribe = player.subscribe((state) => {
      if (alive) setPlayback(state);
    });
    void player.initialize().catch((error) => {
      if (alive) setTrackError(String(error));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [player]);

  useEffect(() => {
    let alive = true;
    const trackId = playback.trackId;
    setTrackError("");
    if (trackId == null) {
      setTrack(null);
      return () => {
        alive = false;
      };
    }
    // 未下载试听是负数 id，不在曲库；走主窗广播的 SongSource 快照，直取平台歌词。
    if (trackId < 0) {
      const published = readPublishedStreamTrack(trackId);
      if (published) {
        setTrack(published);
        void ensureLyrics(published);
      } else {
        setTrack(null);
        setTrackError("在线试听曲目信息尚未同步");
      }
      return () => {
        alive = false;
      };
    }
    void api
      .track(trackId)
      .then((next) => {
        if (!alive) return;
        setTrack(next);
        return ensureLyrics(next);
      })
      .catch((error) => {
        if (alive) setTrackError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [playback.trackId, prefsEpoch]);

  // 窗口通常会由主界面同步隐藏；这里再兜底，避免启动竞态闪出占位文案。
  if (playback.trackId == null) return null;

  const active = activeLrcIndex(entry.lines, smoothTime);
  const currentIndex = active < 0 ? 0 : active;
  const current = entry.lines[currentIndex];
  const next = entry.lines[currentIndex + 1];
  const hasMeaning = entry.translated.some((line) => line.text.trim());
  const hasRomaji = entry.romaji.some((line) => line.text.trim());
  const layer = effectiveLyricExtra(lyricExtra, hasMeaning, hasRomaji);
  const extra = current
    ? layer === "meaning"
      ? alignedText(entry.translated, current.time)
      : layer === "romaji"
        ? alignedText(entry.romaji, current.time)
        : undefined
    : undefined;

  let primary = "正在读取曲目信息…";
  let secondary = "";
  let karaoke = false;
  if (trackError) primary = trackError;
  else if (track && (entry.status === "idle" || entry.status === "loading")) {
    primary = `${track.title || track.filename} · 正在搜歌词…`;
  } else if (entry.status === "error" || entry.status === "empty") {
    primary = "";
  } else if (current) {
    primary = current.text;
    secondary = extra || next?.text || "";
    karaoke = entry.status === "ready";
  }

  const fill = karaoke
    ? lineFillProgress(entry.lines, currentIndex, smoothTime, playback.duration)
    : 1;

  const accent = paintCss(accentPaint(prefs));
  const secondaryColor = paintCss(resolvedSecondaryPaint(prefs));
  const dimColor = paintCss(dimPaint(prefs));
  const stroke = strokeCss(strokePaint(prefs));

  return (
    <main
      className="kd-desktop-lyrics"
      data-locked={locked ? "true" : undefined}
      style={
        {
          "--kd-desktop-lyrics-scale": fontScale,
          "--kd-desktop-lyrics-opacity": opacity,
          "--kd-desktop-lyrics-accent": accent.color,
          "--kd-desktop-lyrics-accent-fill": accent.backgroundImage ?? "none",
          "--kd-desktop-lyrics-accent-clip": accent.clipText ? "text" : "border-box",
          "--kd-desktop-lyrics-secondary": secondaryColor.color,
          "--kd-desktop-lyrics-secondary-fill": secondaryColor.backgroundImage ?? "none",
          "--kd-desktop-lyrics-secondary-clip": secondaryColor.clipText ? "text" : "border-box",
          "--kd-desktop-lyrics-dim": dimColor.color,
          "--kd-desktop-lyrics-dim-fill": dimColor.backgroundImage ?? "none",
          "--kd-desktop-lyrics-dim-clip": dimColor.clipText ? "text" : "border-box",
          "--kd-desktop-lyrics-stroke": stroke.color,
          "--kd-desktop-lyrics-stroke-width": stroke.widthPrimary,
          "--kd-desktop-lyrics-stroke-width-secondary": stroke.widthSecondary,
        } as CSSProperties
      }
    >
      <div className="kd-desktop-lyrics-stage">
        <div
          className="kd-desktop-lyrics-drag"
          data-tauri-drag-region={locked ? undefined : ""}
          title={locked ? undefined : "按住歌词文字附近即可拖动"}
          onPointerDown={(event) => {
            if (locked || event.button !== 0) return;
            window.kdj.windowControl("drag");
          }}
        />
        <div className="kd-desktop-lyrics-content" aria-live="polite">
          <DesktopLyricsLine text={primary} fill={fill} role="primary" fontScale={fontScale} />
          {secondary ? (
            <DesktopLyricsLine
              text={secondary}
              fill={fill}
              role="secondary"
              fontScale={fontScale}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}
