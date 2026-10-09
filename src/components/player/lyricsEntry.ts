import { isVideoTrack } from "../../lib/format";
import { hasVisibleLyrics } from "../../lib/lyricsVisibility";
import { getPlayingTrack } from "../../lib/playingTrack";
import { useSidePanels } from "../../lib/sidePanels";
import { streamMeta } from "../../lib/streamTrack";
import { useLyricsStore } from "../../stores/lyricsStore";
import { showTask } from "../tasks/taskBubbleStore";
import type { Track } from "../../types";

/** The entry to the lyrics of the playing song, as the player bar and its task bubble offer it. */
export interface LyricsEntry {
  /** A video has no lyrics entry. */
  available: boolean;
  /** The lyrics are showing in the drawer. */
  open: boolean;
  /** A match asked for by this entry is under way. */
  matching: boolean;
  /** Close the lyrics when they are showing; otherwise open them, matching first if needed. */
  toggle(): void;
}

const isVideo = (track: Track) => isVideoTrack(track.format) || streamMeta(track)?.kind === "video";

/**
 * Ask for the lyrics of the playing song, from any entry. They open in the drawer when there
 * are some, after a match if none has been made yet; when there is nothing to show, a small
 * note says so for a moment instead of an empty drawer coming out. `onOpened` runs when the
 * lyrics do open.
 */
export function requestPlayingLyrics(onOpened?: () => void): void {
  const track = getPlayingTrack();
  const none = (detail?: string) => showTask({ id: "lyrics-entry", kind: "notice", title: "没有找到歌词", detail, size: "small", stay: 3_000 });
  if (!track) { none(); return; }
  if (isVideo(track)) { none(track.title || track.filename); return; }
  const show = () => { useSidePanels.getState().setLyrics(true); onOpened?.(); };
  if (hasVisibleLyrics(useLyricsStore.getState().get(track.id).lines)) { show(); return; }
  const id = track.id;
  void useLyricsStore.getState().ensure(track, { matchMissing: true }).then(() => {
    if (getPlayingTrack()?.id !== id) return;
    if (hasVisibleLyrics(useLyricsStore.getState().get(id).lines)) show();
    else none(track.title || track.filename);
  });
}

/**
 * The entry does not depend on an earlier match: opening it is an explicit request, so a
 * missing or failed match is tried again and the lyrics open once they have arrived.
 * `onOpened` runs when they do.
 */
export function useLyricsEntry(track: Track | null, onOpened?: () => void): LyricsEntry {
  const open = useSidePanels(state => state.lyrics);
  const entry = useLyricsStore(state => state.get(track?.id));
  const video = !!track && isVideo(track);
  const ready = !video && hasVisibleLyrics(entry.lines);
  return {
    available: !!track && !video,
    open,
    matching: !open && !ready && !!entry.inflight,
    toggle() {
      if (!track || video) return;
      if (useSidePanels.getState().lyrics) { useSidePanels.getState().setLyrics(false); return; }
      requestPlayingLyrics(onOpened);
    },
  };
}
