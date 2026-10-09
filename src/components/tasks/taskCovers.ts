import { api } from "../../lib/api";
import { onlineCoverUrls } from "../../lib/format";
import type { DownloadTask, Track } from "../../types";
import type { CompositionProject } from "../../types/workshop";
import type { TaskCover } from "./taskBubbleSchema";

/**
 * Where the covers of a task bubble come from: whatever the task already carries. Kept to
 * this one file so the derivation can be pointed at the lists' own (src/lib/taskCovers.ts).
 */

/** A library track's cover: the sized thumbnail first, then the embedded original. */
export function libraryCover(trackId: number, revision?: string): TaskCover {
  return { key: trackId, urls: [api.coverUrl(trackId, revision, 256), api.coverUrl(trackId, revision)] };
}

export function trackTaskCover(track: Pick<Track, "id" | "modified_at">, onlineUrls: readonly string[] = []): TaskCover | null {
  if (track.id > 0) return libraryCover(track.id, track.modified_at);
  return onlineUrls.length ? { key: track.id, urls: onlineUrls } : null;
}

/** The search result's cover while the file is on its way, the library's once it is in. */
export function downloadTaskCover(task: Pick<DownloadTask, "id" | "cover" | "track_id">): TaskCover | null {
  if (task.track_id != null && task.track_id > 0) return libraryCover(task.track_id);
  const urls = onlineCoverUrls(task.cover ?? "", 96);
  return urls.length ? { key: task.id, urls } : null;
}

/** A mixing project stands for the library tracks it is cut from. */
export function projectTaskCovers(project: Pick<CompositionProject, "sources"> | undefined): TaskCover[] {
  const ids = new Set<number>();
  for (const source of project?.sources ?? []) if (source.track_id > 0) ids.add(source.track_id);
  return [...ids].map(id => libraryCover(id));
}

/** A visualizer export is frozen from one song, but its task only keeps a name: the song is
 *  noted when the export is added, for as long as this window lives. */
const visualizerSongs = new Map<string, number>();
let pendingVisualizerSong: number | null = null;

export function noteVisualizerExportSong(trackId: number): void {
  pendingVisualizerSong = trackId > 0 ? trackId : null;
}

export function visualizerTaskCover(taskId: string, added: boolean): TaskCover | null {
  if (added && pendingVisualizerSong !== null && !visualizerSongs.has(taskId)) {
    visualizerSongs.set(taskId, pendingVisualizerSong);
    pendingVisualizerSong = null;
  }
  const song = visualizerSongs.get(taskId);
  return song === undefined ? null : libraryCover(song);
}
