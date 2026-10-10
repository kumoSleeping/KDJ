import { useEffect, useSyncExternalStore } from "react";
import { isVideoTrack } from "./format";
import { useLyricsPrefs } from "./lyricsPrefs";
import { hasVisibleLyrics } from "./lyricsVisibility";
import { getPlayingTrack, subscribePlayingTrack } from "./playingTrack";
import { useSidePanels } from "./sidePanels";
import { streamMeta } from "./streamTrack";
import { useLyricsStore } from "../stores/lyricsStore";
import type { Track } from "../types";

export interface PlayingLyrics {
  track: Track | null;
  /** Actual content, not the remembered choice to keep lyrics enabled. */
  visible: boolean;
}

/** The drawer and phone sheet use the same eligibility. A missing song never clears the
 * listener's choice; LyricsHost keeps looking for the following song while that choice is on. */
export function usePlayingLyrics(): PlayingLyrics {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const enabled = useSidePanels(state => state.lyrics);
  const hasLyrics = useLyricsStore(state => hasVisibleLyrics(state.get(track?.id).lines));
  const prefsEpoch = useLyricsPrefs(state => state.prefsEpoch);
  useEffect(() => {
    // Also read the cache when restored/opened while paused, with no body mounted yet.
    // Online matching remains owned by LyricsHost and explicit requests.
    if (enabled && track) void useLyricsStore.getState().ensure(track, { cacheOnly: true });
  }, [enabled, track, prefsEpoch]);
  return {
    track,
    visible: enabled && !!track && !isVideoTrack(track.format)
      && streamMeta(track)?.kind !== "video" && hasLyrics,
  };
}
