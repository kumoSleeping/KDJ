import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { activeLrcIndex } from "../../lib/lrc";
import { useLyricsPrefs, type LyricsExtra } from "../../lib/lyricsPrefs";
import { runtimePlayer, type UnifiedPlayerState } from "../../lib/unifiedPlayer";
import { ensureLyrics, useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

function alignedText(
  lines: { time: number; text: string }[],
  time: number,
): string | undefined {
  return lines.find((line) => Math.abs(line.time - time) < 0.05)?.text;
}

function effectiveExtra(
  preferred: LyricsExtra,
  hasMeaning: boolean,
  hasRomaji: boolean,
): LyricsExtra {
  if (preferred === "meaning" && hasMeaning) return "meaning";
  if (preferred === "romaji" && hasRomaji) return "romaji";
  return "off";
}

export function DesktopLyricsOverlay() {
  const player = runtimePlayer();
  const [playback, setPlayback] = useState<UnifiedPlayerState>(() => player.state());
  const [track, setTrack] = useState<Track | null>(null);
  const [trackError, setTrackError] = useState("");
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const prefsEpoch = useLyricsPrefs((state) => state.prefsEpoch);
  const locked = useLyricsPrefs((state) => state.desktopLocked);
  const fontScale = useLyricsPrefs((state) => state.desktopFontScale);
  const setDesktopCoordinates = useLyricsPrefs((state) => state.setDesktopCoordinates);
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(playback.trackId),
    () => useLyricsStore.getState().get(playback.trackId),
  );

  useEffect(() => {
    const sync = () => useLyricsPrefs.getState().syncFromStorage();
    window.addEventListener("storage", sync);
    let unlisten: UnlistenFn | null = null;
    void listen("lyrics-prefs-changed", sync).then((dispose) => {
      unlisten = dispose;
    });
    // 打开时再读一次，避免主窗先写入、本窗后挂上监听的竞态。
    sync();
    return () => {
      window.removeEventListener("storage", sync);
      unlisten?.();
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

  const active = activeLrcIndex(entry.lines, playback.currentTime);
  const currentIndex = active < 0 ? 0 : active;
  const current = entry.lines[currentIndex];
  const next = entry.lines[currentIndex + 1];
  const hasMeaning = entry.translated.some((line) => line.text.trim());
  const hasRomaji = entry.romaji.some((line) => line.text.trim());
  const layer = effectiveExtra(lyricExtra, hasMeaning, hasRomaji);
  const extra = current
    ? layer === "meaning"
      ? alignedText(entry.translated, current.time)
      : layer === "romaji"
        ? alignedText(entry.romaji, current.time)
        : undefined
    : undefined;

  let primary = "正在读取曲目信息…";
  let secondary = "";
  if (trackError) primary = trackError;
  else if (track && (entry.status === "idle" || entry.status === "loading")) {
    primary = `${track.title || track.filename} · 正在搜歌词…`;
  } else if (entry.status === "error" || entry.status === "empty") {
    primary = entry.error || "没有找到歌词";
  } else if (current) {
    primary = current.text;
    secondary = extra || next?.text || "";
  }

  return (
    <main
      className="kd-desktop-lyrics"
      data-locked={locked ? "true" : undefined}
      style={{ "--kd-desktop-lyrics-scale": fontScale } as CSSProperties}
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
          <div className="kd-desktop-lyrics-primary">{primary}</div>
          {secondary ? <div className="kd-desktop-lyrics-secondary">{secondary}</div> : null}
        </div>
      </div>
    </main>
  );
}
