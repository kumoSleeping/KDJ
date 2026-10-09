import { memo, useSyncExternalStore } from "react";
import { LoaderCircle, Pencil, ScrollText } from "lucide-react";
import { getPlayingTrack, subscribePlayingTrack } from "../../lib/playingTrack";
import { trackMetaEditorAnchor, useTrackMetaEditor } from "../../lib/trackMetaEditor";
import { useLyricsEntry } from "./lyricsEntry";

/**
 * Entries of the player bar that belong to the song rather than to the transport. Each reads
 * its own stores, so the bar's clock does not re-render them.
 */

/** 歌词: opens and closes the lyrics of the playing song in the drawer. */
export const BarLyricsEntry = memo(function BarLyricsEntry() {
  const track = useSyncExternalStore(subscribePlayingTrack, getPlayingTrack, getPlayingTrack);
  const lyrics = useLyricsEntry(track);
  if (!lyrics.available) return null;
  const label = lyrics.open ? "关闭歌词" : "打开歌词";
  return <button type="button" className="kd-player-step kd-player-songbtn kd-player-lyrics-entry"
    aria-label={label} title={lyrics.open ? "歌词：开。点一下关闭" : "打开歌词"} aria-pressed={lyrics.open}
    aria-busy={lyrics.matching || undefined} data-on={lyrics.open ? "true" : undefined} onClick={lyrics.toggle}>
    {lyrics.matching ? <LoaderCircle size={13} className="kd-spin" aria-hidden="true" /> : <ScrollText size={13} aria-hidden="true" />}
  </button>;
});

/** 编辑 Meta of a library track; the same entry closes the editor again. */
export const BarMetaEntry = memo(function BarMetaEntry({ trackId }: { trackId: number }) {
  const editing = useTrackMetaEditor(state => state.trackId === trackId);
  return <button type="button" className="kd-player-step kd-player-songbtn kd-player-meta-entry"
    aria-label="编辑 Meta" title="编辑 Meta" aria-pressed={editing} data-on={editing ? "true" : undefined}
    onClick={event => useTrackMetaEditor.getState().toggle(trackId, trackMetaEditorAnchor(event.currentTarget))}>
    <Pencil size={13} aria-hidden="true" />
  </button>;
});
