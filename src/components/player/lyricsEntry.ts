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

/**
 * The entry does not depend on an earlier match: opening it is an explicit request, so a
 * missing or failed match is tried again and the lyrics open once they have arrived.
 * `onOpened` runs when they do.
 */
export function useLyricsEntry(track: Track | null, onOpened?: () => void): LyricsEntry {
  const open = useSidePanels(state => state.lyrics);
  const entry = useLyricsStore(state => state.get(track?.id));
  const video = !!track && (isVideoTrack(track.format) || streamMeta(track)?.kind === "video");
  const ready = !video && hasVisibleLyrics(entry.lines);
  return {
    available: !!track && !video,
    open,
    matching: !open && !ready && !!entry.inflight,
    toggle() {
      if (!track || video) return;
      if (useSidePanels.getState().lyrics) { useSidePanels.getState().setLyrics(false); return; }
      const show = () => { useSidePanels.getState().setLyrics(true); onOpened?.(); };
      if (ready) { show(); return; }
      const id = track.id;
      void useLyricsStore.getState().ensure(track, { matchMissing: true }).then(() => {
        if (getPlayingTrack()?.id !== id) return;
        if (hasVisibleLyrics(useLyricsStore.getState().get(id).lines)) show();
        // Nothing to open: the request is answered instead of ending in silence.
        else showTask({ id: "lyrics-entry", kind: "notice", title: "没有找到歌词", detail: track.title || track.filename });
      });
    },
  };
}
