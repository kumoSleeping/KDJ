import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ChevronsDown, LoaderCircle, Pencil, Pin, TextQuote } from "lucide-react";
import { isVideoTrack } from "../../lib/format";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { trackMetaEditorAnchor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { isStreamTrack, streamMeta } from "../../lib/streamTrack";
import { NOW_PLAYING_PEEK_MS, nowPlayingInfoVisible, useNowPlayingInfo } from "../../lib/nowPlayingInfo";
import { SONG_SWAP_OUT_MS, setSongSurfacePresent, songSwapEntranceDelay } from "../../lib/songSwapMotion";
import { useLyricsStore } from "../../stores/lyricsStore";
import { Panel } from "../common";
import { TrackDetail } from "../library/TrackDetail";
import { StreamTrackDetail } from "./StreamTrackDetail";
import type { Track } from "../../types";
import "./NowPlayingInfo.css";

/** The retreat into the bar; the panel stays mounted this long after it is dismissed. */
const LEAVE_MS = SONG_SWAP_OUT_MS + 20;

/**
 * Keeps the panel mounted while it is up and for the length of its retreat, and brings it up
 * for a moment when another song starts. Pausing and resuming the same song does not.
 */
export function NowPlayingInfoHost({ trackId, playing }: { trackId: number | null; playing: boolean }) {
  const visible = useNowPlayingInfo(nowPlayingInfoVisible);
  const [mounted, setMounted] = useState(visible);
  const song = useRef({ trackId, announced: true, enterAt: 0 });
  const entrance = useRef<number | null>(null);
  useEffect(() => {
    if (song.current.trackId !== trackId) {
      if (entrance.current !== null) window.clearTimeout(entrance.current);
      entrance.current = null;
      // The song restored at launch is not a change of song. Whatever is on screen for the old
      // song leaves first; the panel arrives when that is over, together with the rest.
      song.current = {
        trackId,
        announced: song.current.trackId === null || trackId === null,
        enterAt: performance.now() + songSwapEntranceDelay(),
      };
    }
    if (!song.current.announced && playing) {
      song.current.announced = true;
      entrance.current = window.setTimeout(() => {
        entrance.current = null;
        useNowPlayingInfo.getState().startPeek();
      }, Math.max(0, song.current.enterAt - performance.now()));
    }
  }, [trackId, playing]);
  useEffect(() => () => { if (entrance.current !== null) window.clearTimeout(entrance.current); }, []);
  useEffect(() => {
    setSongSurfacePresent("now-playing-info", mounted);
    return () => setSongSurfacePresent("now-playing-info", false);
  }, [mounted]);
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  // The panel shows one song for as long as it is up. When another song starts it sinks
  // with the old one and rises again with the new one, instead of changing under the eye.
  const playingTrack = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const [shown, setShown] = useState(playingTrack);
  const swapping = mounted && visible && !!shown && !!playingTrack && shown.id !== playingTrack.id;
  useEffect(() => {
    if (!swapping) { setShown(playingTrack); return; }
    const timer = window.setTimeout(() => setShown(playingTrack), SONG_SWAP_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [playingTrack, swapping]);
  useEffect(() => {
    // The right column and the toast make room for the panel (see --kd-info-lift).
    if (!mounted || !visible) document.documentElement.style.removeProperty("--kd-info-lift");
    return () => { document.documentElement.style.removeProperty("--kd-info-lift"); };
  }, [mounted, visible]);
  return mounted && shown ? <NowPlayingInfo key={shown.id} track={shown} leaving={!visible || swapping} /> : null;
}

/** 曲目信息 and Meta of the loaded deck, risen from the player bar it belongs to. */
function NowPlayingInfo({ track, leaving }: { track: Track; leaving: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || leaving) return;
    const publish = () => document.documentElement.style.setProperty("--kd-info-lift", `${Math.round(panel.offsetHeight)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [leaving]);
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
  // Meta is edited in its own floating window; this panel only says whether that is open.
  const editingMeta = useTrackMetaEditor(state => state.trackId !== null && state.trackId === track.id);
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
  const panel = (information: ReactNode) => {
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
      {!isStreamTrack(track) && <button type="button" className="kd-manager-panel-action" aria-pressed={editingMeta}
        aria-label="编辑 Meta" title="编辑 Meta"
        onClick={event => useTrackMetaEditor.getState().toggle(track.id, trackMetaEditorAnchor(event.currentTarget))}>
        <Pencil size={14} aria-hidden="true" />
      </button>}
      <button type="button" className="kd-manager-panel-action" aria-label="收起曲目信息" title="收起（Esc）"
        onClick={() => useNowPlayingInfo.getState().close()}>
        <ChevronsDown size={14} aria-hidden="true" />
      </button>
    </>}>
      {information}
    </Panel>;
  };
  return <div className="kd-player-info-clip" data-leaving={leaving || undefined}>
    <div ref={panelRef} className="kd-player-info kd-scroll" role="dialog" aria-label={video ? "视频信息" : "曲目信息"}
      data-held={held || undefined}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      {isStreamTrack(track) ? <StreamTrackDetail track={track} renderPanels={panel} />
        : <TrackDetail track={track} mode="summary" renderPanels={panel} />}
    </div>
  </div>;
}
