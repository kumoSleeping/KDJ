import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Palette, PanelBottomOpen, PictureInPicture2, ScrollText } from "lucide-react";
import { isVideoTrack } from "../../lib/format";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { isStreamTrack, streamCoverUrls, streamMeta } from "../../lib/streamTrack";
import {
  NOW_PLAYING_PEEK_MS,
  nowPlayingHeld,
  nowPlayingInfoVisible,
  useNowPlayingInfo,
} from "../../lib/nowPlayingInfo";
import { newerRevision } from "../../lib/coverLoad";
import { useSongColor, useSongColorAvailable } from "../../lib/songColor";
import { songSwapEntranceDelay } from "../../lib/songSwapMotion";
import { useWindowTaken } from "../../lib/windowTaken";
import { useLibraryStore } from "../../stores/libraryStore";
import type { TaskBubbleSpec } from "../tasks/taskBubbleSchema";
import { dismissTask, showTask, updateTask } from "../tasks/taskBubbleStore";
import { useAiStore } from "../../stores/aiStore";
import { trackTaskCover } from "../tasks/taskCovers";
import { prepareTaskCovers } from "../tasks/taskCoverPreparation";
import { NowPlayingTransport } from "./NowPlayingTransport";
import { SongColorBackdrop } from "./SongColorBackdrop";
import { useLyricsEntry } from "./lyricsEntry";
import { useLyricsExtentMenu } from "./LyricsExtentMenu";
import "./NowPlayingTask.css";
import { MiniPlayerKeys } from "./MiniPlayer";

export const NOW_PLAYING_TASK = "now-playing";
const MINI_PLAYER_KEYS = <MiniPlayerKeys />;

/**
 * 曲目信息 as a task bubble: the song that is playing, where it comes from, and the entries
 * that belong to it. It comes up for a moment when another song starts (pausing and resuming
 * the same song does not), stays while it is opened from the now-playing card or pinned, and
 * follows the song across changes.
 *
 * Beside the player bar it is an ordinary message: the bar below is the transport. While the
 * bar is put away it is the listener's transport: it stays, carries the mini transport, and
 * its dismiss key is the way back to the bar. The host draws it, the row of the transport
 * coming and going included; this only says what it shows and keeps it in step with
 * useNowPlayingInfo.
 *
 * `popup` is the floating picture the bar offers for what is playing, as its own 小窗 key
 * does: the video window, the visualizer, or none. With the bar away the bubble is the only
 * place that key is.
 */
export function NowPlayingTask({ trackId, playing, popup = null, popupOn = false, onPopup }: {
  trackId: number | null;
  playing: boolean;
  popup?: "video" | "visualizer" | null;
  popupOn?: boolean;
  onPopup?(): void;
}) {
  const visible = useNowPlayingInfo(nowPlayingInfoVisible);
  // Held: it stays until it is dismissed. With the bar away that is always so.
  const held = useNowPlayingInfo(nowPlayingHeld);
  const barAway = useNowPlayingInfo(state => state.barAway);
  const peek = useNowPlayingInfo(state => state.peek);
  // With the bar up the bar is the transport, and the AI corner has the bottom right: the song's
  // bubble stays down while it is open. With the bar away it is the transport and stays, under
  // the corner (docs/ai-dock.md).
  const aiOpen = useAiStore(state => state.open);
  const yielded = aiOpen && !barAway;
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
  const extent = useLyricsExtentMenu(visible ? track?.id : null);
  // The bubble holds the record the song started with; a cover written since then is only
  // reachable under the list's later revision.
  const listedRevision = useLibraryStore(state => track && track.id > 0 ? state.summaryById.get(track.id)?.modified_at : undefined);
  // Begin with the track, not with the popup: the other song surfaces are still leaving.
  // The host joins this preparation and only reveals the bubble once the images have decoded.
  const covers = useMemo(() => {
    if (!track) return [];
    const cover = trackTaskCover(
      { id: track.id, modified_at: newerRevision(track.modified_at, listedRevision) },
      isStreamTrack(track) ? streamCoverUrls(track) : [],
    );
    return cover ? [cover] : [];
  }, [track, listedRevision]);
  useEffect(() => { void prepareTaskCovers(covers); }, [covers]);
  // Opening the lyrics replaces what the bubble is up for, unless it is the transport of a bar
  // that is away.
  const lyrics = useLyricsEntry(track, () => {
    const info = useNowPlayingInfo.getState();
    if (!info.barAway) info.close();
  });
  // 歌曲色彩: the cover's colours behind this bubble and the lyrics. Not offered where a theme
  // pack draws the two surfaces its own way.
  const colourOffered = useSongColorAvailable();
  const colourOn = useSongColor(state => state.on);
  const live = useRef({ track, lyrics, onPopup });
  live.current = { track, lyrics, onPopup };

  // Raised again whenever what holds it changes; in between only its content is kept current.
  const raise = `${held}:${peek}`;
  const raised = useRef("");
  useEffect(() => {
    if (!visible || !track || yielded) {
      raised.current = "";
      dismissTask(NOW_PLAYING_TASK);
      return;
    }
    const video = isVideoTrack(track.format) || streamMeta(track)?.kind === "video";
    // Two lines: the song and who it is by. The figures (BPM, key, length, format) and the
    // source's mark are the bar's and the list's to show.
    const spec: TaskBubbleSpec = {
      id: NOW_PLAYING_TASK,
      kind: "playing",
      title: track.title || track.filename,
      detail: track.artist || undefined,
      covers,
      song: track.id,
      size: "large",
      base: true,
      stay: held || extent.opened ? 0 : NOW_PLAYING_PEEK_MS,
      escape: true,
      // The window itself can be taken down to this bubble, and brought back from it.
      tools: MINI_PLAYER_KEYS,
      // Rolling it down with the bar away is the way back to the bar, and the key says so.
      dismiss: barAway ? { label: "展开播放条", icon: <PanelBottomOpen size={14} aria-hidden="true" /> } : undefined,
      // The transport only while the bar is away: beside the bar the bubble is a message.
      controls: barAway ? <NowPlayingTransport track={track} /> : undefined,
      backdrop: colourOffered ? <SongColorBackdrop surface="bubble" /> : undefined,
      // The song's toggles, then its editor, then the bubble's own keys.
      actions: [
        ...(video ? [] : [{
          id: "lyrics", label: lyrics.open ? "关闭歌词" : "打开歌词", pressed: lyrics.open, busy: lyrics.matching,
          icon: <ScrollText size={14} aria-hidden="true" />,
          onSelect: () => live.current.lyrics.toggle(),
          onContextMenu: extent.openFrom,
          menuOpen: extent.opened,
        }]),
        ...(popup ? [{
          id: "popup",
          label: popup === "video" ? (popupOn ? "关闭视频小窗" : "打开视频小窗") : (popupOn ? "关闭可视化小窗" : "打开可视化小窗"),
          pressed: popupOn,
          icon: <PictureInPicture2 size={14} aria-hidden="true" />,
          onSelect: () => live.current.onPopup?.(),
        }] : []),
        ...(colourOffered ? [{
          id: "color", label: colourOn ? "关闭歌曲色彩" : "打开歌曲色彩", pressed: colourOn,
          icon: <Palette size={14} aria-hidden="true" />,
          // The colour spreads from this key, and drains back into it.
          onSelect: (bubble: HTMLElement) => useSongColor.getState().toggle(bubble.querySelector('[data-task-action="color"]')),
        }] : []),
      ],
      onDismiss: reason => {
        // Its stay ran out: the peek is over. Dismissed by hand, it goes whatever held it, and
        // the bar comes back if it was away.
        if (reason === "timeout" || reason === "crowded") useNowPlayingInfo.getState().endPeek();
        else if (reason === "user") {
          useNowPlayingInfo.getState().close();
          // An app that had the window with this bubble as its transport (full-screen lyrics)
          // gives the window back: the bar the listener asked for needs its row.
          useWindowTaken.getState().leave?.();
        }
      },
    };
    if (raised.current !== raise) {
      raised.current = raise;
      showTask(spec);
    } else {
      updateTask(NOW_PLAYING_TASK, spec);
    }
  }, [visible, yielded, raise, held, barAway, track, covers, popup, popupOn, lyrics.open, lyrics.matching, colourOffered, colourOn, extent.openFrom, extent.opened]);
  useEffect(() => () => dismissTask(NOW_PLAYING_TASK), []);
  return visible && track ? extent.menu : null;
}
