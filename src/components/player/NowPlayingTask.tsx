import { useEffect, useRef, useSyncExternalStore } from "react";
import { PanelBottomOpen, Pencil, Pin, ScrollText } from "lucide-react";
import { formatBpm, formatDuration, isVideoTrack } from "../../lib/format";
import { displayTrackKey } from "../../lib/keyDisplay";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { trackMetaEditorAnchor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { isStreamTrack, streamCoverUrls, streamMeta } from "../../lib/streamTrack";
import {
  NOW_PLAYING_PEEK_MS,
  nowPlayingHeld,
  nowPlayingInfoVisible,
  useNowPlayingInfo,
} from "../../lib/nowPlayingInfo";
import { newerRevision } from "../../lib/coverLoad";
import { songSwapEntranceDelay } from "../../lib/songSwapMotion";
import { useAppStore } from "../../stores/appStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { TrackDetail } from "../library/TrackDetail";
import type { TaskBubbleSpec } from "../tasks/taskBubbleSchema";
import { dismissTask, showTask, updateTask } from "../tasks/taskBubbleStore";
import { trackTaskCover } from "../tasks/taskCovers";
import { NowPlayingTransport } from "./NowPlayingTransport";
import { StreamTrackDetail } from "./StreamTrackDetail";
import { useLyricsEntry } from "./lyricsEntry";
import type { Track } from "../../types";
import "./NowPlayingTask.css";

export const NOW_PLAYING_TASK = "now-playing";

/** The fuller detail of an expanded bubble: the summary of the song as the library shows it. */
function NowPlayingDetail({ track }: { track: Track }) {
  const summary = (information: React.ReactNode) => information;
  return <div className="kd-now-playing-detail">
    {isStreamTrack(track) ? <StreamTrackDetail track={track} renderPanels={summary} />
      : <TrackDetail track={track} mode="summary" renderPanels={summary} />}
  </div>;
}

/**
 * 曲目信息 as a task bubble: the song that is playing, with the entries that belong to it.
 * It comes up for a moment when another song starts (pausing and resuming the same song does
 * not), stays while it is opened from the now-playing card or pinned, and follows the song
 * across changes. While the player bar is put away it is the listener's transport: it stays,
 * and its dismiss key is the way back to the bar. The host draws it; this only says what it
 * shows and keeps it in step with useNowPlayingInfo.
 */
export function NowPlayingTask({ trackId, playing }: { trackId: number | null; playing: boolean }) {
  const visible = useNowPlayingInfo(nowPlayingInfoVisible);
  // Held: it stays until it is dismissed. With the bar away that is always so, and the pin
  // says whether it will still stay beside the bar when the bar is back.
  const held = useNowPlayingInfo(nowPlayingHeld);
  const pinned = useNowPlayingInfo(state => state.pinned);
  const barAway = useNowPlayingInfo(state => state.barAway);
  const peek = useNowPlayingInfo(state => state.peek);
  const detailed = useNowPlayingInfo(state => state.detailed);
  const song = useRef({ trackId, announced: true, enterAt: 0 });
  const entrance = useRef<number | null>(null);
  useEffect(() => {
    if (song.current.trackId !== trackId) {
      if (entrance.current !== null) window.clearTimeout(entrance.current);
      entrance.current = null;
      // The song restored at launch is not a change of song. Whatever is on screen for the old
      // song leaves first; the bubble arrives when that is over, together with the rest.
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

  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const keyNotation = useAppStore(state => state.settings?.key_notation ?? "camelot");
  // The bubble holds the record the song started with; a cover written since then is only
  // reachable under the list's later revision.
  const listedRevision = useLibraryStore(state => track && track.id > 0 ? state.summaryById.get(track.id)?.modified_at : undefined);
  const editingMeta = useTrackMetaEditor(state => !!track && state.trackId === track.id);
  // Opening the lyrics replaces what the bubble is up for, unless the listener pinned it or it
  // is the transport of a bar that is away.
  const lyrics = useLyricsEntry(track, () => {
    const info = useNowPlayingInfo.getState();
    if (!info.pinned && !info.barAway) info.close();
  });
  const live = useRef({ track, lyrics });
  live.current = { track, lyrics };

  // Raised again whenever what holds it changes; in between only its content is kept current.
  const raise = `${held}:${pinned}:${peek}`;
  const raised = useRef("");
  useEffect(() => {
    if (!visible || !track) {
      raised.current = "";
      dismissTask(NOW_PLAYING_TASK);
      return;
    }
    const video = isVideoTrack(track.format) || streamMeta(track)?.kind === "video";
    const library = !isStreamTrack(track);
    const cover = trackTaskCover(
      { id: track.id, modified_at: newerRevision(track.modified_at, listedRevision) },
      library ? [] : streamCoverUrls(track),
    );
    const key = displayTrackKey(track, keyNotation);
    const spec: TaskBubbleSpec = {
      id: NOW_PLAYING_TASK,
      kind: "playing",
      title: track.title || track.filename,
      detail: track.artist || undefined,
      facts: [
        track.bpm ? `${formatBpm(track.bpm)} BPM` : "",
        key,
        track.duration ? formatDuration(track.duration) : "",
        library ? track.format.toUpperCase() : "",
      ].filter(Boolean),
      covers: cover ? [cover] : [],
      song: track.id,
      size: "large",
      stay: held ? 0 : NOW_PLAYING_PEEK_MS,
      escape: true,
      // Rolling it down with the bar away is the way back to the bar, and the key says so.
      dismiss: barAway ? { label: "展开播放条", icon: <PanelBottomOpen size={14} aria-hidden="true" /> } : undefined,
      body: <NowPlayingDetail track={track} />,
      controls: <NowPlayingTransport track={track} />,
      replacesSummary: true,
      expanded: detailed,
      onExpand: next => useNowPlayingInfo.getState().setDetailed(next),
      actions: [
        ...(video ? [] : [{
          id: "lyrics", label: lyrics.open ? "关闭歌词" : "打开歌词", pressed: lyrics.open, busy: lyrics.matching,
          icon: <ScrollText size={14} aria-hidden="true" />,
          onSelect: () => live.current.lyrics.toggle(),
        }]),
        ...(library ? [{
          id: "meta", label: "编辑 Meta", pressed: editingMeta,
          icon: <Pencil size={14} aria-hidden="true" />,
          onSelect: (bubble: HTMLElement) => useTrackMetaEditor.getState().toggle(track.id, trackMetaEditorAnchor(bubble)),
        }] : []),
        {
          id: "pin",
          label: pinned ? "取消固定" : barAway ? "固定：展开播放条后保留曲目信息" : "固定曲目信息",
          pressed: pinned,
          icon: <Pin size={14} aria-hidden="true" />,
          onSelect: () => useNowPlayingInfo.getState().setPinned(!useNowPlayingInfo.getState().pinned),
        },
      ],
      onDismiss: reason => {
        // Its stay ran out: the peek is over. Dismissed by hand, it goes whatever held it, and
        // the bar comes back if it was away.
        if (reason === "timeout" || reason === "crowded") useNowPlayingInfo.getState().endPeek();
        else if (reason === "user") useNowPlayingInfo.getState().close();
      },
    };
    if (raised.current !== raise) {
      raised.current = raise;
      showTask(spec);
    } else {
      updateTask(NOW_PLAYING_TASK, spec);
    }
  }, [visible, raise, held, pinned, barAway, track, listedRevision, keyNotation, editingMeta, detailed, lyrics.open, lyrics.matching]);
  useEffect(() => () => dismissTask(NOW_PLAYING_TASK), []);
  return null;
}
