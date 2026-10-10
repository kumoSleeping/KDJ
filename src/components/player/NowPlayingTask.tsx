import { useEffect, useRef, useSyncExternalStore } from "react";
import { Pencil, Pin, ScrollText } from "lucide-react";
import { formatBpm, formatDuration, isVideoTrack } from "../../lib/format";
import { displayTrackKey } from "../../lib/keyDisplay";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { trackMetaEditorAnchor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { isStreamTrack, streamCoverUrls, streamMeta } from "../../lib/streamTrack";
import {
  NOW_PLAYING_PEEK_MS,
  nowPlayingHeld,
  nowPlayingInfoVisible,
  nowPlayingKeptAway,
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
 * not), stays while it is opened from the now-playing card or pinned, or while the player bar
 * is put away (then it is the listener's transport), and follows the song across changes. The
 * host draws it; this only says what it shows and keeps it in step with useNowPlayingInfo.
 */
export function NowPlayingTask({ trackId, playing }: { trackId: number | null; playing: boolean }) {
  const visible = useNowPlayingInfo(nowPlayingInfoVisible);
  // Held: it stays until it is dismissed. `fixed` is what the pin shows: pinned by the
  // listener, or kept as if it were because the bar is away.
  const held = useNowPlayingInfo(nowPlayingHeld);
  const fixed = useNowPlayingInfo(state => state.pinned || nowPlayingKeptAway(state));
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
    if (!info.pinned && !nowPlayingKeptAway(info)) info.close();
  });
  const live = useRef({ track, lyrics });
  live.current = { track, lyrics };

  // Raised again whenever what holds it changes; in between only its content is kept current.
  const raise = `${held}:${fixed}:${peek}`;
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
          id: "pin", label: fixed ? "取消固定" : "固定曲目信息", pressed: fixed,
          icon: <Pin size={14} aria-hidden="true" />,
          // Unpinning a bubble that is only kept for the bar lets it go as well.
          onSelect: () => {
            const info = useNowPlayingInfo.getState();
            info.setPinned(!(info.pinned || nowPlayingKeptAway(info)));
          },
        },
      ],
      onDismiss: reason => {
        // Its stay ran out: the peek is over. Dismissed by hand, it goes whatever held it.
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
  }, [visible, raise, held, fixed, track, listedRevision, keyNotation, editingMeta, detailed, lyrics.open, lyrics.matching]);
  useEffect(() => () => dismissTask(NOW_PLAYING_TASK), []);
  return null;
}
