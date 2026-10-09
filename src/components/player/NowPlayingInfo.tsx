import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ChevronsDown, LoaderCircle, Pin, TextQuote } from "lucide-react";
import { isVideoTrack } from "../../lib/format";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import { isStreamTrack, streamMeta } from "../../lib/streamTrack";
import { NOW_PLAYING_PEEK_MS, nowPlayingInfoVisible, useNowPlayingInfo } from "../../lib/nowPlayingInfo";
import { useLyricsStore } from "../../stores/lyricsStore";
import { Panel } from "../common";
import { TrackDetail, type TrackMetadataParts } from "../library/TrackDetail";
import { StreamTrackDetail } from "./StreamTrackDetail";
import "./NowPlayingInfo.css";

const META_KEY = "kd-now-playing-meta-open";
/** The retreat into the bar; the panel stays mounted this long after it is dismissed. */
const LEAVE_MS = 380;

/**
 * Keeps the panel mounted while it is up and for the length of its retreat, and brings it up
 * for a moment when another song starts. Pausing and resuming the same song does not.
 */
export function NowPlayingInfoHost({ trackId, playing }: { trackId: number | null; playing: boolean }) {
  const visible = useNowPlayingInfo(nowPlayingInfoVisible);
  const [mounted, setMounted] = useState(visible);
  const song = useRef({ trackId, announced: true });
  useEffect(() => {
    if (song.current.trackId !== trackId) {
      // The song restored at launch is not a change of song.
      song.current = { trackId, announced: song.current.trackId === null || trackId === null };
    }
    if (!song.current.announced && playing) {
      song.current.announced = true;
      useNowPlayingInfo.getState().startPeek();
    }
  }, [trackId, playing]);
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return mounted ? <NowPlayingInfo leaving={!visible} /> : null;
}

/** 曲目信息 and Meta of the loaded deck, risen from the player bar it belongs to. */
function NowPlayingInfo({ leaving }: { leaving: boolean }) {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const pinned = useNowPlayingInfo(state => state.pinned);
  const peek = useNowPlayingInfo(state => state.peek);
  const timed = useNowPlayingInfo(state => state.peek > 0 && !state.open && !state.pinned);
  // The countdown waits while the pointer or the keyboard focus is in the panel.
  const [held, setHeld] = useState(false);
  const countdown = useRef({ peek: 0, remaining: NOW_PLAYING_PEEK_MS });
  useEffect(() => {
    if (!timed) return;
    if (countdown.current.peek !== peek) countdown.current = { peek, remaining: NOW_PLAYING_PEEK_MS };
    if (held) return;
    const started = performance.now(), remaining = countdown.current.remaining;
    const timer = window.setTimeout(() => useNowPlayingInfo.getState().endPeek(), remaining);
    return () => {
      window.clearTimeout(timer);
      countdown.current.remaining = Math.max(0, remaining - (performance.now() - started));
    };
  }, [timed, held, peek]);
  /** Dismiss unless the listener pinned it: used after an action that replaces the panel's job. */
  const onClose = () => { if (!useNowPlayingInfo.getState().pinned) useNowPlayingInfo.getState().close(); };
  const [metaOpen, setMetaOpen] = useState(() => readLocalStorage(META_KEY) === "true");
  const showMeta = (open: boolean) => {
    setMetaOpen(open);
    writeLocalStorageNow(META_KEY, String(open));
  };
  const lyricsEntry = useLyricsStore(state => state.get(track?.id));
  const video = !!track && (isVideoTrack(track.format) || streamMeta(track)?.kind === "video");
  const lyricsReady = !video && hasVisibleLyrics(lyricsEntry.lines);
  // The entry does not depend on an earlier match: opening it is an explicit request,
  // so a missing or failed match is retried and the lyrics open once they arrive.
  const openLyrics = () => {
    if (!track) return;
    const open = () => { useSidePanels.getState().setLyrics(true); onClose(); };
    if (lyricsReady) return open();
    const id = track.id;
    void useLyricsStore.getState().ensure(track, { matchMissing: true }).then(() => {
      if (getPlayingTrack()?.id === id && hasVisibleLyrics(useLyricsStore.getState().get(id).lines)) open();
    });
  };
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      // Escape inside a field belongs to that field; a draft is never dropped by a stray key.
      if (event.key !== "Escape" || event.defaultPrevented
        || (event.target instanceof Element && event.target.closest("input, textarea, select"))) return;
      event.preventDefault();
      useNowPlayingInfo.getState().close();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);
  if (!track) return null;
  const panel = (information: ReactNode, meta?: TrackMetadataParts) => {
    const expanded = !!meta && (metaOpen || meta.editing);
    const matching = !lyricsReady && !!lyricsEntry.inflight;
    return <Panel heading={video ? "视频信息" : "曲目信息"} floatingHeader className="kd-info-panel" dense actions={<>
      {timed && <svg key={peek} className="kd-info-countdown" viewBox="0 0 16 16" role="img" aria-label="即将收起"
        style={{ "--kd-info-peek": `${NOW_PLAYING_PEEK_MS}ms` } as CSSProperties}>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="5.5" pathLength={1} />
      </svg>}
      <button type="button" className="kd-manager-panel-action" aria-pressed={pinned}
        aria-label={pinned ? "取消固定" : "固定曲目信息"} title={pinned ? "取消固定" : "固定曲目信息"}
        onClick={() => useNowPlayingInfo.getState().setPinned(!pinned)}>
        <Pin size={14} aria-hidden="true" />
      </button>
      {!video && <button type="button" className="kd-manager-panel-action" aria-label="打开歌词" title="打开歌词"
        aria-busy={matching} onClick={openLyrics}>
        {matching ? <LoaderCircle size={14} className="kd-spin" aria-hidden="true" /> : <TextQuote size={14} aria-hidden="true" />}
      </button>}
      {meta && <button type="button" className="kd-manager-panel-action" aria-expanded={expanded}
        aria-label={expanded ? "收起 Meta" : "展开 Meta"} title={expanded ? "收起 Meta" : "展开 Meta"}
        disabled={meta.editing} onClick={() => showMeta(!expanded)}>
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>}
      <button type="button" className="kd-manager-panel-action" aria-label="收起曲目信息" title="收起（Esc）"
        onClick={() => useNowPlayingInfo.getState().close()}>
        <ChevronsDown size={14} aria-hidden="true" />
      </button>
    </>}>
      {information}
      {meta && expanded && <div className="kd-info-meta" role="group" aria-label="Meta">
        <div className="kd-info-meta-actions">{meta.actions}</div>
        {meta.body}
      </div>}
    </Panel>;
  };
  return <div className="kd-player-info-clip" data-leaving={leaving || undefined}>
    <div className="kd-player-info kd-scroll" role="dialog" aria-label={video ? "视频信息" : "曲目信息"}
      data-held={held || undefined}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      {isStreamTrack(track) ? <StreamTrackDetail track={track} renderPanels={panel} />
        : <TrackDetail track={track} mode="summary" renderPanels={panel} onRevealMetadata={() => showMeta(true)} />}
    </div>
  </div>;
}
