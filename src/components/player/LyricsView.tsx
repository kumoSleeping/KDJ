import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  lyricExtraLabel,
  lyricExtraTitle,
  useLyricsPrefs,
  type LyricsExtra,
} from "../../lib/lyricsPrefs";
import { LyricsSourcePicker } from "./LyricsSourcePicker";
import { activeLrcIndex, startedLrcIndex } from "../../lib/lrc";
import {
  getLatestPlayerSync,
  MEDIA_SYNC_EVENT,
  type MediaSyncDetail,
} from "../../lib/mediaSync";
import { SEEK_EVENT, type SeekDetail } from "../library/Waveform";
import { useLyricsStore } from "../../stores/lyricsStore";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { isVideoTrack } from "../../lib/format";
import { streamMeta } from "../../lib/streamTrack";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { Panel } from "../common";
import { AsyncPanelBody } from "../common/AsyncPanelBody";
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

interface LyricsDetailProps {
  track: Track;
  /** Playback docks reserve a loading rectangle and collapse unavailable content. */
  reserveEmpty?: boolean;
  expandKey?: string;
  /** An existing non-audio transport can supply its own clock and seek route. */
  transport?: { position: number; seek(position: number): void };
}
export function LyricsDetailPanel({ track, transport, reserveEmpty = false, expandKey }: LyricsDetailProps) {
  const [actionsHost, setActionsHost] = useState<HTMLSpanElement | null>(null);
  const entry = useLyricsStore(state => state.get(track.id));
  const prefsEpoch = useLyricsPrefs(state => state.prefsEpoch);
  useEffect(() => { void useLyricsStore.getState().ensure(track, {cacheOnly:true}); }, [track.id, prefsEpoch]);
  const video = isVideoTrack(track.format) || streamMeta(track)?.kind === "video";
  const ready = !video && hasVisibleLyrics(entry.lines);
  const state = ready ? "ready" : !video && (entry.status === "idle" || entry.status === "loading") ? "loading" : "empty";
  if (!reserveEmpty && !ready) return null;
  return (
    <Panel heading="歌词" maximizable={ready} expandKey={ready ? expandKey : undefined} actionsHost={actionsHost} padded={false} dense className="kd-detail-lyrics-panel">
      <AsyncPanelBody kind="lyrics" state={state}>
        {ready && <LyricsView track={track} transport={transport} actionsRef={setActionsHost} />}
      </AsyncPanelBody>
    </Panel>
  );
}

function LyricsView({ track, transport, actionsRef }: LyricsDetailProps & { actionsRef(node: HTMLSpanElement | null): void }) {
  const trackId = track.id;
  const playingTrack = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const activeTrack = playingTrack?.id === trackId;
  const entry = useSyncExternalStore(
    useLyricsStore.subscribe,
    () => useLyricsStore.getState().get(trackId),
    () => useLyricsStore.getState().get(trackId),
  );
  const lyricExtra = useLyricsPrefs((state) => state.lyricExtra);
  const prefsEpoch = useLyricsPrefs((state) => state.prefsEpoch);
  const cycleLyricExtra = useLyricsPrefs((state) => state.cycleLyricExtra);
  const playerPosition = usePlayerPosition(transport ? null : trackId);
  const position = transport?.position ?? playerPosition;
  const active = activeLrcIndex(entry.lines ?? [], position);
  const started = startedLrcIndex(entry.lines ?? [], position);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  /** 用户刚点过某句：短暂关掉自动跟滚，避免立刻又滚回当前句。 */
  const userSeekUntilRef = useRef(0);

  const translated = entry.translated ?? [];
  const romaji = entry.romaji ?? [];
  const lines = entry.lines ?? [];
  const hasMeaning = translated.some((line) => line.text.trim());
  const hasRomaji = romaji.some((line) => line.text.trim());
  const layer = effectiveExtra(lyricExtra, hasMeaning, hasRomaji);
  const canCycle = hasMeaning || hasRomaji;

  useEffect(() => {
    void useLyricsStore.getState().ensure(track, { cacheOnly: true });
  }, [trackId, prefsEpoch]);

  useEffect(() => {
    if (performance.now() < userSeekUntilRef.current) return;
    const node = activeRef.current;
    const list = listRef.current;
    if (!node || !list) return;
    const top = node.offsetTop - list.clientHeight * 0.36;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [active, trackId]);

  return (
    <div className="kd-lyrics" data-has-content={lines.length > 0 || !!entry.error || entry.status === "error" ? "true" : undefined}>
      <div className="kd-lyrics-embedded-tools">
        <LyricsSourcePicker platform={entry.meta?.platform} disabled={!activeTrack && !transport} matching={!!entry.inflight} onSelect={platform => void useLyricsStore.getState().ensure(track, { platform })} />
        {canCycle ? <button type="button" className="kd-lyrics-layer" title={lyricExtraTitle(layer)} aria-label={lyricExtraTitle(layer)} onClick={() => cycleLyricExtra(hasMeaning, hasRomaji)}>{lyricExtraLabel(layer)}</button> : null}
        <span className="kd-lyrics-panel-actions" ref={actionsRef} />
      </div>
      <div className="kd-lyrics-stage">
        {entry.error || entry.status === "error" ? <p className="kd-lyrics-empty" role="alert">{entry.error || "歌词暂时不可用"}</p> : null}
        <div ref={listRef} className="kd-lyrics-scroll" aria-live="polite">
          {lines.map((line, index) => {
            const context = active >= 0 ? active : started;
            const distance = context < 0 ? index + 1 : Math.abs(index - context);
            const past = active >= 0 ? index < active : started >= 0 && index <= started;
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
                data-past={past ? "true" : undefined}
                data-dist={String(Math.min(distance, 4))}
                title={activeTrack || transport ? `跳到 ${formatStamp(line.time)}` : undefined}
                disabled={!activeTrack && !transport}
                onClick={() => {
                  if (!activeTrack && !transport) return;
                  userSeekUntilRef.current = performance.now() + 900;
                  if (transport) transport.seek(line.time);
                  else seekToLyric(track.id, line.time);
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
