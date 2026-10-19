/**
 * Where the listener is when they hand the AI a request (docs/ai-dock.md): the page, the folder
 * open in the library, the song picked in the list and the one playing. It goes with every new
 * request as a `<kdj-status>` block after the words and the cards, one JSON object, so 「这个文件夹」
 * 「这首」 mean what is on screen. Changes during the task are told separately (aiPlace.ts).
 */
import type { Track } from "../types";
import { getPlayingTrack } from "./playingTrack";
import { useLibraryStore } from "../stores/libraryStore";
import { readPlace } from "../stores/navStore";

const song = (track: Track | null) => track && {
  track_id: track.id,
  title: track.title || track.filename,
  artist: track.artist || undefined,
  path: track.path || undefined,
};

export function kdjStatus(): Record<string, unknown> {
  const place = readPlace();
  const library = useLibraryStore.getState();
  const selected = library.selectedTrack && library.selectedTrack.id === place.selectedId ? library.selectedTrack : null;
  return {
    page: place.pane === "search" ? "搜索页" : "本地曲库",
    // The library's folder, with or without its subfolders; none is the whole library.
    folder: place.folder || null,
    subfolders: place.folder ? place.folderDeep : undefined,
    library_search: library.filter.q || undefined,
    selected: song(selected) ?? undefined,
    playing: song(getPlayingTrack()) ?? undefined,
  };
}

export function withStatus(text: string): string {
  return `${text}\n\n<kdj-status>\n${JSON.stringify(kdjStatus())}\n</kdj-status>`;
}
