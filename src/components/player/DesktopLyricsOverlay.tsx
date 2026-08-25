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
import { activeLrcIndex, lineFillProgress, projectLoopedPlaybackTime } from "../../lib/lrc";
import { effectiveLyricExtra } from "../../lib/lyricsOverlay";
import { paintCss, strokeCss } from "../../lib/lyricsColor";
import {
  accentPaint,
  dimPaint,
  resolvedSecondaryPaint,
  strokePaint,
  useLyricsPrefs,
} from "../../lib/lyricsPrefs";
import {
  readPublishedStreamPlayback,
  readPublishedStreamTrack,
  type PublishedStreamPlayback,
  type PublishedStreamPlaybackEvent,
} from "../../lib/streamTrack";
import {
  getLiveDeckClock,
  getLiveForegroundDeck,
  runtimePlayer,
  subscribeLivePlaybackClock,
  type UnifiedPlayerState,
} from "../../lib/unifiedPlayer";
import { ensureLyrics, useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

const MIN_SQUEEZE = 0.62;

function alignedText(
  lines: { time: number; text: string }[],
  time: number,
): string | undefined {
  return lines.find((line) => Math.abs(line.time - time) < 0.05)?.text;
}

function useSmoothPlaybackTime(playback: UnifiedPlayerState): number {
  const live = useSyncExternalStore(
    subscribeLivePlaybackClock,
    () => {
      const foreground = getLiveDeckClock(getLiveForegroundDeck());
      if (foreground?.trackId === playback.trackId) return foreground;
      return ([0, 1] as const)
        .map((deck) => getLiveDeckClock(deck))
        .find((clock) => clock?.trackId === playback.trackId && clock.playing)
        ?? null;
    },
    () => null,
  );
  const fallbackDeck = playback.decks
    .filter((deck) => deck.trackId === playback.trackId)
    .sort((left, right) =>
      Math.abs(left.currentTime - playback.currentTime)
      - Math.abs(right.currentTime - playback.currentTime))[0];
  const media = live?.currentTime ?? playback.currentTime;
  const rate = live?.audibleRate
    ?? (fallbackDeck?.audibleRate ?? (playback.playing ? playback.rate : 0));
  const loopStart = live?.loopStart
    ?? fallbackDeck?.effectiveLoopStart
    ?? fallbackDeck?.loopStart
    ?? null;
  const loopLength = live?.loopLength
    ?? fallbackDeck?.effectiveLoopLength
    ?? fallbackDeck?.loopLength
    ?? null;
  const advancing = live
    ? live.playing || live.scratchHeld
    : playback.playing;
  const presentationWall = live?.clientPresentationTimeMs ?? performance.now();
  const [time, setTime] = useState(media);
  const anchorRef = useRef({
    media,
    wall: presentationWall,
    rate,
    loopStart,
    loopLength,
  });

  useEffect(() => {
    anchorRef.current = {
      media,
      wall: presentationWall,
      rate,
      loopStart,
      loopLength,
    };
    setTime(projectLoopedPlaybackTime(
      media,
      Math.max(0, performance.now() - presentationWall) / 1_000,
      rate,
      loopStart,
      loopLength,
    ));
  }, [
    live,
    media,
    presentationWall,
    rate,
    playback.trackId,
    loopStart,
    loopLength,
  ]);

  useEffect(() => {
    if (!advancing || Math.abs(rate) < 1.0e-6) return;
    let frame = 0;
    const tick = () => {
      const anchor = anchorRef.current;
      setTime(projectLoopedPlaybackTime(
        anchor.media,
        (performance.now() - anchor.wall) / 1_000,
        anchor.rate,
        anchor.loopStart,
        anchor.loopLength,
      ));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [advancing, playback.trackId, rate]);

  return time;
}

function publishedStreamState(value: PublishedStreamPlayback): UnifiedPlayerState {
  return {
    trackId: value.trackId,
    preparedTrackId: null,
    status: value.playing ? "playing" : "paused",
    currentTime: value.position,
    duration: value.duration,
    playing: value.playing,
    buffering: false,
    transitioning: false,
    rate: value.rate,
    error: "",
    sync: {
      enabled: false,
      leader: 0,
      follower: 1,
      phase: "disabled",
      phaseErrorSeconds: 0,
      correctionRate: 1,
      targetBpm: 0,
      multiple: 1,
    },
    decks: [0, 1].map((index) => ({
      trackId: index === 0 ? value.trackId : null,
      currentTime: index === 0 ? value.position : 0,
      duration: index === 0 ? value.duration : 0,
      playing: index === 0 ? value.playing : false,
      desiredPlaying: index === 0 ? value.playing : false,
      buffering: false,
      rate: index === 0 ? value.rate : 1,
    })) as UnifiedPlayerState["decks"],
  };
}

function initialPublishedStreamPlayback(track: Track): PublishedStreamPlayback {
  return {
    trackId: track.id,
    position: 0,
    duration:
      typeof track.duration === "number" && Number.isFinite(track.duration)
        ? Math.max(0, track.duration)
        : 0,
    playing: false,
    rate: 1,
  };
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
  const [streamPlayback, setStreamPlayback] = useState<PublishedStreamPlayback | null>(() =>
    readPublishedStreamPlayback(),
  );
  const [track, setTrack] = useState<Track | null>(() => readPublishedStreamTrack());
  const [trackError, setTrackError] = useState("");
  // Tauri 桌面上的在线试听由主窗 BrowserPreviewPlayer 持有，不能读 Rust 播放器的旧时钟。
  // 没有来得及收到播放状态时也先按曲目快照显示歌词；下一条时钟事件到达后再接上精确进度。
  const activeStreamPlayback =
    track?.id != null && track.id >= 0
      ? null
      : streamPlayback && (track == null || streamPlayback.trackId === track.id)
        ? streamPlayback
        : track && track.id < 0
          ? initialPublishedStreamPlayback(track)
          : null;
  const activePlayback = activeStreamPlayback
    ? publishedStreamState(activeStreamPlayback)
    : playback;
  const prefs = useLyricsPrefs();
  const lyricExtra = prefs.lyricExtra;
  const prefsEpoch = prefs.prefsEpoch;
  const locked = prefs.desktopLocked;
  const fontScale = prefs.desktopFontScale;
  const opacity = prefs.desktopOpacity;
  const smoothTime = useSmoothPlaybackTime(activePlayback);
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(activePlayback.trackId),
    () => useLyricsStore.getState().get(activePlayback.trackId),
  );

  useEffect(() => {
    const requestStreamSnapshot = () => {
      void import("@tauri-apps/api/event")
        .then(({ emitTo }) => emitTo("main", "stream-state-request"))
        .catch(() => {});
    };
    requestStreamSnapshot();
    const retry = window.setTimeout(requestStreamSnapshot, 120);
    return () => window.clearTimeout(retry);
  }, []);

  useEffect(() => {
    const applyPublishedStream = (
      published: Track | null,
      streamState: PublishedStreamPlayback | null,
    ) => {
      const nextTrack = published && published.id < 0 ? published : null;
      if (nextTrack) {
        setTrack(nextTrack);
      } else {
        setTrack((current) => (current?.id != null && current.id < 0 ? null : current));
      }
      setStreamPlayback(
        nextTrack && streamState && streamState.trackId === nextTrack.id ? streamState : null,
      );
    };
    const syncPublishedStream = () => {
      applyPublishedStream(readPublishedStreamTrack(), readPublishedStreamPlayback());
    };
    const sync = () => {
      useLyricsPrefs.getState().syncFromStorage();
      // 主窗可能在悬浮窗挂载前已经发布过曲目；storage 事件也是流状态的恢复通道。
      syncPublishedStream();
    };
    window.addEventListener("storage", sync);
    let unlistenPrefs: UnlistenFn | null = null;
    let unlistenStreamTrack: UnlistenFn | null = null;
    let unlistenStreamPlayback: UnlistenFn | null = null;
    void listen("lyrics-prefs-changed", sync).then((dispose) => {
      unlistenPrefs = dispose;
    });
    void listen<Track | null>("stream-track-changed", (event) => {
      // The event carries the snapshot so a separate WKWebView does not depend on
      // cross-window localStorage sharing. The storage read remains the startup fallback.
      const published = event.payload === undefined ? readPublishedStreamTrack() : event.payload;
      applyPublishedStream(published, readPublishedStreamPlayback());
    }).then((dispose) => {
      unlistenStreamTrack = dispose;
    });
    void listen<PublishedStreamPlaybackEvent | PublishedStreamPlayback>(
      "stream-playback-state",
      (event) => {
        const payload = event.payload;
        if (payload && "playback" in payload && payload.track) {
          applyPublishedStream(payload.track, payload.playback);
          return;
        }
        const published = readPublishedStreamTrack();
        applyPublishedStream(
          published,
          payload && "trackId" in payload ? payload : null,
        );
      },
    ).then((dispose) => {
      unlistenStreamPlayback = dispose;
    });
    // 打开时再读一次，避免主窗先写入、本窗后挂上监听的竞态。
    sync();
    syncPublishedStream();
    return () => {
      window.removeEventListener("storage", sync);
      unlistenPrefs?.();
      unlistenStreamTrack?.();
      unlistenStreamPlayback?.();
    };
  }, []);

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
    const trackId = activePlayback.trackId;
    setTrackError("");
    if (trackId == null) {
      setTrack(null);
      return () => {
        alive = false;
      };
    }
    // 未下载试听是负数 id，不在曲库；走主窗广播的 SongSource 快照，直取平台歌词。
    if (trackId < 0) {
      const published = track?.id === trackId ? track : readPublishedStreamTrack(trackId);
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
  }, [playback.trackId, streamPlayback?.trackId, track?.id, prefsEpoch]);

  // 窗口通常会由主界面同步隐藏；这里再兜底，避免启动竞态闪出占位文案。
  if (activePlayback.trackId == null) return null;

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
    primary = entry.status === "error" ? "歌词暂时不可用" : "未找到歌词";
  } else if (current) {
    primary = current.text;
    secondary = extra || next?.text || "";
    karaoke = entry.status === "ready";
  }

  const fill = karaoke
    ? lineFillProgress(entry.lines, currentIndex, smoothTime, activePlayback.duration)
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
