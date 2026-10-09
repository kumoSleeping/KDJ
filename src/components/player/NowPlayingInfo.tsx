import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, ChevronUp, TextQuote } from "lucide-react";
import { isVideoTrack } from "../../lib/format";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { readLocalStorage, writeLocalStorageNow } from "../../lib/storageWrite";
import { isStreamTrack, streamMeta } from "../../lib/streamTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import { Panel } from "../common";
import { TrackDetail, type TrackMetadataParts } from "../library/TrackDetail";
import { StreamTrackDetail } from "./StreamTrackDetail";
import "./NowPlayingInfo.css";

const META_KEY = "kd-now-playing-meta-open";

/** 曲目信息 and Meta of the loaded deck, opened from the now-playing card it sits above. */
export function NowPlayingInfo({ onClose }: { onClose(): void }) {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
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
      onClose();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);
  if (!track) return null;
  const panel = (information: ReactNode, meta?: TrackMetadataParts) => {
    const expanded = !!meta && (metaOpen || meta.editing);
    return <Panel heading={video ? "视频信息" : "曲目信息"} floatingHeader className="kd-info-panel" dense actions={<>
      {!video && <button type="button" className="kd-manager-panel-action" aria-label="打开歌词" title="打开歌词"
        aria-busy={!lyricsReady && !!lyricsEntry.inflight} onClick={openLyrics}>
        <TextQuote size={14} aria-hidden="true" />
      </button>}
      {meta && <button type="button" className="kd-manager-panel-action" aria-expanded={expanded}
        aria-label={expanded ? "收起 Meta" : "展开 Meta"} title={expanded ? "收起 Meta" : "展开 Meta"}
        disabled={meta.editing} onClick={() => showMeta(!expanded)}>
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>}
    </>}>
      {information}
      {meta && expanded && <div className="kd-info-meta" role="group" aria-label="Meta">
        <div className="kd-info-meta-actions">{meta.actions}</div>
        {meta.body}
      </div>}
    </Panel>;
  };
  return <div className="kd-player-info kd-scroll" role="dialog" aria-label={video ? "视频信息" : "曲目信息"}>
    {isStreamTrack(track) ? <StreamTrackDetail track={track} renderPanels={panel} />
      : <TrackDetail track={track} mode="summary" renderPanels={panel} onRevealMetadata={() => showMeta(true)} />}
  </div>;
}
