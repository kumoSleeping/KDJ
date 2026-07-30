import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import {
  lyricExtraLabel,
  lyricExtraTitle,
  useLyricsPrefs,
  type LyricsExtra,
} from "../../lib/lyricsPrefs";
import { activeLrcIndex } from "../../lib/lrc";
import {
  getLatestPlayerSync,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";
import { useLyricsStore } from "../../stores/lyricsStore";
import type { Track } from "../../types";

function usePlayerPosition(trackId: number | null): number {
  const [position, setPosition] = useState(() =>
    trackId != null ? (getLatestPlayerSync(trackId)?.position ?? 0) : 0,
  );
  useEffect(() => {
    if (trackId == null) {
      setPosition(0);
      return;
    }
    setPosition(getLatestPlayerSync(trackId)?.position ?? 0);
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<MediaSyncDetail>).detail;
      if (detail.owner !== "player") return;
      if (detail.trackId != null && detail.trackId !== trackId) return;
      if (typeof detail.position === "number") setPosition(detail.position);
    };
    window.addEventListener(MEDIA_SYNC_EVENT, onSync);
    return () => window.removeEventListener(MEDIA_SYNC_EVENT, onSync);
  }, [trackId]);
  return position;
}

function sourceLabel(platform: string | undefined): string {
  if (platform === "wyy") return "网易云";
  if (platform === "qqm") return "QQ 音乐";
  return "";
}

function seekToLyric(trackId: number, position: number): void {
  window.dispatchEvent(
    new CustomEvent<SeekDetail>(SEEK_EVENT, {
      detail: { trackId, position },
    }),
  );
}

function alignedText(
  lines: { time: number; text: string }[],
  time: number,
): string | undefined {
  return lines.find((item) => Math.abs(item.time - time) < 0.05)?.text;
}

/** 偏好层对本首歌不可用时，显示上退回原词。 */
function effectiveExtra(
  preferred: LyricsExtra,
  hasMeaning: boolean,
  hasRomaji: boolean,
): LyricsExtra {
  if (preferred === "meaning" && hasMeaning) return "meaning";
  if (preferred === "romaji" && hasRomaji) return "romaji";
  return "off";
}

export function LyricsView({ track }: { track: Track | null }) {
  const trackId = track?.id ?? null;
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(trackId),
    () => useLyricsStore.getState().get(trackId),
  );
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const cycleLyricExtra = useLyricsPrefs((state) => state.cycleLyricExtra);
  const position = usePlayerPosition(trackId);
  const active = activeLrcIndex(entry.lines ?? [], position);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  /** 用户刚点过某句：短暂关掉自动跟滚，避免立刻又滚回当前句。 */
  const userSeekUntilRef = useRef(0);

  const translated = entry.translated ?? [];
  const romaji = entry.romaji ?? [];
  const lines = entry.lines ?? [];
  const hasMeaning = translated.some((line) => line.text.trim());
  const hasRomaji = romaji.some((line) => line.text.trim());
  const layer = effectiveExtra(lyricExtra, hasMeaning, hasRomaji);
  const canCycle = hasMeaning || hasRomaji;

  useEffect(() => setCoverFailed(false), [trackId]);

  useEffect(() => {
    if (performance.now() < userSeekUntilRef.current) return;
    const node = activeRef.current;
    const list = listRef.current;
    if (!node || !list) return;
    const top = node.offsetTop - list.clientHeight * 0.36;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [active, trackId]);

  if (!track) {
    return (
      <div className="kd-lyrics">
        <div className="kd-lyrics-stage">
          <p className="kd-lyrics-empty">播放一首歌后会自动搜歌词</p>
        </div>
      </div>
    );
  }

  if (entry.status === "loading" || entry.status === "idle") {
    return (
      <div className="kd-lyrics">
        <LyricsHead
          track={track}
          source=""
          coverFailed={coverFailed}
          onCoverFail={() => setCoverFailed(true)}
          layer="off"
          canCycle={false}
          onCycle={() => undefined}
        />
        <div className="kd-lyrics-stage">
          <p className="kd-lyrics-empty">正在搜歌词…</p>
        </div>
      </div>
    );
  }

  if (entry.status === "error" || entry.status === "empty") {
    return (
      <div className="kd-lyrics">
        <LyricsHead
          track={track}
          source=""
          coverFailed={coverFailed}
          onCoverFail={() => setCoverFailed(true)}
          layer="off"
          canCycle={false}
          onCycle={() => undefined}
        />
        <div className="kd-lyrics-stage">
          <p className="kd-lyrics-empty">{entry.error || "没有找到歌词"}</p>
        </div>
      </div>
    );
  }

  const source = sourceLabel(entry.meta?.platform);

  return (
    <div className="kd-lyrics">
      <LyricsHead
        track={track}
        source={source}
        coverFailed={coverFailed}
        onCoverFail={() => setCoverFailed(true)}
        layer={layer}
        canCycle={canCycle}
        onCycle={() => cycleLyricExtra(hasMeaning, hasRomaji)}
      />
      <div className="kd-lyrics-stage">
        <div ref={listRef} className="kd-lyrics-scroll" aria-live="polite">
          {lines.map((line, index) => {
            const distance = active < 0 ? index + 1 : Math.abs(index - active);
            const roma =
              layer === "romaji" ? alignedText(romaji, line.time) : undefined;
            const trans =
              layer === "meaning" ? alignedText(translated, line.time) : undefined;
            return (
              <button
                key={`${line.time}-${index}`}
                type="button"
                ref={index === active ? activeRef : undefined}
                className="kd-lyrics-line"
                data-active={index === active ? "true" : undefined}
                data-past={index < active ? "true" : undefined}
                data-dist={String(Math.min(distance, 4))}
                title={`跳到 ${formatStamp(line.time)}`}
                onClick={() => {
                  userSeekUntilRef.current = performance.now() + 900;
                  seekToLyric(track.id, line.time);
                }}
              >
                <span className="kd-lyrics-line-text">{line.text}</span>
                {roma ? <span className="kd-lyrics-line-roma">{roma}</span> : null}
                {trans ? <span className="kd-lyrics-line-trans">{trans}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function LyricsHead({
  track,
  source,
  coverFailed,
  onCoverFail,
  layer,
  canCycle,
  onCycle,
}: {
  track: Track;
  source: string;
  coverFailed: boolean;
  onCoverFail(): void;
  layer: LyricsExtra;
  canCycle: boolean;
  onCycle(): void;
}) {
  const cover = api.coverUrl(track.id, track.modified_at);
  return (
    <header className="kd-lyrics-head" data-toggles={canCycle ? "true" : undefined}>
      <div className="kd-lyrics-cover" aria-hidden="true">
        {cover && !coverFailed ? (
          <img src={cover} alt="" onError={onCoverFail} />
        ) : (
          <span className="kd-lyrics-cover-fallback" />
        )}
      </div>
      <div className="kd-lyrics-head-copy">
        <div className="kd-lyrics-head-title">{track.title || track.filename}</div>
        <div className="kd-lyrics-head-artist">{track.artist || "未知艺人"}</div>
        {source ? <div className="kd-lyrics-head-source">歌词来自 {source}</div> : null}
      </div>
      {canCycle ? (
        <button
          type="button"
          className="kd-lyrics-layer"
          title={lyricExtraTitle(layer)}
          aria-label={lyricExtraTitle(layer)}
          onClick={onCycle}
        >
          {lyricExtraLabel(layer)}
        </button>
      ) : null}
    </header>
  );
}
