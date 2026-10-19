/**
 * The AI corner plays a library track (docs/ai-dock.md): pi's `kdj_play` with a `track_id`, or the
 * play key on a downloaded or listed row. The same entry as a double click in the list.
 */
import { api } from "./api";
import { playTrack } from "./playTrack";
import { useLibraryStore } from "../stores/libraryStore";

export async function playLibraryTrack(trackId: number): Promise<boolean> {
  if (!Number.isFinite(trackId) || trackId <= 0) return false;
  const summary = useLibraryStore.getState().summaryById.get(trackId) ?? (await api.trackSummaries([trackId]))[0];
  if (!summary) return false;
  playTrack(summary);
  return true;
}
